import { createServerFn } from "@tanstack/react-start";

import { mercToLatLon, type AlertZone, type Threat } from "./air";
import { OBLASTS, type AlertRegion } from "./alerts";
import { SEED_FACILITIES } from "./infra-seed";
import {
  distanceKm,
  UA_BBOX,
  type CategoryId,
  type Facility,
  type InfraEvent,
} from "./infra-types";

/** Додає опорні обʼєкти, яких немає серед live-даних (дедуп за категорією + близькістю). */
function mergeWithSeed(live: Facility[]): Facility[] {
  const out = [...live];
  for (const s of SEED_FACILITIES) {
    const dup = live.some((f) => f.category === s.category && distanceKm(f, s) < 5);
    if (!dup) out.push(s);
  }
  return out;
}

// Кілька публічних дзеркал Overpass. Пробуємо послідовно, поки якесь не відповість —
// це знижує вплив rate-limit/timeout окремого сервера.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const QUERIES: Record<CategoryId, string> = {
  power_plant: `nwr["power"="plant"]({{bbox}});`,
  substation: `nwr["power"="substation"]["voltage"~"^(1[1-9][0-9]{4}|[2-9][0-9]{5})"]({{bbox}});`,
  oil_gas: `nwr["man_made"="works"]["product"~"oil|fuel|petroleum|diesel|gas|petrol",i]({{bbox}});nwr["landuse"="depot"]["substance"~"oil|fuel|gas",i]({{bbox}});`,
  dam: `nwr["waterway"="dam"]["name"]({{bbox}});`,
  water: `nwr["man_made"="water_works"]({{bbox}});`,
  hospital: `nwr["amenity"="hospital"]({{bbox}});`,
  fire_station: `nwr["amenity"="fire_station"]({{bbox}});`,
  airport: `nwr["aeroway"="aerodrome"]["iata"]({{bbox}});`,
  rail: `nwr["railway"="station"]["train"!="no"]({{bbox}});`,
  seaport: `nwr["harbour"="yes"]({{bbox}});nwr["industrial"="port"]({{bbox}});`,
  border: `nwr["barrier"="border_control"]({{bbox}});`,
  telecom: `nwr["man_made"="communications_tower"]({{bbox}});`,
  data_center: `nwr["telecom"="data_center"]({{bbox}});nwr["office"="telecommunication"]({{bbox}});`,
  government: `nwr["office"="government"]["name"]({{bbox}});`,
  grain: `nwr["man_made"="silo"]["name"]({{bbox}});nwr["crop"="grain"]({{bbox}});`,
  industry: `nwr["landuse"="industrial"]["name"]["operator"]({{bbox}});`,
};

const LIMITS: Record<CategoryId, number> = {
  power_plant: 250,
  substation: 400,
  oil_gas: 120,
  dam: 120,
  water: 200,
  hospital: 350,
  fire_station: 300,
  airport: 60,
  rail: 300,
  seaport: 60,
  border: 120,
  telecom: 250,
  data_center: 80,
  government: 200,
  grain: 200,
  industry: 200,
};

interface CacheEntry<T> {
  at: number;
  value: T;
}
const cache = new Map<string, CacheEntry<unknown>>();

function readCache<T>(key: string, ttlMs: number): T | null {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  return null;
}

function writeCache<T>(key: string, value: T) {
  cache.set(key, { at: Date.now(), value });
}

const BBOX = `${UA_BBOX.south},${UA_BBOX.west},${UA_BBOX.north},${UA_BBOX.east}`;

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function overpass(body: string, signal: AbortSignal): Promise<OverpassElement[]> {
  let lastError: unknown = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(body)}`,
        signal,
      });
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      const json = (await res.json()) as { elements?: OverpassElement[] };
      return json.elements ?? [];
    } catch (err) {
      lastError = err;
    }
  }
  console.error("Overpass unavailable", lastError);
  return [];
}

function toFacility(el: OverpassElement, category: CategoryId): Facility | null {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const tags = el.tags ?? {};
  const name = tags["name:uk"] ?? tags["name"] ?? tags["operator"] ?? "Обʼєкт без назви";
  const detailParts = [
    tags["plant:source"] && `джерело: ${tags["plant:source"]}`,
    tags["voltage"] && `${Math.round(Number(tags["voltage"].split(";")[0]) / 1000)} кВ`,
    tags["iata"] && `IATA ${tags["iata"]}`,
    tags["emergency"] === "yes" ? "приймальне відділення" : null,
  ].filter(Boolean) as string[];

  return {
    id: `${el.type}/${el.id}`,
    name,
    category,
    lat,
    lon,
    ...(tags["operator"] ? { operator: tags["operator"] } : {}),
    ...(detailParts.length ? { detail: detailParts.join(" · ") } : {}),
    source: `https://www.openstreetmap.org/${el.type}/${el.id}`,
  };
}

