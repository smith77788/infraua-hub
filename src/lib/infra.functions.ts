import { createServerFn } from "@tanstack/react-start";

import { TG_CHANNELS } from "./osint-sources";
import { parsePowerLines, powerLineQuery, toEndpoints, type PowerLine } from "./power-grid";
import { formatVoltage, highestVoltage, plantOutputMw } from "./osm-tags";
import { pendingTiles, tileBBox, tileGrid, tileKey, type Tile } from "./tiles";
import { corroborate, withCorroboration, type ChannelReport } from "./cross-source";

import {
  classifyThreatType,
  fuseThreats,
  mercToLatLon,
  moreSevereType,
  type AlertZone,
  type FirePoint,
  type FrontlineArea,
  frontlineKind,
  type Threat,
  type ThreatType,
  type WeatherNow,
} from "./air";
import { parseAlertLevels, type AlertLevels } from "./alert-levels";
import { readQuality } from "./threat-quality";
import { COVERAGE_CAVEAT, shelterQuery, toShelter, type Shelter } from "./shelters";
import { OBLASTS, type AlertRegion } from "./alerts";
import { categorize } from "./osm-categorize";
import { INFRA_DISABLED_NOTICE, infraLayersEnabled } from "./infra-gate";
import {
  distanceKm,
  UA_BBOX,
  type CategoryId,
  type Facility,
  type InfraEvent,
} from "./infra-types";

/**
 * Опорний перелік ключових обʼєктів — динамічним імпортом, і тільки тут.
 *
 * Статичний імпорт затягнув би цей масив у клієнтський бандл: він дістається
 * з модуля, який консоль імпортує заради серверних функцій, тож їхав би до
 * кожного відвідувача незалежно від того, чи хтось його просив, і незалежно
 * від вимикача. Динамічний імпорт усередині обробника лишає його на сервері й
 * не завантажує взагалі, поки шари вимкнені.
 */
async function seedFacilities(): Promise<Facility[]> {
  const { SEED_FACILITIES } = await import("./infra-seed");
  return SEED_FACILITIES;
}

/** Додає опорні обʼєкти, яких немає серед live-даних (дедуп за категорією + близькістю). */
function mergeWithSeed(live: Facility[], seed: Facility[]): Facility[] {
  const out = [...live];
  for (const s of seed) {
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

/**
 * Стеля на категорію в запиті Overpass (`out center N`).
 *
 * Для енергетики вона була вузьким місцем усього продукту.
 *
 * Тепер це не оцінка, а замір. Запит `out count` до Overpass із розгортання на
 * Railway (2026-09-10): **4109 підстанцій 110 кВ+ по Україні** — 3 вузли,
 * 3937 ліній, 169 відношень. Отже стеля в 400 показувала менш ніж десяту
 * частину, і переважна більшість реальних ЛЕП не мала до чого привʼязатися:
 * спостережена топологія була малою вибіркою, поданою як мережа.
 *
 * Поточні 3000 теж менші за 4109, тобто загальнокраїнний запит обрізає набір —
 * доведено, а не припущено, і `truncatedCategories` каже про це прямо. Піднімати
 * стелю далі немає сенсу: один запит на чотири тисячі обʼєктів не встигне за
 * таймаут (той самий `out count` займав 15–20 с). Повне покриття дають тайли
 * (`getSubstationTiles`), у яких загальної стелі немає взагалі; країнний запит
 * лишається як швидка перша картинка.
 */
const LIMITS: Record<CategoryId, number> = {
  power_plant: 2000,
  substation: 6000,
  oil_gas: 800,
  dam: 800,
  water: 2000,
  hospital: 4000,
  fire_station: 3000,
  airport: 400,
  rail: 3000,
  seaport: 300,
  border: 600,
  telecom: 5000,
  data_center: 400,
  government: 5000,
  grain: 3000,
  industry: 4000,
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
  /** Присутнє лише в запитах `out geom` — потрібне для ліній електропередач. */
  geometry?: { lat: number; lon: number }[];
}

/**
 * Хто ми такі — за вимогою джерела, а не з ввічливості.
 *
 * Політика використання OSM зобовʼязує клієнта представлятися описовим
 * User-Agent із контактом. Ми не надсилали жодного, тобто зверталися анонімно
 * до сервісу, який анонімних клієнтів має право відкидати — і, судячи з
 * відповідей, відкидав: заміряно з Railway, Overpass повертав HTTP 406 за
 * 513 мс, тоді як USGS і NASA тим самим шляхом відповідали нормально.
 *
 * Тобто це не «джерело лежить», а «нас не пускають».
 */
const USER_AGENT = "InfraUA-Console/1.0 (critical infrastructure situational awareness)";

/**
 * Запит до Overpass із переходом на дзеркала.
 *
 * `perMirrorMs` — власний бюджет КОЖНОГО дзеркала, і це виправлення тихої
 * поломки: раніше всі дзеркала ділили один сигнал від виклику. Щойно він
 * спрацьовував, кожна наступна спроба падала миттєво — тобто перехід на
 * дзеркало існував у коді й не працював жодного разу, коли був потрібен
 * найбільше (перше дзеркало не відповідає вчасно).
 *
 * Зовнішній `signal` лишається як загальна стеля: він скасовує все.
 */
async function overpassOrThrow(
  body: string,
  signal: AbortSignal,
  perMirrorMs?: number,
): Promise<OverpassElement[]> {
  let lastError: unknown = null;
  for (const url of OVERPASS_ENDPOINTS) {
    if (signal.aborted) break;
    // Власний строк дзеркала, скасовуваний і зовнішнім сигналом теж.
    const own = perMirrorMs ? new AbortController() : null;
    const ownTimer = own ? setTimeout(() => own.abort(), perMirrorMs) : null;
    const onOuterAbort = own ? () => own.abort() : null;
    if (own && onOuterAbort) signal.addEventListener("abort", onOuterAbort, { once: true });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        body: `data=${encodeURIComponent(body)}`,
        signal: own ? own.signal : signal,
      });
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      const json = (await res.json()) as { elements?: OverpassElement[] };
      return json.elements ?? [];
    } catch (err) {
      lastError = err;
    } finally {
      if (ownTimer) clearTimeout(ownTimer);
      if (onOuterAbort) signal.removeEventListener("abort", onOuterAbort);
    }
  }
  console.error("Overpass unavailable", lastError);
  throw new OverpassUnavailable(lastError);
}

/**
 * Те саме, але провал повертається порожнім масивом.
 *
 * Стара поведінка, і вона лишається для шарів карти: там порожньо й недоступно
 * виглядають однаково (позначок просто немає), тож розрізняти їх нема для чого.
 * Укриття натомість друкують людині речення про те, що саме сталося, — і для
 * них є `overpassOrThrow`.
 */
/**
 * Скільки чекати на ОДНЕ дзеркало, перш ніж пробувати наступне.
 *
 * Без цього числа резерв був мертвий: усі дзеркала ділили один сигнал від
 * виклику, тож після його спрацювання кожна наступна спроба падала миттєво —
 * саме тоді, коли резерв і потрібен.
 */
