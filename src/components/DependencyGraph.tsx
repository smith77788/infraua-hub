import { useMemo } from "react";

import { CATEGORIES, type Facility, type GraphEdge } from "@/lib/infra-types";

interface Props {
  root: Facility;
  facilities: Map<string, Facility>;
  edges: GraphEdge[];
  onSelect: (f: Facility) => void;
}

/** Radial 2-level dependency view around the selected node. */
export default function DependencyGraph({ root, facilities, edges, onSelect }: Props) {
  const { upstream, downstream } = useMemo(() => {
    const up = edges
      .filter((e) => e.to === root.id)
      .map((e) => ({ node: facilities.get(e.from), km: e.km }))
      .filter((x): x is { node: Facility; km: number } => Boolean(x.node));
    const down = edges
      .filter((e) => e.from === root.id)
      .map((e) => ({ node: facilities.get(e.to), km: e.km }))
      .filter((x): x is { node: Facility; km: number } => Boolean(x.node))
      .slice(0, 14);
    return { upstream: up, downstream: down };
  }, [root, edges, facilities]);

  const w = 320;
  const h = 240;
  const cx = w / 2;
  const cy = h / 2;

  const place = (i: number, total: number, radius: number, arcStart: number, arcEnd: number) => {
    const t = total === 1 ? 0.5 : i / (total - 1);
    const angle = arcStart + t * (arcEnd - arcStart);
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  };

  if (!upstream.length && !downstream.length) {
    return (
      <p className="font-mono text-[11px] text-muted-foreground">
        Для цього обʼєкта не знайдено звʼязків у радіусі моделювання.
      </p>
    );
  }

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Граф залежностей обʼєкта">
      {upstream.map((u, i) => {
        const p = place(i, upstream.length, 92, Math.PI * 1.15, Math.PI * 0.85);
        return (
          <g key={u.node.id}>
            <line x1={p.x} y1={p.y} x2={cx} y2={cy} stroke="#22d3ee" strokeOpacity={0.5} />
            <circle
              cx={p.x}
              cy={p.y}
              r={5}
              fill={CATEGORIES[u.node.category].color}
              className="cursor-pointer"
              onClick={() => onSelect(u.node)}
            />
            <text x={p.x} y={p.y - 9} textAnchor="middle" className="fill-muted-foreground" fontSize={7}>
              {u.node.name.slice(0, 22)}
            </text>
          </g>
        );
      })}

      {downstream.map((d, i) => {
        const p = place(i, downstream.length, 100, -Math.PI * 0.42, Math.PI * 0.42);
        return (
          <g key={d.node.id}>
            <line x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#64748b" strokeOpacity={0.45} />
            <circle
              cx={p.x}
              cy={p.y}
              r={4}
              fill={CATEGORIES[d.node.category].color}
              className="cursor-pointer"
              onClick={() => onSelect(d.node)}
            />
            <text x={p.x + 7} y={p.y + 3} className="fill-muted-foreground" fontSize={7}>
              {d.node.name.slice(0, 18)}
            </text>
          </g>
        );
      })}

      <circle cx={cx} cy={cy} r={9} fill={CATEGORIES[root.category].color} />
      <circle cx={cx} cy={cy} r={14} fill="none" stroke={CATEGORIES[root.category].color} strokeOpacity={0.4} />
      <text x={cx} y={cy + 28} textAnchor="middle" className="fill-foreground" fontSize={8}>
        {root.name.slice(0, 28)}
      </text>
    </svg>
  );
}