interface FacilitiesPayload {
  facilities: Facility[];
  fetchedAt: string;
  /** true, коли live-джерело недоступне і показано опорний (baseline) перелік. */
  degraded: boolean;
  source: "live" | "baseline";
}

export const getFacilities = createServerFn({ method: "GET" }).handler(async () => {
  const cached = readCache<FacilitiesPayload>("facilities", 30 * 60 * 1000);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const entries = Object.entries(QUERIES) as [CategoryId, string][];
    const results = await Promise.all(
      entries.map(async ([category, q]) => {
        const query = `[out:json][timeout:40];(${q.replaceAll("{{bbox}}", BBOX)});out center ${LIMITS[category]};`;
        const elements = await overpass(query, controller.signal);
        return elements
          .map((el) => toFacility(el, category))
          .filter((f): f is Facility => f !== null);
      }),
    );
    const facilities = results.flat();

    // Overpass періодично недоступний (rate-limit / timeout). Щоб консоль не була
    // порожньою, повертаємо опорний перелік ключових обʼєктів як baseline.
    if (facilities.length === 0) {
      return {
        facilities: SEED_FACILITIES,
        fetchedAt: new Date().toISOString(),
        degraded: true,
        source: "baseline" as const,
      } satisfies FacilitiesPayload;
    }

    const payload: FacilitiesPayload = {
      facilities: mergeWithSeed(facilities),
      fetchedAt: new Date().toISOString(),
      degraded: false,
      source: "live",
    };
    writeCache("facilities", payload);
    return payload;
  } catch {
    return {
      facilities: SEED_FACILITIES,
      fetchedAt: new Date().toISOString(),
      degraded: true,
      source: "baseline" as const,
    } satisfies FacilitiesPayload;
  } finally {
    clearTimeout(timer);
  }
});

interface EonetEvent {
  id: string;
  title: string;
  categories?: { id: string; title: string }[];
  sources?: { url: string }[];
  geometry?: { date: string; type: string; coordinates: number[] }[];
}

function eonetKind(catId: string | undefined): InfraEvent["kind"] {
  if (catId === "wildfires") return "fire";
  if (catId === "severeStorms") return "storm";
  return "other";
}

function gdacsKind(type: string | undefined): InfraEvent["kind"] {
  switch (type) {
    case "EQ":
      return "quake";
    case "TC":
      return "storm";
    case "FL":
      return "flood";
    case "WF":
      return "fire";
    case "DR":
      return "drought";
    default:
      return "other";
  }
}

interface GdacsFeature {
  geometry?: { coordinates?: number[] };
  properties?: {
    eventtype?: string;
    eventid?: number | string;
    name?: string;
    htmldescription?: string;
    alertlevel?: string;
    fromdate?: string;
    todate?: string;
    url?: { report?: string } | string;
  };
}