const PER_MIRROR_MS = 25_000;

async function overpass(
  body: string,
  signal: AbortSignal,
  perMirrorMs: number = PER_MIRROR_MS,
): Promise<OverpassElement[]> {
  try {
    return await overpassOrThrow(body, signal, perMirrorMs);
  } catch {
    return [];
  }
}

/**
 * Джерело не відповіло — і це НЕ те саме, що «тут нічого немає».
 *
 * Раніше `overpass` на повний провал повертав порожній масив, а виклик не міг
 * відрізнити його від чесної порожньої відповіді. Для укриттів це коштувало
 * прямої неправди на екрані: «у цій області нічого не розмічено» замість
 * «джерело не відповіло».
 */
export class OverpassUnavailable extends Error {
  constructor(override readonly cause: unknown) {
    super("overpass unavailable");
    this.name = "OverpassUnavailable";
  }
}

function toFacility(el: OverpassElement, category: CategoryId): Facility | null {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const tags = el.tags ?? {};
  const name = tags["name:uk"] ?? tags["name"] ?? tags["operator"] ?? "Обʼєкт без назви";
  // Спільний парсер: той самий тег читався тут інакше, ніж у решті коду —
  // `split(";")[0]` брав перше значення замість найвищого.
  const voltage = highestVoltage(tags["voltage"]);
  const capacityMw = plantOutputMw(tags["plant:output:electricity"]);

  const detailParts = [
    tags["plant:source"] && `джерело: ${tags["plant:source"]}`,
    voltage !== undefined && formatVoltage(voltage),
    capacityMw !== undefined && `${capacityMw} МВт`,
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
    ...(voltage !== undefined ? { voltage } : {}),
    ...(capacityMw !== undefined ? { capacityMw } : {}),
    ...(detailParts.length ? { detail: detailParts.join(" · ") } : {}),
    // Посилання на конкретний запис, а не на вид карти: його можна відкрити
    // й перевірити.
    source: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    origin: "osm" as const,
  };
}

interface FacilitiesPayload {
  facilities: Facility[];
  fetchedAt: string;
  /** true, коли live-джерело недоступне і показано опорний (baseline) перелік. */
  degraded: boolean;
  source: "live" | "baseline" | "disabled";
  /**
   * Шари вимкнені в цьому розгортанні — це не збій джерела.
   *
   * Проставляється завжди, обома значеннями. Клієнт розрізняє три стани:
   * `true` — вимкнено, `false` — увімкнено, відсутнє — відповіді ще немає; і
   * останнє він трактує як вимкнено. Якби увімкнений шлях лишав поле
   * порожнім, він був би невідрізненним від «ще не відповіли» — тобто
   * вимикач не вмикався б назад.
   */
  disabled: boolean;
  /** Чому порожньо, коли `disabled`. */
  notice?: string;
  /**
   * Категорії, що вперлися у власну стелю, — набір по них неповний.
   *
   * Обрізаний набір нічим не відрізняється від повного, якщо про це не
   * сказати: «підстанцій 3000» і «підстанцій рівно стільки, скільки ми
   * дозволили собі попросити» — різні твердження.
   */
  truncatedCategories: CategoryId[];
}

/**
 * Порожній набір із названою причиною.
 *
 * Не виняток і не HTTP 403: консоль малює ту саму карту без шару обʼєктів, а
 * відмова з помилкою зробила б із навмисного рішення аварію, яку хтось піде
 * лагодити.
 */
const DISABLED_FACILITIES = (): FacilitiesPayload => ({
  facilities: [],
  fetchedAt: new Date().toISOString(),
  degraded: false,
  source: "disabled",
  disabled: true,
  notice: INFRA_DISABLED_NOTICE,
  truncatedCategories: [],
});

