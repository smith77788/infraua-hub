import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import maplibregl, { type Map as MapLibreMap, type Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Globe2, MapPin } from "lucide-react";
import {
  Badge,
  EmptyState,
  ErrorNote,
  Panel,
  PanelHeader,
  Spinner,
  StatTile,
} from "@/console/components/primitives";
import { ClearanceBadge } from "@/console/components/ClearanceBadge";
import { api } from "@/console/lib/api";
import { useSession } from "@/console/hooks/useSession";
import type { GraphEdge, GraphNode } from "@/console/lib/types";
import { entityColorVar, numericProp } from "@/console/lib/format";

// A stable empty array: `?? []` allocates a new one on every render, which
// makes every useMemo downstream recompute even when the data has not changed.
const NONE: never[] = [];

/**
 * Geospatial view of the graph.
 *
 * Only nodes that actually carry lat/lon are placed — nothing is geocoded or
 * guessed, because a fabricated coordinate on an intelligence map is worse
 * than an absent one. Relations between two placed entities are drawn as
 * lines, so a supply route or an affiliation across sites reads spatially.
 *
 * The style URL is configurable (VITE_MAP_STYLE) and defaults to MapLibre's
 * public demo tiles, which need no API key.
 */

const DEFAULT_STYLE =
  import.meta.env["VITE_MAP_STYLE"] ?? "https://demotiles.maplibre.org/style.json";

interface PlacedNode {
  node: GraphNode;
  lat: number;
  lon: number;
}

function placeNodes(nodes: GraphNode[]): PlacedNode[] {
  const placed: PlacedNode[] = [];
  for (const node of nodes) {
    const lat = numericProp(node.properties, "lat");
    const lon = numericProp(node.properties, "lon");
    if (lat === null || lon === null) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    placed.push({ node, lat, lon });
  }
  return placed;
}

