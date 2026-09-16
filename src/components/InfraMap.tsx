import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  LayersControl,
  LayerGroup,
  CircleMarker,
  Circle,
  Marker,
  Popup,
  Polyline,
  Polygon,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import {
  type AlertZone,
  type FirePoint,
  type FrontlineArea,
  type Threat,
  type ThreatType,
} from "@/lib/air";
import {
  LEVEL_COLOR,
  LEVEL_LABEL,
  levelForOblast,
  raionsOf,
  reasonsFor,
  type AlertLevels,
} from "@/lib/alert-levels";
import { linkStyle, selectVisibleLinks } from "@/lib/map-links";
import { UA_OUTLINE } from "@/lib/ua-outline";
import { UA_OBLASTS } from "@/lib/ua-oblasts";
import { OBLASTS, type AlertRegion } from "@/lib/alerts";
import { citiesOnCourse } from "@/lib/threat-eta";
import { swarmForecast } from "@/lib/swarm-forecast";
import { forecastCone } from "@/lib/trajectory";
import { verifyThreat, type VerificationLevel } from "@/lib/advisory";
import { trackLatLngs, updateHistory, type FixPoint } from "@/lib/track-history";
import { fixedAtMs } from "@/lib/position-age";
import {
  CATEGORIES,
  EVENT_KINDS,
  type CategoryId,
  type Facility,
  type GraphEdge,
  type InfraEvent,
} from "@/lib/infra-types";
import { roleOfSource } from "@/lib/osint-sources";
import { KIND_EMOJI, KIND_LABEL, KIND_NOTE, type Shelter } from "@/lib/shelters";
import {
  courseIsObserved,
  displayRadiusKm,
  EMPTY_QUALITY,
  LIFECYCLE_LABEL,
  radiusIsStated,
} from "@/lib/threat-quality";

interface Props {
  facilities: Facility[];
  events: InfraEvent[];
  edges: GraphEdge[];
  alerts: AlertRegion[];
  zones: AlertZone[];
  /**
   * Рівні тривог по областях і районах. `null` — джерело не відповіло.
   *
   * Саме `null`, а не порожній обʼєкт: без рівнів зони малюються як досі,
   * одним кольором. Пофарбувати їх «спокійними» через мовчання джерела було б
   * твердженням, якого ми не маємо права робити.
   */
  alertLevels?: AlertLevels | null;
  threats: Threat[];
  frontline: FrontlineArea[];
  showFrontline: boolean;
  fires: FirePoint[];
  showFires: boolean;
  alarmIds: Set<string>;
  showLinks: boolean;
  riskIds: Set<string>;
  impactedIds: Set<string>;
  selectedId: string | null;
  onSelect: (f: Facility) => void;
  /** Укриття навколо точки перегляду. Порожньо — шар просто не малюється. */
  shelters?: Shelter[];
  /**
   * Куди людина зараз дивиться. Потрібне тим шарам, які вантажаться на вимогу
   * і мають сенс лише у видимому прямокутнику, а не навколо чогось обраного.
   */
  onViewport?: (
    box: { south: number; west: number; north: number; east: number },
    zoom: number,
  ) => void;
}

/**
 * Повідомляє назовні видимий прямокутник і масштаб.
 *
 * Окремим компонентом, бо хуки Leaflet працюють лише всередині `MapContainer`.
 * Перше повідомлення шлеться одразу після монтування: без нього шар, увімкнений
 * до першого руху карти, не дізнався б, де він, і мовчав би — саме так укриття
 * й не було видно.
 */
function ViewportReporter({
  onViewport,
}: {
  onViewport: (
    box: { south: number; west: number; north: number; east: number },
    zoom: number,
  ) => void;
}) {
  const map = useMap();
  const last = useRef("");
  const report = () => {
    const b = map.getBounds();
    const box = {
      // Округлення до сотої градуса (~1 км) — і не лише заради ключа запиту:
      // без нього кожен `moveend` перемальовував би весь маршрут дарма.
      south: Math.round(b.getSouth() * 100) / 100,
      west: Math.round(b.getWest() * 100) / 100,
      north: Math.round(b.getNorth() * 100) / 100,
      east: Math.round(b.getEast() * 100) / 100,
    };
    const zoom = map.getZoom();
    const key = `${box.south},${box.west},${box.north},${box.east},${zoom}`;
    if (key === last.current) return;
    last.current = key;
    onViewport(box, zoom);
  };
  useEffect(report, []);
  useMapEvents({ moveend: report, zoomend: report });
  return null;
}

/** Мінімальні SVG-гліфи (у стилі lucide) для кожної категорії. */
const ICON_PATHS: Record<CategoryId, string> = {
  power_plant: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  substation: '<path d="M12 2v20M6 8h12M8 22l4-14 4 14"/>',
  oil_gas: '<path d="M12 2s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
  dam: '<path d="M3 9h18v5H3z"/><path d="M7 14v5M12 14v5M17 14v5"/>',
  water: '<path d="M12 3s5 6 5 10a5 5 0 0 1-10 0c0-4 5-10 5-10z"/>',
  hospital: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>',
  fire_station:
    '<path d="M12 2c2 4-2 5 0 8 1-1 2-2 2-4 2 2 3 4 3 7a5 5 0 0 1-10 0c0-3 3-5 5-11z"/>',
  airport:
    '<path d="M17.8 19.2 16 11l3.5-3.5a2.1 2.1 0 0 0-3-3L13 8 4.8 6.2a1 1 0 0 0-.9 1.7l4.6 3.5-2 2.9H3l2 3 3 2v-2.5l2.9-2 3.5 4.6a1 1 0 0 0 1.7-.9z"/>',
  rail: '<rect x="4" y="3" width="16" height="13" rx="2"/><path d="M4 11h16M8 16l-2 4M16 16l2 4"/>',
  seaport: '<circle cx="12" cy="5" r="2"/><path d="M12 7v13M5 12a7 7 0 0 0 14 0M4 12h2M18 12h2"/>',
  border: '<path d="M4 22V4h13l-3 4 3 4H4"/>',
  telecom:
    '<path d="M12 11v11M8 8a5 5 0 0 1 8 0M5 5a9 9 0 0 1 14 0"/><circle cx="12" cy="10" r="1"/>',
  data_center:
    '<rect x="3" y="4" width="18" height="7" rx="1"/><rect x="3" y="13" width="18" height="7" rx="1"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  government: '<path d="M3 22h18M4 10h16M5 10 12 4l7 6M8 10v8M12 10v8M16 10v8"/>',
  grain: '<path d="M12 2v20M8 6c0 2 2 3 4 3M16 6c0 2-2 3-4 3M8 11c0 2 2 3 4 3M16 11c0 2-2 3-4 3"/>',
  industry: '<path d="M3 22V10l6 4V10l6 4V6l6 4v12z"/>',
};

