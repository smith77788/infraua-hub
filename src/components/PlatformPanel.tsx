import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Network, RefreshCw, X } from "lucide-react";

import {
  getPlatformAnalytics,
  getPlatformConflicts,
  getPlatformGraphDiff,
  type RiskItem,
} from "@/lib/platform-read.functions";

/*
 * Панель аналітичної платформи (Palanter на Railway).
 *
 * Консоль возила факти в платформу й нічого не показувала назад. Тут — зворотний
 * бік: оцінка ризику вузлів графа з поясненням, центральність, зміни в часі,
 * конфлікти інтересів. Панель самодостатня: сама тягне серверні функції, тож
 * маршруту-god-компоненту не додається ще один блок стану. Дані рахує платформа
 * на своєму сховищі — консоль лише відображає.
 */

const BAND_TONE: Record<RiskItem["band"], string> = {
  severe: "border-red-500/40 bg-red-500/10 text-red-300",
  high: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  elevated: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  low: "border-slate-500/30 bg-slate-500/10 text-slate-300",
};
const BAND_LABEL: Record<RiskItem["band"], string> = {
  severe: "критичний",
  high: "високий",
  elevated: "підвищений",
  low: "низький",
};

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-border bg-card px-3 py-2">
      <div className="font-mono text-[18px] leading-none text-foreground">{value}</div>
      <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
      {children}
    </p>
  );
}

export default function PlatformPanel({ onClose }: { onClose: () => void }) {
  const analyticsFn = useServerFn(getPlatformAnalytics);
  const conflictsFn = useServerFn(getPlatformConflicts);
  const diffFn = useServerFn(getPlatformGraphDiff);

  const analyticsQ = useQuery({
    queryKey: ["platform-analytics"],
    queryFn: () => analyticsFn(),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const conflictsQ = useQuery({
    queryKey: ["platform-conflicts"],
    queryFn: () => conflictsFn(),
    staleTime: 5 * 60_000,
  });
  const diffQ = useQuery({
    queryKey: ["platform-diff-24h"],
    queryFn: () => diffFn({ data: { from: new Date(Date.now() - 24 * 3600_000).toISOString() } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const a = analyticsQ.data;
  const loading = analyticsQ.isLoading;
  const refetching = analyticsQ.isFetching || conflictsQ.isFetching || diffQ.isFetching;

  return (
    <div className="absolute inset-0 z-[600] flex flex-col bg-background/95 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-primary">
          <Network className="size-3.5" /> Аналітична платформа
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              void analyticsQ.refetch();
              void conflictsQ.refetch();
              void diffQ.refetch();
            }}
            title="Оновити"
            aria-label="Оновити"
            className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <RefreshCw className={`size-3.5 ${refetching ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 font-mono text-[10px] uppercase text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : !analyticsQ.data?.ok ? (
          <div className="mx-auto max-w-md rounded border border-amber-500/30 bg-amber-500/5 p-4 text-center">
            <AlertTriangle className="mx-auto mb-2 size-5 text-amber-400" />
            <p className="text-[12px] text-foreground">
              Платформа не відповіла. Перевірте, що задані `PLATFORM_API_URL` і `PLATFORM_API_KEY` і
              що ключ зареєстрований у `PLATFORM_API_KEYS` на боці Railway.
            </p>
            {analyticsQ.data?.error ? (
              <p className="mt-2 break-words font-mono text-[10px] text-muted-foreground">
                {analyticsQ.data.error}
              </p>
            ) : null}
          </div>
        ) : a?.data ? (
          <div className="mx-auto max-w-3xl space-y-6">
            <section>
              <SectionTitle>Граф онтології</SectionTitle>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                <Stat label="сутності" value={a.data.totals.nodes} />
                <Stat label="звʼязки" value={a.data.totals.edges} />
                <Stat label="компоненти" value={a.data.totals.components} />
                <Stat label="найбільший" value={a.data.totals.largestComponent} />
                <Stat label="ізольовані" value={a.data.totals.isolated} />
              </div>
            </section>

            <section>
              <SectionTitle>Ризик за смугами</SectionTitle>
              <div className="flex flex-wrap gap-2">
                {(["severe", "high", "elevated", "low"] as const).map((b) => (
                  <span
                    key={b}
                    className={`flex items-center gap-2 rounded border px-2.5 py-1 font-mono text-[11px] ${BAND_TONE[b]}`}
                  >
                    {BAND_LABEL[b]}
                    <span className="font-semibold">{a.data!.riskBands[b]}</span>
                  </span>
                ))}
              </div>
            </section>

            {a.data.risk.length > 0 ? (
              <section>
                <SectionTitle>Найризикованіші сутності (з поясненням)</SectionTitle>
                <div className="space-y-1.5">
                  {a.data.risk.slice(0, 10).map((r) => (
                    <div
                      key={r.id}
                      className={`rounded border p-2 ${BAND_TONE[r.band]} bg-opacity-5`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                          {r.label}
                        </span>
                        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                          {r.type}
                        </span>
                        <span className="shrink-0 font-mono text-[13px] font-semibold">
                          {r.score}
                        </span>
                      </div>
                      {r.signals[0] ? (
                        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                          {r.signals[0].reason}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {a.data.centrality.length > 0 ? (
              <section>
                <SectionTitle>Центральність (вузли-мости)</SectionTitle>
                <div className="space-y-1">
                  {a.data.centrality.slice(0, 8).map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center gap-2 rounded border border-border bg-card px-2 py-1.5"
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                        {c.label}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-primary">
                        {c.score.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="grid gap-2 sm:grid-cols-2">
              <div>
                <SectionTitle>Зміни за 24 год</SectionTitle>
                {diffQ.data?.ok && diffQ.data.data ? (
                  <div className="grid grid-cols-3 gap-2">
                    <Stat label="додано" value={`+${diffQ.data.data.totals.added}`} />
                    <Stat label="зникло" value={`−${diffQ.data.data.totals.removed}`} />
                    <Stat label="змінено" value={diffQ.data.data.totals.changed} />
                  </div>
                ) : (
                  <p className="font-mono text-[10px] text-muted-foreground">—</p>
                )}
              </div>
              <div>
                <SectionTitle>Конфлікти інтересів</SectionTitle>
                {conflictsQ.data?.ok && conflictsQ.data.data ? (
                  <div className="grid grid-cols-3 gap-2">
                    <Stat label="підтв." value={conflictsQ.data.data.confirmed} />
                    <Stat label="питання" value={conflictsQ.data.data.unconfirmed} />
                    <Stat label="спільні" value={conflictsQ.data.data.commonOwnership} />
                  </div>
                ) : (
                  <p className="font-mono text-[10px] text-muted-foreground">—</p>
                )}
              </div>
            </section>

            {a.data.duplicateCount > 0 ? (
              <p className="font-mono text-[10px] text-muted-foreground">
                Кандидати на злиття (дублі сутностей): {a.data.duplicateCount}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
