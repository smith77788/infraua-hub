import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Loader2,
  Map as MapIcon,
  RefreshCw,
  Search,
  Waypoints,
  Zap,
} from "lucide-react";

import DependencyGraph from "@/components/DependencyGraph";
import SituationBar from "@/components/SituationBar";
import TimelinePlayer, { TRAIL_MS } from "@/components/TimelinePlayer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getAlerts, getEvents, getFacilities } from "@/lib/infra.functions";
import { assignRegions } from "@/lib/infra-analytics";
import {
  buildGraph,
  CATEGORIES,
  EVENT_KINDS,
  downstreamOf,
  facilitiesAtRisk,
  summarize,
  type CategoryId,
  type Facility,
} from "@/lib/infra-types";

const InfraMap = lazy(() => import("@/components/InfraMap"));
const AnalyticsView = lazy(() => import("@/components/AnalyticsView"));

const TIME_WINDOWS = [
  { id: "24h", label: "24 год", hours: 24 },
  { id: "3d", label: "3 дні", hours: 72 },
  { id: "7d", label: "7 днів", hours: 168 },
  { id: "30d", label: "30 днів", hours: 720 },
] as const;
type WindowId = (typeof TIME_WINDOWS)[number]["id"];

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "InfraUA — консоль моніторингу критичної інфраструктури" },
      {
        name: "description",
        content:
          "Жива карта обʼєктів енергетики, води, транспорту та звʼязку України, стрічка подій NASA і USGS та граф залежностей з моделюванням каскадних відключень.",
      },
      { property: "og:title", content: "InfraUA — консоль критичної інфраструктури" },
      {
        property: "og:description",
        content: "Карта, події та граф залежностей інфраструктури України на відкритих даних.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Console,
});

const ALL_CATEGORIES = Object.keys(CATEGORIES) as CategoryId[];