/*
 * Позначка повітряної цілі. Тип (дрон/ракета/КАБ…) визначається з тексту
 * Telegram-каналів (getThreats), тож у кожного типу свій силует і колір — як у
 * kontursystems/neptun. Де типу з тексту дістати не вдалось — нейтральний
 * силует "unknown". Свіжість модулює розмір/яскравість/пульс: свіжий сигнал
 * світиться, давніший тьмяніє.
 */
type Freshness = "fresh" | "recent" | "stale";
function freshnessOf(iso: string | undefined): Freshness {
  if (!iso) return "stale";
  const min = (Date.now() - new Date(iso).getTime()) / 60000;
  if (min <= 10) return "fresh";
  if (min <= 30) return "recent";
  return "stale";
}

// Розміри підняті під телефон: на маленькому екрані позначка має читатися й
// бути придатною для дотику. Свіжі — найбільші, застарілі — дрібніші й тьмяні.
const FRESH_TONE: Record<Freshness, { opacity: number; size: number }> = {
  fresh: { opacity: 1, size: 32 },
  recent: { opacity: 0.9, size: 27 },
  stale: { opacity: 0.5, size: 21 },
};

/** Точка на відстані `km` за курсом `headingDeg` (0=Пн) — для вектора курсу. */
function destPoint(lat: number, lon: number, headingDeg: number, km: number): [number, number] {
  const th = (headingDeg * Math.PI) / 180;
  const dLat = (km * Math.cos(th)) / 111.32;
  const dLon = (km * Math.sin(th)) / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lon + dLon];
}
// Обласні центри для «на курсі: місто (~N хв)» у вікні цілі.
const CITY_CENTERS = Object.values(OBLASTS)
  .filter((o, i, arr) => arr.findIndex((x) => x.code === o.code) === i)
  .map((o) => ({ name: o.name, lat: o.lat, lon: o.lon }));

const COMPASS = ["Пн", "ПнСх", "Сх", "ПдСх", "Пд", "ПдЗх", "Зх", "ПнЗх"];
const compass = (d: number) => COMPASS[Math.round((((d % 360) + 360) % 360) / 45) % 8];

// Силует + колір за типом цілі. Кольори узгоджені зі звичною семантикою:
// БпЛА — жовтий, реактивний БпЛА — помаранчевий, ракети/балістика — червоне.
const TYPE_STYLE: Record<ThreatType, { color: string; glyph: string; label: string }> = {
  // Силует дельтакрилого БпЛА (Shahed-136), а не абстрактна стрілка: широке
  // дельтакрило, осьова фюзеляжна лінія і задня риска — штовхальний гвинт. Так
  // ціль упізнається як дрон з першого погляду, як на картах конкурентів.
  shahed: {
    color: "#ffd23f",
    glyph:
      '<path d="M12 2.5 L20 19.5 L12 15.5 L4 19.5 Z"/><path d="M12 5.5 L12 15"/><path d="M9 19 L15 19"/>',
    label: "Ударний БпЛА",
  },
  reactive: {
    color: "#ff8c1a",
    glyph: '<path d="M12 2l6 18-6-3.6L6 20z"/><path d="M12 5v11"/>',
    label: "Реактивний БпЛА",
  },
  cruise: {
    color: "#ff6a2a",
    glyph: '<path d="M3 12h13l5-2-5-2H3z"/><path d="M7 12l-2 4M11 12l-2 4"/>',
    label: "Крилата ракета",
  },
  missile: {
    color: "#ff4d4d",
    glyph: '<path d="M12 2c3.2 4 3.2 9 0 20-3.2-11-3.2-16 0-20z"/><path d="M9 16l-3 5M15 16l3 5"/>',
    label: "Ракета",
  },
  ballistic: {
    color: "#ff2d2d",
    glyph: '<path d="M12 1c3.4 4.5 3.4 10 0 22-3.4-12-3.4-17.5 0-22z"/>',
    label: "Балістика",
  },
  kab: { color: "#ffb020", glyph: '<path d="M12 3v11M8 14h8l-4 7z"/>', label: "КАБ" },
  recon: {
    color: "#22d3ee",
    glyph: '<path d="M12 4l8 8-8 8-8-8z"/><circle cx="12" cy="12" r="2"/>',
    label: "Розвід. БпЛА",
  },
  aircraft: { color: "#38bdf8", glyph: '<path d="M2 12l20-6-7 18-3-8z"/>', label: "Авіація" },
  unknown: {
    color: "#ffb020",
    glyph: '<path d="M12 3l7 16-7-3.6L5 19z"/>',
    label: "Повітряна ціль",
  },
};

// Колір і значок рівня верифікації (анти-фейк) для попапа цілі.
const VERIFICATION_COLOR: Record<VerificationLevel, string> = {
  official: "#34d399", // офіційне джерело — зелений
  corroborated: "#22d3ee", // підтверджено незалежними — блакитний
  single: "#fbbf24", // одне джерело — жовтий
  unverified: "#f87171", // надійність невідома — червоний
};
const VERIFICATION_MARK: Record<VerificationLevel, string> = {
  official: "★",
  corroborated: "✔",
  single: "?",
  unverified: "!",
};

