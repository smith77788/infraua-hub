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
        <h1 className="text-xl font-semibold tracking-tight">Analysis</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Computed over your view of the graph, not the whole store — an entity above your clearance
          cannot influence the scores of one below it, which would reveal that it exists.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Entities" value={formatNumber(data.totals.nodes)} />
        <StatTile label="Relations" value={formatNumber(data.totals.edges)} />
        <StatTile
          label="Clusters"
          value={formatNumber(data.totals.components)}
          hint={`largest ${data.totals.largestComponent}`}
        />
        <StatTile label="Isolated" value={formatNumber(data.totals.isolated)} hint="no relations" />
        <StatTile
          label="Severe risk"
          value={formatNumber(data.riskBands.severe)}
          hint={`${data.riskBands.high} high`}
          tone={data.riskBands.severe > 0 ? "bad" : data.riskBands.high > 0 ? "warn" : "good"}
        />
      </div>

      <Tabs
        tabs={[
          { id: "risk" as const, label: "Risk", count: scored.length },
          { id: "structure" as const, label: "Structure" },
          {
            id: "duplicates" as const,
            label: "Duplicates",
            count: data.duplicateCandidates.length,
          },
          { id: "paths" as const, label: "Connections" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "risk" && <RiskPanel scored={scored} total={data.risk.length} />}
      {tab === "structure" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel>
            <PanelHeader
              title="Brokerage (betweenness)"
              description="Entities sitting on the paths between others — where intermediaries show up"
            />
            {data.centrality.every((c) => c.raw === 0) ? (
              <EmptyState
                icon={GitBranch}
                title="Nobody brokers anything"
                description="Either the graph has no paths of length two or more, or every entity has an equally direct alternative route. Neither is a problem — there is simply no intermediary position to find."
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
            <PanelHeader title="Most connected" description="Raw relation count" />
            {data.connectivity.length === 0 ? (
              <EmptyState title="No entities" />
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
          title="No entity triggered a risk signal"
          description={`All ${total} visible entities scored zero. Signals and their weights are in config/risk_signals.json — if you expected a hit, the thresholds there are the place to look.`}
        />
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader
        title="Risk assessments"
        description="Click an entity to see every signal behind its score"
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
                    Scores are capped at 100, so the contributions above may sum higher. Weights
                    live in <span className="font-mono">config/risk_signals.json</span> — what
                    counts as risky is your judgement, not the platform&apos;s.
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
          title="No duplicate candidates"
          description="No two entities of the same type share a name, an identifier, or enough corroborating structure to be worth proposing."
        />
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader
        title="Possible duplicates"
        description="Proposed, never merged — a wrong merge invents a relationship between two real people"
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
                title="Confidence — a strength of case, never a decision"
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
        These are proposals for a person to judge. Merging automatically on a similarity score would
        rewrite history in a system whose whole value is that its history is auditable.
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
        title="How are these connected?"
        description="Every equally-short route, so no single path reads as the connection"
      />
      <form
        className="flex flex-col gap-2 border-b border-border p-4 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (from && to && from !== to) lookup.mutate();
        }}
      >
        <Select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From entity">
          <option value="">From…</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label} ({n.type})
            </option>
          ))}
        </Select>
        <Select value={to} onChange={(e) => setTo(e.target.value)} aria-label="To entity">
          <option value="">To…</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label} ({n.type})
            </option>
          ))}
        </Select>
        <Button type="submit" loading={lookup.isPending} disabled={!from || !to || from === to}>
          <Route className="h-3.5 w-3.5" /> Trace
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
              title="No connection at your clearance"
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
          title="Pick two entities"
          description="Only entities visible at your clearance are listed, and only routes through visible entities are returned."
        />
      )}
    </Panel>
  );
}
