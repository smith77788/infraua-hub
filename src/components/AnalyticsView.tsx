import { useMemo, type ReactNode } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from "recharts";
import { Activity, Layers, Network, ShieldAlert, Siren, TrendingUp } from "lucide-react";

import { type AlertRegion } from "@/lib/alerts";
import { analyzeNetwork, eventTimeline } from "@/lib/infra-analytics";
import {
  CATEGORIES,
  EVENT_KINDS,
  type Facility,
  type GraphEdge,
  type InfraEvent,
} from "@/lib/infra-types";

interface Props {
  facilities: Facility[];
  edges: GraphEdge[];
  events: InfraEvent[];
  alerts: AlertRegion[];
  onSelect: (id: string) => void;
}

function Stat({
  icon,
  label,
  value,
  tone = "text-foreground",
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <div className="rounded border border-border bg-card p-3">
      <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

const READINESS_TONE = (r: number) =>
  r >= 90 ? "#34d399" : r >= 70 ? "#f5a623" : r >= 40 ? "#fb923c" : "#ef4444";

export default function AnalyticsView({ facilities, edges, events, alerts, onSelect }: Props) {
  const analysis = useMemo(
    () => analyzeNetwork(facilities, edges, events, alerts),
    [facilities, edges, events, alerts],
  );
  const timeline = useMemo(() => eventTimeline(events, 30), [events]);
  const activeAlarms = useMemo(() => alerts.filter((r) => r.active), [alerts]);

  const totalAtRisk = analysis.sectors.reduce((n, s) => n + s.atRisk, 0);
  const top = analysis.ranked.slice(0, 15);

  return (
    <div className="grid-bg h-full overflow-y-auto bg-background p-4">
      <div className="mx-auto max-w-5xl space-y-4">
        {/* KPI */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat icon={<Layers className="size-3" />} label="Обʼєктів" value={facilities.length} />
          <Stat
            icon={<Network className="size-3" />}
            label="Звʼязків живлення"
            value={edges.length}
          />
          <Stat
            icon={<ShieldAlert className="size-3" />}
            label="Під загрозою"
            value={totalAtRisk}
            tone={totalAtRisk ? "text-amber-400" : "text-foreground"}
          />
          <Stat
            icon={<Siren className="size-3" />}
            label="Тривоги"
            value={activeAlarms.length}
            tone={activeAlarms.length ? "text-red-400" : "text-foreground"}
          />
        </div>

        {/* Sector readiness */}
        <section className="rounded border border-border bg-card p-3">
          <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <TrendingUp className="size-3" /> Готовність секторів
          </p>
          <div className="mt-3 space-y-2.5">
            {analysis.sectors.map((s) => (
              <div key={s.tier}>
                <div className="mb-1 flex items-center justify-between text-[11px]">
                  <span>{s.label}</span>
                  <span className="font-mono text-muted-foreground">
                    {s.readiness}% · {s.total} обʼєктів
                    {s.atRisk ? ` · ${s.atRisk} під загрозою` : ""}
                    {s.underAlarm ? ` · ${s.underAlarm} у тривозі` : ""}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${s.readiness}%`, background: READINESS_TONE(s.readiness) }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Event timeline */}
        <section className="rounded border border-border bg-card p-3">
          <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <Activity className="size-3" /> Динаміка подій · 30 днів
          </p>
          <div className="mt-3 h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={timeline} margin={{ top: 4, right: 4, bottom: 0, left: -22 }}>
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9, fill: "#94a3b8" }}
                  interval={4}
                  tickLine={false}
                  axisLine={{ stroke: "#1f2937" }}
                />
                <YAxis
                  tick={{ fontSize: 9, fill: "#94a3b8" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "#0a0d12",
                    border: "1px solid #1f2937",
                    borderRadius: 6,
                    fontSize: 11,
                  }}
                  labelStyle={{ color: "#e2e8f0" }}
                />
                <Bar dataKey="fire" stackId="e" fill={EVENT_KINDS.fire.color} name="Пожежі" />
                <Bar dataKey="quake" stackId="e" fill={EVENT_KINDS.quake.color} name="Сейсміка" />
                <Bar dataKey="storm" stackId="e" fill={EVENT_KINDS.storm.color} name="Шторми" />
                <Bar
                  dataKey="other"
                  stackId="e"
                  fill={EVENT_KINDS.other.color}
                  name="Інше"
                  radius={[2, 2, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Active alarms */}
          <section className="rounded border border-border bg-card p-3">
            <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <Siren className="size-3" /> Повітряні тривоги
            </p>
            {activeAlarms.length === 0 ? (
              <p className="mt-2 font-mono text-[11px] text-emerald-400">
                Наразі активних тривог немає.
              </p>
            ) : (
              <div className="mt-2 space-y-1.5">
                {activeAlarms.map((r) => (
                  <div
                    key={r.code}
                    className="flex items-center justify-between rounded border border-red-500/40 bg-red-500/5 px-2.5 py-1.5"
                  >
                    <span className="flex items-center gap-2 text-[11px]">
                      <span className="size-2 animate-pulse rounded-full bg-red-500" />
                      {r.name}
                    </span>
                    {r.since ? (
                      <span className="font-mono text-[10px] text-muted-foreground">{r.since}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Critical ranking */}
          <section className="rounded border border-border bg-card p-3">
            <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <ShieldAlert className="size-3" /> Індекс критичності · топ-15
            </p>
            <div className="mt-2 space-y-1">
              {top.map(({ facility, a }) => (
                <button
                  key={facility.id}
                  onClick={() => onSelect(facility.id)}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-muted"
                >
                  <span className="w-8 shrink-0 font-mono text-[11px] font-semibold tabular-nums text-primary">
                    {a.score}
                  </span>
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: CATEGORIES[facility.category].color }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px]">{facility.name}</span>
                    <span className="block truncate font-mono text-[9px] text-muted-foreground">
                      {CATEGORIES[facility.category].label}
                      {a.dependents ? ` · ${a.dependents} залежних` : ""}
                    </span>
                  </span>
                  {a.underAlarm ? <Siren className="size-3 shrink-0 text-red-400" /> : null}
                  {a.atRisk ? <span className="size-2 shrink-0 rounded-full bg-amber-400" /> : null}
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* Dependents bar */}
        <section className="rounded border border-border bg-card p-3">
          <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <Network className="size-3" /> Найбільш звʼязані вузли (низхідні залежності)
          </p>
          <div className="mt-3 h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                layout="vertical"
                data={analysis.ranked
                  .filter((r) => r.a.dependents > 0)
                  .slice(0, 10)
                  .map((r) => ({
                    name:
                      r.facility.name.length > 26
                        ? r.facility.name.slice(0, 25) + "…"
                        : r.facility.name,
                    dependents: r.a.dependents,
                    color: CATEGORIES[r.facility.category].color,
                  }))}
                margin={{ top: 0, right: 12, bottom: 0, left: 4 }}
              >
                <XAxis
                  type="number"
                  tick={{ fontSize: 9, fill: "#94a3b8" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={150}
                  tick={{ fontSize: 9, fill: "#cbd5e1" }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  cursor={{ fill: "#1f293733" }}
                  contentStyle={{
                    background: "#0a0d12",
                    border: "1px solid #1f2937",
                    borderRadius: 6,
                    fontSize: 11,
                  }}
                />
                <Bar dataKey="dependents" radius={[0, 3, 3, 0]}>
                  {analysis.ranked
                    .filter((r) => r.a.dependents > 0)
                    .slice(0, 10)
                    .map((r) => (
                      <Cell key={r.facility.id} fill={CATEGORIES[r.facility.category].color} />
                    ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <p className="pb-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
          Індекс критичності враховує тир обʼєкта, кількість низхідних залежностей за графом
          живлення, близькість активних подій та повітряну тривогу в регіоні.
        </p>
      </div>
    </div>
  );
}