export const getFacilities = createServerFn({ method: "GET" })
  .validator((input: unknown): { initData?: string } => {
    const initData = (input as { initData?: unknown } | undefined)?.initData;
    return typeof initData === "string" && initData ? { initData } : {};
  })
  .handler(async ({ data }): Promise<FacilitiesPayload> => {
    if (!(await infraLayersEnabled(data.initData))) return DISABLED_FACILITIES();

    const cached = readCache<FacilitiesPayload>("facilities", 30 * 60 * 1000);
    if (cached) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 28_000);
    try {
      const entries = Object.entries(QUERIES) as [CategoryId, string][];
      const results = await Promise.all(
        entries.map(async ([category, q]) => {
          const query = `[out:json][timeout:25];(${q.replaceAll("{{bbox}}", BBOX)});out center ${LIMITS[category]};`;
          const elements = await overpass(query, controller.signal);
          return {
            category,
            // Рівно стільки, скільки просили, — майже напевно обрізано.
            truncated: elements.length >= LIMITS[category],
            facilities: elements
              .map((el) => toFacility(el, category))
              .filter((f): f is Facility => f !== null),
          };
        }),
      );
      const facilities = results.flatMap((r) => r.facilities);
      const truncatedCategories = results.filter((r) => r.truncated).map((r) => r.category);

      // Overpass періодично недоступний (rate-limit / timeout). Щоб консоль не була
      // порожньою, повертаємо опорний перелік ключових обʼєктів як baseline.
      if (facilities.length === 0) {
        return {
          facilities: await seedFacilities(),
          fetchedAt: new Date().toISOString(),
          degraded: true,
          disabled: false,
          source: "baseline" as const,
          truncatedCategories: [],
        } satisfies FacilitiesPayload;
      }

      const payload: FacilitiesPayload = {
        facilities: mergeWithSeed(facilities, await seedFacilities()),
        fetchedAt: new Date().toISOString(),
        degraded: false,
        disabled: false,
        source: "live",
        truncatedCategories,
      };
      writeCache("facilities", payload);
      return payload;
    } catch {
      return {
        facilities: await seedFacilities(),
        fetchedAt: new Date().toISOString(),
        degraded: true,
        disabled: false,
        source: "baseline" as const,
        truncatedCategories: [],
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

// Повітряні цілі та зони тривог.
// Основне джерело — neptun.in.ua/api/v1/threats: keyless, вже типізовані,
// дедупльовані й геокодовані треки з курсом і рівнем впевненості (те, що інші
// карти будують важким пайплайном). detoyshahed лишається фолбеком.
const NEPTUN_ENDPOINT = "https://neptun.in.ua/api/v1/threats";
const THREATS_ENDPOINT = "https://detoyshahed.in.ua/api/incidents/active";
const ZONES_ENDPOINT = "https://detoyshahed.in.ua/api/alerts/active";

interface ThreatsPayload {
  threats: Threat[];
  fetchedAt: string;
  degraded: boolean;
  source?: "neptun" | "detoyshahed";
}

/** Тип цілі neptun → наш ThreatType. Спираємось на текст (title+пояснення). */
function mapNeptunType(type: string | undefined, text: string): ThreatType {
  const byText = classifyThreatType(text);
  if (byText !== "unknown") return byText;
  const t = (type ?? "").toLowerCase();
  if (/ballist/.test(t)) return "ballistic";
  if (/cruise|krylat/.test(t)) return "cruise";
  if (/missile|rocket|raket/.test(t)) return "missile";
  if (/kab/.test(t)) return "kab";
  if (/recon|rozvid/.test(t)) return "recon";
  if (/aircraft|jet|avia/.test(t)) return "aircraft";
  if (/fpv|uav|drone|bpla|shahed/.test(t)) return "shahed";
  return "unknown";
}

interface NeptunThreat {
  id: string;
  type?: string;
  title?: string;
  region?: string;
  district?: string;
  locality?: string;
  lat?: number;
  lon?: number;
  heading?: number | null;
  confidenceLevel?: string;
  sourceCount?: number;
  count?: number;
  updatedAt?: string;
  confirmedAt?: string;
  explanationShort?: string;
  status?: string;
  /* Заяви джерела про власну точність — розбираються в readQuality. */
  uncertaintyKm?: unknown;
  positionQuality?: unknown;
  lifecycle?: unknown;
  presumptiveCourse?: unknown;
  velocity?: unknown;
  sea?: unknown;
  trail?: unknown;
}

/**
 * Трек із джерела — лише коректні точки.
 *
 * Джерело віддає його не завжди й не для всіх цілей, тож усе, що не є парою
 * скінченних координат із часом, відкидається мовчки: половина треку гірша за
 * його відсутність лише тоді, коли з неї малюють суцільну лінію, а тут вона до
 * лінії просто не доходить.
 */
function readTrail(raw: unknown): { lat: number; lon: number; t: string }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { lat: number; lon: number; t: string }[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const o = p as { lat?: unknown; lon?: unknown; t?: unknown };
    if (
      typeof o.lat === "number" &&
      Number.isFinite(o.lat) &&
      typeof o.lon === "number" &&
      Number.isFinite(o.lon) &&
      typeof o.t === "string" &&
      o.t
    ) {
      out.push({ lat: o.lat, lon: o.lon, t: o.t });
    }
  }
  return out.length >= 2 ? out : null;
}

/**
 * ЄДИНЕ канонічне джерело повітряних цілей.
 *
 * Карта застосунку, картинка каналу, текст поста й публічний віджет мають
 * читати ОДИН знімок, а не кожен свій — інакше на екрані «три різні картини».
 * Усе крутиться в одному Railway-процесі, тож цей модульний кеш і є та єдина
 * памʼять: усі споживачі в межах TTL бачать ТІ САМІ байти, без розбіжності.
 * Джерело neptun уже дедупить за треками — свого злиття НЕ додаємо, бо саме
 * воно й робило канал окремою правдою.
 */
let neptunCache: { at: number; threats: Threat[] } | null = null;
export async function neptunThreatsCached(maxAgeMs = 10_000): Promise<Threat[]> {
  const now = Date.now();
  if (neptunCache && now - neptunCache.at < maxAgeMs) return neptunCache.threats;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const threats = (await fetchNeptunThreats(controller.signal)) ?? [];
    neptunCache = { at: now, threats };
    return threats;
  } catch {
    // Збій джерела не має стирати останню відому картину.
    return neptunCache?.threats ?? [];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNeptunThreats(signal: AbortSignal): Promise<Threat[] | null> {
  const res = await fetch(NEPTUN_ENDPOINT, {
    signal,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InfraUA/1.0)" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { threats?: NeptunThreat[] };
  const list = data.threats;
  if (!Array.isArray(list)) return null;
  const out: Threat[] = [];
  for (const t of list) {
    /*
     * `Number.isFinite`, а не `typeof === "number"`.
     *
     * typeof NaN — це «number», а всі порівняння NaN із межами bbox нижче
     * хибні, тож запис із NaN проходив би повз обидві перевірки й потрапляв у
     * систему. На карті його намалювати неможливо, у лічильнику він є — і
     * число над картою перестає збігатися з тим, що під нею.
     *
     * Чесно: з JSON це недосяжно (у JSON немає літерала NaN), і на живому фіді
     * я такого не спостерігав. Але перевірка, яка не перевіряє того, що
     * обіцяє, — це вада незалежно від того, чи вистрілила вона сьогодні.
     */
    if (typeof t.lat !== "number" || !Number.isFinite(t.lat)) continue;
    if (typeof t.lon !== "number" || !Number.isFinite(t.lon)) continue;
    if (t.status && t.status !== "active") continue;
    if (
      t.lat < UA_BBOX.south ||
      t.lat > UA_BBOX.north ||
      t.lon < UA_BBOX.west ||
      t.lon > UA_BBOX.east
    )
      continue;
    const text = `${t.title ?? ""} ${t.explanationShort ?? ""}`;
    const trail = readTrail(t.trail);
    out.push({
      id: t.id,
      name: t.locality || t.district || t.region || t.title || "Ціль",
      lat: t.lat,
      lon: t.lon,
      source: "neptun.in.ua",
      type: mapNeptunType(t.type, text),
      count: t.count ?? 1,
      since: t.confirmedAt ?? t.updatedAt ?? "",
      expires: "",
      reports: t.sourceCount ?? 1,
      lastSeen: t.updatedAt ?? t.confirmedAt ?? "",
      ...(typeof t.heading === "number" ? { heading: t.heading } : {}),
      ...(t.confidenceLevel ? { confidence: t.confidenceLevel } : {}),
      // Те, що джерело каже про власну точність. Без цього позначка ±45 км
      // малювалась крапкою, а припущений курс — як спостережений.
      quality: readQuality(t),
      ...(trail ? { trail } : {}),
      ...(t.sea === true ? { sea: true } : {}),
      ...(t.region ? { region: t.region } : {}),
    });
  }
  return out;
}

/*
 * Тип цілі з тексту Telegram-каналів (те, як це роблять kontursystems/neptun):
 * позиції в detoyshahed без типу, але ті самі канали в Telegram пишуть його
 * текстом («Реактивний БпЛА», «ракета», «КАБ»…). Публічне вебпревʼю
 * t.me/s/<канал> віддає останні повідомлення БЕЗ ключа — читаємо його прямо з
 * Workers, класифікуємо тип і зіставляємо з позначкою за назвою пункту.
 */
// Канали моніторингу повітряної обстановки для фолбек-класифікації типу
// (коли основне джерело neptun недоступне). Дедупльований набір хендлів.

function normPlace(s: string): string {
  return s
    .toLowerCase()
    .replace(/["'`ʼ’]/g, "")
    .trim();
}

async function fetchThreatTypesByPlace(placeNames: string[]): Promise<Map<string, ThreatType>> {
  const out = new Map<string, ThreatType>();
  // Нормалізовані назви пунктів, за якими шукатимемо збіг у тексті.
  const names = placeNames
    .map((n) => ({ raw: n, norm: normPlace(n) }))
    .filter((n) => n.norm.length >= 4);
  if (!names.length) return out;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const pages = await Promise.allSettled(
      TG_CHANNELS.map((ch) =>
        fetch(`https://t.me/s/${ch}`, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; InfraUA/1.0)" },
        }).then((r) => (r.ok ? r.text() : "")),
      ),
    );
    for (const p of pages) {
      if (p.status !== "fulfilled" || !p.value) continue;
      const blocks = p.value.match(
        /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g,
      );
      if (!blocks) continue;
      for (const raw of blocks) {
        const text = raw
          .replace(/<br\s*\/?>/g, " ")
          .replace(/<[^>]+>/g, "")
          .replace(/&[a-z#0-9]+;/gi, " ");
        const type = classifyThreatType(text);
        if (type === "unknown") continue;
        const low = normPlace(text);
        for (const n of names) {
          if (low.includes(n.norm)) {
            out.set(n.raw, moreSevereType(out.get(n.raw) ?? "unknown", type));
          }
        }
      }
    }
  } catch {
    // Best-effort: без типів позначки просто лишаться "unknown".
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/**
 * Сирі повідомлення другого агрегатора — як НЕЗАЛЕЖНІ СВІДКИ, а не як фолбек.
 *
 * detoyshahed доти брали, лише коли neptun не відповів. Але його цінність не в
 * тому, що він схожий на перший, а в тому, що він ІНШИЙ: віддає окремі
 * повідомлення з назвою каналу, який їх написав. Заміряно на живому зрізі:
 * 187 повідомлень від 10 різних каналів, і 8 цілей neptun із 29 (28%) не мали
 * там жодного підтвердження. Ціль, яку бачать два незалежні збирачі, і ціль,
 * про яку сказав один, — різні за вагою, а на карті виглядали однаково.
 *
 * Свій короткий кеш і власний строк: збій цього запиту не має валити головний
 * шлях — без свідків картина лишається такою, як була, просто без підтверджень.
 */
const REPORTS_TTL_MS = 20_000;
let reportsCache: { at: number; reports: ChannelReport[] } | null = null;

export async function fetchChannelReports(signal?: AbortSignal): Promise<ChannelReport[]> {
  const now = Date.now();
  if (reportsCache && now - reportsCache.at < REPORTS_TTL_MS) return reportsCache.reports;
  try {
    const res = await fetch(THREATS_ENDPOINT, {
      ...(signal ? { signal } : {}),
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`reports ${res.status}`);
    const data = (await res.json()) as {
      incidents?: {
        coordinates?: { lat: number; lng: number };
        channel_name?: string;
        created_at?: string;
      }[];
    };
    const out: ChannelReport[] = [];
    for (const it of data.incidents ?? []) {
      const c = it.coordinates;
      const channel = it.channel_name;
      if (!c || !channel) continue;
      const [lat, lon] = mercToLatLon(c.lng, c.lat);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < UA_BBOX.south || lat > UA_BBOX.north || lon < UA_BBOX.west || lon > UA_BBOX.east) {
        continue;
      }
      const at = Date.parse(it.created_at ?? "");
      if (!Number.isFinite(at)) continue;
      out.push({ lat, lon, channel, at });
    }
    reportsCache = { at: now, reports: out };
    return out;
  } catch {
    // Свідків не дісталися — картина лишається без підтверджень, і це чесніше
    // за спробу видати останній кеш за свіжі підтвердження.
    return reportsCache && now - reportsCache.at < 5 * REPORTS_TTL_MS ? reportsCache.reports : [];
  }
}

export const getThreats = createServerFn({ method: "GET" }).handler(async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    // 1) Основне джерело — neptun через СПІЛЬНИЙ кеш: та сама пам'ять, з якої
    // читає канал і публічний віджет, тож карта застосунку й пост показують
    // один знімок, а не кожен свій.
    try {
      const neptun = await neptunThreatsCached();
      if (neptun.length) {
        /*
         * Перехресне підтвердження другим агрегатором. Знайдені канали
         * домішуються в `sources`, а зважує їх наявна `verifyThreat` — вона
         * вже вміє рахувати незалежність джерел і знає їхні ролі. Другої шкали
         * довіри поряд із першою не заводимо: два різні числа про те саме в
         * цьому проєкті вже проходили.
         */
        const reports = await fetchChannelReports(controller.signal);
        const now = Date.now();
        const threats = reports.length
          ? withCorroboration(neptun, corroborate(neptun, reports, now))
          : neptun;
        return {
          threats, // вже дедупльовано джерелом — не зливаємо повторно
          fetchedAt: new Date().toISOString(),
          degraded: false,
          source: "neptun",
        } satisfies ThreatsPayload;
      }
    } catch {
      // Падаємо на фолбек detoyshahed нижче.
    }

    // 2) Фолбек — detoyshahed (позиції) + тип із тексту Telegram.
    const res = await fetch(THREATS_ENDPOINT, { signal: controller.signal });
    if (!res.ok) throw new Error(`threats ${res.status}`);
    const data = (await res.json()) as {
      incidents?: {
        id: string;
        location_name?: string;
        display_name?: string;
        osm_id?: number;
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
        ...(it.osm_id != null ? { osmId: it.osm_id } : {}),
      });
    }
    // Збагачуємо тип цілі з тексту Telegram-каналів (за назвою пункту).
    const typeByPlace = await fetchThreatTypesByPlace(threats.map((t) => t.name));
    if (typeByPlace.size) {
      for (const t of threats) {
        const ty = typeByPlace.get(t.name);
        if (ty) t.type = ty;
      }
    }
    return {
      // Зливаємо близькі позначки (різні канали про ту саму ціль/район), щоб на
      // карті не було стосів дублікатів над одним містом.
      threats: fuseThreats(threats),
      fetchedAt: new Date().toISOString(),
      degraded: false,
      source: "detoyshahed",
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

// Лінія фронту — відкрите джерело DeepState Map (GeoJSON, keyless). Порт модуля
// osiris/Palanter: ключовий шар ситуативної картини України, поруч із обʼєктами
// та повітряною загрозою.
const FRONTLINE_ENDPOINT = "https://deepstatemap.live/api/history/last";

interface FrontlinePayload {
  areas: FrontlineArea[];
  datetime: string;
  degraded: boolean;
}

function simplifyRing(ring: number[][], max = 140): [number, number][] {
  const step = Math.max(1, Math.ceil(ring.length / max));
  const out: [number, number][] = [];
  for (let i = 0; i < ring.length; i += step) {
    const p = ring[i];
    if (!p) continue;
    const [lon, lat] = p;
    if (typeof lon === "number" && typeof lat === "number")
      out.push([Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4]);
  }
  return out;
}

/** Назва DeepState: «Окуповано /// Occupied /// geoJSON.status.occupied» → перша частина. */
/**
 * Чи лежить полігон хоч якоюсь частиною в межах України.
 *
 * Перевіряється за вершинами, а не за центром: окупована територія на сході
 * має центр у межах країни, а сатиричний полігон на Калінінград — ні, і
 * жодна з них не вимагає точної геометрії, щоб їх розрізнити.
 */
function touchesUkraine(rings: [number, number][][]): boolean {
  return rings.some((ring) =>
    ring.some(
      ([lat, lon]) =>
        lat >= UA_BBOX.south && lat <= UA_BBOX.north && lon >= UA_BBOX.west && lon <= UA_BBOX.east,
    ),
  );
}

function statusFromName(name: string | undefined): string {
  return (
    (name ?? "")
      .split("///")[0]
      ?.replace(/\u00a0/g, " ")
      .trim() ?? ""
  );
}

export const getFrontline = createServerFn({ method: "GET" }).handler(
  async (): Promise<FrontlinePayload> => {
    const cached = readCache<FrontlinePayload>("frontline", 30 * 60 * 1000);
    if (cached) return cached;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(FRONTLINE_ENDPOINT, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`frontline ${res.status}`);
      const data = (await res.json()) as {
        datetime?: string;
        map?: {
          features?: Array<{
            geometry?: { type?: string; coordinates?: unknown };
            properties?: { stroke?: string; name?: string };
          }>;
        };
      };
      const feats = data.map?.features ?? [];
      const areas: FrontlineArea[] = [];
      for (const f of feats) {
        if (f?.geometry?.type !== "Polygon") continue;

        const status = statusFromName(f.properties?.name);
        // Беремо лише окуповану територію. Звільнене у 2022-му, стрілки
        // напрямків ударів і позначки підрозділів — це робоча мапа редакції,
        // а не межа контролю; намальовані разом, вони дають червону пляму, у
        // якій справжньої лінії фронту не видно.
        if (frontlineKind(status) !== "occupied") continue;

        const coords = f.geometry.coordinates as number[][][] | undefined;
        const rings = (coords ?? []).map((r) => simplifyRing(r)).filter((r) => r.length >= 3);
        if (!rings.length) continue;

        // Джерело несе й сатиричні полігони на чужі регіони — «тимчасово
        // окупована Карелія», Пруссія, Ічкерія. За назвою вони не
        // відрізняються від справжніх, за розташуванням — відрізняються.
        if (!touchesUkraine(rings)) continue;

        areas.push({
          polygons: rings,
          color: f.properties?.stroke ?? "#ff4d4d",
          status,
          kind: "occupied",
        });
      }
      const payload: FrontlinePayload = { areas, datetime: data.datetime ?? "", degraded: false };
      if (areas.length) writeCache("frontline", payload);
      return payload;
    } catch {
      return { areas: [], datetime: "", degraded: true };
    } finally {
      clearTimeout(timer);
    }
  },
);

// Активні пожежі — NASA FIRMS Global 24h CSV (keyless). Порт модуля osiris/geo.
// Тягнемо глобальний CSV, фільтруємо по Україні, кешуємо. Термоточки — не лише
// удари: с/г випали, лісові пожежі теж; тому підписуємо як «теплові аномалії».
const FIRMS_SOURCES = [
  "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv",
  "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv",
];

interface FiresPayload {
  fires: FirePoint[];
  source: string;
  fetchedAt: string;
  degraded: boolean;
}

export const getFires = createServerFn({ method: "GET" }).handler(
  async (): Promise<FiresPayload> => {
    const cached = readCache<FiresPayload>("fires", 20 * 60 * 1000);
    if (cached) return cached;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      for (const url of FIRMS_SOURCES) {
        try {
          const res = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": USER_AGENT },
          });
          if (!res.ok) continue;
          const text = await res.text();
          const nl = text.indexOf("\n");
          if (nl < 0) continue;
          const header = text.slice(0, nl).trim().split(",");
          const li = header.indexOf("latitude");
          const oi = header.indexOf("longitude");
          const ci = header.indexOf("confidence");
          const fi = header.indexOf("frp");
          const di = header.indexOf("acq_date");
          const ti = header.indexOf("acq_time");
          const ni = header.indexOf("daynight");
          if (li < 0 || oi < 0) continue;
          const fires: FirePoint[] = [];
          let pos = nl + 1;
          while (pos < text.length && fires.length < 4000) {
            let end = text.indexOf("\n", pos);
            if (end < 0) end = text.length;
            const line = text.slice(pos, end);
            pos = end + 1;
            if (!line) continue;
            const c = line.split(",");
            const lat = Number(c[li]);
            const lon = Number(c[oi]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            if (
              lat < UA_BBOX.south ||
              lat > UA_BBOX.north ||
              lon < UA_BBOX.west ||
              lon > UA_BBOX.east
            )
              continue;
            fires.push({
              lat,
              lon,
              frp: fi >= 0 ? Number(c[fi]) || 0 : 0,
              confidence: ci >= 0 ? (c[ci] ?? "") : "",
              acqDate: di >= 0 ? (c[di] ?? "") : "",
              acqTime: ti >= 0 ? (c[ti] ?? "") : "",
              daynight: ni >= 0 ? (c[ni] ?? "") : "",
            });
          }
          const payload: FiresPayload = {
            fires,
            source: url.includes("SUOMI") ? "NASA FIRMS (VIIRS)" : "NASA FIRMS (MODIS)",
            fetchedAt: new Date().toISOString(),
            degraded: false,
          };
          if (fires.length) writeCache("fires", payload);
          return payload;
        } catch {
          continue;
        }
      }
      return { fires: [], source: "", fetchedAt: new Date().toISOString(), degraded: true };
    } finally {
      clearTimeout(timer);
    }
  },
);

// Космічна погода — планетарний Kp-індекс (NOAA SWPC, keyless). Геомагнітні бурі
// погіршують ГНСС/КХ-звʼязок — релевантно для навігації й РЕБ-фону. Порт модуля
// osiris/geo; це індикатор стану, не шар карти.
const KP_ENDPOINT = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";

export interface SpaceWeather {
  kp: number;
  /** quiet | unsettled | storm */
  level: "quiet" | "unsettled" | "storm";
  /** G-шкала бурі (0 = немає), 1..5. */
  gScale: number;
  observedAt: string;
  degraded: boolean;
}

export const getSpaceWeather = createServerFn({ method: "GET" }).handler(
  async (): Promise<SpaceWeather> => {
    const cached = readCache<SpaceWeather>("spaceweather", 20 * 60 * 1000);
    if (cached) return cached;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(KP_ENDPOINT, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`kp ${res.status}`);
      const rows = (await res.json()) as Array<{ time_tag?: string; Kp?: number }>;
      let last: { time_tag?: string; Kp?: number } | undefined;
      for (const r of rows) if (typeof r?.Kp === "number") last = r;
      if (!last || typeof last.Kp !== "number") throw new Error("no kp");
      const kp = Math.round(last.Kp * 10) / 10;
      const gScale = kp >= 5 ? Math.min(5, Math.floor(kp) - 4) : 0;
      const level: SpaceWeather["level"] = kp >= 5 ? "storm" : kp >= 4 ? "unsettled" : "quiet";
      const payload: SpaceWeather = {
        kp,
        level,
        gScale,
        observedAt: last.time_tag ?? "",
        degraded: false,
      };
      writeCache("spaceweather", payload);
      return payload;
    } catch {
      return { kp: 0, level: "quiet", gScale: 0, observedAt: "", degraded: true };
    } finally {
      clearTimeout(timer);
    }
  },
);

// Інтернет-збої по Україні — IODA (Georgia Tech), keyless. Порт модуля
// osiris/geo: падіння звʼязності напряму корелює з ударами по енергетиці/
// інфраструктурі, тож це цінний незалежний сигнал стану.
const IODA_ENDPOINT = "https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events";

export interface InternetOutages {
  count: number;
  maxScore: number;
  latestStart: number;
  sources: string[];
  degraded: boolean;
}

export const getInternetOutages = createServerFn({ method: "GET" }).handler(
  async (): Promise<InternetOutages> => {
    const cached = readCache<InternetOutages>("ioda", 10 * 60 * 1000);
    if (cached) return cached;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const now = Math.floor(Date.now() / 1000);
      const from = now - 86400;
      const url = `${IODA_ENDPOINT}?from=${from}&until=${now}&entityType=country&entityCode=UA&limit=200`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`ioda ${res.status}`);
      const json = (await res.json()) as {
        data?: Array<{ score?: number; start?: number; duration?: number; datasource?: string }>;
      };
      const data = json.data ?? [];
      let maxScore = 0;
      let latestStart = 0;
      const sources = new Set<string>();
      for (const e of data) {
        if (typeof e.score === "number" && e.score > maxScore) maxScore = e.score;
        if (typeof e.start === "number" && e.start > latestStart) latestStart = e.start;
        if (e.datasource) sources.add(e.datasource.replace(/_/g, " "));
      }
      const payload: InternetOutages = {
        count: data.length,
        maxScore: Math.round(maxScore),
        latestStart,
        sources: [...sources],
        degraded: false,
      };
      writeCache("ioda", payload);
      return payload;
    } catch {
      return { count: 0, maxScore: 0, latestStart: 0, sources: [], degraded: true };
    } finally {
      clearTimeout(timer);
    }
  },
);

// Поточна погода над Києвом — open-meteo, keyless. Вітер важить для роботи БпЛА
// й поширення пожеж; це фоновий оперативний показник, не шар карти.
const WEATHER_ENDPOINT =
  "https://api.open-meteo.com/v1/forecast?latitude=50.45&longitude=30.52&current=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation&timezone=UTC";

export const getWeather = createServerFn({ method: "GET" }).handler(
  async (): Promise<WeatherNow> => {
    const cached = readCache<WeatherNow>("weather", 15 * 60 * 1000);
    if (cached) return cached;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(WEATHER_ENDPOINT, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`weather ${res.status}`);
      const data = (await res.json()) as {
        current?: {
          temperature_2m?: number;
          wind_speed_10m?: number;
          wind_direction_10m?: number;
          precipitation?: number;
        };
      };
      const c = data.current;
      if (!c || typeof c.temperature_2m !== "number") throw new Error("no current");
      const payload: WeatherNow = {
        tempC: Math.round(c.temperature_2m),
        windKmh: Math.round(c.wind_speed_10m ?? 0),
        windDir: Math.round(c.wind_direction_10m ?? 0),
        precip: c.precipitation ?? 0,
        degraded: false,
      };
      writeCache("weather", payload);
      return payload;
    } catch {
      return { tempC: 0, windKmh: 0, windDir: 0, precip: 0, degraded: true };
    } finally {
      clearTimeout(timer);
    }
  },
);

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
    if (!p) continue;
    // Destructure rather than index: `p.length >= 2` does not narrow the
    // element type, so p[0]/p[1] stay `number | undefined` to the compiler —
    // and a malformed ring really can carry a hole here.
    const [lon, lat] = p;
    if (typeof lon === "number" && typeof lat === "number") out.push([lat, lon]);
  }
  return out;
}

