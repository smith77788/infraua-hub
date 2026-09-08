import * as React from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphEdge, GraphNode } from "@/console/lib/types";
import { clearanceColorVar, entityColorVar } from "@/console/lib/format";

/**
 * Force-directed graph on a canvas.
 *
 * Canvas rather than SVG because an analyst graph gets into the hundreds of
 * nodes quickly and one DOM element per node stops being interactive well
 * before that. The simulation runs on the raw nodes/edges the API returned —
 * nothing is laid out server-side, so the same data drives the map and the
 * tables without a second representation to keep in sync.
 */

interface SimNode extends SimulationNodeDatum {
  id: string;
  node: GraphNode;
  degree: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  edge: GraphEdge;
}

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId?: string | null;
  onSelect?: (node: GraphNode | null) => void;
  /** Node ids to highlight (e.g. an investigation's anchors). */
  highlightIds?: Set<string>;
  colorBy?: "type" | "clearance";
  className?: string;
  height?: number;
}

function radiusFor(degree: number): number {
  return 5 + Math.min(9, Math.sqrt(degree) * 2.6);
}

export function GraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
  highlightIds,
  colorBy = "type",
  className,
  height = 460,
}: GraphCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const simRef = React.useRef<Simulation<SimNode, SimLink> | null>(null);
  const stateRef = React.useRef<{
    simNodes: SimNode[];
    simLinks: SimLink[];
    transform: { x: number; y: number; k: number };
    hoverId: string | null;
    width: number;
    height: number;
  }>({
    simNodes: [],
    simLinks: [],
    transform: { x: 0, y: 0, k: 1 },
    hoverId: null,
    width: 0,
    height,
  });

  const [hoverLabel, setHoverLabel] = React.useState<{
    x: number;
    y: number;
    node: GraphNode;
  } | null>(null);

  // Redraw whenever the simulation ticks or the view is panned/zoomed.
  const draw = React.useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const state = stateRef.current;
    const dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, state.width, state.height);
    ctx.translate(state.transform.x, state.transform.y);
    ctx.scale(state.transform.k, state.transform.k);

    const styles = getComputedStyle(document.documentElement);
    const resolve = (v: string) => {
      const match = /var\((--[a-z-]+)\)/.exec(v);
      const name = match?.[1];
      if (!name) return v;
      // Tailwind v4 tokens are already complete colour values (oklch), so the
      // variable resolves to a colour directly rather than to hsl() channels.
      return styles.getPropertyValue(name).trim() || v;
    };
    // These tokens are complete oklch colours in this design system, not bare
    // hsl channels, so they are used as-is.
    const edgeColor = styles.getPropertyValue("--border").trim() || "#334155";
    const textColor = styles.getPropertyValue("--muted-foreground").trim() || "#94a3b8";
    const ringColor = styles.getPropertyValue("--primary").trim() || "#22d3ee";

    // Edges first, so nodes always sit on top of them.
    ctx.lineWidth = 1 / state.transform.k;
    for (const link of state.simLinks) {
      const s = link.source as SimNode;
      const t = link.target as SimNode;
      if (s.x == null || t.x == null) continue;
      const touchesSelection = selectedId != null && (s.id === selectedId || t.id === selectedId);
      ctx.strokeStyle = touchesSelection ? ringColor : edgeColor;
      ctx.globalAlpha = touchesSelection ? 0.9 : 0.45;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y!);
      ctx.lineTo(t.x, t.y!);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const sn of state.simNodes) {
      if (sn.x == null || sn.y == null) continue;
      const r = radiusFor(sn.degree);
      const fill = resolve(
        colorBy === "clearance"
          ? clearanceColorVar(sn.node.clearance)
          : entityColorVar(sn.node.type),
      );

      const dimmed =
        highlightIds && highlightIds.size > 0 && !highlightIds.has(sn.id) && sn.id !== selectedId;
      ctx.globalAlpha = dimmed ? 0.25 : 1;

      ctx.beginPath();
      ctx.arc(sn.x, sn.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();

      if (sn.id === selectedId || sn.id === state.hoverId) {
        ctx.beginPath();
        ctx.arc(sn.x, sn.y, r + 3 / state.transform.k, 0, Math.PI * 2);
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 2 / state.transform.k;
        ctx.stroke();
      }

      // Labels only once zoomed in enough, or for the node under focus —
      // otherwise a dense graph turns into a wall of text.
      if (state.transform.k > 0.85 || sn.id === selectedId || sn.id === state.hoverId) {
        ctx.globalAlpha = dimmed ? 0.3 : 1;
        ctx.fillStyle = textColor;
        ctx.font = `${11 / state.transform.k}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(
          sn.node.label.length > 26 ? `${sn.node.label.slice(0, 25)}…` : sn.node.label,
          sn.x,
          sn.y + r + 12 / state.transform.k,
        );
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }, [colorBy, highlightIds, selectedId]);

  // Build/refresh the simulation when the data changes.
  React.useEffect(() => {
    const state = stateRef.current;
    const previous = new Map(state.simNodes.map((n) => [n.id, n]));

    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    const simNodes: SimNode[] = nodes.map((node) => {
      const prior = previous.get(node.id);
      return {
        id: node.id,
        node,
        degree: degree.get(node.id) ?? 0,
        // Keep positions across refreshes so the layout does not jump when a
        // poll returns the same graph plus one new node.
        x: prior?.x,
        y: prior?.y,
        vx: prior?.vx,
        vy: prior?.vy,
      };
    });
    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const simLinks: SimLink[] = edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((edge) => ({ source: byId.get(edge.source)!, target: byId.get(edge.target)!, edge }));

    state.simNodes = simNodes;
    state.simLinks = simLinks;

    simRef.current?.stop();
    const width = state.width || 800;
    const sim = forceSimulation<SimNode, SimLink>(simNodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(70)
          .strength(0.35),
      )
      .force("charge", forceManyBody<SimNode>().strength(-220).distanceMax(420))
      .force("center", forceCenter(width / 2, state.height / 2))
      .force(
        "collide",
        forceCollide<SimNode>().radius((d) => radiusFor(d.degree) + 6),
      )
      .alpha(0.9)
      .alphaDecay(0.035)
      .on("tick", draw);

    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [nodes, edges, draw]);

  // Size the canvas to its container, in device pixels.
  React.useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      stateRef.current.width = rect.width;
      stateRef.current.height = height;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${height}px`;
      simRef.current?.force("center", forceCenter(rect.width / 2, height / 2));
      simRef.current?.alpha(0.3).restart();
      draw();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [height, draw]);

  React.useEffect(() => {
    draw();
  }, [draw, selectedId, colorBy, highlightIds]);

  const toGraphCoords = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const { x, y, k } = stateRef.current.transform;
    return { x: (clientX - rect.left - x) / k, y: (clientY - rect.top - y) / k };
  };

  const nodeAt = (gx: number, gy: number): SimNode | null => {
    // Reverse order so the topmost drawn node wins a click.
    const list = stateRef.current.simNodes;
    for (let i = list.length - 1; i >= 0; i--) {
      const sn = list[i];
      if (!sn || sn.x == null || sn.y == null) continue;
      const r = radiusFor(sn.degree) + 3;
      if ((gx - sn.x) ** 2 + (gy - sn.y) ** 2 <= r * r) return sn;
    }
    return null;
  };

  const dragRef = React.useRef<{
    mode: "pan" | "node" | null;
    startX: number;
    startY: number;
    origin: { x: number; y: number };
    node: SimNode | null;
    moved: boolean;
  }>({ mode: null, startX: 0, startY: 0, origin: { x: 0, y: 0 }, node: null, moved: false });

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = toGraphCoords(event.clientX, event.clientY);
    const hit = nodeAt(x, y);
    dragRef.current = {
      mode: hit ? "node" : "pan",
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...stateRef.current.transform },
      node: hit,
      moved: false,
    };
    if (hit) {
      hit.fx = hit.x;
      hit.fy = hit.y;
      simRef.current?.alphaTarget(0.25).restart();
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const state = stateRef.current;

    if (!drag.mode) {
      const { x, y } = toGraphCoords(event.clientX, event.clientY);
      const hit = nodeAt(x, y);
      const nextId = hit?.id ?? null;
      if (nextId !== state.hoverId) {
        state.hoverId = nextId;
        setHoverLabel(
          hit
            ? {
                x: event.clientX - canvasRef.current!.getBoundingClientRect().left,
                y: event.clientY - canvasRef.current!.getBoundingClientRect().top,
                node: hit.node,
              }
            : null,
        );
        draw();
      } else if (hit) {
        const rect = canvasRef.current!.getBoundingClientRect();
        setHoverLabel({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
          node: hit.node,
        });
      }
      return;
    }

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;

    if (drag.mode === "pan") {
      state.transform = { ...state.transform, x: drag.origin.x + dx, y: drag.origin.y + dy };
      draw();
    } else if (drag.node) {
      const { x, y } = toGraphCoords(event.clientX, event.clientY);
      drag.node.fx = x;
      drag.node.fy = y;
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.mode === "node" && drag.node) {
      drag.node.fx = null;
      drag.node.fy = null;
      simRef.current?.alphaTarget(0);
      // A press without movement is a selection, not a drag.
      if (!drag.moved) onSelect?.(drag.node.node);
    } else if (drag.mode === "pan" && !drag.moved) {
      onSelect?.(null);
    }
    dragRef.current = { ...drag, mode: null, node: null };
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const state = stateRef.current;
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const k = Math.max(0.25, Math.min(4, state.transform.k * factor));
    // Zoom about the cursor, so the point under the pointer stays put.
    state.transform = {
      k,
      x: px - ((px - state.transform.x) / state.transform.k) * k,
      y: py - ((py - state.transform.y) / state.transform.k) * k,
    };
    draw();
  };

  const resetView = () => {
    stateRef.current.transform = { x: 0, y: 0, k: 1 };
    simRef.current?.alpha(0.4).restart();
    draw();
  };

  return (
    <div ref={wrapRef} className={className} style={{ position: "relative", height }}>
      <canvas
        ref={canvasRef}
        className="block h-full w-full cursor-grab touch-none rounded-md active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          stateRef.current.hoverId = null;
          setHoverLabel(null);
          draw();
        }}
        onWheel={onWheel}
      />
      {hoverLabel && (
        <div
          className="pointer-events-none absolute z-10 max-w-[220px] rounded-md border border-border bg-popover px-2 py-1.5 text-xs shadow-lg"
          style={{
            left: Math.min(hoverLabel.x + 12, (stateRef.current.width || 0) - 230),
            top: hoverLabel.y + 12,
          }}
        >
          <p className="truncate font-medium">{hoverLabel.node.label}</p>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {hoverLabel.node.type}
          </p>
        </div>
      )}
      <button
        type="button"
        onClick={resetView}
        className="absolute bottom-2 right-2 rounded border border-border bg-card/90 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
      >
        Скинути вигляд
      </button>
    </div>
  );
}
