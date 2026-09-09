import type { AlertRegion } from "./alerts";
import type { FacilityAnalytics } from "./infra-analytics";
import { CATEGORIES, type Facility } from "./infra-types";

/**
 * Зріз по областях.
 *
 * Привʼязка обʼєктів до областей уже була (`assignRegions`), але відповіді на
 * питання «де зараз найгірше» з неї ніхто не діставав. Оператор бачив або всю
 * країну одразу, або один обʼєкт — між ними не було рівня, на якому ухвалюють
 * більшість рішень.
 *
 * Привʼязка робиться за найближчим обласним центром — це припущення, а не
 * адміністративна межа. Обʼєкт біля межі двох областей може потрапити не туди,
 * і в цьому зрізі це треба памʼятати: він добрий для «де гірше», і не годиться
 * як юридична належність.
 */

export interface RegionRollup {
  code: string;
  name: string;
  /** Активна повітряна тривога в області. */
  active: boolean;
  since?: string | undefined;
  total: number;
  atRisk: number;
  /** Обʼєкти життєзабезпечення — лікарні, водоканали. */
  life: number;
  lifeAtRisk: number;
  /** Найвищий індекс критичності в області. */
  maxScore: number;
}

export interface RegionInput {
  facilities: Facility[];
  analytics: Map<string, FacilityAnalytics>;
  /** Обʼєкт → код області, з `assignRegions`. */
  regionOf: Map<string, string>;
  regions: AlertRegion[];
}

/**
 * Зводить області й упорядковує за серйозністю.
 *
 * Порядок навмисний: спершу тривога, потім життєзабезпечення під загрозою,
 * потім будь-яка загроза. Область із діючою тривогою над лікарнею — інша
 * ситуація, ніж область із двадцятьма спокійними обʼєктами, і сортування за
 * кількістю ховало б саме це.
 */
export function rollupRegions(input: RegionInput): RegionRollup[] {
  const { facilities, analytics, regionOf, regions } = input;
  const byCode = new Map<string, RegionRollup>();

  for (const r of regions) {
    byCode.set(r.code, {
      code: r.code,
      name: r.name,
      active: r.active,
      since: r.since,
      total: 0,
      atRisk: 0,
      life: 0,
      lifeAtRisk: 0,
      maxScore: 0,
    });
  }

  for (const f of facilities) {
    const code = regionOf.get(f.id);
    if (!code) continue;
    const row = byCode.get(code);
    if (!row) continue;

    row.total++;
    const a = analytics.get(f.id);
    const isLife = CATEGORIES[f.category].tier === "life";
    if (isLife) row.life++;
    if (a?.atRisk) {
      row.atRisk++;
      if (isLife) row.lifeAtRisk++;
    }
    if ((a?.score ?? 0) > row.maxScore) row.maxScore = a?.score ?? 0;
  }

  return [...byCode.values()]
    .filter((r) => r.total > 0 || r.active)
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        b.lifeAtRisk - a.lifeAtRisk ||
        b.atRisk - a.atRisk ||
        b.maxScore - a.maxScore ||
        a.name.localeCompare(b.name, "uk"),
    );
}

/** Готовність області: частка обʼєктів без загрози, 0..100. */
export function regionReadiness(row: RegionRollup): number {
  if (row.total === 0) return 100;
  return Math.round(((row.total - row.atRisk) / row.total) * 100);
}