/**
 * Рівні тривог: жовтий і червоний, плюс розріз по районах.
 *
 * Окремим джерелом від `getAlertZones`, і це не дубль: зони дають ГЕОМЕТРІЮ
 * (де саме межа регіону), а це джерело — ЗМІСТ (який рівень і чому). Наше
 * основне джерело тривог уміє лише «так/ні» на цілу область, тож «дронова
 * загроза» і «ракетна загроза» виглядали однаково — а це різні дії й різний
 * запас часу.
 *
 * Помилка джерела дає `null`, а не порожній перелік: порожній фарбує карту в
 * спокій, тобто СТВЕРДЖУЄ, що ніде не тривожно.
 */
const ALERT_LEVELS_ENDPOINT = "https://neptun.in.ua/api/v1/alerts";

export const getAlertLevels = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ levels: AlertLevels | null; fetchedAt: number }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(ALERT_LEVELS_ENDPOINT, { signal: controller.signal });
      if (!res.ok) return { levels: null, fetchedAt: Date.now() };
      return { levels: parseAlertLevels(await res.json()), fetchedAt: Date.now() };
    } catch {
      return { levels: null, fetchedAt: Date.now() };
    } finally {
      clearTimeout(timer);
    }
  },
);

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

/**
 * Реальні лінії електропередач 110 кВ+ — основа **спостереженої** топології.
 *
 * Решта графа виводиться за найближчим сусідом, тобто є припущенням. Ці лінії
 * — зафіксовані обʼєкти OSM з напругою і геометрією; зведені з підстанціями,
 * вони дають ребра, які можна відкрити в OSM і перевірити очима.
 *
 * ## Чому по тайлах, а не одним запитом
 *
 * Перевірено запитами до Overpass (вересень 2026), а не припущено:
 *
 *   вся Україна одним запитом   → відмова (HTML замість JSON)
 *   чверть країни               → відмова
 *   тайл 2°×2°                  → 470 ліній, 911 КБ, успішно
 *   тайл 1°×1°                  → 319 ліній, 523 КБ, успішно
 *
 * Тобто повний набір (близько 16.9 тис. ліній) через один запит не проходить
 * узагалі. Країна розбивається на сітку по 2°, і кожен виклик догружає кілька
 * тайлів, повертаючи все, що вже накопичено. Мережа передачі змінюється
 * роками, тож кеш живе довго, а покриття зростає від виклику до виклику.
 *
 * Наслідок, який видно в інтерфейсі: доля фактів у графі не фіксована — вона
 * росте, поки тайли підвантажуються. Це чесніше за «все або нічого»: система
 * показує рівно те, що встигла підтвердити.
 */