export function MapView() {
  const { apiKey } = useSession();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<MapLibreMap | null>(null);
  const markersRef = React.useRef<Marker[]>([]);
  const [mapError, setMapError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<GraphNode | null>(null);

  const graph = useQuery({
    queryKey: ["graph"],
    queryFn: () => api.graph(apiKey),
  });

  const placed = React.useMemo(() => placeNodes(graph.data?.nodes ?? NONE), [graph.data?.nodes]);
  const unplacedCount = (graph.data?.nodes.length ?? 0) - placed.length;

  const routes = React.useMemo<{ edge: GraphEdge; from: PlacedNode; to: PlacedNode }[]>(() => {
    const byId = new Map(placed.map((p) => [p.node.id, p]));
    const out: { edge: GraphEdge; from: PlacedNode; to: PlacedNode }[] = [];
    for (const edge of graph.data?.edges ?? NONE) {
      const from = byId.get(edge.source);
      const to = byId.get(edge.target);
      if (from && to) out.push({ edge, from, to });
    }
    return out;
  }, [placed, graph.data?.edges]);

  // Create the map once. A failed style load (offline, blocked host) is caught
  // and reported rather than leaving an empty grey box with no explanation.
  React.useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: DEFAULT_STYLE,
        center: [10, 25],
        zoom: 1.4,
        attributionControl: { compact: true },
      });
    } catch (err) {
      setMapError(err instanceof Error ? err.message : String(err));
      return;
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("error", (event) => {
      const message = event.error?.message ?? "Map tiles failed to load.";
      setMapError(message);
    });
    mapRef.current = map;

    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Markers + route lines, rebuilt whenever the placed set changes.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const render = () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];

      for (const item of placed) {
        const el = document.createElement("button");
        el.type = "button";
        el.setAttribute("aria-label", item.node.label);
        el.style.cssText = [
          "width:14px",
          "height:14px",
          "border-radius:9999px",
          "cursor:pointer",
          "border:2px solid rgba(255,255,255,0.85)",
          "box-shadow:0 0 0 1px rgba(0,0,0,0.35)",
          `background:${entityColorVar(item.node.type)}`,
        ].join(";");
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          setSelected(item.node);
        });

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([item.lon, item.lat])
          .setPopup(
            new maplibregl.Popup({ offset: 14, closeButton: false }).setText(
              `${item.node.label} · ${item.node.type}`,
            ),
          )
          .addTo(map);
        markersRef.current.push(marker);
      }

      const source = map.getSource("palanter-routes") as maplibregl.GeoJSONSource | undefined;
      const data: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: routes.map(({ edge, from, to }) => ({
          type: "Feature",
          properties: { relation: edge.relation },
          geometry: {
            type: "LineString",
            coordinates: [
              [from.lon, from.lat],
              [to.lon, to.lat],
            ],
          },
        })),
      };

      if (source) {
        source.setData(data);
      } else {
        map.addSource("palanter-routes", { type: "geojson", data });
        map.addLayer(
          {
            id: "palanter-routes-line",
            type: "line",
            source: "palanter-routes",
            paint: {
              "line-color": "#38bdf8",
              "line-width": 1.5,
              "line-opacity": 0.65,
            },
          },
          // Under the markers, which are DOM elements, so no beforeId needed.
        );
      }

      if (placed.length > 0) {
        const bounds = new maplibregl.LngLatBounds();
        for (const item of placed) bounds.extend([item.lon, item.lat]);
        map.fitBounds(bounds, { padding: 60, maxZoom: 8, duration: 600 });
      }
    };

    if (map.isStyleLoaded()) render();
    else map.once("load", render);
  }, [placed, routes]);

  // The console is dark throughout and MapLibre's demo style is light, so it
  // is inverted to sit in the same surface. A custom VITE_MAP_STYLE is assumed
  // to already be dark and is left exactly as authored.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const usingDefaultStyle = DEFAULT_STYLE === "https://demotiles.maplibre.org/style.json";
    container.style.filter = usingDefaultStyle
      ? "invert(0.92) hue-rotate(180deg) saturate(0.75)"
      : "";
  }, []);

  if (graph.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (graph.isError) return <ErrorNote>{(graph.error as Error).message}</ErrorNote>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Мапа</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Сутності з координатами та звʼязки між ними. Нічого не геокодується — обʼєкт зʼявляється
          тут лише якщо його власні дані кажуть, де він.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Розміщено" value={placed.length} hint="мають lat/lon" />
        <StatTile label="Маршрути" value={routes.length} hint="обидва кінці розміщені" />
        <StatTile label="Не розміщено" value={unplacedCount} hint="без координат" />
        <StatTile label="Усього сутностей" value={graph.data?.nodes.length ?? 0} />
      </div>

      {mapError && (
        <ErrorNote>
          Map tiles could not be loaded ({mapError}). The entity list below still works; set
          VITE_MAP_STYLE to a reachable style URL to restore the map.
        </ErrorNote>
      )}

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Геопросторовий вигляд"
          description={
            placed.length === 0
              ? "Розміщених сутностей немає"
              : `Розміщено сутностей: ${placed.length}`
          }
        />
        <div className="relative">
          <div ref={containerRef} className="h-[460px] w-full" />
          {placed.length === 0 && !mapError && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70">
              <EmptyState
                icon={Globe2}
                title="Жодна сутність ще не має координат"
                description="Завантажте записи з властивостями lat і lon — наприклад сутність Location із CSV із такими колонками — і вони зʼявляться тут."
              />
            </div>
          )}
        </div>
      </Panel>

      {selected && (
        <Panel>
          <PanelHeader
            title={
              <span className="flex items-center gap-2">
                <MapPin className="h-4 w-4" /> {selected.label}
              </span>
            }
            description={selected.id}
            actions={<ClearanceBadge level={selected.clearance} />}
          />
          <div className="flex flex-wrap gap-1.5 p-4">
            {Object.entries(selected.properties).map(([k, v]) => (
              <Badge key={k} className="border-border bg-muted font-mono text-muted-foreground">
                {k}={String(v)}
              </Badge>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
