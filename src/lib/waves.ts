/**
 * Сегментація нальоту на окремі хвилі та відстеження їх у часі.
 *
 * ## Навіщо
 *
 * «У небі 24 цілі» — майже нічого не каже. 24 цілі одним роєм з півночі й
 * 24 цілі трьома групами з різних боків — це різні нальоти, різні рішення,
 * різні області під ударом. Досі система бачила купу окремих позначок; тут вона
 * бачить СТРУКТУРУ: скільки скоординованих груп, де кожна, куди росте.
 *
 * ## Дві задачі
 *
 * 1. Кластеризація (`clusterThreats`) — згрупувати позначки одного моменту в
 *    групи за близькістю (одинарний зв'язок: ланцюжок сусідів — одна хвиля).
 * 2. Асоціація в часі (`updateWaves`) — упізнати ту саму хвилю на наступному
 *    тику й дати їй СТАЛИЙ ідентифікатор, щоб вести життєвий цикл: народження,
 *    ріст, пік, згасання. Без сталого id «хвиля №2» щотику була б іншою.
 *
 * ## Межа
 *
 * Ідеальна асоціація (яка саме група стала якою при злитті/розпаді, хто куди
 * перетік) — це вже багатогіпотезне трекінг за радарними вимірами, не за
 * OSINT-позначками. Тут — жадібне зіставлення найближчих центрів: стеля того,
 * що чесно з наявних даних. Далі потрібні нові дані, не новий код.
 */

import type { Threat, ThreatType } from "./air";

const R_KM = 6371;
function distKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

export interface WaveCluster {
  threats: Threat[];
  /** Центр мас групи. */
  lat: number;
  lon: number;
  count: number;
  types: Partial<Record<ThreatType, number>>;
  dominantType: ThreatType;
  /** Найдальша ціль від центра, км — «розмір» хвилі. */
  radiusKm: number;
}

function dominant(types: Partial<Record<ThreatType, number>>): ThreatType {
  let best: ThreatType = "unknown";
  let bestN = -1;
  for (const [t, n] of Object.entries(types) as [ThreatType, number][]) {
    if (n > bestN) {
      bestN = n;
      best = t;
    }
  }
  return best;
}

/**
 * Групує позначки одного моменту в хвилі одинарним зв'язком: дві цілі в одній
 * групі, якщо між ними менше `linkKm` (транзитивно — ланцюжок сусідів злипається
 * в одну хвилю). Реалізація через систему неперетинних множин (union-find).
 */
export function clusterThreats(threats: readonly Threat[], linkKm = 45): WaveCluster[] {
  const n = threats.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) {
      const nx = parent[x]!;
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = threats[i]!;
      const b = threats[j]!;
      if (distKm(a.lat, a.lon, b.lat, b.lon) <= linkKm) union(i, j);
    }
  }
  const groups = new Map<number, Threat[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(threats[i]!);
    else groups.set(r, [threats[i]!]);
  }
  const out: WaveCluster[] = [];
  for (const g of groups.values()) {
    const lat = g.reduce((s, t) => s + t.lat, 0) / g.length;
    const lon = g.reduce((s, t) => s + t.lon, 0) / g.length;
    const types: Partial<Record<ThreatType, number>> = {};
    for (const t of g) {
      const ty = t.type ?? "unknown";
      types[ty] = (types[ty] ?? 0) + 1;
    }
    const radiusKm = g.reduce((m, t) => Math.max(m, distKm(lat, lon, t.lat, t.lon)), 0);
    out.push({
      threats: g,
      lat,
      lon,
      count: g.length,
      types,
      dominantType: dominant(types),
      radiusKm: Math.round(radiusKm),
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

export type WaveStatus = "new" | "active" | "fading";
export type WaveTrend = "growing" | "steady" | "shrinking";

export interface Wave {
  id: string;
  lat: number;
  lon: number;
  count: number;
  peakCount: number;
  firstSeen: number;
  lastSeen: number;
  dominantType: ThreatType;
  status: WaveStatus;
  trend: WaveTrend;
  /** id цілей у хвилі зараз — для власного вектора хвилі через trajectory. */
  threatIds: string[];
}

export interface UpdateWavesOptions {
  /** Наскільки близько центр нової групи до старої хвилі, щоб визнати їх однією. */
  matchKm?: number;
  /** Скільки хвиля живе без нових позначок, перш ніж зникнути (згасання). */
  expireMs?: number;
}

function waveId(now: number, lat: number, lon: number): string {
  return `w${now}_${Math.round(lat * 100)}_${Math.round(lon * 100)}`;
}

/**
 * Асоціює групи цього тику з хвилями попереднього й веде їх у часі. Жадібне
 * зіставлення: кожна група бере найближчу ще вільну стару хвилю в межах
 * `matchKm`. Знайшла — успадковує id, firstSeen і пік; не знайшла — нова хвиля.
 * Стара без пари живе ще `expireMs` як «згасає», потім зникає.
 */
export function updateWaves(
  prev: readonly Wave[],
  clusters: readonly WaveCluster[],
  now: number,
  opts: UpdateWavesOptions = {},
): Wave[] {
  const matchKm = opts.matchKm ?? 70;
  const expireMs = opts.expireMs ?? 4 * 60_000;
  const taken = new Set<number>();
  const result: Wave[] = [];

  // Найбільші групи вибирають пару першими — вони визначальні.
  const ordered = [...clusters].sort((a, b) => b.count - a.count);
  for (const c of ordered) {
    let bestIdx = -1;
    let bestD = Infinity;
    for (let i = 0; i < prev.length; i++) {
      if (taken.has(i)) continue;
      const d = distKm(c.lat, c.lon, prev[i]!.lat, prev[i]!.lon);
      if (d <= matchKm && d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    const ids = c.threats.map((t) => t.id);
    if (bestIdx >= 0) {
      const p = prev[bestIdx]!;
      taken.add(bestIdx);
      const trend: WaveTrend =
        c.count > p.count + 1 ? "growing" : c.count < p.count - 1 ? "shrinking" : "steady";
      result.push({
        id: p.id,
        lat: c.lat,
        lon: c.lon,
        count: c.count,
        peakCount: Math.max(p.peakCount, c.count),
        firstSeen: p.firstSeen,
        lastSeen: now,
        dominantType: c.dominantType,
        status: "active",
        trend,
        threatIds: ids,
      });
    } else {
      result.push({
        id: waveId(now, c.lat, c.lon),
        lat: c.lat,
        lon: c.lon,
        count: c.count,
        peakCount: c.count,
        firstSeen: now,
        lastSeen: now,
        dominantType: c.dominantType,
        status: "new",
        trend: "growing",
        threatIds: ids,
      });
    }
  }

  // Хвилі без пари цього тику — згасають, поки не вийде час.
  for (let i = 0; i < prev.length; i++) {
    if (taken.has(i)) continue;
    const p = prev[i]!;
    if (now - p.lastSeen <= expireMs) {
      result.push({ ...p, status: "fading", trend: "shrinking" });
    }
  }

  return result.sort((a, b) => b.count - a.count);
}