export const getEvents = createServerFn({ method: "GET" }).handler(async () => {
  const cached = readCache<{ events: InfraEvent[]; fetchedAt: string; degraded: boolean }>(
    "events",
    5 * 60 * 1000,
  );
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const events: InfraEvent[] = [];
  let failures = 0;

  const eonetUrl = `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30&bbox=${UA_BBOX.west},${UA_BBOX.north},${UA_BBOX.east},${UA_BBOX.south}`;
  const start = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const usgsUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&minlatitude=${UA_BBOX.south}&maxlatitude=${UA_BBOX.north}&minlongitude=${UA_BBOX.west}&maxlongitude=${UA_BBOX.east}&orderby=time&limit=60`;
  const gdacsUrl = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP";

  try {
    const [eonetRes, usgsRes, gdacsRes] = await Promise.allSettled([
      fetch(eonetUrl, { signal: controller.signal }).then((r) => r.json()),
      fetch(usgsUrl, { signal: controller.signal }).then((r) => r.json()),
      fetch(gdacsUrl, { signal: controller.signal }).then((r) => r.json()),
    ]);

    if (eonetRes.status === "fulfilled") {
      const data = eonetRes.value as { events?: EonetEvent[] };
      for (const ev of data.events ?? []) {
        const geo = ev.geometry?.filter((g) => g.type === "Point").at(-1);
        if (!geo) continue;
        const [lon, lat] = geo.coordinates as [number, number];
        if (lat < UA_BBOX.south || lat > UA_BBOX.north || lon < UA_BBOX.west || lon > UA_BBOX.east)
          continue;
        events.push({
          id: `eonet-${ev.id}`,
          title: ev.title,
          kind: eonetKind(ev.categories?.[0]?.id),
          lat,
          lon,
          time: geo.date,
          ...(ev.sources?.[0]?.url ? { url: ev.sources[0].url } : {}),
          source: "NASA EONET",
        });
      }
    } else failures++;

    if (usgsRes.status === "fulfilled") {
      const data = usgsRes.value as {
        features?: {
          id: string;
          properties: { title: string; time: number; mag: number | null; url: string };
          geometry: { coordinates: number[] };
        }[];
      };
      for (const f of data.features ?? []) {
        const [lon, lat] = f.geometry.coordinates as [number, number];
        events.push({
          id: `usgs-${f.id}`,
          title: f.properties.title,
          kind: "quake",
          lat,
          lon,
          time: new Date(f.properties.time).toISOString(),
          ...(f.properties.mag != null ? { magnitude: f.properties.mag } : {}),
          url: f.properties.url,
          source: "USGS",
        });
      }
    } else failures++;

    if (gdacsRes.status === "fulfilled") {
      const data = gdacsRes.value as { features?: GdacsFeature[] };
      for (const f of data.features ?? []) {
        const coords = f.geometry?.coordinates;
        const p = f.properties;
        if (!coords || !p) continue;
        const [lon, lat] = coords as [number, number];
        if (lat < UA_BBOX.south || lat > UA_BBOX.north || lon < UA_BBOX.west || lon > UA_BBOX.east)
          continue;
        const when = p.todate ?? p.fromdate;
        const t = when ? new Date(when) : new Date();
        const report = typeof p.url === "object" ? p.url?.report : p.url;
        events.push({
          id: `gdacs-${p.eventtype}-${p.eventid}`,
          title: p.htmldescription ?? p.name ?? "Подія GDACS",
          kind: gdacsKind(p.eventtype),
          lat,
          lon,
          time: (isNaN(t.getTime()) ? new Date() : t).toISOString(),
          ...(report ? { url: report } : {}),
          source: "GDACS",
        });
      }
    } else failures++;
  } finally {
    clearTimeout(timer);
  }

  events.sort((a, b) => b.time.localeCompare(a.time));
  const payload = { events, fetchedAt: new Date().toISOString(), degraded: failures > 0 };
  if (failures === 0) writeCache("events", payload);
  return payload;
});

// Повітряні тривоги по областях — безключове публічне джерело.
const ALERT_ENDPOINT = "https://ubilling.net.ua/aerialalerts/?json";

interface AlertsPayload {
  regions: AlertRegion[];
  activeCount: number;
  fetchedAt: string;
  degraded: boolean;
}

function idleRegions(): AlertRegion[] {
  const seen = new Set<string>();
  const out: AlertRegion[] = [];
  for (const o of Object.values(OBLASTS)) {
    if (seen.has(o.code)) continue;
    seen.add(o.code);
    out.push({ ...o, active: false });
  }
  return out;
}

export const getAlerts = createServerFn({ method: "GET" }).handler(async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(ALERT_ENDPOINT, { signal: controller.signal });
    if (!res.ok) throw new Error(`alerts ${res.status}`);
    const data = (await res.json()) as {
      states?: Record<string, { alertnow?: boolean; changed?: string }>;
    };
    const states = data.states ?? {};

    const byCode = new Map<string, AlertRegion>();
    for (const [apiName, st] of Object.entries(states)) {
      const center = OBLASTS[apiName];
      if (!center) continue;
      const active = st.alertnow === true;
      const prev = byCode.get(center.code);
      // Той самий регіон може прийти під кількома назвами — беремо «активний».
      if (!prev || (active && !prev.active)) {
        byCode.set(center.code, {
          ...center,
          active,
          ...(st.changed && !st.changed.startsWith("1970") ? { since: st.changed } : {}),
        });
      }
    }

    const regions = byCode.size ? [...byCode.values()] : idleRegions();
    const activeCount = regions.filter((r) => r.active).length;
    return {
      regions,
      activeCount,
      fetchedAt: new Date().toISOString(),
      degraded: byCode.size === 0,
    } satisfies AlertsPayload;
  } catch {
    return {
      regions: idleRegions(),
      activeCount: 0,
      fetchedAt: new Date().toISOString(),
      degraded: true,
    } satisfies AlertsPayload;
  } finally {
    clearTimeout(timer);
  }
});

// Повітряні цілі та зони тривог — відкрите джерело detoyshahed.in.ua (OSINT).
const THREATS_ENDPOINT = "https://detoyshahed.in.ua/api/incidents/active";
const ZONES_ENDPOINT = "https://detoyshahed.in.ua/api/alerts/active";

interface ThreatsPayload {
  threats: Threat[];
  fetchedAt: string;
  degraded: boolean;
}

export const getThreats = createServerFn({ method: "GET" }).handler(async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(THREATS_ENDPOINT, { signal: controller.signal });
    if (!res.ok) throw new Error(`threats ${res.status}`);
    const data = (await res.json()) as {
      incidents?: {
        id: string;
        location_name?: string;
        display_name?: string;
        coordinates?: { lat: number; lng: number };
        channel_name?: string;
        count?: number;
        created_at?: string;
        expires_at?: string;
      }[];
    };
    const threats: Threat[] = [];
    for (const it of data.incidents ?? []) {
      const c = it.coordinates;
      if (!c) continue;
      const [lat, lon] = mercToLatLon(c.lng, c.lat);
      if (lat < UA_BBOX.south || lat > UA_BBOX.north || lon < UA_BBOX.west || lon > UA_BBOX.east)
        continue;
      threats.push({
        id: it.id,
        name: it.location_name ?? it.display_name ?? "Ціль",
        lat,
        lon,
        source: it.channel_name ?? "OSINT",
        count: it.count ?? 1,
        since: it.created_at ?? "",
        expires: it.expires_at ?? "",
      });
    }
    return {
      threats,
      fetchedAt: new Date().toISOString(),
      degraded: false,
    } satisfies ThreatsPayload;
  } catch {
    return {
      threats: [],
      fetchedAt: new Date().toISOString(),
      degraded: true,
    } satisfies ThreatsPayload;
  } finally {
    clearTimeout(timer);
  }
});

interface ZonesPayload {
  zones: AlertZone[];
  fetchedAt: string;
  degraded: boolean;
}

/** Спрощує кільце: конвертує [lon,lat]→[lat,lon] і проріджує до ~120 точок. */
function ringToLatLon(ring: number[][]): [number, number][] {
  const step = Math.max(1, Math.ceil(ring.length / 120));
  const out: [number, number][] = [];
  for (let i = 0; i < ring.length; i += step) {
    const p = ring[i];
    if (Array.isArray(p) && p.length >= 2) out.push([p[1], p[0]]);
  }
  return out;
}

export const getAlertZones = createServerFn({ method: "GET" }).handler(async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(ZONES_ENDPOINT, { signal: controller.signal });
    if (!res.ok) throw new Error(`zones ${res.status}`);
    const data = (await res.json()) as {
      alerts?: {
        region_name?: string;
        region_type?: string;
        geometry?: { type?: string; coordinates?: unknown };
      }[];
    };
    const zones: AlertZone[] = [];
    for (const a of data.alerts ?? []) {
      const g = a.geometry;
      if (!g?.coordinates) continue;
      const polygons: [number, number][][] = [];
      if (g.type === "Polygon") {
        const poly = g.coordinates as number[][][];
        if (poly[0]) polygons.push(ringToLatLon(poly[0]));
      } else if (g.type === "MultiPolygon") {
        const multi = g.coordinates as number[][][][];
        for (const poly of multi) if (poly[0]) polygons.push(ringToLatLon(poly[0]));
      }
      if (polygons.length) {
        zones.push({
          region: a.region_name ?? "Регіон",
          type: a.region_type ?? "",
          polygons,
        });
      }
    }
    return { zones, fetchedAt: new Date().toISOString(), degraded: false } satisfies ZonesPayload;
  } catch {
    return {
      zones: [],
      fetchedAt: new Date().toISOString(),
      degraded: true,
    } satisfies ZonesPayload;
  } finally {
    clearTimeout(timer);
  }
});
