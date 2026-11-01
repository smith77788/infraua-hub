/**
 * Тривога в РАЙОНІ точки підписника — а не лише в області.
 *
 * ## Навіщо
 *
 * Персональні тривоги й відбої бот рахував за переліком ОБЛАСТЕЙ
 * (ubilling / API Вадима Клименка). Але тривогу давно оголошують по районах і
 * громадах: уночі 01.11 активних було 78 районів, і область у тому переліку
 * стає «під тривогою» лише тоді, коли тривога на всю область. Тривога лише в
 * Рівненському чи Сарненському районі до людини в Рівному не доходила взагалі.
 * Користувач (01.11): бот не надсилав «повідомлень про тривогу».
 *
 * Джерело районів — detoyshahed.in.ua: та сама відповідь, з якої карта малює
 * заливку тривоги, з полігоном кожного району (GeoJSON, [lon, lat]). Тут вона
 * розбирається повністю, без проріджування: для заливки карти досить 120
 * точок на контур, для «чи моя точка всередині» біля межі — ні.
 *
 * ## Правила переходів
 *
 * - Перше спостереження точки (памʼяті нема) — лише запамʼятовуємо. Інакше
 *   кожен деплой посеред тривоги розсилав би «тривога» всім, хто в ній уже є.
 * - «Не в тривозі» → «в тривозі» — початок; навпаки — відбій.
 * - Перехід між зонами (район → уся область) — не подія: тривога триває.
 */

export interface AlertZone {
  id: string;
  name: string;
  /** Коли зону оголошено, мс; `null`, якщо джерело не дало. */
  since: number | null;
  /** Полігони зони: кожен — масив контурів (зовнішній і дірки), точки [lon, lat]. */
  polygons: number[][][][];
}

/** Розбір відповіді detoyshahed. `null` — відповідь не схожа на перелік (збій джерела). */
export function parseAlertZones(raw: unknown): AlertZone[] | null {
  const d = raw as { alerts?: unknown } | null;
  if (!d || !Array.isArray(d.alerts)) return null;
  const out: AlertZone[] = [];
  for (const a of d.alerts as Record<string, unknown>[]) {
    if (!a || typeof a !== "object") continue;
    const g = a["geometry"] as { type?: unknown; coordinates?: unknown } | undefined;
    const polygons = polygonsOf(g);
    if (polygons.length === 0) continue;
    const name = typeof a["region_name"] === "string" ? a["region_name"] : "";
    const id = String(a["api_region_id"] ?? a["osm_id"] ?? name);
    const since = typeof a["updated_at"] === "string" ? Date.parse(a["updated_at"]) : Number.NaN;
    out.push({ id, name, since: Number.isFinite(since) ? since : null, polygons });
  }
  return out;
}

function polygonsOf(g: { type?: unknown; coordinates?: unknown } | undefined): number[][][][] {
  if (!g || !Array.isArray(g.coordinates)) return [];
  const valid = (ring: unknown): ring is number[][] =>
    Array.isArray(ring) &&
    ring.length >= 3 &&
    ring.every((p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number");
  if (g.type === "Polygon") {
    const rings = (g.coordinates as unknown[]).filter(valid);
    return rings.length ? [rings] : [];
  }
  if (g.type === "MultiPolygon") {
    return (g.coordinates as unknown[])
      .map((poly) => (Array.isArray(poly) ? poly.filter(valid) : []))
      .filter((rings) => rings.length > 0);
  }
  return [];
}

/** Чи точка всередині полігона (правило парності: дірки враховуються самі). */
function inPolygon(lat: number, lon: number, rings: readonly number[][][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi! > lat !== yj! > lat && lon < ((xj! - xi!) * (lat - yi!)) / (yj! - yi!) + xi!) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Зона тривоги, що накриває точку; із кількох — найраніше оголошена. */
export function zoneAt(lat: number, lon: number, zones: readonly AlertZone[]): AlertZone | null {
  let best: AlertZone | null = null;
  for (const z of zones) {
    if (!z.polygons.some((rings) => inPolygon(lat, lon, rings))) continue;
    if (!best || (z.since ?? Infinity) < (best.since ?? Infinity)) best = z;
  }
  return best;
}

/** Що памʼятаємо про точку між обходами. */
export interface PointAlarm {
  /** Назва зони, якщо точка під тривогою; `null` — тривоги нема. */
  zone: string | null;
  /** Відколи тривога в точці, мс (для «тривала 2 год»). */
  since: number | null;
}

export type PointTransition =
  { kind: "started"; zone: string } | { kind: "cleared"; zone: string; durationMs: number | null };

/**
 * Перехід для однієї точки. `prev === undefined` — перше спостереження:
 * переходу нема, лише новий стан.
 */
export function pointTransition(
  prev: PointAlarm | undefined,
  zone: AlertZone | null,
  now: number,
): { next: PointAlarm; transition: PointTransition | null } {
  if (zone) {
    const since = prev?.zone ? (prev.since ?? zone.since ?? now) : (zone.since ?? now);
    const next: PointAlarm = { zone: zone.name, since };
    if (prev && !prev.zone) return { next, transition: { kind: "started", zone: zone.name } };
    return { next, transition: null };
  }
  const next: PointAlarm = { zone: null, since: null };
  if (prev?.zone) {
    return {
      next,
      transition: {
        kind: "cleared",
        zone: prev.zone,
        durationMs: prev.since !== null ? Math.max(0, now - prev.since) : null,
      },
    };
  }
  return { next, transition: null };
}

/** Ключ точки: чат і координати — назву місця людина може перейменувати. */
export function pointKey(chatId: number, lat: number, lon: number): string {
  return `${chatId}|${lat.toFixed(3)},${lon.toFixed(3)}`;
}

/** Памʼять для тому. Тотальна: битий стан — порожня памʼять. */
export function packPointAlarms(m: ReadonlyMap<string, PointAlarm>): string {
  return JSON.stringify([...m]);
}

export function unpackPointAlarms(raw: string | null): Map<string, PointAlarm> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out = new Map<string, PointAlarm>();
    for (const item of parsed) {
      if (!Array.isArray(item) || typeof item[0] !== "string") continue;
      const v = item[1] as Partial<PointAlarm> | undefined;
      if (!v || (v.zone !== null && typeof v.zone !== "string")) continue;
      out.set(item[0], {
        zone: v.zone ?? null,
        since: typeof v.since === "number" ? v.since : null,
      });
    }
    return out;
  } catch {
    return null;
  }
}
