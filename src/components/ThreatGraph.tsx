import { useMemo, useState } from "react";

import type { ThreatGraph as Graph, ThreatSeverity } from "@/lib/threat-correlation";

/*
 * Граф звʼязків «канал → ціль → обʼєкт» — шар аналізу звʼязків Palantir-класу.
 *
 * Раніше тут був force-layout у SVG. На вузькому екрані фізична симуляція
 * стягувала вузли в купу, а підписи налазили одна на одну — граф ставав
 * нечитабельним. Замість симуляції — детермінований шаровий макет: три колонки
 * (канали → цілі → обʼєкти), вузли рівномірно рознесені по вертикалі. Колонки
 * не можуть «злипнутися», відстані задані конструктивно, а заголовки колонок
 * прямо кажуть, на що дивишся. Ребра йдуть лише між сусідніми колонками, тож
 * не перетинають усе полотно.
 *
 * Далі виправлено три речі, через які граф лишався нечитабельним:
 *
 * 1. **Підписи були лише в обʼєктів і каналів.** Середня колонка — цілі —
 *    стояла безіменними кружечками, тож сказати, яка саме ціль звʼязує обʼєкт
 *    із каналом, було неможливо. Тепер підписано кожен вузол.
 * 2. **Полотно було 860 px завширшки з `max-w-none`.** На телефоні воно
 *    виїжджало за екран, і людина бачила середину графа без колонки обʼєктів.
 *    Тепер ширина тягнеться за контейнером, а горизонтальні відстані
 *    лишаються сталими у власних координатах.
 * 3. **Не було чим простежити один ланцюжок.** Наведення на будь-який вузол
 *    підсвічує його ланцюжок і приглушує решту — саме цим граф і корисний,
 *    коли ціль спільна для кількох обʼєктів.
 */

const SEV_COLOR: Record<ThreatSeverity, string> = {
  critical: "#ff4d4d",
  high: "#ff9900",
  medium: "#ffcc33",
};
const KIND_COLOR = { asset: "#ff4d4d", threat: "#ffb020", channel: "#64748b" } as const;

// Скільки цілей/каналів показуємо максимум — решту згортаємо в підпис «+N».
const MAX_THREATS = 22;
const MAX_CHANNELS = 18;

const COL_ASSET = 300;
const COL_THREAT = 520;
const COL_CHANNEL = 700;
const W = 880;
const TOP = 58;
const ROW_H = 30;
const R_BASE = { asset: 7, threat: 5, channel: 4 } as const;

interface Placed {
  key: string;
  label: string;
  kind: "asset" | "threat" | "channel";
  color: string;
  r: number;
  x: number;
  y: number;
}

interface Layout {
  nodes: Placed[];
  byKey: Map<string, Placed>;
  edges: { a: Placed; b: Placed; channel: boolean }[];
  height: number;
  hiddenThreats: number;
  hiddenChannels: number;
  /** Сусіди кожного вузла — з цього будується підсвітка ланцюжка. */
  adj: Map<string, Set<string>>;
}

function layout(graph: Graph): Layout {
  const empty: Layout = {
    nodes: [],
    byKey: new Map(),
    edges: [],
    height: 220,
    hiddenThreats: 0,
    hiddenChannels: 0,
    adj: new Map(),
  };
  if (!graph.nodes.length) return empty;

  // Розкладаємо по типах і сортуємо за важливістю (обʼєкти — за рівнем, решта —
  // за ступенем звʼязків): найпоказовіші вузли лишаються, коли впираємось у ліміт.
  const sevOrder: Record<ThreatSeverity, number> = { critical: 0, high: 1, medium: 2 };
  const assets = graph.nodes
    .filter((n) => n.kind === "asset")
    .sort(
      (a, b) =>
        (a.severity ? sevOrder[a.severity] : 3) - (b.severity ? sevOrder[b.severity] : 3) ||
        b.degree - a.degree,
    );
  const threatsAll = graph.nodes
    .filter((n) => n.kind === "threat")
    .sort((a, b) => b.degree - a.degree);
  const channelsAll = graph.nodes
    .filter((n) => n.kind === "channel")
    .sort((a, b) => b.degree - a.degree);
  const threats = threatsAll.slice(0, MAX_THREATS);
  const channels = channelsAll.slice(0, MAX_CHANNELS);

  const rows = Math.max(assets.length, threats.length, channels.length, 1);
  const contentH = (rows - 1) * ROW_H;
  const height = TOP + contentH + 24;

  const byKey = new Map<string, Placed>();
  const place = (
    list: {
      key: string;
      label: string;
      kind: Placed["kind"];
      degree: number;
      severity?: ThreatSeverity;
    }[],
    x: number,
  ) => {
    const m = list.length;
    const blockH = (m - 1) * ROW_H;
    const startY = TOP + (contentH - blockH) / 2;
    list.forEach((node, i) => {
      const color =
        node.kind === "asset" && node.severity ? SEV_COLOR[node.severity] : KIND_COLOR[node.kind];
      const p: Placed = {
        key: node.key,
        label: node.label,
        kind: node.kind,
        color,
        r: R_BASE[node.kind] + Math.min(4, node.degree),
        x,
        y: startY + i * ROW_H,
      };
      byKey.set(p.key, p);
    });
  };
  place(assets, COL_ASSET);
  place(threats, COL_THREAT);
  place(channels, COL_CHANNEL);

  const edges: Layout["edges"] = [];
  const adj = new Map<string, Set<string>>();
  const link = (x: string, y: string) => {
    let set = adj.get(x);
    if (!set) adj.set(x, (set = new Set()));
    set.add(y);
  };
  for (const e of graph.edges) {
    const a = byKey.get(e.a);
    const b = byKey.get(e.b);
    if (!a || !b) continue; // один із кінців відсіявся лімітом
    edges.push({ a, b, channel: e.kind === "reported-by" });
    link(a.key, b.key);
    link(b.key, a.key);
  }

  return {
    nodes: [...byKey.values()],
    byKey,
    edges,
    height,
    hiddenThreats: threatsAll.length - threats.length,
    hiddenChannels: channelsAll.length - channels.length,
    adj,
  };
}