/** Розмір тайла в градусах — найбільший, який Overpass віддає стабільно. */
const TILE_DEG = 2;

/** Скільки тайлів догружати за один виклик, щоб не впертися в таймаут. */
const TILES_PER_CALL = 3;

/** Сітка тайлів по країні — спільна для ліній і підстанцій. */
function grid(): Tile[] {
  return tileGrid(UA_BBOX, TILE_DEG);
}

/**
 * Кеш тайлів — **найкраще зусилля, а не сховище**.
 *
 * Збірка йде під Cloudflare Workers (див. `.output/server/wrangler.json`), а
 * там модульний стан живе в межах ізоляту: ізолят створюється і зникає коли
 * завгодно, сусідній запит може потрапити в інший. Тому накопичувати покриття
 * тут не можна — раніше саме так і було, і в продакшені лічильник «завантажено
 * N з 50» показував би що завгодно, а ті самі перші тайли перезапитувалися б в
 * Overpass знову і знову з кожного холодного ізоляту.
 *
 * Накопичення переїхало на клієнт: він каже, які тайли вже має, сервер
 * дозавантажує наступні й віддає лише їх. Цей кеш лишається як економія
 * запитів до Overpass, коли ізолят таки живий, і від нього більше нічого не
 * залежить.
 */
const powerLineTiles = new Map<string, PowerLine[]>();

