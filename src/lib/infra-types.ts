export type CategoryId =
  | "power_plant"
  | "substation"
  | "water"
  | "hospital"
  | "airport"
  | "rail"
  | "telecom";

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

export interface InfraEvent {
  id: string;
  title: string;
  kind: "fire" | "quake" | "storm" | "other";
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
  { label: string; short: string; color: string; tier: "energy" | "life" | "mobility" | "comms" }
> = {
  power_plant: { label: "Електростанції", short: "ЕС", color: "#f5a623", tier: "energy" },
  substation: { label: "Підстанції 110кВ+", short: "ПС", color: "#22d3ee", tier: "energy" },
  water: { label: "Водоканали", short: "ВД", color: "#38bdf8", tier: "life" },
  hospital: { label: "Лікарні", short: "ЛК", color: "#f87171", tier: "life" },
  airport: { label: "Аеродроми", short: "АП", color: "#a78bfa", tier: "mobility" },
  rail: { label: "Залізничні вузли", short: "ЗВ", color: "#94a3b8", tier: "mobility" },
  telecom: { label: "Вузли звʼязку", short: "ЗВʼ", color: "#4ade80", tier: "comms" },
};

export const EVENT_KINDS: Record<InfraEvent["kind"], { label: string; color: string }> = {
  fire: { label: "Пожежі", color: "#fb923c" },
  quake: { label: "Сейсміка", color: "#facc15" },
  storm: { label: "Шторми", color: "#60a5fa" },
  other: { label: "Інше", color: "#a3a3a3" },
};

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface GraphEdge {
  from: string;
  to: string;
  km: number;
  kind: "supply" | "feed";
}

/** Derives a dependency graph: plants -> substations -> consumers (nearest-neighbour). */
export function buildGraph(facilities: Facility[]): GraphEdge[] {
  const plants = facilities.filter((f) => f.category === "power_plant");
  const subs = facilities.filter((f) => f.category === "substation");
  const consumers = facilities.filter(
    (f) => !["power_plant", "substation"].includes(f.category),
  );
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

  for (const s of subs) {
    const n = nearest(s, plants);
    if (n && n.km < 250) edges.push({ from: n.node.id, to: s.id, km: n.km, kind: "supply" });
  }
  for (const c of consumers) {
    const n = nearest(c, subs.length ? subs : plants);
    if (n && n.km < 120) edges.push({ from: n.node.id, to: c.id, km: n.km, kind: "feed" });
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

/** Cascade: everything downstream of the given nodes. */
export function downstreamOf(ids: Set<string>, edges: GraphEdge[]): Set<string> {
  const out = new Set(ids);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10) {
    changed = false;
    for (const e of edges) {
      if (out.has(e.from) && !out.has(e.to)) {
        out.add(e.to);
        changed = true;
      }
    }
  }
  return out;
}
