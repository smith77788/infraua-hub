import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, Copy, GitBranch, Route, ShieldAlert, TriangleAlert } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Panel,
  PanelHeader,
  Select,
  Spinner,
  StatTile,
  Tabs,
} from "@/console/components/primitives";
import { api } from "@/console/lib/api";
import { useSession } from "@/console/hooks/useSession";
import type { PathsResponse, RiskAssessment, RiskBand } from "@/console/lib/types";
import { cn } from "@/lib/utils";
import { entityClasses, formatNumber } from "@/console/lib/format";

// A stable empty array: `?? []` allocates a new one on every render, which
// makes every useMemo downstream recompute even when the data has not changed.
const NONE: never[] = [];

/**
 * Structural analysis: who brokers between clusters, who scores as risky and
 * exactly why, which entities look like duplicates of each other, and how any
 * two entities are actually connected.
 *
 * Every risk score here is shown with the signals that produced it, expanded
 * on click. That is not a UI nicety — a score an analyst cannot take apart is
 * a score they cannot disagree with, and in a compliance or intelligence
 * setting it will be acted on anyway.
 */

const BAND_STYLES: Record<RiskBand, string> = {
  severe: "border-clearance-topsecret/50 bg-clearance-topsecret/10 text-clearance-topsecret",
  high: "border-clearance-secret/50 bg-clearance-secret/10 text-clearance-secret",
  elevated:
    "border-clearance-confidential/50 bg-clearance-confidential/10 text-clearance-confidential",
  low: "border-border bg-muted text-muted-foreground",
};