export interface PowerLineTile {
  /** Ключ тайла у сітці, `${south}:${west}`. */
  key: string;
  lines: PowerLine[];
}

export interface PowerLinesPayload {
  /** Лише щойно завантажені тайли — клієнт складає покриття сам. */
  tiles: PowerLineTile[];
  retrievedAt: string;
  /** Скільки всього тайлів покриває країну. */
  tilesTotal: number;
  /**
   * false означає «джерело недоступне», а не «ліній не існує». Без цього
   * прапорця відсутність фактів виглядала б як доведена відсутність звʼязків.
   */
  available: boolean;
  /** Шари вимкнені в цьому розгортанні — це не «джерело недоступне». */
  disabled?: boolean;
}

export const getPowerLines = createServerFn({ method: "GET" })
  .validator((input: unknown): { have: string[]; initData?: string } => {
    const obj = input as { have?: unknown; initData?: unknown } | undefined;
    const have = Array.isArray(obj?.have)
      ? obj.have.filter((k): k is string => typeof k === "string")
      : [];
    const initData = obj?.initData;
    return typeof initData === "string" && initData ? { have, initData } : { have };
  })
  .handler(async ({ data }) => {
    // tilesTotal 0 означає «покриття повне»: клієнт не проситиме ще.
    // (Раніше тут бракувало await — проміс завжди істинний, і шар віддавався
    // будь-кому попри вимикач. Тепер право звіряється як і всюди.)
    if (!(await infraLayersEnabled(data.initData))) {
      return {
        tiles: [],
        retrievedAt: new Date().toISOString(),
        tilesTotal: 0,
        available: false,
        disabled: true,
      };
    }

    const all = grid();
    const pending = pendingTiles(all, data.have, TILES_PER_CALL);
    const fetched: PowerLineTile[] = [];

    if (pending.length > 0) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90_000);
      try {
        for (const tile of pending) {
          const key = tileKey(tile);
          const cached = powerLineTiles.get(key);
          if (cached) {
            fetched.push({ key, lines: cached });
            continue;
          }
          const query = powerLineQuery(tileBBox(tile, TILE_DEG));
          const elements = await overpass(query, controller.signal);
          // Порожній тайл віддається теж: над морем чи за кордоном ліній
          // справді немає, і без запису клієнт просив би його вічно.
          // Клієнтові потрібні лише кінці — див. `toEndpoints`.
          const lines = parsePowerLines({ elements }).map(toEndpoints);
          powerLineTiles.set(key, lines);
          fetched.push({ key, lines });
        }
      } catch (err) {
        console.error("power line tile failed", err);
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      tiles: fetched,
      retrievedAt: new Date().toISOString(),
      tilesTotal: all.length,
      available: fetched.length > 0 || data.have.length > 0,
    } satisfies PowerLinesPayload;
  });

