import { useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
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

const threatIcon = L.divIcon({
  html: '<span class="threat-mark"></span>',
  className: "threat-pin",
  iconSize: [12, 12],
  iconAnchor: [6, 6],
  popupAnchor: [0, -6],
});

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

// Безключові базові тайли з автоперемиканням.
const BASEMAPS = [
  {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution:
      'Tiles &copy; Esri · Джерела: Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 16,
  },
  {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  },
] as const;

function ResilientTileLayer() {
  const [idx, setIdx] = useState(0);
  const errors = useRef(0);
  const bm = BASEMAPS[Math.min(idx, BASEMAPS.length - 1)];
  return (
    <TileLayer
      key={idx}
      url={bm.url}
      attribution={bm.attribution}
      maxZoom={bm.maxZoom}
      eventHandlers={{
        load: () => {
          errors.current = 0;
        },
        tileerror: () => {
          errors.current += 1;
          if (errors.current >= 8 && idx < BASEMAPS.length - 1) {
            errors.current = 0;
            setIdx((i) => i + 1);
          }
        },
      }}
    />
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
  const ring = state.danger ? "#ef4444" : state.warn ? "#f59e0b" : "rgba(255,255,255,.35)";
  const size = state.selected ? 30 : 24;
  const g = size * 0.58;
  const html = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 ${state.danger || state.warn ? 2.5 : 1.5}px ${ring},0 1px 4px rgba(0,0,0,.7)">
<svg viewBox="0 0 24 24" width="${g}" height="${g}" fill="none" stroke="#0a0d12" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[category]}</svg></div>`;
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

/** Зум-залежний шар обʼєктів: точки на огляді країни, іконки з прорідженням при наближенні. */
function FacilityLayer({
  facilities,
  riskIds,
  impactedIds,
  alarmIds,
  selectedId,
  onSelect,
}: {
  facilities: Facility[];
  riskIds: Set<string>;
  impactedIds: Set<string>;
  alarmIds: Set<string>;
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

  const useIcons = zoom >= 8;

  if (!useIcons) {
    return (
      <>
        {facilities.map((f) => {
          const danger = riskIds.has(f.id) || alarmIds.has(f.id);
          const warn = impactedIds.has(f.id);
          return (
            <CircleMarker
              key={f.id}
              center={[f.lat, f.lon]}
              radius={selectedId === f.id ? 7 : danger ? 5 : 3.5}
              eventHandlers={{ click: () => onSelect(f) }}
              pathOptions={{
                color: danger ? "#ef4444" : warn ? "#f59e0b" : CATEGORIES[f.category].color,
                fillColor: CATEGORIES[f.category].color,
                fillOpacity: 0.85,
                weight: danger || warn ? 2 : 1,
              }}
            >
              <FacilityPopup f={f} />
            </CircleMarker>
          );
        })}
      </>
    );
  }

  const inView = facilities.filter((f) => bounds.contains([f.lat, f.lon]));
  // пріоритет під час прорідження: небезпечні та важливі — першими
  const sorted = inView.sort((a, b) => {
    const da = (riskIds.has(a.id) || alarmIds.has(a.id) ? 2 : 0) + (a.id === selectedId ? 4 : 0);
    const db = (riskIds.has(b.id) || alarmIds.has(b.id) ? 2 : 0) + (b.id === selectedId ? 4 : 0);
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
            danger: riskIds.has(f.id) || alarmIds.has(f.id),
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
  alarmIds,
  showLinks,
  riskIds,
  impactedIds,
  selectedId,
  onSelect,
}: Props) {
  const byId = useMemo(() => new Map(facilities.map((f) => [f.id, f])), [facilities]);
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  const lines = useMemo(() => {
    if (!showLinks) return [];
    return edges
      .map((e) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) return null;
        return { e, a, b };
      })
      .filter((x): x is { e: GraphEdge; a: Facility; b: Facility } => x !== null)
      .slice(0, 1200);
  }, [edges, byId, showLinks]);

  return (
    <MapContainer
      center={[48.6, 31.2]}
      zoom={6}
      minZoom={5}
      scrollWheelZoom
      className="size-full"
      style={{ background: "#0a0d12" }}
    >
      <ResilientTileLayer />

      {/* Зони тривог: реальні полігони регіонів, або кола-фолбек, якщо полігони недоступні */}
      {zones.length > 0
        ? zones.flatMap((z) =>
            z.polygons.map((ring, i) => (
              <Polygon
                key={`zone-${z.region}-${i}`}
                positions={ring}
                pathOptions={{
                  color: "#ef4444",
                  fillColor: "#ef4444",
                  fillOpacity: 0.14,
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
                  color: "#ef4444",
                  fillColor: "#ef4444",
                  fillOpacity: 0.12,
                  weight: 1.2,
                  dashArray: "5 5",
                }}
              >
                <Popup>
                  <div className="space-y-1 font-sans text-xs">
                    <p className="font-semibold text-red-600">Повітряна тривога</p>
                    <p className="opacity-80">{r.name}</p>
                    {r.since ? <p className="opacity-70">Від {r.since}</p> : null}
                  </div>
                </Popup>
              </Circle>
            ))}

      {lines.map(({ e, a, b }) => (
        <Polyline
          key={`${e.from}-${e.to}`}
          positions={[
            [a.lat, a.lon],
            [b.lat, b.lon],
          ]}
          pathOptions={{
            color: impactedIds.has(e.to) ? "#f87171" : e.kind === "supply" ? "#22d3ee" : "#64748b",
            weight: e.kind === "supply" ? 1.1 : 0.6,
            opacity: impactedIds.has(e.to) ? 0.7 : 0.28,
          }}
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
        alarmIds={alarmIds}
        selectedId={selectedId}
        onSelect={onSelect}
      />

      {/* Повітряні цілі (OSINT) */}
      {threats.map((t) => (
        <Marker key={t.id} position={[t.lat, t.lon]} icon={threatIcon}>
          <Popup>
            <div className="space-y-1 font-sans text-xs">
              <p className="font-semibold text-red-600">Повітряна ціль</p>
              <p className="opacity-80">{t.name}</p>
              <p className="opacity-70">Джерело: {t.source}</p>
              {t.since ? (
                <p className="opacity-70">{new Date(t.since).toLocaleString("uk-UA")}</p>
              ) : null}
            </div>
          </Popup>
        </Marker>
      ))}

      <FlyTo facility={selected} />
    </MapContainer>
  );
}
