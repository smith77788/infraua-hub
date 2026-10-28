/**
 * Свіжість позначки цілі — у хвилинах І в кілометрах.
 *
 * Пороги `airObserved` (12 і 25 хв) заміряні на живому фіді, де переважали
 * поршневі шахеди. Для шахеда 12 хвилин — це ≈ 37 км можливого зсуву. Але
 * реактивний за ті самі 12 хвилин пролітає ≈ 110 км, і його позначка
 * семихвилинної давнини виглядала так само впевнено, як щойно оновлена.
 *
 * Заміряно 28.10, 18:13 UTC, біля Житомира: реактивний «Коростишів» мав
 * 417 с, тобто до ≈ 64 км зсуву, і малювався на повну яскравість поруч зі
 * свіжим звітом. Людина бачила кілька однаково певних цілей там, де свіжою була
 * одна.
 *
 * Правило: беремо гірше з двох — вік у хвилинах (як і раніше) і можливий зсув у
 * кілометрах. Межі зсуву ВИВЕДЕНО з тих самих порогів для шахеда (12 і 25 хв ×
 * 185 км/год), тож для шахеда нічого не змінюється, а швидкі апарати старіють
 * пропорційно своїй швидкості. Повільніші (FPV) лишаються на часових порогах —
 * гірше з двох не робить їх «свіжішими».
 */

import type { ThreatType } from "./air";
import { ageOf, FRESHNESS_THRESHOLDS, type Freshness } from "./freshness";
import { SPEED_KMH } from "./threat-eta";

const BASE_KMH = SPEED_KMH.shahed;
/** Зсув, з якого позначка «старіє» / «застаріла», км — з порогів шахеда. */
export const AGING_KM = (FRESHNESS_THRESHOLDS.airObserved.aging * BASE_KMH) / 60;
export const STALE_KM = (FRESHNESS_THRESHOLDS.airObserved.stale * BASE_KMH) / 60;

const RANK: Record<Freshness, number> = { fresh: 0, aging: 1, stale: 2, unknown: 2 };

export function markerFreshness(
  iso: string | undefined,
  type: ThreatType | undefined,
  now: number = Date.now(),
): Freshness {
  const { aging, stale } = FRESHNESS_THRESHOLDS.airObserved;
  const byTime = ageOf(iso, aging, stale, now);
  if (byTime.freshness === "unknown" || byTime.minutes === null) return byTime.freshness;
  const km = (byTime.minutes / 60) * (SPEED_KMH[type ?? "unknown"] ?? SPEED_KMH.unknown);
  const byDistance: Freshness = km >= STALE_KM ? "stale" : km >= AGING_KM ? "aging" : "fresh";
  return RANK[byDistance] > RANK[byTime.freshness] ? byDistance : byTime.freshness;
}
