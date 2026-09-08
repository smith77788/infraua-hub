import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Network, RefreshCw, Search, X } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Select,
  Spinner,
  StatTile,
} from "@/console/components/primitives";
import { ClearanceBadge } from "@/console/components/ClearanceBadge";
import { GraphCanvas } from "@/console/components/GraphCanvas";
import { api } from "@/console/lib/api";
import { useSession } from "@/console/hooks/useSession";
import { NODE_TYPES, type GraphNode, type NodeType } from "@/console/lib/types";
import { cn } from "@/lib/utils";
import { downloadJson, entityClasses, formatNumber } from "@/console/lib/format";

// A stable empty array: `?? []` allocates a new one on every render, which
// makes every useMemo downstream recompute even when the data has not changed.
const NONE: never[] = [];

/**
 * The whole graph the operator is cleared to see, with filtering and a
 * selection inspector. Filtering happens client-side over an already
 * clearance-filtered payload: the server never sends a node above the
 * caller's level, so nothing here can widen what is visible — only narrow it.
 */
export function GraphView() {
  const { apiKey } = useSession();
  const [selected, setSelected] = React.useState<GraphNode | null>(null);
  const [search, setSearch] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<NodeType | "all">("all");
  const [colorBy, setColorBy] = React.useState<"type" | "clearance">("type");

  const graph = useQuery({
    queryKey: ["graph"],
    queryFn: () => api.graph(apiKey),
  });

  const nodes = graph.data?.nodes ?? NONE;
  const edges = graph.data?.edges ?? NONE;

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    const keep = nodes.filter((n) => {
      if (typeFilter !== "all" && n.type !== typeFilter) return false;
      if (!term) return true;
      return n.label.toLowerCase().includes(term) || n.id.toLowerCase().includes(term);
    });
    const keepIds = new Set(keep.map((n) => n.id));
    return {
      nodes: keep,
      // Only edges whose both ends survived the filter — a dangling edge would
      // imply a relation to something the view is not showing.
      edges: edges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target)),
    };
  }, [nodes, edges, search, typeFilter]);

  const typeCounts = React.useMemo(() => {
    const counts = new Map<NodeType, number>();
    for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    return counts;
  }, [nodes]);

  const neighbours = React.useMemo(() => {
    if (!selected) return [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return edges
      .filter((e) => e.source === selected.id || e.target === selected.id)
      .map((e) => {
        const otherId = e.source === selected.id ? e.target : e.source;
        return {
          edge: e,
          direction: e.source === selected.id ? ("out" as const) : ("in" as const),
          other: byId.get(otherId),
          otherId,
        };
      });
  }, [selected, nodes, edges]);

  if (graph.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (graph.isError) {
    return <ErrorNote>{(graph.error as Error).message}</ErrorNote>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Граф знань</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Усе, що дозволяє ваш допуск. Тягніть, щоб пересунути, крутіть для масштабу, клацніть
            вузол, щоб оглянути.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadJson("palanter-graph.json", graph.data)}
            disabled={nodes.length === 0}
          >
            <Download className="h-3.5 w-3.5" /> Експорт
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => graph.refetch()}
            loading={graph.isFetching}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Оновити
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Сутності" value={formatNumber(nodes.length)} />
        <StatTile label="Звʼязки" value={formatNumber(edges.length)} />
        <StatTile
          label="Показано"
          value={formatNumber(filtered.nodes.length)}
          hint={filtered.nodes.length !== nodes.length ? "відфільтровано" : "усі"}
        />
        <StatTile
          label="Ізольовані"
          value={formatNumber(
            nodes.filter((n) => !edges.some((e) => e.source === n.id || e.target === n.id)).length,
          )}
          hint="без звʼязків"
        />
      </div>

      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Фільтр за назвою або id…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Фільтр сутностей"
            />
          </div>
          <Select
            className="w-auto"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as NodeType | "all")}
            aria-label="Фільтр за типом сутності"
          >
            <option value="all">Усі типи</option>
            {NODE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t} ({typeCounts.get(t) ?? 0})
              </option>
            ))}
          </Select>
          <Select
            className="w-auto"
            value={colorBy}
            onChange={(e) => setColorBy(e.target.value as "type" | "clearance")}
            aria-label="Колір вузлів за"
          >
            <option value="type">Колір: тип сутності</option>
            <option value="clearance">Колір: допуск</option>
          </Select>
        </div>

        {nodes.length === 0 ? (
          <EmptyState
            icon={Network}
            title="Граф порожній"
            description="Ще нічого не завантажено, або все в ньому вище вашого допуску. Почніть з розділу «Завантаження»."
          />
        ) : (
          <div className="grid lg:grid-cols-[1fr_280px]">
            <GraphCanvas
              nodes={filtered.nodes}
              edges={filtered.edges}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
              colorBy={colorBy}
              height={520}
              className="p-2"
            />
            <div className="border-t border-border p-4 lg:border-l lg:border-t-0">
              {selected ? (
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{selected.label}</p>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                        {selected.id}
                      </p>
                    </div>
                    <button
                      onClick={() => setSelected(null)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Зняти вибір"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <Badge className={entityClasses(selected.type)}>{selected.type}</Badge>
                    <ClearanceBadge level={selected.clearance} />
                  </div>

                  {Object.keys(selected.properties).length > 0 && (
                    <div>
                      <p className="field-label">Властивості</p>
                      <dl className="space-y-1">
                        {Object.entries(selected.properties).map(([k, v]) => (
                          <div key={k} className="flex justify-between gap-2 text-xs">
                            <dt className="shrink-0 text-muted-foreground">{k}</dt>
                            <dd className="truncate text-right font-mono">{String(v)}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  )}

                  <div>
                    <p className="field-label">Звʼязки ({neighbours.length})</p>
                    {neighbours.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Немає на вашому допуску.</p>
                    ) : (
                      <ul className="space-y-1">
                        {neighbours.map(({ edge, direction, other, otherId }, i) => (
                          <li key={`${otherId}-${i}`}>
                            <button
                              onClick={() => other && setSelected(other)}
                              disabled={!other}
                              className={cn(
                                "w-full rounded border border-border px-2 py-1.5 text-left text-xs transition-colors",
                                other ? "hover:border-primary/50" : "opacity-60",
                              )}
                            >
                              <span className="text-muted-foreground">
                                {direction === "out" ? "→" : "←"} {edge.relation}
                              </span>
                              <span className="mt-0.5 block truncate font-medium">
                                {other?.label ?? otherId}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {selected.source_doc_ids.length > 0 && (
                    <div>
                      <p className="field-label">Походження</p>
                      <p className="text-xs text-muted-foreground">
                        Asserted by {selected.source_doc_ids.length} source document
                        {selected.source_doc_ids.length === 1 ? "" : "s"}.
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Оберіть вузол, щоб оглянути його властивості, звʼязки та походження.
                  </p>
                  <div>
                    <p className="field-label">Легенда</p>
                    <div className="flex flex-wrap gap-1.5">
                      {colorBy === "type"
                        ? NODE_TYPES.map((t) => (
                            <Badge key={t} className={entityClasses(t)}>
                              {t}
                            </Badge>
                          ))
                        : [0, 1, 2, 3, 4].map((level) => (
                            <ClearanceBadge key={level} level={level} />
                          ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
