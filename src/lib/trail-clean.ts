import { distanceKm } from "./infra-types";
import { bearingDeg } from "./threat-eta";

/**
 * Трек цілі, придатний для показу: без тремтіння й неможливих стрибків.
 *
 * ## Навіщо
 *
 * Трек приходить від джерела таким, яким його склали позначки по населених
 * пунктах. Заміряно на проді 29.10 ~18:40 UTC:
 *
 * - Нікополь (FPV): 12 точок, що чергуються між двома місцями за 2 км, —
 *   на карті це зигзаг, а не рух;
 * - Кам'янське (реактивний): стрибок на 33 км за нуль хвилин;
 * - Нова Слобода (реактивний): 51.07 → 50.98 → 51.38 — на південь і різко на
 *   північ, 45 км за 3 хв.
 *
 * Малювати такий трек як «де ціль була» — показувати шум як спостереження. А
 * курс, узятий з нього, дивиться не туди.
 *
 * ## Правила
 *
 * 1. Точка ближче `MIN_STEP_KM` до попередньої прийнятої — та сама позиція.
 * 2. Точка, що повертає назад до передостанньої (A → B → A), — тремтіння:
 *    відкидаємо B.
 * 3. Крок, швидший за `maxKmh` (з запасом на неточність часу), — стрибок
 *    позначки, а не політ: точку відкидаємо.
 */

export interface TrailPoint {
  lat: number;
  lon: number;
  t: string;
}

export const MIN_STEP_KM = 1;
/** Найкоротший проміжок, від якого рахуємо швидкість: секунди між позначками неточні. */
const MIN_DT_H = 1 / 60;

export function cleanTrail(trail: readonly TrailPoint[], maxKmh: number): TrailPoint[] {
  const out: TrailPoint[] = [];
  for (const p of trail) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const last = out[out.length - 1];
    if (!last) {
      out.push(p);
      continue;
    }
    if (distanceKm(last, p) < MIN_STEP_KM) continue;
    const prev = out[out.length - 2];
    if (prev && distanceKm(prev, p) < MIN_STEP_KM) {
      // A → B → A: B був тремтінням.
      out.pop();
      continue;
    }
    const dtH = Math.max(MIN_DT_H, (Date.parse(p.t) - Date.parse(last.t)) / 3_600_000);
    if (Number.isFinite(dtH) && distanceKm(last, p) / dtH > maxKmh) continue;
    out.push(p);
  }
  return out;
}

/** Напрямок за останнім кроком очищеного треку, або `null`, якщо кроку нема. */
export function trailHeading(trail: readonly TrailPoint[]): number | null {
  if (trail.length < 2) return null;
  return bearingDeg(trail[trail.length - 2]!, trail[trail.length - 1]!);
}