function Console() {
  const facilitiesFn = useServerFn(getFacilities);
  const eventsFn = useServerFn(getEvents);

  const facilitiesQuery = useQuery({
    queryKey: ["facilities"],
    queryFn: () => facilitiesFn(),
    staleTime: 30 * 60 * 1000,
  });
  const eventsQuery = useQuery({
    queryKey: ["events"],
    queryFn: () => eventsFn(),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
  const alertsFn = useServerFn(getAlerts);
  const alertsQuery = useQuery({
    queryKey: ["alerts"],
    queryFn: () => alertsFn(),
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });

  const [active, setActive] = useState<Set<CategoryId>>(new Set(ALL_CATEGORIES));
  const [query, setQuery] = useState("");
  const [showLinks, setShowLinks] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [outageId, setOutageId] = useState<string | null>(null);
  const [view, setView] = useState<"map" | "analytics">("map");
  const [windowId, setWindowId] = useState<WindowId>("30d");
  const [playCursor, setPlayCursor] = useState<number | null>(null);

  const allFacilities = useMemo(
    () => facilitiesQuery.data?.facilities ?? [],
    [facilitiesQuery.data],
  );
  const allEvents = useMemo(() => eventsQuery.data?.events ?? [], [eventsQuery.data]);
  const regions = useMemo(() => alertsQuery.data?.regions ?? [], [alertsQuery.data]);
  const activeAlarms = useMemo(() => regions.filter((r) => r.active).length, [regions]);
  const alarmIds = useMemo(() => {
    const active = new Set(regions.filter((r) => r.active).map((r) => r.code));
    if (!active.size) return new Set<string>();
    const reg = assignRegions(allFacilities, regions);
    const s = new Set<string>();
    for (const [id, code] of reg) if (active.has(code)) s.add(id);
    return s;
  }, [allFacilities, regions]);

  const windowHours = TIME_WINDOWS.find((w) => w.id === windowId)!.hours;
  const events = useMemo(() => {
    if (playCursor != null) {
      const from = playCursor - TRAIL_MS;
      return allEvents.filter((e) => {
        const t = new Date(e.time).getTime();
        return t <= playCursor && t >= from;
      });
    }
    if (windowId === "30d") return allEvents;
    const cutoff = Date.now() - windowHours * 3600_000;
    return allEvents.filter((e) => new Date(e.time).getTime() >= cutoff);
  }, [allEvents, windowId, windowHours, playCursor]);
  const edges = useMemo(() => buildGraph(allFacilities), [allFacilities]);
  const byId = useMemo(() => new Map(allFacilities.map((f) => [f.id, f])), [allFacilities]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allFacilities.filter(
      (f) =>
        active.has(f.category) &&
        (!q || f.name.toLowerCase().includes(q) || (f.operator ?? "").toLowerCase().includes(q)),
    );
  }, [allFacilities, active, query]);

  const riskIds = useMemo(
    () => new Set(facilitiesAtRisk(allFacilities, events).keys()),
    [allFacilities, events],
  );
  const riskMap = useMemo(() => facilitiesAtRisk(allFacilities, events), [allFacilities, events]);

  const summary = useMemo(
    () => summarize(allFacilities, riskMap, events, activeAlarms),
    [allFacilities, riskMap, events, activeAlarms],
  );

  const atRiskList = useMemo(
    () =>
      [...riskMap.entries()]
        .map(([id, ev]) => ({ facility: byId.get(id), event: ev }))
        .filter((x): x is { facility: Facility; event: (typeof events)[number] } => !!x.facility)
        .sort((a, b) => {
          const at = CATEGORIES[a.facility.category].tier === "life" ? 0 : 1;
          const bt = CATEGORIES[b.facility.category].tier === "life" ? 0 : 1;
          return at - bt;
        }),
    [riskMap, byId],
  );

  const impactedIds = useMemo(() => {
    if (!outageId) return new Set<string>();
    const set = downstreamOf(new Set([outageId]), edges);
    set.delete(outageId);
    return set;
  }, [outageId, edges]);

  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  useEffect(() => {
    if (selectedId && !byId.has(selectedId)) setSelectedId(null);
  }, [selectedId, byId]);

  const toggle = (c: CategoryId) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  const loading = facilitiesQuery.isLoading;
  const counts = useMemo(() => {
    const m = new Map<CategoryId, number>();
    for (const f of allFacilities) m.set(f.category, (m.get(f.category) ?? 0) + 1);
    return m;
  }, [allFacilities]);

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="z-20 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex items-center gap-2.5">
          <span className="relative flex size-2.5">
            <span className="animate-pulse-dot absolute inline-flex size-full rounded-full bg-primary" />
          </span>
          <span className="font-mono text-sm font-bold tracking-[0.18em]">
            INFRA<span className="text-primary">UA</span>
          </span>
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground sm:inline">
            консоль
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center rounded border border-border p-0.5">
            <button
              onClick={() => setView("map")}
              className={`flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                view === "map" ? "bg-card text-foreground" : "text-muted-foreground"
              }`}
            >
              <MapIcon className="size-3" /> Карта
            </button>
            <button
              onClick={() => setView("analytics")}
              className={`flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                view === "analytics" ? "bg-card text-foreground" : "text-muted-foreground"
              }`}
            >
              <BarChart3 className="size-3" /> Аналітика
            </button>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="font-mono text-[10px] uppercase tracking-[0.12em]"
            onClick={() => {
              void facilitiesQuery.refetch();
              void eventsQuery.refetch();
              void alertsQuery.refetch();
            }}
          >
            <RefreshCw className={eventsQuery.isFetching ? "animate-spin" : ""} />
            Оновити
          </Button>
          <Button
            asChild
            size="sm"
            variant="outline"
            className="font-mono text-[10px] uppercase tracking-[0.12em]"
          >
            <Link to="/brief">Брифінг</Link>
          </Button>
          <Button
            asChild
            size="sm"
            variant="ghost"
            className="hidden font-mono text-[10px] uppercase tracking-[0.12em] sm:inline-flex"
          >
            <Link to="/about">Про платформу</Link>
          </Button>
        </div>
      </header>

      <SituationBar summary={summary} loading={loading} />

      {view === "analytics" ? (
        <ClientOnly
          fallback={
            <div className="flex flex-1 items-center justify-center bg-background">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center bg-background">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <AnalyticsView
              facilities={allFacilities}
              edges={edges}
              events={allEvents}
              alerts={regions}
              onSelect={(id) => {
                setSelectedId(id);
                setView("map");
              }}
            />
          </Suspense>
        </ClientOnly>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* Filters */}
          <aside className="order-2 shrink-0 space-y-4 overflow-y-auto border-border p-4 lg:order-1 lg:w-72 lg:border-r">
            <div>
              <label className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                <Search className="size-3" /> Пошук обʼєкта
              </label>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="назва або оператор"
                className="h-9 font-mono text-xs"
              />
            </div>

            <div>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Шари даних
              </p>
              <div className="space-y-1">
                {ALL_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    onClick={() => toggle(c)}
                    className={`flex w-full items-center justify-between rounded border px-2.5 py-1.5 text-left transition-colors ${
                      active.has(c)
                        ? "border-border bg-card"
                        : "border-transparent bg-transparent opacity-45"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="size-2.5 rounded-full"
                        style={{ background: CATEGORIES[c].color }}
                      />
                      <span className="text-xs">{CATEGORIES[c].label}</span>
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {counts.get(c) ?? 0}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => setShowLinks((v) => !v)}
              className={`flex w-full items-center gap-2 rounded border px-2.5 py-1.5 text-xs transition-colors ${
                showLinks ? "border-primary/60 text-primary" : "border-border text-muted-foreground"
              }`}
            >
              <Waypoints className="size-3.5" /> Звʼязки живлення
            </button>

            <div>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Вікно подій
              </p>
              <div className="grid grid-cols-4 gap-1">
                {TIME_WINDOWS.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => setWindowId(w.id)}
                    className={`rounded border px-1 py-1 font-mono text-[10px] transition-colors ${
                      windowId === w.id
                        ? "border-primary/60 text-primary"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </div>

            {outageId ? (
              <div className="rounded border border-destructive/50 bg-destructive/10 p-2.5">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-destructive">
                  Симуляція відключення
                </p>
                <p className="mt-1 text-xs">
                  {byId.get(outageId)?.name ?? "—"} → {impactedIds.size} залежних обʼєктів
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1.5 h-7 px-2 font-mono text-[10px] uppercase"
                  onClick={() => setOutageId(null)}
                >
                  Скинути
                </Button>
              </div>
            ) : null}

            <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
              Дані: OpenStreetMap (обʼєкти), NASA EONET (пожежі, шторми), USGS (сейсміка).
              {facilitiesQuery.data?.fetchedAt
                ? ` Оновлено ${new Date(facilitiesQuery.data.fetchedAt).toLocaleTimeString("uk-UA")}.`
                : ""}
            </p>
          </aside>

          {/* Map */}
          <main className="relative order-1 min-h-[52svh] flex-1 lg:order-2">
            <ClientOnly fallback={<MapSkeleton />}>
              <Suspense fallback={<MapSkeleton />}>
                <InfraMap
                  facilities={visible}
                  events={events}
                  edges={edges}
                  alerts={regions}
                  alarmIds={alarmIds}
                  showLinks={showLinks}
                  riskIds={riskIds}
                  impactedIds={impactedIds}
                  selectedId={selectedId}
                  onSelect={(f) => setSelectedId(f.id)}
                />
              </Suspense>
            </ClientOnly>

            {loading ? (
              <div className="pointer-events-none absolute inset-x-0 top-3 z-[500] flex justify-center">
                <span className="flex items-center gap-2 rounded-full border border-border bg-background/90 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> Завантаження обʼєктів з OpenStreetMap
                </span>
              </div>
            ) : null}

            {facilitiesQuery.data?.source === "baseline" ? (
              <div className="absolute inset-x-0 bottom-3 z-[500] mx-auto w-fit rounded border border-amber-500/50 bg-background/95 px-3 py-2 font-mono text-[10px] text-amber-400">
                Live-джерело OpenStreetMap недоступне — показано опорний перелік ключових обʼєктів.
                Натисніть «Оновити» для повторної спроби.
              </div>
            ) : null}

            <TimelinePlayer onCursor={setPlayCursor} />
          </main>

          {/* Right panel */}
          <aside className="order-3 flex shrink-0 flex-col overflow-y-auto border-border p-4 lg:w-80 lg:border-l">
            {selected ? (
              <section className="mb-5">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Інспектор
                </p>
                <h2 className="mt-1.5 text-sm font-semibold leading-snug">{selected.name}</h2>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {CATEGORIES[selected.category].label}
                  {selected.detail ? ` · ${selected.detail}` : ""}
                </p>
                {selected.operator ? (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    Оператор: {selected.operator}
                  </p>
                ) : null}
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {selected.lat.toFixed(4)}, {selected.lon.toFixed(4)}
                </p>

                {riskMap.get(selected.id) ? (
                  <p className="mt-2 flex items-start gap-1.5 rounded border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" />
                    Поруч активна подія: {riskMap.get(selected.id)!.title}
                  </p>
                ) : null}

                <div className="mt-3 rounded border border-border bg-card p-2">
                  <DependencyGraph
                    root={selected}
                    facilities={byId}
                    edges={edges}
                    onSelect={(f) => setSelectedId(f.id)}
                  />
                </div>

                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 font-mono text-[10px] uppercase"
                    onClick={() => setOutageId(selected.id)}
                  >
                    <Zap className="size-3" /> Змоделювати відключення
                  </Button>
                  <Button
                    asChild
                    size="sm"
                    variant="ghost"
                    className="h-8 font-mono text-[10px] uppercase"
                  >
                    <a href={selected.source} target="_blank" rel="noreferrer">
                      Джерело
                    </a>
                  </Button>
                </div>
              </section>
            ) : (
              <section className="mb-5">
                <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  <AlertTriangle className="size-3" /> Обʼєкти під загрозою
                </p>
                {atRiskList.length === 0 ? (
                  <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                    {loading
                      ? "Аналізуємо близькість подій…"
                      : "Обʼєктів у зоні активних подій не виявлено. Оберіть обʼєкт на карті, щоб побачити його звʼязки."}
                  </p>
                ) : (
                  <div className="mt-2 space-y-1.5">
                    {atRiskList.slice(0, 12).map(({ facility, event }) => (
                      <button
                        key={facility.id}
                        onClick={() => setSelectedId(facility.id)}
                        className="flex w-full items-start gap-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-left transition-colors hover:bg-destructive/10"
                      >
                        <span
                          className="mt-1 size-2 shrink-0 rounded-full"
                          style={{ background: CATEGORIES[facility.category].color }}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-[11px] font-medium">
                            {facility.name}
                          </span>
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">
                            {CATEGORIES[facility.category].label} · {event.title}
                          </span>
                        </span>
                      </button>
                    ))}
                    {atRiskList.length > 12 ? (
                      <p className="font-mono text-[10px] text-muted-foreground">
                        …та ще {atRiskList.length - 12} обʼєктів
                      </p>
                    ) : null}
                  </div>
                )}
              </section>
            )}

            <section className="min-h-0">
              <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                <Activity className="size-3" /> Стрічка подій
                {eventsQuery.isFetching ? <Loader2 className="size-3 animate-spin" /> : null}
              </p>
              <div className="mt-2 space-y-1.5">
                {events.length === 0 ? (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {eventsQuery.isLoading
                      ? "Отримуємо дані…"
                      : "За останні 30 днів у межах України активних подій не зафіксовано."}
                  </p>
                ) : (
                  events.slice(0, 40).map((ev) => (
                    <article key={ev.id} className="rounded border border-border bg-card p-2">
                      <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em]">
                        <span
                          className="size-1.5 rounded-full"
                          style={{ background: EVENT_KINDS[ev.kind].color }}
                        />
                        {EVENT_KINDS[ev.kind].label} · {ev.source}
                      </p>
                      <p className="mt-1 text-[11px] leading-snug">{ev.title}</p>
                      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                        {new Date(ev.time).toLocaleString("uk-UA")}
                      </p>
                    </article>
                  ))
                )}
              </div>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

function MapSkeleton() {
  return (
    <div className="grid-bg flex size-full items-center justify-center bg-card">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        Ініціалізація карти…
      </span>
    </div>
  );
}
