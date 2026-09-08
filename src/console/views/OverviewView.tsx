import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  ArrowRight,
  Database,
  Network,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
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
import { CLEARANCE_ORDER, NODE_TYPES, type NodeType } from "@/console/lib/types";
import { cn } from "@/lib/utils";
import { entityClasses, formatNumber, relativeTime } from "@/console/lib/format";

// A stable empty array: `?? []` allocates a new one on every render, which
// makes every useMemo downstream recompute even when the data has not changed.
const NONE: never[] = [];

/**
 * The landing view: what is in the graph, whether the audit chain is sound,
 * and what has happened recently. Deliberately answers "is this platform in a
 * state I can trust right now?" before it shows any analysis.
 */
export function OverviewView() {
  const { apiKey, clearance } = useSession();

  const graph = useQuery({ queryKey: ["graph"], queryFn: () => api.graph(apiKey) });
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => api.audit(apiKey) });
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health(), retry: false });

  const nodes = graph.data?.nodes ?? NONE;
  const edges = graph.data?.edges ?? NONE;
  const entries = audit.data?.entries ?? NONE;

  const typeCounts = React.useMemo(() => {
    const counts = new Map<NodeType, number>();
    for (const t of NODE_TYPES) counts.set(t, 0);
    for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    return counts;
  }, [nodes]);

  const clearanceCounts = React.useMemo(() => {
    const counts = new Map<number, number>();
    for (const level of CLEARANCE_ORDER) counts.set(level, 0);
    for (const n of nodes) counts.set(n.clearance, (counts.get(n.clearance) ?? 0) + 1);
    return counts;
  }, [nodes]);

  const relationCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of edges) counts.set(e.relation, (counts.get(e.relation) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [edges]);

  const blockedCount = entries.filter((e) => e.action === "query_blocked").length;
  const recent = entries.slice(-6).reverse();

  if (graph.isLoading || audit.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  const error = graph.error ?? audit.error;
  if (error) return <ErrorNote>{(error as Error).message}</ErrorNote>;

  const verification = audit.data?.verification;
  const maxTypeCount = Math.max(1, ...Array.from(typeCounts.values()));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Огляд</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Усе нижче обмежено вашим допуском
            {clearance !== null && (
              <>
                {" "}
                — <ClearanceBadge level={clearance} className="align-middle" />
              </>
            )}
            . Сутності вище нього відфільтровані ще до складання відповіді, а не приховані потім.
          </p>
        </div>
        <Link
          to="/investigate"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Почати розслідування <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Сутності" value={formatNumber(nodes.length)} hint="видимі вам" />
        <StatTile label="Звʼязки" value={formatNumber(edges.length)} hint="перевірені онтологією" />
        <StatTile
          label="Документи"
          value={formatNumber(health.data?.documents ?? 0)}
          hint="у семантичному індексі"
        />
        <StatTile
          label="Записів аудиту"
          value={formatNumber(entries.length)}
          hint={blockedCount > 0 ? `${blockedCount} заблокованих запитів` : "заблокованих немає"}
          tone={blockedCount > 0 ? "warn" : "default"}
        />
      </div>

      {verification && (
        <div
          className={cn(
            "flex items-center gap-3 rounded-lg border px-4 py-3",
            verification.valid
              ? "border-clearance-public/40 bg-clearance-public/5"
              : "border-destructive/50 bg-destructive/10",
          )}
        >
          {verification.valid ? (
            <ShieldCheck className="h-4 w-4 shrink-0 text-clearance-public" />
          ) : (
            <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />
          )}
          <p className="text-xs">
            {verification.valid ? (
              <>
                <span className="font-medium text-clearance-public">Ланцюжок аудиту цілий.</span>{" "}
                <span className="text-muted-foreground">
                  Усі {entries.length} записів перераховуються до своїх хешів.
                </span>
              </>
            ) : (
              <>
                <span className="font-medium text-destructive">
                  Ланцюжок аудиту порушено на #{verification.brokenAtSeq}.
                </span>{" "}
                <span className="text-muted-foreground">
                  Записам від цієї точки далі вже не можна довіряти.
                </span>
              </>
            )}
          </p>
          <Link
            to="/audit"
            className="ml-auto shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Переглянути
          </Link>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-1">
          <PanelHeader title="Сутності за типом" />
          {nodes.length === 0 ? (
            <EmptyState
              icon={Database}
              title="Ще нічого не завантажено"
              description="Завантажте документ або CSV, щоб наповнити граф."
            />
          ) : (
            <div className="space-y-2.5 p-4">
              {NODE_TYPES.map((type) => {
                const count = typeCounts.get(type) ?? 0;
                return (
                  <div key={type}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <Badge className={entityClasses(type)}>{type}</Badge>
                      <span className="tabular-nums text-muted-foreground">{count}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${(count / maxTypeCount) * 100}%`,
                          background: `var(--entity-${type.toLowerCase()})`,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel className="lg:col-span-1">
          <PanelHeader title="Розподіл класифікації" description="Де лежать видимі дані" />
          {nodes.length === 0 ? (
            <EmptyState title="Сутностей немає" />
          ) : (
            <div className="space-y-2 p-4">
              {CLEARANCE_ORDER.map((level) => {
                const count = clearanceCounts.get(level) ?? 0;
                const pct = nodes.length > 0 ? (count / nodes.length) * 100 : 0;
                return (
                  <div key={level} className="flex items-center gap-2">
                    <ClearanceBadge level={level} className="w-[104px] shrink-0 justify-center" />
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${pct}%`,
                          background: `var(--clearance-${
                            ["public", "internal", "confidential", "secret", "topsecret"][level] ??
                            "public"
                          })`,
                        }}
                      />
                    </div>
                    <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {count}
                    </span>
                  </div>
                );
              })}
              {clearance !== null && clearance < 4 && (
                <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
                  Рівнів вище вашого допуску немає на цій діаграмі взагалі — сервер їх не надсилав.
                </p>
              )}
            </div>
          )}
        </Panel>

        <Panel className="lg:col-span-1">
          <PanelHeader title="Звʼязки" description={`${relationCounts.length} різних типів`} />
          {relationCounts.length === 0 ? (
            <EmptyState icon={Network} title="Звʼязків ще немає" />
          ) : (
            <ul className="divide-y divide-border">
              {relationCounts.slice(0, 8).map(([relation, count]) => (
                <li key={relation} className="flex items-center justify-between px-4 py-2 text-xs">
                  <span className="truncate font-mono">{relation}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel>
        <PanelHeader
          title="Нещодавня активність"
          description="Найновіші записи аудиту"
          actions={
            <Link to="/audit" className="text-xs text-muted-foreground hover:text-foreground">
              Усі записи
            </Link>
          }
        />
        {recent.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="Активності ще немає"
            description="Завантаження і розслідування зʼявляються тут одразу."
          />
        ) : (
          <ul className="divide-y divide-border">
            {recent.map((entry) => (
              <li key={entry.seq} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                <span className="w-10 shrink-0 font-mono text-muted-foreground">#{entry.seq}</span>
                <Badge
                  className={cn(
                    "shrink-0",
                    entry.action === "query_blocked"
                      ? "border-destructive/40 bg-destructive/10 text-destructive"
                      : "border-border bg-muted text-muted-foreground",
                  )}
                >
                  {entry.action}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.actor}</span>
                <span className="shrink-0 text-muted-foreground">
                  {relativeTime(entry.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {health.data && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Activity className="h-3 w-3" />
          Механізм викладу: <span className="font-mono">{health.data.narrative_engine}</span>
        </p>
      )}
    </div>
  );
}
