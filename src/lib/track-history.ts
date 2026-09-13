/**
 * Накопичення СПОСТЕРЕЖЕНОГО треку цілі на клієнті.
 *
 * Проблема, яку це закриває (з розбору моніторів): вони малюють стрілку «на
 * око», людина бачить вектор на своє місто й панікує, а ціль іде зовсім інакше.
 * Чесна карта має розрізняти ДВІ різні речі:
 *   — де ціль РЕАЛЬНО була (спостережений трек) — суцільна лінія;
 *   — куди вона МОЖЕ полетіти за фізикою руху (екстраполяція) — пунктир.
 *
 * Джерело (neptun) віддає лише поточну позицію + курс, без історії. Але консоль
 * опитує його періодично, тож послідовні фікси однієї цілі (за стабільним id)
 * складаються в трек саме тут. Це також дає «куди вона летіла»: видно її
 * розвороти за останню годину, а не пряму стрілку.
 *
 * Чиста функція `updateHistory` (нову мапу повертає, стару не змінює) — щоб
 * покрити тестами без DOM і без таймерів.
 */

import { distanceKm } from "./infra-types";

export interface FixPoint {
  lat: number;
  lon: number;
  ts: number;
}

export interface TrackInput {
  id: string;
  lat: number;
  lon: number;
}

export interface UpdateOptions {
  /** Максимум точок у треку однієї цілі. */
  maxPoints?: number;
  /** Менший зсув вважаємо тим самим фіксом (шум/та сама позиція), не пишемо. */
  minMoveKm?: number;
  /** Треки старші за це (за останнім фіксом) прибираємо повністю. */
  maxAgeMs?: number;
}

/**
 * Додає поточні позиції цілей до історії й повертає ОНОВЛЕНУ мапу
 * `id → фікси у часовому порядку`. Дрібні зсуви не пишемо (та сама точка),
 * довгі треки підрізаємо, зниклі/застарілі цілі забуваємо.
 */
export function updateHistory(
  prev: Map<string, FixPoint[]>,
  threats: readonly TrackInput[],
  now: number,
  opts: UpdateOptions = {},
): Map<string, FixPoint[]> {
  const maxPoints = opts.maxPoints ?? 40;
  const minMoveKm = opts.minMoveKm ?? 1;
  const maxAgeMs = opts.maxAgeMs ?? 90 * 60 * 1000;

  const next = new Map<string, FixPoint[]>();
  const alive = new Set<string>();

  for (const t of threats) {
    alive.add(t.id);
    const past = prev.get(t.id) ?? [];
    const last = past[past.length - 1];
    const point: FixPoint = { lat: t.lat, lon: t.lon, ts: now };
    // Пишемо новий фікс лише коли ціль РЕАЛЬНО зрушила — інакше трек
    // роздувся б однаковими точками на кожному опитуванні.
    if (!last || distanceKm(last, point) >= minMoveKm) {
      const merged = [...past, point];
      next.set(t.id, merged.length > maxPoints ? merged.slice(merged.length - maxPoints) : merged);
    } else {
      next.set(t.id, past);
    }
  }

  // Цілі, яких уже немає у видачі, тримаємо ще трохи (щоб слід не зникав
  // миттєво), але прибираємо застарілі.
  for (const [id, pts] of prev) {
    if (alive.has(id)) continue;
    const last = pts[pts.length - 1];
    if (last && now - last.ts <= maxAgeMs) next.set(id, pts);
  }

  return next;
}

/** Точки треку як [lat, lon][] для Leaflet-полілінії (лише спостережене). */
export function trackLatLngs(pts: readonly FixPoint[] | undefined): [number, number][] {
  return (pts ?? []).map((p) => [p.lat, p.lon]);
}
