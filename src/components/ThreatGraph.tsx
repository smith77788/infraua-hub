import { useMemo } from "react";

import type { ThreatGraph as Graph, ThreatSeverity } from "@/lib/threat-correlation";

/*
 * Граф звʼязків «обʼєкт ↔ повітряна ціль ↔ OSINT-канал» — шар аналізу звʼязків
 * Palantir-класу, перенесений у консоль. Власний force-layout у SVG (без
 * зовнішніх бібліотек): відштовхування вузлів + притягання по ребрах + легке
 * тяжіння до центру. Розрахунок обмежений фіксованим числом ітерацій, тож
 * детермінований і дешевий.
 */

const W = 760;
const H = 520;

const SEV_COLOR: Record<ThreatSeverity, string> = {
  critical: "#ff4d4d",
  high: "#ff9900",
  medium: "#ffcc33",
};
const KIND_COLOR = { asset: "#ff4d4d", threat: "#ffb020", channel: "#64748b" } as const;

interface Placed {
  key: string;
  label: string;
  kind: "asset" | "threat" | "channel";
  color: string;
  r: number;
  x: number;
  y: number;
}

function layout(graph: Graph): { nodes: Placed[]; edges: { a: Placed; b: Placed }[] } {
  const n = graph.nodes.length;
  if (!n) return { nodes: [], edges: [] };
  const nodes: Placed[] = graph.nodes.map((node, i) => {
    const color =
      node.kind === "asset" && node.severity ? SEV_COLOR[node.severity] : KIND_COLOR[node.kind];
    const base = node.kind === "asset" ? 8 : node.kind === "threat" ? 6 : 5;
    // Розкидаємо по колу як стартову позицію — стабільніше за випадкову.
    const ang = (i / n) * Math.PI * 2;
    return {
      key: node.key,
      label: node.label,
      kind: node.kind,
      color,
      r: base + Math.min(5, node.degree),
      x: W / 2 + Math.cos(ang) * 180,
      y: H / 2 + Math.sin(ang) * 130,
    };
  });
  const idx = new Map(nodes.map((p, i) => [p.key, i]));
  const edges = graph.edges
    .map((e) => ({ a: nodes[idx.get(e.a)!]!, b: nodes[idx.get(e.b)!]! }))
    .filter((e) => e.a && e.b);

  const K = Math.sqrt((W * H) / n) * 0.62;
  for (let it = 0; it < 80; it++) {
    const fx = new Array(n).fill(0);
    const fy = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2);
        const rep = (K * K) / d2;
        fx[i]! += (dx / d) * rep;
        fy[i]! += (dy / d) * rep;
        fx[j]! -= (dx / d) * rep;
        fy[j]! -= (dy / d) * rep;
      }
    }
    for (const e of graph.edges) {
      const ia = idx.get(e.a)!;
      const ib = idx.get(e.b)!;
      const a = nodes[ia]!;
      const b = nodes[ib]!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const att = (d * d) / K;
      fx[ia]! -= (dx / d) * att;
      fy[ia]! -= (dy / d) * att;
      fx[ib]! += (dx / d) * att;
      fy[ib]! += (dy / d) * att;
    }
    for (let i = 0; i < n; i++) {
      const p = nodes[i]!;
      const dxc = (W / 2 - p.x) * 0.012;
      const dyc = (H / 2 - p.y) * 0.012;
      p.x += Math.max(-18, Math.min(18, fx[i]! * 0.02 + dxc));
      p.y += Math.max(-18, Math.min(18, fy[i]! * 0.02 + dyc));
      p.x = Math.max(p.r + 8, Math.min(W - p.r - 8, p.x));
      p.y = Math.max(p.r + 16, Math.min(H - p.r - 8, p.y));
    }
  }
  return { nodes, edges };
}

export default function ThreatGraph({
  graph,
  onSelectAsset,
}: {
  graph: Graph;
  onSelectAsset?: (facilityId: string) => void;
}) {
  const placed = useMemo(() => layout(graph), [graph]);

  if (!placed.nodes.length) {
    return (
      <div className="flex size-full items-center justify-center font-mono text-[11px] text-muted-foreground">
        Немає активних звʼязків «загроза → обʼєкт»
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="size-full"
      role="img"
      aria-label="Граф звʼязків загроз і обʼєктів"
    >
      {placed.edges.map((e, i) => (
        <line
          key={i}
          x1={e.a.x}
          y1={e.a.y}
          x2={e.b.x}
          y2={e.b.y}
          stroke={e.a.kind === "channel" || e.b.kind === "channel" ? "#3a4658" : "#ff4d4d"}
          strokeWidth={e.a.kind === "channel" || e.b.kind === "channel" ? 1 : 1.6}
          strokeOpacity={0.5}
          strokeDasharray={e.a.kind === "channel" || e.b.kind === "channel" ? "2 4" : undefined}
        />
      ))}
      {placed.nodes.map((p) => {
        const facilityId = p.kind === "asset" ? p.key.slice(2) : null;
        return (
          <g
            key={p.key}
            style={{ cursor: facilityId && onSelectAsset ? "pointer" : "default" }}
            onClick={facilityId && onSelectAsset ? () => onSelectAsset(facilityId) : undefined}
          >
            <circle
              cx={p.x}
              cy={p.y}
              r={p.r}
              fill={`${p.color}33`}
              stroke={p.color}
              strokeWidth={1.5}
            />
            <text
              x={p.x}
              y={p.y - p.r - 3}
              fill="#d7e0ea"
              fontSize={9}
              textAnchor="middle"
              fontFamily="'JetBrains Mono', monospace"
            >
              {p.label.length > 20 ? `${p.label.slice(0, 20)}…` : p.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