/**
 * Підстанції по тайлах — зняття стелі, а не ще одне джерело.
 *
 * Загальнокраїнний запит обмежений `out center N`, і цей ліміт був вузьким
 * місцем усього продукту: заміряно на реальному тайлі 2°×2° (50–52°N,
 * 30–32°E) — 470 ліній 110 кВ+, кінці яких збиваються у 285 різних вузлів, в
 * одному тайлі з приблизно півсотні. Стеля в кількасот підстанцій на країну
 * означала, що більшість реальних ліній не мала до чого привʼязатися.
 *
 * Тут тієї стелі немає: кожен тайл питається окремо, і межа `out center`
 * застосовується до площі, де стільки обʼєктів просто не буває.
 *
 * **Це доповнення, а не заміна.** `getFacilities` лишається як був і сам по
 * собі дає працездатну консоль; тайли лише додають те, що не вмістилося. Якщо
 * цей шлях відмовить, гірше, ніж було, не стане — саме тому він окремий.
 */
const substationTiles = new Map<string, Facility[]>();

export interface SubstationTile {
  key: string;
  facilities: Facility[];
}

export interface SubstationTilesPayload {
  tiles: SubstationTile[];
  tilesTotal: number;
  disabled?: boolean;
}

/** Стеля на тайл: запобіжник від патологічного запиту, а не робоче обмеження. */
const SUBSTATIONS_PER_TILE = 1200;

export const getSubstationTiles = createServerFn({ method: "GET" })
  .validator((input: unknown): { have: string[]; initData?: string } => {
    const obj = input as { have?: unknown; initData?: unknown } | undefined;
    const have = Array.isArray(obj?.have)
      ? obj.have.filter((k): k is string => typeof k === "string")
      : [];
    const initData = obj?.initData;
    return typeof initData === "string" && initData ? { have, initData } : { have };
  })
  .handler(async ({ data }): Promise<SubstationTilesPayload> => {
    if (!(await infraLayersEnabled(data.initData)))
      return { tiles: [], tilesTotal: 0, disabled: true };

    const all = grid();
    const pending = pendingTiles(all, data.have, TILES_PER_CALL);
    const fetched: SubstationTile[] = [];
    if (pending.length === 0) return { tiles: fetched, tilesTotal: all.length };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      for (const tile of pending) {
        const key = tileKey(tile);
        const cached = substationTiles.get(key);
        if (cached) {
          fetched.push({ key, facilities: cached });
          continue;
        }
        const b = tileBBox(tile, TILE_DEG);
        const query =
          `[out:json][timeout:90];(` +
          `nwr["power"="substation"]["voltage"~"^(1[1-9][0-9]{4}|[2-9][0-9]{5})"]` +
          `(${b.south},${b.west},${b.north},${b.east});` +
          `);out center ${SUBSTATIONS_PER_TILE};`;
        const elements = await overpass(query, controller.signal);
        // Порожній тайл записується теж: над морем чи за кордоном підстанцій
        // справді немає, і без запису клієнт просив би його вічно.
        const facilities = elements
          .map((el) => toFacility(el, "substation"))
          .filter((f): f is Facility => f !== null);
        substationTiles.set(key, facilities);
        fetched.push({ key, facilities });
      }
    } catch (err) {
      console.error("substation tile failed", err);
    } finally {
      clearTimeout(timer);
    }

    return { tiles: fetched, tilesTotal: all.length };
  });

/**
 * Усі категорії обʼєктів по тайлах — знімає загальнокраїнну стелю `out center N`
 * для КОЖНОЇ категорії, а не лише для підстанцій. Один обʼєднаний запит на тайл
 * повертає всі типи одразу; `categorize` розкладає елементи по категоріях.
 *
 * Це і є повний тайлинг, якого бракувало: набір більше не «22 секунди або
 * нічого» з жорсткою стелею, а прогресивне повне покриття по 2°×2° ділянках,
 * що кешуються на сервері та накопичуються на клієнті.
 *
 * `getFacilities` лишається як миттєвий опорний прошарок (швидкий перший показ);
 * тайли доповнюють його до повного набору, дедуп за OSM-id.
 */
