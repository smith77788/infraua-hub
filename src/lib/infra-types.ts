import type { Provenance } from "./provenance";

export type CategoryId =
  | "power_plant"
  | "substation"
  | "oil_gas"
  | "dam"
  | "water"
  | "hospital"
  | "fire_station"
  | "airport"
  | "rail"
  | "seaport"
  | "border"
  | "telecom"
  | "data_center"
  | "government"
  | "grain"
  | "industry";

export type Tier = "energy" | "life" | "mobility" | "comms" | "industry" | "gov";

export interface Facility {
  id: string;
  name: string;
  category: CategoryId;
  lat: number;
  lon: number;
  operator?: string;
  detail?: string;
  source: string;
}

export type EventKind = "fire" | "quake" | "storm" | "flood" | "drought" | "other";

export interface InfraEvent {
  id: string;
  title: string;
  kind: EventKind;
  lat: number;
  lon: number;
  time: string;
  magnitude?: number;
  url?: string;
  source: string;
}

export const UA_BBOX = { south: 44.2, west: 22.0, north: 52.4, east: 40.3 };

export const CATEGORIES: Record<
  CategoryId,
  { label: string; short: string; color: string; tier: Tier }
> = {
  power_plant: { label: "Електростанції", short: "ЕС", color: "#f5a623", tier: "energy" },
  substation: { label: "Підстанції 110кВ+", short: "ПС", color: "#22d3ee", tier: "energy" },
  oil_gas: { label: "Нафта і газ", short: "НГ", color: "#fb7185", tier: "energy" },
  dam: { label: "Греблі / ГТС", short: "ГТ", color: "#2dd4bf", tier: "energy" },
  water: { label: "Водоканали", short: "ВД", color: "#38bdf8", tier: "life" },
  hospital: { label: "Лікарні", short: "ЛК", color: "#f87171", tier: "life" },
  fire_station: { label: "Пожежні частини (ДСНС)", short: "ПЧ", color: "#ef4444", tier: "life" },
  airport: { label: "Аеродроми", short: "АП", color: "#a78bfa", tier: "mobility" },
  rail: { label: "Залізничні вузли", short: "ЗВ", color: "#94a3b8", tier: "mobility" },
  seaport: { label: "Морські порти", short: "МП", color: "#818cf8", tier: "mobility" },
  border: { label: "Пункти пропуску", short: "КП", color: "#c084fc", tier: "mobility" },
  telecom: { label: "Вузли звʼязку", short: "ЗВʼ", color: "#4ade80", tier: "comms" },
  data_center: { label: "Центри обробки даних", short: "ЦОД", color: "#34d399", tier: "comms" },
  government: { label: "Держустанови", short: "ДУ", color: "#e2e8f0", tier: "gov" },
  grain: { label: "Елеватори", short: "ЕЛ", color: "#eab308", tier: "industry" },
  industry: { label: "Промислові вузли", short: "ПР", color: "#9ca3af", tier: "industry" },
};

export const EVENT_KINDS: Record<EventKind, { label: string; color: string }> = {
  fire: { label: "Пожежі", color: "#fb923c" },
  quake: { label: "Сейсміка", color: "#facc15" },
  storm: { label: "Шторми", color: "#60a5fa" },
  flood: { label: "Повені", color: "#22d3ee" },
  drought: { label: "Посухи", color: "#eab308" },
  other: { label: "Інше", color: "#a3a3a3" },
};

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface GraphEdge {
  from: string;
  to: string;
  km: number;
  kind: "supply" | "feed";
  /**
   * Звідки взялося це ребро. Обовʼязкове поле: ребро без походження нічим не
   * відрізняється від вигаданого, а на цьому графі будуються висновки про те,
   * що вимкнеться при аварії.
   */
  provenance: Provenance;
}

/**
 * Виводить граф залежностей: станції → підстанції → споживачі, за найближчим
 * сусідом.
 *
 * Це **не топологія мережі**, а припущення. Реальна лінія може йти повз
 * найближчу підстанцію до дальшої, живлення буває резервованим з двох боків,
 * а межі балансових зон нам невідомі. Метод дає правдоподібний кістяк там, де
 * реальних даних немає, — і кожне ребро позначене як виведене, щоб цей кістяк
 * не сплутали з фактом.
 *
 * Спостережені ребра з реальних ЛЕП будує `buildObservedGraph`
 * (src/lib/power-grid.ts); там, де вони є, їм слід віддавати перевагу.
 */
