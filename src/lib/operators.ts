import type { FacilityAnalytics } from "./infra-analytics";
import { CATEGORIES, type Facility, type Tier } from "./infra-types";

/**
 * Досьє оператора: усе, що система знає про одну організацію.
 *
 * Оператор в OSM — це справжній тег на обʼєкті (`operator`), тобто реальні
 * дані, а не наша побудова. Досі він був лише рядком у картці обʼєкта: не було
 * способу спитати «що ще належить цій організації і в якому воно стані»,
 * хоча відповідь уже лежала в наборі.
 *
 * Питання не косметичне. Відмова однієї організації — це не один обʼєкт, а вся
 * її частка мережі; концентрація критичних вузлів у одного оператора і є той
 * ризик, якого не видно, поки дивишся на обʼєкти поодинці.
 */

export interface OperatorProfile {
  operator: string;
  total: number;
  /** Скільки обʼєктів у радіусі активної події. */
  atRisk: number;
  /** Скільки в областях з активною тривогою. */
  underAlarm: number;
  /** Найвищий індекс критичності серед обʼєктів оператора. */
  maxScore: number;
  /** Середній індекс — щоб відрізнити «один критичний» від «усі критичні». */
  avgScore: number;
  /** Сектори, у яких оператор присутній, з кількістю обʼєктів. */
  sectors: { tier: Tier; label: string; count: number }[];
  /** Обʼєкти оператора, найкритичніші першими. */
  facilities: { facility: Facility; analytics: FacilityAnalytics | undefined }[];
}

const TIER_LABEL: Record<Tier, string> = {
  energy: "Енергетика",
  life: "Життєзабезпечення",
  mobility: "Мобільність",
  comms: "Звʼязок",
  gov: "Держуправління",
  industry: "Промисловість",
};

/**
 * Профіль одного оператора. `null`, якщо в наборі немає жодного його обʼєкта —
 * порожнє досьє гірше за його відсутність, бо виглядає як відповідь.
 */
export function operatorProfile(
  operator: string,
  facilities: Facility[],
  analytics: Map<string, FacilityAnalytics>,
): OperatorProfile | null {
  const own = facilities.filter((f) => f.operator === operator);
  if (own.length === 0) return null;

  let atRisk = 0;
  let underAlarm = 0;
  let maxScore = 0;
  let scoreSum = 0;
  const byTier = new Map<Tier, number>();

  const rows = own.map((facility) => {
    const a = analytics.get(facility.id);
    if (a?.atRisk) atRisk++;
    if (a?.underAlarm) underAlarm++;
    const score = a?.score ?? 0;
    if (score > maxScore) maxScore = score;
    scoreSum += score;
    const tier = CATEGORIES[facility.category].tier;
    byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
    return { facility, analytics: a };
  });

  rows.sort((x, y) => (y.analytics?.score ?? 0) - (x.analytics?.score ?? 0));

  return {
    operator,
    total: own.length,
    atRisk,
    underAlarm,
    maxScore,
    avgScore: Math.round(scoreSum / own.length),
    sectors: [...byTier.entries()]
      .map(([tier, count]) => ({ tier, label: TIER_LABEL[tier], count }))
      .sort((a, b) => b.count - a.count),
    facilities: rows,
  };
}

/**
 * Оператори, впорядковані за тим, наскільки на них зав'язана мережа.
 *
 * Сортування за найвищим індексом, а не за кількістю обʼєктів: організація з
 * трьома підстанціями 750 кВ важливіша за ту, у якої двісті трансформаторних
 * будок, і рахунок обʼєктів цього не показує.
 */
export function rankOperators(
  facilities: Facility[],
  analytics: Map<string, FacilityAnalytics>,
  limit = 12,
): OperatorProfile[] {
  const names = new Set<string>();
  for (const f of facilities) {
    const op = f.operator?.trim();
    if (op) names.add(op);
  }

  const profiles: OperatorProfile[] = [];
  for (const name of names) {
    const p = operatorProfile(name, facilities, analytics);
    if (p) profiles.push(p);
  }

  return profiles
    .sort(
      (a, b) =>
        b.maxScore - a.maxScore ||
        b.atRisk + b.underAlarm - (a.atRisk + a.underAlarm) ||
        b.total - a.total ||
        a.operator.localeCompare(b.operator, "uk"),
    )
    .slice(0, limit);
}