const facilityTiles = new Map<string, Facility[]>();

export interface FacilityTile {
  key: string;
  facilities: Facility[];
}

export interface FacilityTilesPayload {
  tiles: FacilityTile[];
  tilesTotal: number;
  disabled?: boolean;
}

/** Стеля на тайл (усі категорії разом) — запобіжник, а не робоче обмеження. */
const FACILITIES_PER_TILE = 8000;

export const getFacilityTiles = createServerFn({ method: "GET" })
  .validator((input: unknown): { have: string[]; initData?: string } => {
    const obj = input as { have?: unknown; initData?: unknown } | undefined;
    const have = Array.isArray(obj?.have)
      ? obj.have.filter((k): k is string => typeof k === "string")
      : [];
    const initData = obj?.initData;
    return typeof initData === "string" && initData ? { have, initData } : { have };
  })
  .handler(async ({ data }): Promise<FacilityTilesPayload> => {
    if (!(await infraLayersEnabled(data.initData)))
      return { tiles: [], tilesTotal: 0, disabled: true };

    const all = grid();
    const pending = pendingTiles(all, data.have, TILES_PER_CALL);
    const fetched: FacilityTile[] = [];
    if (pending.length === 0) return { tiles: fetched, tilesTotal: all.length };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      for (const tile of pending) {
        const key = tileKey(tile);
        const cached = facilityTiles.get(key);
        if (cached) {
          fetched.push({ key, facilities: cached });
          continue;
        }
        const b = tileBBox(tile, TILE_DEG);
        const bbox = `${b.south},${b.west},${b.north},${b.east}`;
        // Обʼєднання фільтрів усіх категорій в один запит на тайл.
        const union = Object.values(QUERIES)
          .map((q) => q.replaceAll("{{bbox}}", bbox))
          .join("");
        const query = `[out:json][timeout:90];(${union});out center ${FACILITIES_PER_TILE};`;
        const elements = await overpass(query, controller.signal);
        const facilities: Facility[] = [];
        for (const el of elements) {
          const cat = categorize(el.tags ?? {});
          if (!cat) continue;
          const f = toFacility(el, cat);
          if (f) facilities.push(f);
        }
        // Порожній тайл теж кешуємо: над морем/за кордоном обʼєктів немає.
        facilityTiles.set(key, facilities);
        fetched.push({ key, facilities });
      }
    } catch (err) {
      console.error("facility tile failed", err);
    } finally {
      clearTimeout(timer);
    }

    return { tiles: fetched, tilesTotal: all.length };
  });

/*
 * Укриття навколо точки.
 *
 * Запит вузький і навмисно не кешується надовго в памʼяті процесу: на
 * Cloudflare Workers ізолят живе недовго, а сам запит малий (радіус кілька
 * кілометрів, не країна). Дані змінюються рідко, тож частота звернень
 * визначається людьми, а не таймером.
 */
export interface SheltersPayload {
  shelters: Shelter[];
  /**
   * Прямокутник ширший за розумний — консоль просить наблизити карту.
   *
   * Це окремий стан, а не помилка й не «нічого не знайдено»: обидва останні
   * читалися б як «тут укриттів немає», що неправда.
   */
  tooWide?: boolean;
  /** Межа покриття — інтерфейс мусить її показати. Див. shelters.ts. */
  caveat: string;
  degraded: boolean;
}

/** Півсторона прямокутника пошуку, градуси (~5.5 км по широті). */
const SHELTER_BOX_DEG = 0.05;

/**
 * Укриття навколо точки — звичайна функція, а не лише серверна.
 *
 * Бот ходить сюди з вебхука, консоль — через серверну функцію нижче. Один шлях
 * на двох: якби кожен мав свій, вони б розійшлися в тому, що вважають
 * укриттям, і людина отримала б у боті одну відповідь, а на карті іншу.
 */
export interface ShelterBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * Найбільший прямокутник, який має сенс питати, градуси по стороні.
 *
 * Не заради Overpass, а заради відповіді: на огляді всієї країни перелік
 * укриттів — це десятки тисяч точок, серед яких нічого не знайти, а сама
 * відповідь їхатиме хвилину. Понад цю межу консоль просить наблизити карту.
 */
export const SHELTER_MAX_SPAN_DEG = 0.9;

/**
 * Укриття в прямокутнику — звичайна функція, а не лише серверна.
 *
 * Бот ходить сюди з вебхука, консоль — через серверну функцію нижче. Один шлях
 * на двох: якби кожен мав свій, вони б розійшлися в тому, що вважають
 * укриттям, і людина отримала б у боті одну відповідь, а на карті іншу.
 */
export async function fetchSheltersBox(box: ShelterBox): Promise<SheltersPayload> {
  const finite =
    Number.isFinite(box.south) &&
    Number.isFinite(box.west) &&
    Number.isFinite(box.north) &&
    Number.isFinite(box.east);
  if (!finite || box.north <= box.south || box.east <= box.west) {
    return { shelters: [], caveat: COVERAGE_CAVEAT, degraded: true };
  }
  if (box.north - box.south > SHELTER_MAX_SPAN_DEG || box.east - box.west > SHELTER_MAX_SPAN_DEG) {
    // Занадто широко, щоб відповідь була корисною. Не помилка — стан.
    return { shelters: [], caveat: COVERAGE_CAVEAT, degraded: false, tooWide: true };
  }

  /*
   * Відповідь дає локальний набір, а не мережа.
   *
   * Заміряно на живому Overpass той самий запит по місту: то 10 секунд, то 45,
   * то не віддає зовсім. Залежність, яка гальмує саме тоді, коли на неї
   * спирається кнопка «куди сховатися», для аварійної функції не годиться —
   * сплеск навантаження на публічний Overpass і сплеск потреби в укриттях
   * трапляються з тих самих причин і в той самий час.
   *
   * Набір оновлюється окремим кроком (`scripts/build-shelters.mjs`), тож
   * мережа лишається джерелом ОНОВЛЕННЯ, а не джерелом відповіді людині.
   */
  const { sheltersInBox } = await import("./shelter-data");
  return { shelters: sheltersInBox(box), caveat: COVERAGE_CAVEAT, degraded: false };
}

/** Укриття навколо точки — те саме, але прямокутник будується сам. */
export async function fetchShelters(lat: number, lon: number): Promise<SheltersPayload> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { shelters: [], caveat: COVERAGE_CAVEAT, degraded: true };
  }
  return fetchSheltersBox({
    south: lat - SHELTER_BOX_DEG,
    west: lon - SHELTER_BOX_DEG,
    north: lat + SHELTER_BOX_DEG,
    east: lon + SHELTER_BOX_DEG,
  });
}

export const getShelters = createServerFn({ method: "GET" })
  .validator((input: unknown): ShelterBox => {
    const o = (input ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);
    return {
      south: num(o["south"]),
      west: num(o["west"]),
      north: num(o["north"]),
      east: num(o["east"]),
    };
  })
  .handler(async ({ data }): Promise<SheltersPayload> => fetchSheltersBox(data));
