import { type AlertRegion } from "./alerts";
import {
  assessCriticality,
  type CriticalityBand,
  type CriticalitySignal,
} from "./infra-criticality";
import {
  CATEGORIES,
  distanceKm,
  facilitiesAtRisk,
  type Facility,
  type GraphEdge,
  type InfraEvent,
  type Tier,
} from "./infra-types";

export const TIER_LABEL: Record<Tier, string> = {
  energy: "Енергетика",
  life: "Життєзабезпечення",
  mobility: "Мобільність",
  comms: "Звʼязок",
  gov: "Держуправління",
  industry: "Промисловість",
};

export interface FacilityAnalytics {
  id: string;
  dependents: number;
  atRisk: boolean;
  underAlarm: boolean;
  regionCode: string | null;
  /** Індекс критичності 0..100 — сума внесків `signals`, обмежена сотнею. */
  score: number;
  band: CriticalityBand;
  /**
   * З чого складається оцінка. Порожній масив означає нуль — інших причин
   * для нуля тут немає, і жоден бал не приходить поза цим списком.
   */
  signals: CriticalitySignal[];
}

export interface SectorStat {
  tier: Tier;
  label: string;
  total: number;
  atRisk: number;
  underAlarm: number;
  /** 0..100 — частка обʼєктів без загроз. */
  readiness: number;
}

export interface NetworkAnalysis {
  perFacility: Map<string, FacilityAnalytics>;
  ranked: { facility: Facility; a: FacilityAnalytics }[];
  sectors: SectorStat[];
  maxDependents: number;
}

/** Кількість низхідних (downstream) вузлів для кожного обʼєкта за графом живлення. */
function dependentsMap(edges: GraphEdge[]): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.from);
    if (list) list.push(e.to);
    else adj.set(e.from, [e.to]);
  }
  const memo = new Map<string, Set<string>>();
  const reach = (id: string): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const set = new Set<string>();
    memo.set(id, set); // guard проти циклів
    for (const n of adj.get(id) ?? []) {
      if (!set.has(n)) {
        set.add(n);
        for (const m of reach(n)) set.add(m);
      }
    }
    return set;
  };
  const out = new Map<string, number>();
  for (const id of adj.keys()) out.set(id, reach(id).size);
  return out;
}

/** Привʼязка обʼєкта до найближчого центру області. */
export function assignRegions(facilities: Facility[], regions: AlertRegion[]): Map<string, string> {
  const map = new Map<string, string>();
  if (!regions.length) return map;
  for (const f of facilities) {
    let best: string | null = null;
    let bestKm = Infinity;
    for (const r of regions) {
      const km = distanceKm(f, r);
      if (km < bestKm) {
        bestKm = km;
        best = r.code;
      }
    }
    if (best) map.set(f.id, best);
  }
  return map;
}