export function buildGraph(facilities: Facility[]): GraphEdge[] {
  const plants = facilities.filter((f) => f.category === "power_plant");
  const subs = facilities.filter((f) => f.category === "substation");
  const consumers = facilities.filter((f) => !["power_plant", "substation"].includes(f.category));
  const edges: GraphEdge[] = [];

  const nearest = (f: Facility, pool: Facility[]) => {
    let best: Facility | null = null;
    let bestKm = Infinity;
    for (const p of pool) {
      const km = distanceKm(f, p);
      if (km < bestKm) {
        bestKm = km;
        best = p;
      }
    }
    return best ? { node: best, km: bestKm } : null;
  };

  const SUPPLY_RADIUS_KM = 250;
  const FEED_RADIUS_KM = 120;

  for (const s of subs) {
    const n = nearest(s, plants);
    if (n && n.km < SUPPLY_RADIUS_KM) {
      edges.push({
        from: n.node.id,
        to: s.id,
        km: n.km,
        kind: "supply",
        provenance: {
          kind: "inferred",
          method: "найближча електростанція",
          params: { radiusKm: SUPPLY_RADIUS_KM, distanceKm: Math.round(n.km) },
          // Слабке припущення: на такій відстані між станцією і підстанцією
          // зазвичай стоїть ще кілька вузлів, яких ми не бачимо.
          confidence: 0.35,
          caveat:
            "Живлення приписано найближчій станції в радіусі. Реальна лінія може йти від іншої, а підстанція часто живиться з двох боків.",
        },
      });
    }
  }
  for (const c of consumers) {
    const n = nearest(c, subs.length ? subs : plants);
    if (n && n.km < FEED_RADIUS_KM) {
      edges.push({
        from: n.node.id,
        to: c.id,
        km: n.km,
        kind: "feed",
        provenance: {
          kind: "inferred",
          method: "найближча підстанція",
          params: { radiusKm: FEED_RADIUS_KM, distanceKm: Math.round(n.km) },
          // Ще слабше: споживач майже завжди живиться через розподільчу
          // мережу нижчої напруги, якої в наборі немає взагалі.
          confidence: 0.25,
          caveat:
            "Споживача приписано найближчій підстанції. Розподільчої мережі нижчої напруги в даних немає, тож справжній шлях живлення майже напевно інший.",
        },
      });
    }
  }
  return edges;
}

/** Facilities within `radiusKm` of any active event. */
export function facilitiesAtRisk(
  facilities: Facility[],
  events: InfraEvent[],
  radiusKm = 25,
): Map<string, InfraEvent> {
  const map = new Map<string, InfraEvent>();
  for (const f of facilities) {
    for (const e of events) {
      if (distanceKm(f, e) <= radiusKm) {
        map.set(f.id, e);
        break;
      }
    }
  }
  return map;
}

export type SituationLevel = "normal" | "elevated" | "critical";

export interface SituationSummary {
  level: SituationLevel;
  label: string;
  atRisk: number;
  /** At-risk facilities in the life-critical tier (hospitals, water works). */
  lifeAtRisk: number;
  alarms: number;
  byKind: Record<InfraEvent["kind"], number>;
  eventCount: number;
}

const LEVEL_LABEL: Record<SituationLevel, string> = {
  normal: "Штатний режим",
  elevated: "Підвищена готовність",
  critical: "Критичний стан",
};

/**
 * Aggregates an operational picture from facilities, their risk map and events.
 * The life-critical tier (лікарні, водоканали) escalates the alert level, and a
 * large absolute number of endangered objects does the same.
 */
export function summarize(
  facilities: Facility[],
  riskMap: Map<string, InfraEvent>,
  events: InfraEvent[],
  alarms = 0,
): SituationSummary {
  const byId = new Map(facilities.map((f) => [f.id, f]));
  let lifeAtRisk = 0;
  for (const id of riskMap.keys()) {
    const f = byId.get(id);
    if (f && CATEGORIES[f.category].tier === "life") lifeAtRisk++;
  }

  const byKind: Record<EventKind, number> = {
    fire: 0,
    quake: 0,
    storm: 0,
    flood: 0,
    drought: 0,
    other: 0,
  };
  for (const e of events) byKind[e.kind]++;

  const atRisk = riskMap.size;
  const level: SituationLevel =
    alarms > 0 || lifeAtRisk > 0 || atRisk >= 8 ? "critical" : atRisk > 0 ? "elevated" : "normal";

  return {
    level,
    label: LEVEL_LABEL[level],
    atRisk,
    lifeAtRisk,
    alarms,
    byKind,
    eventCount: events.length,
  };
}

/*
 * `downstreamOf` жив тут і рахував наслідки відмови як транзитивне замикання
 * вниз за течією. Прибраний, а не залишений «про всяк випадок»: він давав
 * неправильну відповідь одразу в два боки — перебільшував, бо не бачив
 * резервного живлення, і недооцінював, бо обмежував поширення десятьма
 * проходами (`guard++ < 10`) і на глибшому ланцюжку мовчки зупинявся.
 *
 * Заміна — `simulateOutage` у src/lib/contingency.ts: втрата шляху до
 * генерації, критерій N-1.
 */
