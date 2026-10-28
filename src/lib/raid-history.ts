import { normalizeThreatType, type Threat, type ThreatType } from "./air";
import type { RaidFrame } from "./raid-replay";

/**
 * Історія нальоту на СЕРВЕРІ — для повтору.
 *
 * ## Навіщо
 *
 * Повтор записувався лише в браузері й лише поки сторінка відкрита
 * (`raid-replay`). Відкрив міні-застосунок — буфер порожній, і кнопка «▶»
 * програвала кілька хвилин від відкриття, тобто майже нічого. Користувач
 * (28.10): «Історія нальотів не працює… повтор не відтворюється».
 *
 * Сервер бачить картину безперервно — обхід сповіщень опитує її щопівхвилини.
 * Тут він складає кадри за останні `WINDOW_MS`, а клієнт при відкритті бере
 * їх і дописує до них свої.
 *
 * ## Формат — компактний
 *
 * Назва, тип і джерело цілі не повторюються в кожному кадрі: вони в довіднику
 * `ids`, а кадр — лише [номер, широта, довгота, курс]. Три години нальоту на
 * 40 цілей при кадрі щохвилини — ~200 КБ замість ~1 МБ.
 */

/**
 * Доба: «Історія» показує нальоти за добу, «Наліт» — останні 3 год. Свіжі 3
 * год — кадр щохвилини; старше — проріджено до кадру на 5 хв: для повтору
 * доби цього досить, а дані лишаються легкими для телефона.
 */
export const WINDOW_MS = 24 * 60 * 60_000;
export const DENSE_MS = 3 * 60 * 60_000;
export const SPARSE_EVERY_MS = 5 * 60_000;
/** Не частіше за кадр на хвилину: для повтору на 15 с цього досить із запасом. */
export const SAMPLE_EVERY_MS = 60_000;

interface Meta {
  id: string;
  name: string;
  type: ThreatType;
  source: string;
}

/** Кадр: [номер у `ids`, широта, довгота, курс або -1]. */
type Point = [number, number, number, number];

export interface RaidHistoryPayload {
  ids: Meta[];
  frames: { t: number; p: Point[] }[];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export class RaidHistory {
  private frames: { t: number; p: { id: string; lat: number; lon: number; h: number }[] }[] = [];
  private meta = new Map<string, Meta>();
  private lastFingerprint = "";

  /** Записати картину, якщо минула хвилина й вона змінилась. */
  sample(threats: readonly Threat[], now: number): boolean {
    const last = this.frames[this.frames.length - 1];
    if (last && now - last.t < SAMPLE_EVERY_MS) return false;
    const p = threats
      .filter((t) => t.id && Number.isFinite(t.lat) && Number.isFinite(t.lon))
      .map((t) => ({
        id: t.id,
        lat: r3(t.lat),
        lon: r3(t.lon),
        h: typeof t.heading === "number" && Number.isFinite(t.heading) ? Math.round(t.heading) : -1,
      }));
    const fp = p
      .map((x) => `${x.id}|${x.lat}|${x.lon}`)
      .sort()
      .join(";");
    // Порожнє небо — теж кадр, але один: інакше повтор не покаже, що наліт
    // скінчився. Історію з порожнього неба не починаємо.
    if (!last && p.length === 0) return false;
    if (fp === this.lastFingerprint && last) return false;
    this.lastFingerprint = fp;
    for (const t of threats) {
      if (!t.id) continue;
      this.meta.set(t.id, {
        id: t.id,
        name: t.name,
        type: normalizeThreatType(t.type),
        source: t.source,
      });
    }
    this.frames.push({ t: now, p });
    this.prune(now);
    return true;
  }

  private prune(now: number): void {
    const kept: typeof this.frames = [];
    for (const f of this.frames) {
      if (now - f.t > WINDOW_MS) continue;
      const prev = kept[kept.length - 1];
      // Старше 3 год — не частіше за кадр на 5 хв.
      if (prev && now - f.t > DENSE_MS && f.t - prev.t < SPARSE_EVERY_MS) continue;
      kept.push(f);
    }
    this.frames = kept;
    const alive = new Set(this.frames.flatMap((f) => f.p.map((x) => x.id)));
    for (const id of this.meta.keys()) if (!alive.has(id)) this.meta.delete(id);
  }

  /** Кадри за останні `sinceMs` (усталено — усе вікно). */
  payload(now: number, sinceMs: number = WINDOW_MS): RaidHistoryPayload {
    this.prune(now);
    const frames = this.frames.filter((f) => now - f.t <= sinceMs);
    const used = new Set(frames.flatMap((f) => f.p.map((x) => x.id)));
    const ids = [...this.meta.values()].filter((m) => used.has(m.id));
    const index = new Map(ids.map((m, i) => [m.id, i]));
    return {
      ids,
      frames: frames.map((f) => ({
        t: f.t,
        p: f.p.filter((x) => index.has(x.id)).map((x) => [index.get(x.id)!, x.lat, x.lon, x.h]),
      })),
    };
  }

  /** Стан для тому — той самий компактний формат. */
  toState(now: number): RaidHistoryPayload {
    return this.payload(now);
  }

  static fromState(raw: unknown, now: number): RaidHistory {
    const h = new RaidHistory();
    const frames = framesFromPayload(raw);
    for (const f of frames) {
      if (now - f.t > WINDOW_MS) continue;
      h.frames.push({
        t: f.t,
        p: f.threats.map((t) => ({ id: t.id, lat: t.lat, lon: t.lon, h: t.heading ?? -1 })),
      });
      for (const t of f.threats) {
        h.meta.set(t.id, { id: t.id, name: t.name, type: t.type ?? "unknown", source: t.source });
      }
    }
    return h;
  }
}

/**
 * Компактний формат → кадри повтору. Тотальна: на зіпсованому вході —
 * порожньо, а не виняток (повтор — допоміжне, ламати через нього карту не можна).
 */
export function framesFromPayload(raw: unknown): RaidFrame[] {
  const d = raw as Partial<RaidHistoryPayload> | null;
  if (!d || !Array.isArray(d.ids) || !Array.isArray(d.frames)) return [];
  const ids = d.ids;
  const out: RaidFrame[] = [];
  for (const f of d.frames) {
    if (!f || typeof f.t !== "number" || !Array.isArray(f.p)) continue;
    const iso = new Date(f.t).toISOString();
    const threats: Threat[] = [];
    for (const pt of f.p) {
      if (!Array.isArray(pt)) continue;
      const [i, lat, lon, h] = pt;
      const m = typeof i === "number" ? ids[i] : undefined;
      if (!m || typeof lat !== "number" || typeof lon !== "number") continue;
      threats.push({
        id: m.id,
        name: m.name,
        lat,
        lon,
        source: m.source,
        type: normalizeThreatType(m.type),
        count: 1,
        since: iso,
        lastSeen: iso,
        expires: "",
        ...(typeof h === "number" && h >= 0 ? { heading: h } : {}),
      });
    }
    out.push({ t: f.t, threats });
  }
  return out.sort((a, b) => a.t - b.t);
}
