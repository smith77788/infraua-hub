import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ArrowLeft, Printer } from "lucide-react";

import { getAlerts, getEvents, getFacilities, getThreats } from "@/lib/infra.functions";
import { analyzeNetwork, operatorRollup } from "@/lib/infra-analytics";
import {
  buildGraph,
  CATEGORIES,
  EVENT_KINDS,
  facilitiesAtRisk,
  summarize,
} from "@/lib/infra-types";

export const Route = createFileRoute("/brief")({
  head: () => ({
    meta: [{ title: "InfraUA — ситуаційний брифінг" }],
  }),
  component: Brief,
});

function Brief() {
  const facilitiesFn = useServerFn(getFacilities);
  const eventsFn = useServerFn(getEvents);
  const alertsFn = useServerFn(getAlerts);

  const facilitiesQuery = useQuery({ queryKey: ["facilities"], queryFn: () => facilitiesFn() });
  const eventsQuery = useQuery({ queryKey: ["events"], queryFn: () => eventsFn() });
  const alertsQuery = useQuery({ queryKey: ["alerts"], queryFn: () => alertsFn() });
  const threatsFn = useServerFn(getThreats);
  const threatsQuery = useQuery({ queryKey: ["threats"], queryFn: () => threatsFn() });
  const threats = threatsQuery.data?.threats ?? [];

  const facilities = useMemo(() => facilitiesQuery.data?.facilities ?? [], [facilitiesQuery.data]);
  const events = useMemo(() => eventsQuery.data?.events ?? [], [eventsQuery.data]);
  const regions = useMemo(() => alertsQuery.data?.regions ?? [], [alertsQuery.data]);
  const activeAlarms = useMemo(() => regions.filter((r) => r.active), [regions]);

  const edges = useMemo(() => buildGraph(facilities), [facilities]);
  const analysis = useMemo(
    () => analyzeNetwork(facilities, edges, events, regions),
    [facilities, edges, events, regions],
  );
  const operators = useMemo(() => operatorRollup(facilities, analysis, 10), [facilities, analysis]);
  const riskMap = useMemo(() => facilitiesAtRisk(facilities, events), [facilities, events]);
  const summary = useMemo(
    () => summarize(facilities, riskMap, events, activeAlarms.length),
    [facilities, riskMap, events, activeAlarms.length],
  );

  const loading = facilitiesQuery.isLoading || eventsQuery.isLoading || alertsQuery.isLoading;

  const now = new Date();
  const top = analysis.ranked.slice(0, 20);
  const recent = [...events].sort((a, b) => b.time.localeCompare(a.time)).slice(0, 15);

  return (
    <div className="brief mx-auto max-w-3xl bg-background px-6 py-8 text-foreground">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .brief { color: #000; background: #fff; }
          .brief * { color: #000 !important; border-color: #bbb !important; }
        }
      `}</style>

      <div className="no-print mb-6 flex items-center justify-between">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:bg-card"
        >
          <ArrowLeft className="size-3.5" /> До консолі
        </Link>
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Printer className="size-3.5" /> Друк / PDF
        </button>
      </div>

      <header className="border-b border-border pb-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
          INFRAUA · ситуаційний брифінг
        </p>
        <h1 className="mt-1 text-2xl font-bold">Критична інфраструктура України</h1>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          Сформовано {now.toLocaleString("uk-UA")}
          {loading ? " · завантаження…" : ""}
        </p>
      </header>

      {/* Резюме */}
      <section className="mt-5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          1. Загальна обстановка
        </h2>
        <p className="mt-2 text-sm leading-relaxed">
          Статус: <b>{summary.label}</b>. Під моніторингом <b>{facilities.length}</b> обʼєктів у{" "}
          {analysis.sectors.length} секторах, зафіксовано <b>{summary.atRisk}</b> обʼєктів у зоні
          активних подій
          {summary.lifeAtRisk ? ` (зокрема ${summary.lifeAtRisk} обʼєктів життєзабезпечення)` : ""}.
          Повітряні тривоги активні у <b>{activeAlarms.length}</b> регіонах, зафіксовано{" "}
          <b>{threats.length}</b> активних повітряних цілей (OSINT). Усього подій за 30 днів:{" "}
          <b>{summary.eventCount}</b>.
        </p>
      </section>

      {/* Тривоги */}
      <section className="mt-5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          2. Повітряні тривоги
        </h2>
        {activeAlarms.length === 0 ? (
          <p className="mt-2 text-sm">Активних тривог немає.</p>
        ) : (
          <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            {activeAlarms.map((r) => (
              <li key={r.code} className="flex justify-between border-b border-border/50 py-0.5">
                <span>{r.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{r.since ?? "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Сектори */}
      <section className="mt-5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          3. Готовність секторів
        </h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left font-mono text-[10px] uppercase text-muted-foreground">
              <th className="py-1 font-normal">Сектор</th>
              <th className="py-1 text-right font-normal">Обʼєктів</th>
              <th className="py-1 text-right font-normal">Під загрозою</th>
              <th className="py-1 text-right font-normal">Готовність</th>
            </tr>
          </thead>
          <tbody>
            {analysis.sectors.map((s) => (
              <tr key={s.tier} className="border-b border-border/40">
                <td className="py-1">{s.label}</td>
                <td className="py-1 text-right font-mono">{s.total}</td>
                <td className="py-1 text-right font-mono">{Math.max(s.atRisk, s.underAlarm)}</td>
                <td className="py-1 text-right font-mono font-semibold">{s.readiness}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Критичні обʼєкти */}
      <section className="mt-5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          4. Обʼєкти найвищої критичності
        </h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left font-mono text-[10px] uppercase text-muted-foreground">
              <th className="py-1 font-normal">#</th>
              <th className="py-1 font-normal">Обʼєкт</th>
              <th className="py-1 font-normal">Сектор</th>
              <th className="py-1 text-right font-normal">Залежних</th>
              <th className="py-1 text-right font-normal">Індекс</th>
            </tr>
          </thead>
          <tbody>
            {top.map(({ facility, a }, i) => (
              <tr key={facility.id} className="border-b border-border/40">
                <td className="py-1 font-mono text-muted-foreground">{i + 1}</td>
                <td className="py-1">
                  {facility.name}
                  {a.atRisk ? " ⚠" : ""}
                  {a.underAlarm ? " 🚨" : ""}
                </td>
                <td className="py-1 text-muted-foreground">
                  {CATEGORIES[facility.category].label}
                </td>
                <td className="py-1 text-right font-mono">{a.dependents}</td>
                <td className="py-1 text-right font-mono font-semibold">{a.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Події */}
      <section className="mt-5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          5. Останні події
        </h2>
        {recent.length === 0 ? (
          <p className="mt-2 text-sm">Подій не зафіксовано.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {recent.map((ev) => (
              <li key={ev.id} className="border-b border-border/40 py-1">
                <span className="font-mono text-[11px] text-muted-foreground">
                  {new Date(ev.time).toLocaleString("uk-UA")} · {EVENT_KINDS[ev.kind].label} ·{" "}
                  {ev.source}
                </span>
                <br />
                {ev.title}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-6 border-t border-border pt-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
        Джерела: OpenStreetMap (обʼєкти), NASA EONET та GDACS (події), USGS (сейсміка), відкриті
        дані повітряних тривог. Показники розрахункові й призначені для ситуаційної обізнаності.
      </footer>
    </div>
  );
}
