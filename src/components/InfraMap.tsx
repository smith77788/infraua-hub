import { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  TileLayer,
  LayersControl,
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

import { type AlertZone, type Threat } from "@/lib/air";
import { linkStyle, selectVisibleLinks } from "@/lib/map-links";
import { type AlertRegion } from "@/lib/alerts";
import {
  CATEGORIES,
  EVENT_KINDS,
  type CategoryId,
  type Facility,
  type GraphEdge,
  type InfraEvent,
} from "@/lib/infra-types";

interface Props {
  facilities: Facility[];
  events: InfraEvent[];
  edges: GraphEdge[];
  alerts: AlertRegion[];
  zones: AlertZone[];
  threats: Threat[];
  alarmIds: Set<string>;
  showLinks: boolean;
  riskIds: Set<string>;
  impactedIds: Set<string>;
  selectedId: string | null;
  onSelect: (f: Facility) => void;
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
 * Позначка повітряної цілі. Джерело (detoyshahed) віддає лише пункт і час, без
 * типу цілі й курсу, тож гліф один — розпізнаваний силует загрози з повітря,
 * навмисно НЕ схожий на кружечки обʼєктів чи подій. Колір бурштиновий, щоб не
 * зливатися з червоним (обʼєкти під загрозою / зони тривог).
 *
 * Свіжість несе основну інформацію цього джерела: свіжий сигнал світиться й
 * пульсує, давніший — тьмяніє. Так на карті видно живу хвилю, а не 2-годинний
 * осад міток.
 */
type Freshness = "fresh" | "recent" | "stale";
function freshnessOf(iso: string | undefined): Freshness {
  if (!iso) return "stale";
  const min = (Date.now() - new Date(iso).getTime()) / 60000;
  if (min <= 10) return "fresh";
  if (min <= 30) return "recent";
  return "stale";
}

const AIR_TONE: Record<Freshness, { color: string; opacity: number; size: number }> = {
  fresh: { color: "#ffb020", opacity: 1, size: 26 },
  recent: { color: "#ff9900", opacity: 0.92, size: 22 },
  stale: { color: "#a86a2a", opacity: 0.55, size: 18 },
};

const threatIconCache = new Map<string, L.DivIcon>();
function threatIcon(fresh: Freshness, reports: number): L.DivIcon {
  const badge = reports > 1 ? Math.min(reports, 99) : 0;
  const key = `${fresh}|${badge}`;
  const cached = threatIconCache.get(key);
  if (cached) return cached;
  const { color, opacity, size } = AIR_TONE[fresh];
  const g = Math.round(size * 0.72);
  const pulse = fresh === "fresh" ? " air-tgt--pulse" : "";
  const badgeHtml =
    badge > 0
      ? `<b style="position:absolute;top:-5px;right:-5px;min-width:13px;height:13px;padding:0 2px;border-radius:7px;background:${color};color:#0a0e14;font:700 9px 'JetBrains Mono',monospace;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1.5px #0a0e14">${badge}</b>`
      : "";
  const html = `<div class="air-tgt${pulse}" style="--air:${color};width:${size}px;height:${size}px;opacity:${opacity}">
<svg viewBox="0 0 24 24" width="${g}" height="${g}" fill="${color}" stroke="#0a0e14" stroke-width="1.2" stroke-linejoin="round"><path d="M12 3l7 15-7-3.4L5 18z"/></svg>${badgeHtml}</div>`;
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

function BaseLayers() {
  return (
    <LayersControl position="topright">
      <LayersControl.BaseLayer checked name="Темна">
        <TileLayer
          attribution="Tiles &copy; Esri"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
          maxZoom={16}
        />
      </LayersControl.BaseLayer>
      <LayersControl.BaseLayer name="Супутник">
        <TileLayer
          attribution="Imagery &copy; Esri, Maxar, Earthstar Geographics"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          maxZoom={18}
        />
      </LayersControl.BaseLayer>
      <LayersControl.BaseLayer name="Гібрид (мітки)">
        <TileLayer
          attribution="Labels &copy; Esri"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
          maxZoom={18}
        />
      </LayersControl.BaseLayer>
      <LayersControl.BaseLayer name="Схема (OSM)">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />
      </LayersControl.BaseLayer>
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

function gridClusters(facilities: Facility[], zoom: number): Cluster[] {
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

function FlyTo({ facility }: { facility: Facility | null }) {
  const map = useMap();
  useEffect(() => {
    if (facility)
      map.flyTo([facility.lat, facility.lon], Math.max(map.getZoom(), 10), { duration: 0.7 });
  }, [facility, map]);
  return null;
}

export default function InfraMap({
  facilities,
  events,
  edges,
  alerts,
  zones,
  threats,
  showLinks,
  riskIds,
  impactedIds,
  selectedId,
  onSelect,
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
    return selectVisibleLinks(drawable, 1200).visible.map((e) => ({
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
      scrollWheelZoom
      className="size-full"
      style={{ background: "#0a0e14" }}
    >
      <BaseLayers />

      {/* Зони тривог: реальні полігони регіонів, або кола-фолбек */}
      {zones.length > 0
        ? zones.flatMap((z) =>
            z.polygons.map((ring, i) => (
              <Polygon
                key={`zone-${z.region}-${i}`}
                positions={ring}
                pathOptions={{
                  color: "#ff4d4d",
                  fillColor: "#ff4d4d",
                  fillOpacity: 0.1,
                  weight: 1,
                }}
              >
                <Popup>
                  <div className="space-y-1 font-sans text-xs">
                    <p className="font-semibold text-red-600">Повітряна тривога</p>
                    <p className="opacity-80">{z.region}</p>
                    {z.type ? <p className="opacity-60">{z.type}</p> : null}
                  </div>
                </Popup>
              </Polygon>
            )),
          )
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

      {/* Повітряні цілі (OSINT) */}
      {threats.map((t) => {
        const seen = t.lastSeen ?? t.since;
        const fresh = freshnessOf(seen);
        return (
          <Marker
            key={t.id}
            position={[t.lat, t.lon]}
            icon={threatIcon(fresh, t.reports ?? 1)}
            zIndexOffset={fresh === "fresh" ? 1000 : fresh === "recent" ? 500 : 0}
          >
            <Popup>
              <div className="space-y-1 font-sans text-xs">
                <p className="font-semibold" style={{ color: AIR_TONE[fresh].color }}>
                  Повітряна ціль
                  {fresh === "fresh" ? " · свіжа" : fresh === "stale" ? " · застаріла" : ""}
                </p>
                <p className="opacity-80">{t.name}</p>
                <p className="opacity-70">
                  {t.reports && t.reports > 1 ? `${t.reports} повідомлень з каналів: ` : "Канал: "}
                  {t.sources && t.sources.length ? t.sources.join(", ") : t.source}
                </p>
                {seen ? (
                  <p className="opacity-70">
                    Останній сигнал: {new Date(seen).toLocaleString("uk-UA")}
                  </p>
                ) : null}
              </div>
            </Popup>
          </Marker>
        );
      })}

      <FlyTo facility={selected} />
    </MapContainer>
  );
}
