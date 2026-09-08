import { createServerFn } from "@tanstack/react-start";

import { UA_BBOX, type CategoryId, type Facility, type InfraEvent } from "./infra-types";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const QUERIES: Record<CategoryId, string> = {
  power_plant: `nwr["power"="plant"]({{bbox}});`,
  substation: `nwr["power"="substation"]["voltage"~"^(1[1-9][0-9]{4}|[2-9][0-9]{5})"]({{bbox}});`,
  water: `nwr["man_made"="water_works"]({{bbox}});`,
  hospital: `nwr["amenity"="hospital"]({{bbox}});`,
  airport: `nwr["aeroway"="aerodrome"]["iata"]({{bbox}});`,
  rail: `nwr["railway"="station"]["train"!="no"]({{bbox}});`,
  telecom: `nwr["man_made"="communications_tower"]({{bbox}});`,
};

const LIMITS: Record<CategoryId, number> = {
  power_plant: 250,
  substation: 400,
  water: 200,
  hospital: 350,
  airport: 60,
  rail: 300,
  telecom: 250,
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
  const name =
    tags["name:uk"] ?? tags["name"] ?? tags["operator"] ?? "Обʼєкт без назви";
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

export const getFacilities = createServerFn({ method: "GET" }).handler(async () => {
  const cached = readCache<{ facilities: Facility[]; fetchedAt: string; degraded: boolean }>(
    "facilities",
    30 * 60 * 1000,
  );
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
    const payload = {
      facilities,
      fetchedAt: new Date().toISOString(),
      degraded: facilities.length === 0,
    };
    if (facilities.length) writeCache("facilities", payload);
    return payload;
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

  try {
    const [eonetRes, usgsRes] = await Promise.allSettled([
      fetch(eonetUrl, { signal: controller.signal }).then((r) => r.json()),
      fetch(usgsUrl, { signal: controller.signal }).then((r) => r.json()),
    ]);

    if (eonetRes.status === "fulfilled") {
      const data = eonetRes.value as { events?: EonetEvent[] };
      for (const ev of data.events ?? []) {
        const geo = ev.geometry?.filter((g) => g.type === "Point").at(-1);
        if (!geo) continue;
        const [lon, lat] = geo.coordinates as [number, number];
        if (
          lat < UA_BBOX.south ||
          lat > UA_BBOX.north ||
          lon < UA_BBOX.west ||
          lon > UA_BBOX.east
        )
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
  } finally {
    clearTimeout(timer);
  }

  events.sort((a, b) => b.time.localeCompare(a.time));
  const payload = { events, fetchedAt: new Date().toISOString(), degraded: failures > 0 };
  if (failures === 0) writeCache("events", payload);
  return payload;
});