const threatIconCache = new Map<string, L.DivIcon>();
/**
 * Позначка цілі, ПОВЕРНУТА за курсом. Гліфи намальовані вістрям на північ
 * (0°), тож поворот на `heading` градусів (за годинниковою) спрямовує їх
 * уздовж траєкторії — так само, як пунктирний вектор курсу. Раніше поворот не
 * застосовувався, і всі стрілки дивилися вгору незалежно від напрямку руху.
 *
 * `heading === null` — курсу ми не знаємо. Тоді НЕ вигадуємо напрямок: значок
 * без стрілки не бреше про рух (див. ROTATABLE).
 */
const ROTATABLE: Partial<Record<ThreatType, boolean>> = {
  shahed: true,
  reactive: true,
  missile: true,
  cruise: true,
  ballistic: true,
  kab: true,
  recon: true,
  aircraft: true,
};
/**
 * Значок цілі: тип, свіжість, курс. Кількості повідомлень тут немає навмисно.
 *
 * Лічильник висів просто на позначці й читався як щось про саму ціль — скільки
 * їх, скільки боєприпасів, наскільки вона небезпечна. Насправді це кількість
 * згадок у OSINT-каналах, тобто показник **упевненості джерела**, а не
 * властивість цілі. Число, яке на карті означає не те, що думає читач, гірше
 * за його відсутність: воно не додає знання, а підмінює його.
 *
 * Місце такого числа — у вікні цілі, поруч із поясненням, що воно означає.
 */