/** Плавна крива між сусідніми колонками — читабельніше за пряму лінію. */
function curve(a: Placed, b: Placed): string {
  const mx = (a.x + b.x) / 2;
  return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
}

function ColumnHeader({ x, text, tone }: { x: number; text: string; tone: string }) {
  return (
    <text
      x={x}
      y={28}
      fill={tone}
      fontSize={11}
      textAnchor="middle"
      fontFamily="'JetBrains Mono', monospace"
      style={{ letterSpacing: "0.14em", textTransform: "uppercase" }}
    >
      {text}
    </text>
  );
}

export default function ThreatGraph({
  graph,
  onSelectAsset,
}: {
  graph: Graph;
  onSelectAsset?: (facilityId: string) => void;
}) {
  const l = useMemo(() => layout(graph), [graph]);
  /*
   * Наведений вузол задає «ланцюжок»: він сам плюс усі його сусіди. Решта
   * приглушується, а не ховається — зникання вузлів під курсором змінює
   * картинку під рукою й дезорієнтує.
   */
  const [hover, setHover] = useState<string | null>(null);
  const chain = useMemo(() => {
    if (!hover) return null;
    const set = new Set<string>([hover]);
    for (const k of l.adj.get(hover) ?? []) set.add(k);
    return set;
  }, [hover, l]);

  if (!l.nodes.length) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-emerald-400">
          Активних звʼязків немає
        </p>
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
          Граф малює ланцюжок «канал повідомив → ціль → наш обʼєкт». Він порожній, поки жодна
          повітряна ціль не наблизилась до критичного обʼєкта.
        </p>
      </div>
    );
  }

  const clip = (str: string, max: number) => (str.length > max ? `${str.slice(0, max)}…` : str);
  const dim = (key: string) => (chain && !chain.has(key) ? 0.15 : 1);

  return (
    <div className="size-full overflow-y-auto overflow-x-hidden">
      <svg
        viewBox={`0 0 ${W} ${l.height}`}
        width="100%"
        height={l.height}
        preserveAspectRatio="xMidYMin meet"
        className="block"
        role="img"
        aria-label="Граф звʼязків загроз і обʼєктів"
        onMouseLeave={() => setHover(null)}
      >
        <ColumnHeader x={COL_CHANNEL} text="Канали" tone="#94a3b8" />
        <ColumnHeader x={COL_THREAT} text="Цілі" tone="#ffb020" />
        <ColumnHeader x={COL_ASSET} text="Обʼєкти" tone="#ff6b6b" />

        {l.edges.map((e, i) => {
          const lit = !chain || (chain.has(e.a.key) && chain.has(e.b.key));
          return (
            <path
              key={i}
              d={curve(e.a, e.b)}
              fill="none"
              stroke={e.channel ? "#3a4658" : "#ff4d4d"}
              strokeWidth={e.channel ? 1 : 1.5}
              strokeOpacity={lit ? (e.channel ? 0.45 : 0.55) : 0.06}
              strokeDasharray={e.channel ? "2 4" : undefined}
            />
          );
        })}

        {l.nodes.map((p) => {
          const facilityId = p.kind === "asset" ? p.key.slice(2) : null;
          const clickable = Boolean(facilityId && onSelectAsset);
          // Обʼєкти підписані ліворуч від колонки, цілі й канали — праворуч:
          // так підпис ніколи не лягає на ребро сусідньої колонки.
          const right = p.kind !== "asset";
          return (
            <g
              key={p.key}
              opacity={dim(p.key)}
              style={{ cursor: clickable ? "pointer" : "default" }}
              onMouseEnter={() => setHover(p.key)}
              onFocus={() => setHover(p.key)}
              onClick={clickable ? () => onSelectAsset!(facilityId!) : undefined}
            >
              <title>{p.label}</title>
              <circle
                cx={p.x}
                cy={p.y}
                r={p.r}
                fill={`${p.color}33`}
                stroke={p.color}
                strokeWidth={chain?.has(p.key) ? 2.5 : 1.5}
              />
              <text
                x={right ? p.x + p.r + 6 : p.x - p.r - 6}
                y={p.y + 3}
                fill={p.kind === "asset" ? "#e6edf5" : "#9fb0c0"}
                fontSize={p.kind === "asset" ? 11 : 10}
                textAnchor={right ? "start" : "end"}
                fontFamily="'JetBrains Mono', monospace"
              >
                {clip(p.label, p.kind === "asset" ? 32 : 20)}
              </text>
            </g>
          );
        })}

        {l.hiddenThreats > 0 ? (
          <text
            x={COL_THREAT}
            y={l.height - 8}
            fill="#64748b"
            fontSize={9}
            textAnchor="middle"
            fontFamily="'JetBrains Mono', monospace"
          >
            +{l.hiddenThreats} цілей
          </text>
        ) : null}
        {l.hiddenChannels > 0 ? (
          <text
            x={COL_CHANNEL}
            y={l.height - 8}
            fill="#64748b"
            fontSize={9}
            textAnchor="middle"
            fontFamily="'JetBrains Mono', monospace"
          >
            +{l.hiddenChannels} каналів
          </text>
        ) : null}
      </svg>
    </div>
  );
}