export function analyzeNetwork(
  facilities: Facility[],
  edges: GraphEdge[],
  events: InfraEvent[],
  regions: AlertRegion[],
): NetworkAnalysis {
  const deps = dependentsMap(edges);
  const risk = facilitiesAtRisk(facilities, events);
  const region = assignRegions(facilities, regions);
  const activeCodes = new Set(regions.filter((r) => r.active).map((r) => r.code));

  let maxDependents = 1;
  for (const v of deps.values()) if (v > maxDependents) maxDependents = v;

  // Хто в тривозі й під подією — це вхід для оцінки критичності, тож рахуємо
  // до неї.
  const underAlarmIds = new Set<string>();
  for (const f of facilities) {
    const code = region.get(f.id);
    if (code && activeCodes.has(code)) underAlarmIds.add(f.id);
  }

  /*
   * Оцінка більше не складається тут із безіменних доданків
   * (`TIER_WEIGHT * 38 + depScore + riskScore + alarmScore`). Таке число
   * неможливо оскаржити: аналітик бачив «73» і не міг сказати, звідки воно
   * і з чим саме він не згоден. Тепер кожен бал приходить від названого
   * сигналу з причиною і доказом, а структурні метрики (посередництво,
   * мости) додають те, чого підрахунок споживачів не бачить узагалі.
   */
  const assessed = assessCriticality({
    facilities,
    edges,
    dependents: deps,
    atRisk: new Set(risk.keys()),
    underAlarm: underAlarmIds,
  });

  const perFacility = new Map<string, FacilityAnalytics>();
  for (const f of facilities) {
    const dependents = deps.get(f.id) ?? 0;
    const regionCode = region.get(f.id) ?? null;
    const a = assessed.get(f.id);
    perFacility.set(f.id, {
      id: f.id,
      dependents,
      atRisk: risk.has(f.id),
      underAlarm: underAlarmIds.has(f.id),
      regionCode,
      score: a?.score ?? 0,
      band: a?.band ?? "low",
      signals: a?.signals ?? [],
    });
  }

  const ranked = facilities
    .map((facility) => ({ facility, a: perFacility.get(facility.id)! }))
    .sort((x, y) => y.a.score - x.a.score);

  // Готовність секторів
  const tiers = new Map<Tier, SectorStat>();
  for (const f of facilities) {
    const tier = CATEGORIES[f.category].tier;
    const s =
      tiers.get(tier) ??
      ({
        tier,
        label: TIER_LABEL[tier],
        total: 0,
        atRisk: 0,
        underAlarm: 0,
        readiness: 100,
      } as SectorStat);
    s.total++;
    const a = perFacility.get(f.id)!;
    if (a.atRisk) s.atRisk++;
    if (a.underAlarm) s.underAlarm++;
    tiers.set(tier, s);
  }
  const sectors = [...tiers.values()].map((s) => {
    const affected = Math.max(s.atRisk, s.underAlarm);
    s.readiness = s.total ? Math.round(((s.total - affected) / s.total) * 100) : 100;
    return s;
  });
  sectors.sort((a, b) => a.readiness - b.readiness);

  return { perFacility, ranked, sectors, maxDependents };
}

export interface OperatorStat {
  operator: string;
  total: number;
  atRisk: number;
  underAlarm: number;
  avgScore: number;
}

/** Зведення по операторах (сутностях): скільки обʼєктів, під загрозою, критичність. */
export function operatorRollup(
  facilities: Facility[],
  analysis: NetworkAnalysis,
  limit = 12,
): OperatorStat[] {
  const map = new Map<string, { total: number; atRisk: number; underAlarm: number; sum: number }>();
  for (const f of facilities) {
    const op = f.operator?.trim();
    if (!op) continue;
    const a = analysis.perFacility.get(f.id);
    if (!a) continue;
    const s = map.get(op) ?? { total: 0, atRisk: 0, underAlarm: 0, sum: 0 };
    s.total++;
    s.sum += a.score;
    if (a.atRisk) s.atRisk++;
    if (a.underAlarm) s.underAlarm++;
    map.set(op, s);
  }
  return [...map.entries()]
    .map(([operator, s]) => ({
      operator,
      total: s.total,
      atRisk: s.atRisk,
      underAlarm: s.underAlarm,
      avgScore: Math.round(s.sum / s.total),
    }))
    .sort((a, b) => b.total - a.total || b.avgScore - a.avgScore)
    .slice(0, limit);
}

export interface TimelineBucket {
  date: string;
  label: string;
  fire: number;
  quake: number;
  storm: number;
  flood: number;
  drought: number;
  other: number;
  total: number;
}

/** Гістограма подій за днями за останні `days` днів. */
export function eventTimeline(events: InfraEvent[], days = 30): TimelineBucket[] {
  const buckets = new Map<string, TimelineBucket>();
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 864e5);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, {
      date: key,
      label: d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" }),
      fire: 0,
      quake: 0,
      storm: 0,
      flood: 0,
      drought: 0,
      other: 0,
      total: 0,
    });
  }
  for (const e of events) {
    const key = e.time.slice(0, 10);
    const b = buckets.get(key);
    if (!b) continue;
    b[e.kind]++;
    b.total++;
  }
  return [...buckets.values()];
}