function threatIcon(type: ThreatType, fresh: Freshness, heading: number | null): L.DivIcon {
  // Курс округлюємо до 5° — досить для ока й тримає кеш маленьким.
  const rot =
    heading != null && ROTATABLE[type] ? Math.round((((heading % 360) + 360) % 360) / 5) * 5 : null;
  const key = `${type}|${fresh}|${rot ?? "x"}`;
  const cached = threatIconCache.get(key);
  if (cached) return cached;
  const { color, glyph } = TYPE_STYLE[type];
  const { opacity, size } = FRESH_TONE[fresh];
  const g = Math.round(size * 0.74);
  const pulse = fresh === "fresh" ? " air-tgt--pulse" : "";
  // Обертається лише гліф, а не контейнер: так позначка лишається на місці, а
  // за курсом дивиться саме форма цілі.
  const svgTransform = rot != null ? ` style="transform:rotate(${rot}deg)"` : "";
  const html = `<div class="air-tgt${pulse}" style="--air:${color};width:${size}px;height:${size}px;opacity:${opacity}">
<svg viewBox="0 0 24 24" width="${g}" height="${g}" fill="${color}" stroke="#0a0e14" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"${svgTransform}>${glyph}</svg></div>`;
  const icon = L.divIcon({
    html,
    className: "threat-pin",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
  threatIconCache.set(key, icon);
  return icon;
}

/**
 * Прибирає рекламний префікс «Leaflet» з атрибуції — лишається лише кредит
 * даних (Esri/OSM), якого вимагає ліцензія. Саме посилання «Leaflet» на карті
 * зайве й ще й налазило на стрічку внизу.
 */
function AttributionPrefixOff() {
  const map = useMap();
  useEffect(() => {
    map.attributionControl?.setPrefix(false);
  }, [map]);
  return null;
}

/**
 * Куди можна доїхати зумом.
 *
 * `MAX_ZOOM` — межа САМОЇ карти, `maxNativeZoom` — до якого зуму в підкладки
 * взагалі є плитки. Різниця між ними і є те, чого бракувало: темна підкладка
 * має плитки лише до 16, і без `maxNativeZoom` Leaflet просто зупиняв зум на
 * цьому числі. Тобто наблизитись до будинку було неможливо не через дані про
 * цілі, а через підкладку.
 *
 * З `maxNativeZoom` карта наближається далі, розтягуючи останню наявну плитку:
 * підкладка стає розмитою, а позначка цілі лишається на своєму місці з повною
 * точністю. Розмита підкладка чесно показує, що детальнішої картинки НЕМАЄ, —
 * і це краще, ніж упертись у стелю й не побачити нічого.
 */
const MAX_ZOOM = 19;

/**
 * З якого зуму усталений шар переходить на супутник.
 *
 * Чотирнадцять — там, де схема вже перестає додавати (окремі вулиці видно) і
 * починає бракувати знімка: саме з цього масштабу питання стає «над яким
 * будинком», а не «над яким містом».
 */
const SAT_FROM_ZOOM = 14;

function BaseLayers() {
  return (
    <LayersControl position="topright">
      {/*
        Усталений шар передає естафету сам: темна схема на огляді країни,
        супутник — щойно наближаєшся.
        
        Підняти стелю зуму було мало. Темний канвас — це СХЕМА, знімків у ньому
        немає взагалі: розтягнута плитка на глибокому зумі дає просто темряву,
        і питання «над яким будинком летить» лишалось без відповіді. Тому з
        чотирнадцятого зуму під позначками зʼявляється супутниковий знімок —
        той самий, що й у шарі «Супутник», лише без потреби його шукати.
        
        Окремі шари «Темна» і «Супутник» лишились: хто хоче тримати одне й те
        саме на всіх зумах, обере вручну.
      */}
      <LayersControl.BaseLayer checked name="Авто: схема + супутник">
        <LayerGroup>
          <TileLayer
            attribution="&copy; Esri"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
            maxNativeZoom={16}
            maxZoom={SAT_FROM_ZOOM - 1}
          />
          <TileLayer
            attribution="Imagery &copy; Esri, Maxar, Earthstar Geographics"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            minZoom={SAT_FROM_ZOOM}
            maxNativeZoom={18}
            maxZoom={MAX_ZOOM}
          />
        </LayerGroup>
      </LayersControl.BaseLayer>
      <LayersControl.BaseLayer name="Темна">
        <TileLayer
          attribution="&copy; Esri"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
          maxNativeZoom={16}
          maxZoom={MAX_ZOOM}
        />
      </LayersControl.BaseLayer>
      <LayersControl.BaseLayer name="Супутник">
        <TileLayer
          attribution="Imagery &copy; Esri, Maxar, Earthstar Geographics"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          maxNativeZoom={18}
          maxZoom={MAX_ZOOM}
        />
      </LayersControl.BaseLayer>
      <LayersControl.BaseLayer name="Гібрид (мітки)">
        <TileLayer
          attribution="Labels &copy; Esri"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
          maxNativeZoom={18}
          maxZoom={MAX_ZOOM}
        />
      </LayersControl.BaseLayer>
      <LayersControl.BaseLayer name="Схема (OSM)">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxNativeZoom={19}
          maxZoom={MAX_ZOOM}
        />
      </LayersControl.BaseLayer>
      {/*
       * Межі областей і назви міст — постійним накладним шаром, увімкненим за
       * замовчуванням. Базовий «Canvas» майже не показує адмінмеж на малому
       * зумі, тож країна виглядала суцільною плямою. Довідковий шар Esri
       * (Dark Gray Reference) домальовує адмінкордони й підписи міст поверх
       * будь-якої підкладки в тон темної теми, на всіх зумах. Це overlay, тож
       * його видно завжди, а не замість базового шару; кому заважає — вимкне.
       */}
      <LayersControl.Overlay checked name="Межі областей і міста">
        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
          maxNativeZoom={18}
          maxZoom={MAX_ZOOM}
        />
      </LayersControl.Overlay>
    </LayersControl>
  );
}

const iconCache = new Map<string, L.DivIcon>();
function facilityIcon(
  category: CategoryId,
  state: { selected: boolean; danger: boolean; warn: boolean },
): L.DivIcon {
  const key = `${category}|${state.selected ? 1 : 0}|${state.danger ? 1 : 0}|${state.warn ? 1 : 0}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const color = CATEGORIES[category].color;
  const ring = state.danger ? "#ff4d4d" : state.warn ? "#ff9900" : "rgba(255,255,255,.28)";
  const size = state.selected ? 30 : 22;
  const g = size * 0.58;
  const html = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 ${state.danger || state.warn ? 2.5 : 1.5}px ${ring},0 1px 5px rgba(0,0,0,.8)">
<svg viewBox="0 0 24 24" width="${g}" height="${g}" fill="none" stroke="#0a0e14" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[category]}</svg></div>`;
  const icon = L.divIcon({
    html,
    className: "infra-pin",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
  iconCache.set(key, icon);
  return icon;
}

function clusterIcon(count: number): L.DivIcon {
  const size = count > 200 ? 46 : count > 50 ? 40 : count > 10 ? 34 : 28;
  const html = `<div style="width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(10,14,20,.82);border:1.5px solid rgba(34,211,238,.7);color:#67e8f9;font:600 ${size > 36 ? 12 : 11}px 'JetBrains Mono',monospace;box-shadow:0 0 12px rgba(34,211,238,.25)">${count}</div>`;
  return L.divIcon({
    html,
    className: "infra-cluster",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/** Бурштинова купка повітряних цілей на огляді країни (за масштабом). */
function threatClusterIcon(count: number): L.DivIcon {
  const size = count > 50 ? 42 : count > 20 ? 36 : count > 8 ? 32 : 26;
  const html = `<div style="width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(20,12,4,.85);border:1.5px solid rgba(255,160,32,.85);color:#ffb020;font:700 ${size > 34 ? 12 : 11}px 'JetBrains Mono',monospace;box-shadow:0 0 12px rgba(255,153,0,.35)">${count}</div>`;
  return L.divIcon({
    html,
    className: "infra-cluster",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function FacilityPopup({ f }: { f: Facility }) {
  const meta = CATEGORIES[f.category];
  return (
    <Popup>
      <div className="space-y-1 font-sans text-xs">
        <p className="font-semibold">{f.name}</p>
        <p className="opacity-70">{meta.label}</p>
        {f.operator ? <p className="opacity-70">Оператор: {f.operator}</p> : null}
        {f.detail ? <p className="opacity-70">{f.detail}</p> : null}
        <a href={f.source} target="_blank" rel="noreferrer" className="underline">
          Джерело
        </a>
      </div>
    </Popup>
  );
}

interface Cluster {
  lat: number;
  lon: number;
  count: number;
}

function gridClusters(facilities: { lat: number; lon: number }[], zoom: number): Cluster[] {
  const step = zoom <= 5 ? 1.3 : zoom === 6 ? 0.8 : 0.45;
  const cells = new Map<string, { lat: number; lon: number; count: number }>();
  for (const f of facilities) {
    const gy = Math.round(f.lat / step);
    const gx = Math.round(f.lon / step);
    const key = `${gy}|${gx}`;
    const c = cells.get(key);
    if (c) {
      c.lat += f.lat;
      c.lon += f.lon;
      c.count++;
    } else {
      cells.set(key, { lat: f.lat, lon: f.lon, count: 1 });
    }
  }
  return [...cells.values()].map((c) => ({
    lat: c.lat / c.count,
    lon: c.lon / c.count,
    count: c.count,
  }));
}

/** Обʼєкти: кластери на огляді країни, іконки з прорідженням при наближенні. */
function FacilityLayer({
  facilities,
  riskIds,
  impactedIds,
  selectedId,
  onSelect,
}: {
  facilities: Facility[];
  riskIds: Set<string>;
  impactedIds: Set<string>;
  selectedId: string | null;
  onSelect: (f: Facility) => void;
}) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  const [bounds, setBounds] = useState<L.LatLngBounds>(map.getBounds());
  useMapEvents({
    zoomend: () => {
      setZoom(map.getZoom());
      setBounds(map.getBounds());
    },
    moveend: () => setBounds(map.getBounds()),
  });

  // На огляді країни — кластери (щоб не було каші з точок).
  if (zoom < 8) {
    const clusters = gridClusters(facilities, zoom);
    return (
      <>
        {clusters.map((c, i) => (
          <Marker
            key={`cl-${i}`}
            position={[c.lat, c.lon]}
            icon={clusterIcon(c.count)}
            eventHandlers={{
              click: () => map.flyTo([c.lat, c.lon], Math.min(zoom + 3, 10), { duration: 0.6 }),
            }}
          />
        ))}
      </>
    );
  }

  // Наближено — реальні іконки, лише у видимій області, з пріоритетом небезпечних.
  const inView = facilities.filter((f) => bounds.contains([f.lat, f.lon]));
  const sorted = inView.sort((a, b) => {
    const da = (riskIds.has(a.id) ? 2 : 0) + (a.id === selectedId ? 4 : 0);
    const db = (riskIds.has(b.id) ? 2 : 0) + (b.id === selectedId ? 4 : 0);
    return db - da;
  });
  const capped = sorted.slice(0, 500);

  return (
    <>
      {capped.map((f) => (
        <Marker
          key={f.id}
          position={[f.lat, f.lon]}
          icon={facilityIcon(f.category, {
            selected: selectedId === f.id,
            danger: riskIds.has(f.id),
            warn: impactedIds.has(f.id),
          })}
          eventHandlers={{ click: () => onSelect(f) }}
        >
          <FacilityPopup f={f} />
        </Marker>
      ))}
    </>
  );
}

/*
 * Шар повітряних цілей. На огляді країни згортає позначки в бурштинові купки за
 * масштабом (щоб не було сотні стрілок), при наближенні — окремі силуети за
 * типом (дрон/ракета/КАБ), із свіжістю як індикатором актуальності.
 */
/**
 * Конус прогнозу руху рою на карті — просторова пара до текстової панелі
 * «Прогноз руху рою». Малюємо ОДИН чесний коридор лише коли рій когерентний
 * (летить разом): усереднювати курс розсипаних цілей в одну стрілку — брехня,
 * тож при низькій злагодженості конуса немає (текст тоді каже «урізнобіч»).
 *
 * Оцінка — та сама, що в панелі (swarm-forecast: відсів стрибків, лише
 * спостережений курс), тож карта й панель не можуть розійтися.
 */
function ForecastCone({ threats }: { threats: Threat[] }) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  const model = useMemo(() => swarmForecast(threats, Date.now()), [threats]);
  if (zoom < 7 || !model || model.swarm.coherence < 0.6) return null;
  const cone = forecastCone(model.centroid, model.swarm);
  return (
    <>
      <Polygon
        positions={cone.ring}
        pathOptions={{
          stroke: false,
          fillColor: "#22d3ee",
          fillOpacity: 0.08,
          interactive: false,
        }}
      />
      <Polyline
        positions={cone.centerline}
        pathOptions={{
          color: "#22d3ee",
          weight: 1.5,
          opacity: 0.7,
          dashArray: "6 6",
          interactive: false,
        }}
      />
    </>
  );
}

function ThreatLayer({ threats }: { threats: Threat[] }) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  const [bounds, setBounds] = useState<L.LatLngBounds>(map.getBounds());
  useMapEvents({
    zoomend: () => {
      setZoom(map.getZoom());
      setBounds(map.getBounds());
    },
    moveend: () => setBounds(map.getBounds()),
  });

  /*
   * Спостережений трек: власні фікси плюс трек самого джерела.
   *
   * Кожна точка несе час СПОСТЕРЕЖЕННЯ, а не час опитування. Інакше лінія
   * малює рух за вигаданий інтервал: застій позиції у фіді заміряно від 38 до
   * 674 секунд, і два опитування з різним застоєм дають хибну швидкість на тій
   * самій відстані.
   */
  const historyRef = useRef<Map<string, FixPoint[]>>(new Map());
  useEffect(() => {
    historyRef.current = updateHistory(
      historyRef.current,
      threats.map((t) => ({
        id: t.id,
        lat: t.lat,
        lon: t.lon,
        observedAt: fixedAtMs(t) ?? undefined,
        ...(t.trail ? { trail: t.trail } : {}),
      })),
      Date.now(),
    );
  }, [threats]);

  if (zoom < 7) {
    const clusters = gridClusters(threats, zoom);
    return (
      <>
        {clusters.map((c, i) => (
          <Marker
            key={`tc-${i}`}
            position={[c.lat, c.lon]}
            icon={threatClusterIcon(c.count)}
            zIndexOffset={800}
            eventHandlers={{
              click: () => map.flyTo([c.lat, c.lon], Math.min(zoom + 3, 10), { duration: 0.6 }),
            }}
          />
        ))}
      </>
    );
  }

  const inView = threats.filter((t) => bounds.contains([t.lat, t.lon]));
  return (
    <>
      {inView.map((t) => {
        const seen = t.lastSeen ?? t.since;
        const fresh = freshnessOf(seen);
        const type: ThreatType = t.type ?? "unknown";
        const style = TYPE_STYLE[type];
        const hasCourse = typeof t.heading === "number" && Number.isFinite(t.heading);
        const vecEnd = hasCourse ? destPoint(t.lat, t.lon, t.heading as number, 16) : null;
        // Спостережений трек (де ціль реально була) — СУЦІЛЬНА лінія; вектор
        // курсу вперед — ПУНКТИР (екстраполяція, а не факт). Це прибирає
        // хибну паніку: пунктир прямо каже «це припущення, не трек».
        /*
         * Трек беремо з двох джерел і саме в такому порядку.
         *
         * `neptun` віддає `trail` — уже зафіксовані положення цілі, — і це
         * краще за накопичене нами: воно є з ПЕРШОГО кадру, а власна історія
         * набирається хвилинами опитувань, тобто рівно тоді, коли вона вже не
         * потрібна. Накопичене лишається як доповнення: сесія триває довше за
         * вікно, яке віддає джерело.
         */
        const fromSource = (t.trail ?? []).map((p) => [p.lat, p.lon] as [number, number]);
        const accumulated = trackLatLngs(historyRef.current.get(t.id));
        const observed = fromSource.length >= 2 ? fromSource : accumulated;

        /*
         * Коло невизначеності. Джерело саме каже, з якою точністю знає
         * позицію — від 4 до 45 км, — і крапка на карті це приховувала:
         * позначка ±45 км виглядала так само впевнено, як ±4 км.
         *
         * Коло не «прикрашає» позначку, воно її виправляє: ціль десь у цьому
         * колі, і рішення людини має спиратися на коло, а не на його центр.
         */
        const q = t.quality ?? EMPTY_QUALITY;
        const radiusKm = displayRadiusKm(q);
        const courseObserved = courseIsObserved(q);
        return (
          <Fragment key={t.id}>
            <Circle
              center={[t.lat, t.lon]}
              radius={radiusKm * 1000}
              pathOptions={{
                color: style.color,
                weight: 1,
                opacity: fresh === "stale" ? 0.18 : 0.35,
                fillColor: style.color,
                fillOpacity: fresh === "stale" ? 0.03 : 0.07,
                // Заявлений джерелом радіус — суцільний контур; наше
                // консервативне припущення, коли джерело промовчало, —
                // пунктир. Різницю видно, не читаючи попап.
                ...(radiusIsStated(q) ? {} : { dashArray: "3 6" }),
              }}
            />
            {observed.length >= 2 ? (
              <Polyline
                positions={observed}
                pathOptions={{
                  color: style.color,
                  weight: 2,
                  opacity: fresh === "stale" ? 0.4 : 0.85,
                }}
              />
            ) : null}
            {vecEnd ? (
              <Polyline
                positions={[[t.lat, t.lon], vecEnd]}
                pathOptions={{
                  color: style.color,
                  // Припущений курс джерело позначає окремо, і таких цілей
                  // більшість: у живій відповіді — вісім із пʼятнадцяти. Досі
                  // вони малювалися так само впевнено, як спостережені, тож
                  // половина стрілок на карті була здогадкою без жодної ознаки.
                  weight: courseObserved ? 1.6 : 1,
                  opacity: (fresh === "stale" ? 0.3 : 0.6) * (courseObserved ? 1 : 0.6),
                  dashArray: courseObserved ? "5 5" : "2 7",
                }}
              />
            ) : null}
            <Marker
              position={[t.lat, t.lon]}
              icon={threatIcon(type, fresh, hasCourse ? (t.heading as number) : null)}
              zIndexOffset={fresh === "fresh" ? 1000 : fresh === "recent" ? 500 : 0}
            >
              <Popup>
                <div className="space-y-1 font-sans text-xs">
                  <p className="font-semibold" style={{ color: style.color }}>
                    {style.label}
                    {fresh === "fresh" ? " · свіжа" : fresh === "stale" ? " · застаріла" : ""}
                  </p>
                  <p className="opacity-80">{t.name}</p>
                  <p className="opacity-70">
                    {/*
                      Число названо тим, чим воно є: скільки каналів сказали про
                      цю ціль. Це впевненість джерела, а не властивість цілі, —
                      і саме тому воно тут, а не на позначці.
                    */}
                    {t.reports && t.reports > 1
                      ? `Підтверджень: ${t.reports} · канали: `
                      : "Канал: "}
                    {t.sources && t.sources.length ? t.sources.join(", ") : t.source}
                  </p>
                  {hasCourse ? (
                    <p className="opacity-70">
                      Курс: {compass(t.heading as number)} ({Math.round(t.heading as number)}°)
                      {courseObserved ? "" : " · припущений джерелом"}
                    </p>
                  ) : null}
                  <p className="opacity-70">
                    Позиція:{" "}
                    {radiusIsStated(q)
                      ? `±${Math.round(radiusKm)} км`
                      : `±~${radiusKm} км (джерело не вказало)`}
                    {q.lifecycle ? ` · ${LIFECYCLE_LABEL[q.lifecycle]}` : ""}
                  </p>
                  {q.speedKmh !== null ? (
                    <p className="opacity-70">
                      Швидкість: {Math.round(q.speedKmh)} км/год (заміряна)
                    </p>
                  ) : null}
                  {t.sea ? <p className="opacity-70">Над морем</p> : null}
                  {hasCourse
                    ? (() => {
                        const onCourse = citiesOnCourse(t, CITY_CENTERS);
                        return onCourse.length ? (
                          <p className="text-amber-300/90">
                            На курсі:{" "}
                            {onCourse.map((c) => `${c.name} (~${c.etaMin} хв)`).join(", ")}
                          </p>
                        ) : null;
                      })()
                    : null}
                  {observed.length >= 2 || vecEnd ? (
                    <p className="opacity-60 text-[11px] leading-snug">
                      {observed.length >= 2
                        ? `── трек (де була${fromSource.length >= 2 ? ", з джерела" : ""}) · `
                        : ""}
                      {vecEnd ? "╌╌ курс (екстраполяція, не факт)" : ""}
                    </p>
                  ) : null}
                  {(() => {
                    // Анти-фейк: наскільки цій позначці можна вірити, словами
                    // й кольором. Одиночне непідтверджене повідомлення не має
                    // виглядати як підтверджена ціль.
                    const v = verifyThreat(t, roleOfSource);
                    return (
                      <p className="font-medium" style={{ color: VERIFICATION_COLOR[v.level] }}>
                        {VERIFICATION_MARK[v.level]} {v.label}
                        {v.independentSources > 1 ? ` · ${v.independentSources} незалежних` : ""}
                      </p>
                    );
                  })()}
                  {t.confidence ? <p className="opacity-70">Впевненість: {t.confidence}</p> : null}
                  {seen ? (
                    <p className="opacity-70">
                      Останній сигнал: {new Date(seen).toLocaleString("uk-UA")}
                    </p>
                  ) : null}
                  {type === "unknown" ? (
                    <p className="opacity-50">Тип не визначено з тексту OSINT-каналів</p>
                  ) : null}
                </div>
              </Popup>
            </Marker>
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * Маска-прожектор: усе поза Україною трохи притемнюється, щоб країна читалася
 * серед сусідів. Зовнішнє кільце — увесь світ, дірка — контур України; Leaflet
 * малює полігон із діркою, тож затемнюється лише зовнішнє.
 */
const WORLD_RING: [number, number][] = [
  [-89, -179],
  [89, -179],
  [89, 179],
  [-89, 179],
];

function FlyTo({ facility }: { facility: Facility | null }) {
  const map = useMap();
  useEffect(() => {
    if (facility)
      map.flyTo([facility.lat, facility.lon], Math.max(map.getZoom(), 10), { duration: 0.7 });
  }, [facility, map]);
  return null;
}

/**
 * Окупована територія і повітряна тривога — різні речі й мають виглядати
 * по-різному. Тон приглушений навмисно: насичений червоний лишається за
 * тривогою, бо на карті має бути рівно один колір, що означає «зараз».
 */
const OCCUPIED_FILL = "#4a1b24";
const OCCUPIED_EDGE = "#9c5561";
const ALERT_EDGE = "#ff4d4d";

export default function InfraMap({
  facilities,
  events,
  edges,
  alerts,
  zones,
  alertLevels = null,
  threats,
  frontline,
  showFrontline,
  fires,
  showFires,
  showLinks,
  riskIds,
  impactedIds,
  selectedId,
  onSelect,
  shelters = [],
  onViewport,
}: Props) {
  const byId = useMemo(() => new Map(facilities.map((f) => [f.id, f])), [facilities]);
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  /*
   * Стеля на кількість ліній лишається — кілька тисяч полілайнів у Leaflet
   * помітно гальмують карту. Але відкидання більше не випадкове: раніше
   * бралися перші 1200 у порядку масиву, тож реальна лінія 330 кВ могла
   * зникнути, а здогадка «найближча підстанція» лишитися. Тепер ховаються
   * припущення, а факти показуються завжди.
   */
  const lines = useMemo(() => {
    if (!showLinks) return [];
    const drawable = edges.filter((e) => byId.has(e.from) && byId.has(e.to));
    return selectVisibleLinks(drawable, 3000).visible.map((e) => ({
      e,
      a: byId.get(e.from)!,
      b: byId.get(e.to)!,
    }));
  }, [edges, byId, showLinks]);

  return (
    <MapContainer
      center={[48.6, 31.2]}
      zoom={6}
      minZoom={5}
      maxZoom={MAX_ZOOM}
      scrollWheelZoom
      className="size-full"
      style={{ background: "#0a0e14" }}
    >
      <AttributionPrefixOff />
      <BaseLayers />

      {/*
        Підсвічування України серед сусідів. Дві частини: легка маска, що
        притемнює все ЗА межами країни (полігон світу з діркою-Україною), і
        чіткий контур самого кордону. Це орієнтир, а не юридична межа —
        координати спрощені (див. ua-outline.ts).
      */}
      <Polygon
        positions={[WORLD_RING, UA_OUTLINE]}
        pathOptions={{ stroke: false, fillColor: "#050810", fillOpacity: 0.5, interactive: false }}
      />
      {/*
        Межі областей — тонкою лінією, завжди. Орієнтир, не юридичні межі
        (спрощено, див. ua-oblasts.ts). Дає читабельну мапу областей на будь-якій
        підкладці, не покладаючись на підписи тайлів Esri.
      */}
      {UA_OBLASTS.map((ring, i) => (
        <Polyline
          key={`oblast-${i}`}
          positions={ring}
          pathOptions={{ color: "#3b5566", weight: 0.8, opacity: 0.5, interactive: false }}
        />
      ))}
      <Polyline
        positions={UA_OUTLINE}
        pathOptions={{ color: "#22d3ee", weight: 1.5, opacity: 0.6, interactive: false }}
      />

      {/*
        Окупована територія — під усіма іншими шарами.

        Колір НЕ береться з джерела. DeepState віддає власний `stroke`
        червонуватим, і він збігався з червоним повітряної тривоги: два шари з
        різним сенсом і різним часом життя виглядали однаково, а разом давали
        суцільну червону пляму, у якій не читався жоден з них.

        Тут територія — суцільна приглушена маса (те, що тримають місяцями),
        тривога нижче — пунктирний контур (те, що минає за годину). Різниця і
        за тоном, і за накресленням: одного тону замало, якщо дивитися з
        телефона на сонці або не розрізняти червоне з зеленим.
      */}
      {showFrontline
        ? frontline.flatMap((a, ai) =>
            a.polygons.map((ring, i) => (
              <Polygon
                key={`fl-${ai}-${i}`}
                positions={ring}
                pathOptions={{
                  color: OCCUPIED_EDGE,
                  fillColor: OCCUPIED_FILL,
                  fillOpacity: 0.42,
                  weight: 1,
                  opacity: 0.85,
                }}
              >
                <Popup>
                  <div className="font-sans text-xs">
                    <p className="font-semibold">Окупована територія</p>
                    {a.status ? <p className="opacity-80">{a.status}</p> : null}
                    <p className="opacity-60">Джерело: DeepState Map</p>
                  </div>
                </Popup>
              </Polygon>
            )),
          )
        : null}

      {/* Активні пожежі (NASA FIRMS): теплові аномалії за 24 год */}
      {showFires
        ? fires.map((f, i) => {
            const hot = f.frp >= 30;
            const color = hot ? "#ff3b30" : f.frp >= 8 ? "#ff7a1a" : "#ffb020";
            return (
              <CircleMarker
                key={`fire-${i}`}
                center={[f.lat, f.lon]}
                radius={hot ? 5 : 3.5}
                pathOptions={{
                  color,
                  fillColor: color,
                  fillOpacity: 0.55,
                  weight: 1,
                  opacity: 0.85,
                }}
              >
                <Popup>
                  <div className="space-y-0.5 font-sans text-xs">
                    <p className="font-semibold" style={{ color }}>
                      Теплова аномалія (пожежа)
                    </p>
                    <p className="opacity-80">
                      FRP {Math.round(f.frp)} МВт · впевненість {f.confidence || "—"}
                    </p>
                    <p className="opacity-70">
                      {f.acqDate} {f.acqTime} UTC · {f.daynight === "N" ? "ніч" : "день"}
                    </p>
                    <p className="opacity-60">Джерело: NASA FIRMS (24 год)</p>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })
        : null}

      {/* Зони тривог: реальні полігони регіонів, або кола-фолбек */}
      {zones.length > 0
        ? zones.flatMap((z) => {
            /*
             * Колір за РІВНЕМ, а не один на всі тривоги. Жовтий і червоний —
             * це не «слабше/сильніше», а різний запас часу: дрон лишає час
             * дійти до укриття, ракета — ні. Коли рівня не знаємо, лишається
             * попередній єдиний колір: вигаданий рівень гірший за його брак.
             */
            const level = alertLevels ? levelForOblast(alertLevels, z.region) : null;
            const color = level ? LEVEL_COLOR[level] : ALERT_EDGE;
            const reasons = alertLevels ? reasonsFor(alertLevels, z.region) : [];
            const raions = alertLevels ? raionsOf(alertLevels, z.region) : [];
            return z.polygons.map((ring, i) => (
              <Polygon
                key={`zone-${z.region}-${i}`}
                positions={ring}
                pathOptions={{
                  color,
                  fillColor: color,
                  fillOpacity: level === "red" ? 0.1 : 0.05,
                  weight: 1.2,
                  // Пунктир — стан, що минає. Суцільна лінія нижче належить
                  // території, яку тримають місяцями.
                  dashArray: "5 4",
                }}
              >
                <Popup>
                  <div className="space-y-1 font-sans text-xs">
                    <p className="font-semibold" style={{ color }}>
                      Повітряна тривога
                      {level ? ` · ${LEVEL_LABEL[level]}` : ""}
                    </p>
                    <p className="opacity-80">{z.region}</p>
                    {/* Причина головніша за колір: вона й каже, що робити. */}
                    {reasons.map((r) => (
                      <p key={r} className="opacity-70">
                        {r}
                      </p>
                    ))}
                    {raions.length > 0 ? (
                      <p className="opacity-60">Райони: {raions.map((a) => a.name).join(", ")}</p>
                    ) : null}
                    {z.type && reasons.length === 0 ? <p className="opacity-60">{z.type}</p> : null}
                  </div>
                </Popup>
              </Polygon>
            ));
          })
        : alerts
            .filter((r) => r.active)
            .map((r) => (
              <Circle
                key={`alarm-${r.code}`}
                center={[r.lat, r.lon]}
                radius={62000}
                pathOptions={{
                  color: "#ff4d4d",
                  fillColor: "#ff4d4d",
                  fillOpacity: 0.1,
                  weight: 1.2,
                  dashArray: "5 5",
                }}
              />
            ))}

      {lines.map(({ e, a, b }) => (
        <Polyline
          key={`${e.from}-${e.to}`}
          positions={[
            [a.lat, a.lon],
            [b.lat, b.lon],
          ]}
          // Стиль за походженням, а не за видом звʼязку: на головному екрані
          // факт і здогадка не мають виглядати однаково.
          pathOptions={linkStyle(e, { impacted: impactedIds.has(e.to) })}
        />
      ))}

      {events.map((ev) => (
        <CircleMarker
          key={ev.id}
          center={[ev.lat, ev.lon]}
          radius={10}
          pathOptions={{
            color: EVENT_KINDS[ev.kind].color,
            fillColor: EVENT_KINDS[ev.kind].color,
            fillOpacity: 0.14,
            weight: 1.6,
            dashArray: "3 3",
          }}
        >
          <Popup>
            <div className="space-y-1 font-sans text-xs">
              <p className="font-semibold">{ev.title}</p>
              <p className="opacity-70">
                {EVENT_KINDS[ev.kind].label} · {new Date(ev.time).toLocaleString("uk-UA")}
              </p>
              <p className="opacity-70">Джерело: {ev.source}</p>
              {ev.url ? (
                <a href={ev.url} target="_blank" rel="noreferrer" className="underline">
                  Першоджерело
                </a>
              ) : null}
            </div>
          </Popup>
        </CircleMarker>
      ))}

      <FacilityLayer
        facilities={facilities}
        riskIds={riskIds}
        impactedIds={impactedIds}
        selectedId={selectedId}
        onSelect={onSelect}
      />

      {/* Повітряні цілі (OSINT) — з кластеризацією за масштабом */}
      <ForecastCone threats={threats} />
      <ThreatLayer threats={threats} />

      <FlyTo facility={selected} />
      {onViewport ? <ViewportReporter onViewport={onViewport} /> : null}

      {/*
        Укриття. Зелене — єдиний зелений шар на карті, і це навмисно: усе
        інше тут про загрозу, а це єдине, що про порятунок. Підпис у попапі
        каже, ЩО це насправді: станція метро й підземний паркінг дають різний
        захист, і зрівняти їх кольором означало б збрехати кольором.
      */}
      {shelters.map((sh) => (
        <CircleMarker
          key={sh.id}
          center={[sh.lat, sh.lon]}
          radius={sh.kind === "shelter" ? 6 : 4}
          pathOptions={{
            color: "#34d399",
            weight: sh.kind === "shelter" ? 2 : 1.2,
            fillColor: "#34d399",
            fillOpacity: sh.kind === "underground" ? 0.25 : 0.5,
          }}
        >
          <Popup>
            <div className="space-y-1 font-sans text-xs">
              <p className="font-semibold text-emerald-600">
                {KIND_EMOJI[sh.kind]} {KIND_LABEL[sh.kind]}
              </p>
              <p>{sh.name}</p>
              <p className="opacity-70">{KIND_NOTE[sh.kind]}</p>
              {sh.capacity ? <p className="opacity-70">Місткість: {sh.capacity}</p> : null}
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
