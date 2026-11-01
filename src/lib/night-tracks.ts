import { normalizeThreatType, type Threat, type ThreatType } from "./air";
import { distanceKm } from "./infra-types";
import { kyivDate } from "./kyiv";

/**
 * Усі треки ночі — однією картинкою, за 30 днів.
 *
 * ## Навіщо
 *
 * «Історія» програвала добу кадрами, як відео. Користувач (опитувальник
 * 01.11) хоче інше: «показувати всі треки ночі на одній картинці» і тримати
 * історію 30 днів. Кадри повтору для цього не годяться — 30 діб кадрів
 * щохвилини важать десятки мегабайт. Тут кожна ціль ночі — одна лінія з
 * точками через `STEP_KM`: так ніч великого нальоту — десятки кілобайт.
 *
 * ## Що таке «ніч»
 *
 * Наліт іде через північ, тож ніч — це не календарна дата. Ключ ночі — дата
 * за Києвом на `NIGHT_SHIFT_H` годин раніше: усе з 12:00 31.10 до 12:00 01.11
 * — «ніч на 1 листопада» з ключем «2026-10-31».
 */

export const NIGHT_SHIFT_H = 12;
export const KEEP_NIGHTS = 30;
/** Нова точка треку — коли ціль зрушила щонайменше на стільки. */
export const STEP_KM = 3;
const MAX_POINTS = 240;
const MAX_TRACKS = 3000;

/** Точка: [широта, довгота, хвилина від початку ночі]. */
export type NightPoint = [number, number, number];

export interface NightTrack {
  id: string;
  name: string;
  type: ThreatType;
  pts: NightPoint[];
}

export interface NightPayload {
  /** Ключ ночі (дата за Києвом, коли ніч почалась). */
  night: string;
  /** Початок ночі, мс. */
  start: number;
  tracks: NightTrack[];
}

export function nightKeyOf(now: number): string {
  return kyivDate(new Date(now - NIGHT_SHIFT_H * 3_600_000));
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export class NightTracks {
  readonly night: string;
  readonly start: number;
  private tracks = new Map<string, NightTrack>();

  constructor(night: string, start: number) {
    this.night = night;
    this.start = start;
  }

  get size(): number {
    return this.tracks.size;
  }

  observe(threats: readonly Threat[], now: number): boolean {
    let changed = false;
    const minute = Math.max(0, Math.round((now - this.start) / 60_000));
    for (const t of threats) {
      if (!t.id || !Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue;
      const type = normalizeThreatType(t.type);
      let tr = this.tracks.get(t.id);
      if (!tr) {
        if (this.tracks.size >= MAX_TRACKS) continue;
        tr = { id: t.id, name: t.name, type, pts: [] };
        this.tracks.set(t.id, tr);
      }
      // Тип — останній відомий: канали могли уточнити його посеред польоту.
      if (tr.type !== type) {
        tr.type = type;
        changed = true;
      }
      const last = tr.pts[tr.pts.length - 1];
      if (last && distanceKm({ lat: last[0], lon: last[1] }, t) < STEP_KM) continue;
      if (tr.pts.length >= MAX_POINTS) continue;
      tr.pts.push([r3(t.lat), r3(t.lon), minute]);
      changed = true;
    }
    return changed;
  }

  payload(): NightPayload {
    return { night: this.night, start: this.start, tracks: [...this.tracks.values()] };
  }

  /** Тотальна: битий стан — порожня ніч, а не виняток. */
  static fromPayload(raw: unknown, night: string, start: number): NightTracks {
    const n = new NightTracks(night, start);
    const d = raw as Partial<NightPayload> | null;
    if (!d || d.night !== night || !Array.isArray(d.tracks)) return n;
    for (const tr of d.tracks) {
      if (!tr || typeof tr.id !== "string" || !Array.isArray(tr.pts)) continue;
      const pts = tr.pts.filter(
        (p): p is NightPoint =>
          Array.isArray(p) && p.length === 3 && p.every((x) => typeof x === "number"),
      );
      n.tracks.set(tr.id, {
        id: tr.id,
        name: typeof tr.name === "string" ? tr.name : "",
        type: normalizeThreatType(tr.type),
        pts: pts.slice(0, MAX_POINTS),
      });
    }
    return n;
  }
}

/** Початок ночі з ключем `night`: 12:00 за Києвом того дня. */
export function nightStart(night: string): number {
  // Київ — UTC+2 взимку, UTC+3 влітку; беремо полудень UTC і зсуваємо так, щоб
  // ключ цього моменту збігався з `night` (перевіряємо обидва зсуви).
  for (const offsetH of [2, 3]) {
    const t = Date.parse(`${night}T${String(NIGHT_SHIFT_H - offsetH).padStart(2, "0")}:00:00Z`);
    if (Number.isFinite(t) && nightKeyOf(t) === night && nightKeyOf(t - 60_000) !== night) return t;
  }
  return Date.parse(`${night}T10:00:00Z`);
}

/** Ключі ночей, які лишаємо: останні `KEEP_NIGHTS`, від нової до старої. */
export function keepNights(keys: readonly string[]): string[] {
  return [...new Set(keys)].sort().reverse().slice(0, KEEP_NIGHTS);
}
