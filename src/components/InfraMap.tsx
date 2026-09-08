import { useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Circle,
  Popup,
  Polyline,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

import { type AlertRegion } from "@/lib/alerts";
import {
  CATEGORIES,
  EVENT_KINDS,
  type Facility,
  type GraphEdge,
  type InfraEvent,
} from "@/lib/infra-types";

interface Props {
  facilities: Facility[];
  events: InfraEvent[];
  edges: GraphEdge[];
  alerts: AlertRegion[];
  alarmIds: Set<string>;
  showLinks: boolean;
  riskIds: Set<string>;
  impactedIds: Set<string>;
  selectedId: string | null;
  onSelect: (f: Facility) => void;
}

// Безключові базові тайли з автоперемиканням: якщо основне джерело масово
// не віддає тайли — переходимо до наступного.
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

function FlyTo({ facility }: { facility: Facility | null }) {
  const map = useMap();
  useEffect(() => {
    if (facility)
      map.flyTo([facility.lat, facility.lon], Math.max(map.getZoom(), 9), { duration: 0.7 });
  }, [facility, map]);
  return null;
}

export default function InfraMap({
  facilities,
  events,
  edges,
  alerts,
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

      {alerts
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
            opacity: impactedIds.has(e.to) ? 0.7 : 0.32,
          }}
        />
      ))}

      {events.map((ev) => (
        <CircleMarker
          key={ev.id}
          center={[ev.lat, ev.lon]}
          radius={9}
          pathOptions={{
            color: EVENT_KINDS[ev.kind].color,
            fillColor: EVENT_KINDS[ev.kind].color,
            fillOpacity: 0.14,
            weight: 1.4,
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

      {facilities
        .filter((f) => alarmIds.has(f.id))
        .map((f) => (
          <CircleMarker
            key={`alarm-ring-${f.id}`}
            center={[f.lat, f.lon]}
            radius={8}
            interactive={false}
            pathOptions={{
              color: "#ef4444",
              weight: 1,
              opacity: 0.65,
              fill: false,
              dashArray: "2 3",
            }}
          />
        ))}

      {facilities.map((f) => {
        const meta = CATEGORIES[f.category];
        const atRisk = riskIds.has(f.id);
        const impacted = impactedIds.has(f.id);
        return (
          <CircleMarker
            key={f.id}
            center={[f.lat, f.lon]}
            radius={selectedId === f.id ? 8 : atRisk ? 6 : 4}
            eventHandlers={{ click: () => onSelect(f) }}
            pathOptions={{
              color: atRisk ? "#ef4444" : impacted ? "#f59e0b" : meta.color,
              fillColor: meta.color,
              fillOpacity: 0.85,
              weight: atRisk || impacted ? 2 : 1,
            }}
          >
            <Popup>
              <div className="space-y-1 font-sans text-xs">
                <p className="font-semibold">{f.name}</p>
                <p className="opacity-70">{meta.label}</p>
                {f.operator ? <p className="opacity-70">Оператор: {f.operator}</p> : null}
                {f.detail ? <p className="opacity-70">{f.detail}</p> : null}
                <a href={f.source} target="_blank" rel="noreferrer" className="underline">
                  Дані OpenStreetMap
                </a>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}

      <FlyTo facility={selected} />
    </MapContainer>
  );
}