export function AnalyticsView() {
  const { apiKey } = useSession();
  const [tab, setTab] = React.useState<"risk" | "structure" | "duplicates" | "paths">("risk");

  const analytics = useQuery({
    queryKey: ["analytics"],
    queryFn: () => api.analytics(apiKey),
  });

  if (analytics.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (analytics.isError) return <ErrorNote>{(analytics.error as Error).message}</ErrorNote>;

  const data = analytics.data!;
  const scored = data.risk.filter((r) => r.score > 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Аналіз</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Обчислено за вашим виглядом графа, а не за всім сховищем — сутність вище вашого допуску не
          може впливати на оцінки тих, що нижче, бо це виказало б її існування.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Сутності" value={formatNumber(data.totals.nodes)} />
        <StatTile label="Звʼязки" value={formatNumber(data.totals.edges)} />
        <StatTile
          label="Кластери"
          value={formatNumber(data.totals.components)}
          hint={`найбільший ${data.totals.largestComponent}`}
        />
        <StatTile
          label="Ізольовані"
          value={formatNumber(data.totals.isolated)}
          hint="без звʼязків"
        />
        <StatTile
          label="Критичний ризик"
          value={formatNumber(data.riskBands.severe)}
          hint={`${data.riskBands.high} високих`}
          tone={data.riskBands.severe > 0 ? "bad" : data.riskBands.high > 0 ? "warn" : "good"}
        />
      </div>

      <Tabs
        tabs={[
          { id: "risk" as const, label: "Ризик", count: scored.length },
          { id: "structure" as const, label: "Структура" },
          {
            id: "duplicates" as const,
            label: "Дублікати",
            count: data.duplicateCandidates.length,
          },
          { id: "paths" as const, label: "Звʼязність" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "risk" && <RiskPanel scored={scored} total={data.risk.length} />}
      {tab === "structure" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel>
            <PanelHeader
              title="Посередництво (betweenness)"
              description="Сутності, що лежать на шляхах між іншими — там, де зʼявляються посередники"
            />
            {data.centrality.every((c) => c.raw === 0) ? (
              <EmptyState
                icon={GitBranch}
                title="Посередників немає"
                description="Або в графі немає шляхів довжиною два і більше, або в кожної сутності є так само прямий обхідний маршрут. Це не проблема — просто немає позиції посередника."
              />
            ) : (
              <ul className="divide-y divide-border">
                {data.centrality
                  .filter((c) => c.raw > 0)
                  .map((entry) => (
                    <li key={entry.id} className="px-4 py-2.5">
                      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                        <span className="truncate font-medium">{entry.label}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {entry.score.toFixed(2)}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${entry.score * 100}%` }}
                        />
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Найбільш звʼязані" description="Кількість звʼязків" />
            {data.connectivity.length === 0 ? (
              <EmptyState title="Сутностей немає" />
            ) : (
              <ul className="divide-y divide-border">
                {data.connectivity.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-2 px-4 py-2 text-xs"
                  >
                    <span className="truncate font-medium">{entry.label}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {entry.degree}
                      <span className="ml-1.5 text-[10px]">
                        ({entry.outDegree}↗ {entry.inDegree}↙)
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
      {tab === "duplicates" && <DuplicatesPanel candidates={data.duplicateCandidates} />}
      {tab === "paths" && <PathsPanel apiKey={apiKey} />}
    </div>
  );
}

function RiskPanel({ scored, total }: { scored: RiskAssessment[]; total: number }) {
  const [expanded, setExpanded] = React.useState<string | null>(null);

  if (scored.length === 0) {
    return (
      <Panel>
        <EmptyState
          icon={ShieldAlert}
          title="Жодна сутність не спрацювала на сигнал ризику"
          description={`All ${total} visible entities scored zero. Signals and their weights are in config/risk_signals.json — if you expected a hit, the thresholds there are the place to look.`}
        />
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader
        title="Оцінки ризику"
        description="Клацніть сутність, щоб побачити кожен сигнал за її оцінкою"
      />
      <ul className="divide-y divide-border">
        {scored.map((assessment) => {
          const open = expanded === assessment.id;
          return (
            <li key={assessment.id}>
              <button
                onClick={() => setExpanded(open ? null : assessment.id)}
                aria-expanded={open}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/40"
              >
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                    open && "rotate-90",
                  )}
                />
                <span className="w-9 shrink-0 text-right font-mono text-sm font-semibold tabular-nums">
                  {assessment.score}
                </span>
                <Badge className={cn("shrink-0", BAND_STYLES[assessment.band])}>
                  {assessment.band}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-sm">{assessment.label}</span>
                <Badge
                  className={cn(
                    "hidden shrink-0 sm:inline-flex",
                    entityClasses(assessment.type as never),
                  )}
                >
                  {assessment.type}
                </Badge>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {assessment.signals.length} signal{assessment.signals.length === 1 ? "" : "s"}
                </span>
              </button>

              {open && (
                <ul className="animate-fade-in space-y-2 border-t border-border bg-muted/20 px-4 py-3 pl-12">
                  {assessment.signals.map((signal) => (
                    <li key={signal.id} className="rounded border border-border bg-card p-2.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-xs font-medium">{signal.label}</p>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          +{signal.contribution}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {signal.reason}
                      </p>
                      <p className="mt-1 font-mono text-[11px] text-primary">{signal.evidence}</p>
                    </li>
                  ))}
                  <li className="pt-0.5 text-[11px] text-muted-foreground">
                    Оцінки обмежені сотнею, тож внески вище можуть у сумі перевищувати її. Ваги
                    лежать у<span className="font-mono"> config/risk_signals.json</span> — що
                    вважати ризиком, вирішуєте ви, а не платформа.
                  </li>
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function DuplicatesPanel({
  candidates,
}: {
  candidates: {
    a: { id: string; label: string };
    b: { id: string; label: string };
    confidence: number;
    reasons: string[];
    sharedNeighbors: string[];
  }[];
}) {
  if (candidates.length === 0) {
    return (
      <Panel>
        <EmptyState
          icon={Copy}
          title="Кандидатів у дублікати немає"
          description="Жодні дві сутності одного типу не мають спільної назви, ідентифікатора чи достатньої підтверджувальної структури."
        />
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader
        title="Можливі дублікати"
        description="Пропонуються, але ніколи не обʼєднуються — помилкове обʼєднання вигадує звʼязок між двома реальними людьми"
      />
      <ul className="divide-y divide-border">
        {candidates.map((candidate, i) => (
          <li key={`${candidate.a.id}-${candidate.b.id}-${i}`} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded border border-border bg-muted px-2 py-0.5 text-xs font-medium">
                {candidate.a.label}
              </span>
              <span className="text-xs text-muted-foreground">≟</span>
              <span className="rounded border border-border bg-muted px-2 py-0.5 text-xs font-medium">
                {candidate.b.label}
              </span>
              <span
                className={cn(
                  "ml-auto shrink-0 font-mono text-xs tabular-nums",
                  candidate.confidence >= 0.8 ? "text-clearance-secret" : "text-muted-foreground",
                )}
                title="Впевненість — сила аргументу, а не рішення"
              >
                {candidate.confidence.toFixed(2)}
              </span>
            </div>
            <ul className="mt-1.5 space-y-0.5">
              {candidate.reasons.map((reason, j) => (
                <li key={j} className="text-[11px] leading-relaxed text-muted-foreground">
                  • {reason}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="flex items-start gap-2 border-t border-border px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Це пропозиції для людського рішення. Автоматичне обʼєднання за оцінкою подібності переписало
        б історію в системі, вся цінність якої — у перевірності цієї історії.
      </p>
    </Panel>
  );
}

function PathsPanel({ apiKey }: { apiKey: string }) {
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [result, setResult] = React.useState<PathsResponse | null>(null);

  const graph = useQuery({ queryKey: ["graph"], queryFn: () => api.graph(apiKey) });
  const nodes = graph.data?.nodes ?? NONE;

  const lookup = useMutation({
    mutationFn: () => api.paths(apiKey, from, to),
    onSuccess: setResult,
  });

  const labelFor = React.useMemo(() => new Map(nodes.map((n) => [n.id, n.label])), [nodes]);

  return (
    <Panel>
      <PanelHeader
        title="Як вони повʼязані?"
        description="Усі однаково короткі маршрути, щоб жоден окремий не читався як «той самий» звʼязок"
      />
      <form
        className="flex flex-col gap-2 border-b border-border p-4 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (from && to && from !== to) lookup.mutate();
        }}
      >
        <Select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Від сутності">
          <option value="">Від…</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label} ({n.type})
            </option>
          ))}
        </Select>
        <Select value={to} onChange={(e) => setTo(e.target.value)} aria-label="До сутності">
          <option value="">До…</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label} ({n.type})
            </option>
          ))}
        </Select>
        <Button type="submit" loading={lookup.isPending} disabled={!from || !to || from === to}>
          <Route className="h-3.5 w-3.5" /> Простежити
        </Button>
      </form>

      {lookup.isError && (
        <div className="p-4">
          <ErrorNote>{(lookup.error as Error).message}</ErrorNote>
        </div>
      )}

      {result && !lookup.isError && (
        <div className="p-4">
          {!result.connected ? (
            <EmptyState
              title="Звʼязку на вашому допуску немає"
              description={`${labelFor.get(result.from) ?? result.from} and ${labelFor.get(result.to) ?? result.to} are not linked by any chain of relations you can see. A path may exist above your clearance.`}
            />
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {result.paths.length} shortest route{result.paths.length === 1 ? "" : "s"} of{" "}
                {result.hops} hop{result.hops === 1 ? "" : "s"}.
              </p>
              <ul className="space-y-2">
                {result.paths.map((path, i) => (
                  <li key={i} className="scroll-x rounded border border-border p-2.5">
                    <div className="flex min-w-max items-center gap-1.5">
                      {path.map((step, j) => (
                        <React.Fragment key={`${step.id}-${j}`}>
                          {j > 0 && <span className="text-muted-foreground">→</span>}
                          <span className="whitespace-nowrap rounded bg-muted px-2 py-0.5 text-xs">
                            {step.label}
                          </span>
                        </React.Fragment>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {!result && !lookup.isPending && (
        <EmptyState
          icon={Route}
          title="Оберіть дві сутності"
          description="У списку лише сутності, видимі на вашому допуску, і маршрути лише через видимі сутності."
        />
      )}
    </Panel>
  );
}
