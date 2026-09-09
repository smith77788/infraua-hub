import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { buildObservedGraph, mergeGraphs, type PowerLine } from "@/lib/power-grid";
import { backoffMs, sourceUnavailable } from "@/lib/backoff";
import { ageOf, FRESHNESS_THRESHOLDS } from "@/lib/freshness";
import { selectVisibleLinks } from "@/lib/map-links";
import {
  SOURCE_STATE_LABEL,
  SOURCE_STATE_TONE,
  statusOf,
  worstState,
  type SourceStatus,
} from "@/lib/sources";
import { mergeTiles } from "@/lib/tiles";
import { summarize as summarizeProvenance } from "@/lib/provenance";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Loader2,
  Map as MapIcon,
  RefreshCw,
  Search,
  Share2,
  Waypoints,
  Zap,
} from "lucide-react";

import CriticalityBreakdown, { BandChip } from "@/components/CriticalityBreakdown";
import DependencyGraph from "@/components/DependencyGraph";
import SourceHealth from "@/components/SourceHealth";
import SituationBar from "@/components/SituationBar";
import TimelinePlayer, { TRAIL_MS } from "@/components/TimelinePlayer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getAlerts,
  getAlertZones,
  getEvents,
  getFacilities,
  getPowerLines,
  getSubstationTiles,
  getThreats,
} from "@/lib/infra.functions";
import { simulateOutage } from "@/lib/contingency";
import {
  palanterStatus,
  pushSplit,
  pushToPalanter,
  pushableDependencies,
} from "@/lib/palanter.functions";
import { SEED_FACILITIES } from "@/lib/infra-seed";
import { analyzeNetwork, assignRegions } from "@/lib/infra-analytics";
import {
  buildGraph,
  CATEGORIES,
  EVENT_KINDS,
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
  const powerLinesFn = useServerFn(getPowerLines);

  const facilitiesQuery = useQuery({
    queryKey: ["facilities"],
    queryFn: () => facilitiesFn(),
    staleTime: 30 * 60 * 1000,
    // Опорний набір показуємо миттєво, поки вантажиться live з OpenStreetMap
    // (Overpass буває повільним), щоб карта не була порожньою під час старту.
    placeholderData: {
      facilities: SEED_FACILITIES,
      fetchedAt: "",
      degraded: true,
      source: "baseline" as const,
      truncatedCategories: [],
    },
  });
  /*
   * Покриття накопичується тут, а не на сервері.
   *
   * Збірка йде під Cloudflare Workers, де модульний стан живе в межах ізоляту:
   * сервер не може нічого накопичувати між запитами, бо наступний запит може
   * потрапити в інший ізолят. Тому клієнт тримає завантажені тайли сам,
   * повідомляє серверові, що вже має, і отримує у відповідь тільки нові — це
   * заразом прибирає пересилання всієї країни при кожному опитуванні.
   */
  const [powerTiles, setPowerTiles] = useState<Map<string, PowerLine[]>>(() => new Map());
  const powerTilesRef = useRef(powerTiles);
  powerTilesRef.current = powerTiles;

  /*
   * Порожні відповіді поспіль означають, що джерело не відповідає. Без цього
   * лічильника консоль опитувала б його щохвилини вічно — навантажуючи те, що
   * саме зараз не в порядку, і малюючи прогрес, якого немає.
   */
  const [powerEmpty, setPowerEmpty] = useState(0);
  const powerLinesQuery = useQuery({
    queryKey: ["power-lines"],
    queryFn: () => powerLinesFn({ data: { have: [...powerTilesRef.current.keys()] } }),
    staleTime: 60 * 1000,
    // Мережа передачі змінюється роками, поспішати нікуди.
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data || powerTilesRef.current.size >= data.tilesTotal) return false;
      return backoffMs(powerEmpty);
    },
  });

  const newTiles = powerLinesQuery.data?.tiles;
  useEffect(() => {
    if (!newTiles) return;
    if (newTiles.length === 0) {
      setPowerEmpty((n) => n + 1);
      return;
    }
    setPowerEmpty(0);
    setPowerTiles((prev) =>
      mergeTiles(
        prev,
        newTiles.map((t) => ({ key: t.key, value: t.lines })),
      ),
    );
  }, [newTiles]);

  /*
   * Підстанції по тайлах — зняття стелі загальнокраїнного запиту. Заміряно:
   * в одному тайлі 2°×2° кінці ліній 110 кВ+ збиваються у 285 різних вузлів,
   * тобто кількасот підстанцій на всю країну — це мала вибірка, а не мережа.
   *
   * Доповнення, а не заміна: `getFacilities` лишається основним джерелом, і
   * якщо цей шлях відмовить, консоль працює як раніше.
   */
  const substationTilesFn = useServerFn(getSubstationTiles);
  const [subTiles, setSubTiles] = useState<Map<string, Facility[]>>(() => new Map());
  const subTilesRef = useRef(subTiles);
  subTilesRef.current = subTiles;

  const [subEmpty, setSubEmpty] = useState(0);
  const subTilesQuery = useQuery({
    queryKey: ["substation-tiles"],
    queryFn: () => substationTilesFn({ data: { have: [...subTilesRef.current.keys()] } }),
    staleTime: 60 * 1000,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data || subTilesRef.current.size >= data.tilesTotal) return false;
      return backoffMs(subEmpty);
    },
  });

  const newSubTiles = subTilesQuery.data?.tiles;
  useEffect(() => {
    if (!newSubTiles) return;
    if (newSubTiles.length === 0) {
      setSubEmpty((n) => n + 1);
      return;
    }
    setSubEmpty(0);
    setSubTiles((prev) =>
      mergeTiles(
        prev,
        newSubTiles.map((t) => ({ key: t.key, value: t.facilities })),
      ),
    );
  }, [newSubTiles]);

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
  const threatsFn = useServerFn(getThreats);
  const threatsQuery = useQuery({
    queryKey: ["threats"],
    queryFn: () => threatsFn(),
    staleTime: 30 * 1000,
    refetchInterval: 30 * 1000,
  });
  /*
   * Звʼязок із платформою Palanter. Ключ лишається на сервері, тому і статус, і
   * саме надсилання — серверні функції. Незаданий звʼязок — штатний стан:
   * консоль самодостатня, і кнопки тоді просто немає.
   */
  const palanterStatusFn = useServerFn(palanterStatus);
  const pushFn = useServerFn(pushToPalanter);
  const palanterQuery = useQuery({
    queryKey: ["palanter-status"],
    queryFn: () => palanterStatusFn(),
    staleTime: Infinity,
  });
  const [pushState, setPushState] = useState<
    { status: "idle" | "sending" } | { status: "done"; text: string; ok: boolean }
  >({ status: "idle" });

  const zonesFn = useServerFn(getAlertZones);
  const zonesQuery = useQuery({
    queryKey: ["zones"],
    queryFn: () => zonesFn(),
    staleTime: 45 * 1000,
    refetchInterval: 45 * 1000,
  });

  const [active, setActive] = useState<Set<CategoryId>>(new Set(ALL_CATEGORIES));
  const [query, setQuery] = useState("");
  const [showLinks, setShowLinks] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [outageId, setOutageId] = useState<string | null>(null);
  const [view, setView] = useState<"map" | "analytics">("map");
  const [windowId, setWindowId] = useState<WindowId>("30d");
  const [playCursor, setPlayCursor] = useState<number | null>(null);

  const allFacilities = useMemo(() => {
    const base = facilitiesQuery.data?.facilities ?? [];
    if (subTiles.size === 0) return base;
    // Ідентифікатор — це `${type}/${id}` з OSM, тож той самий обʼєкт із
    // загального запиту й з тайла зливається в один, а не подвоюється.
    const byId = new Map(base.map((f) => [f.id, f]));
    for (const tile of subTiles.values()) {
      for (const f of tile) if (!byId.has(f.id)) byId.set(f.id, f);
    }
    return [...byId.values()];
  }, [facilitiesQuery.data, subTiles]);
  const allEvents = useMemo(() => eventsQuery.data?.events ?? [], [eventsQuery.data]);
  const regions = useMemo(() => alertsQuery.data?.regions ?? [], [alertsQuery.data]);
  const activeAlarms = useMemo(() => regions.filter((r) => r.active).length, [regions]);
  const threats = useMemo(() => threatsQuery.data?.threats ?? [], [threatsQuery.data]);
  const zones = useMemo(() => zonesQuery.data?.zones ?? [], [zonesQuery.data]);
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
  // Граф — це спостережені ребра з реальних ЛЕП плюс виведений кістяк там, де
  // фактів ще немає. Вузол, у якого вже є справжня лінія, здогадок не отримує.
  const powerLines = useMemo(() => [...powerTiles.values()].flat(), [powerTiles]);
  const retrievedAt = powerLinesQuery.data?.retrievedAt;
  const observedGraph = useMemo(
    () => (powerLines.length ? buildObservedGraph(allFacilities, powerLines, retrievedAt) : null),
    [allFacilities, powerLines, retrievedAt],
  );
  const edges = useMemo(() => {
    const inferred = buildGraph(allFacilities);
    return observedGraph ? mergeGraphs(observedGraph.edges, inferred) : inferred;
  }, [allFacilities, observedGraph]);
  const groundedness = useMemo(() => summarizeProvenance(edges), [edges]);
  /*
   * Один розрахунок на консоль: інспектор і вкладка аналітики мають показувати
   * одну й ту саму оцінку, інакше рейтинг і картка обʼєкта суперечили б одне
   * одному на очах у користувача.
   *
   * Вартість заміряна, бо набір обʼєктів тепер росте по тайлах, а не
   * фіксований: 3210 вузлів — 420 мс, 6000 — 343 мс, 10000 — 487 мс, 15000 —
   * 675 мс. Спадання на 6000 не помилка: вище 4000 посередництво переходить на
   * вибірку опорних вузлів, і залежність стає лінійною замість квадратичної.
   * Перерахунок трапляється при надходженні тайла, тобто раз на хвилину під
   * час прогріву, — помітна затримка, але не заморозка.
   */
  const analysis = useMemo(
    () => analyzeNetwork(allFacilities, edges, events, regions),
    [allFacilities, edges, events, regions],
  );
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

  /*
   * Аналіз одиничної відмови замість транзитивного замикання вниз за течією.
   * Замикання вважало знеструмленим усе, що нижче, — а підстанція на трьох
   * реальних лініях відмову однієї з них переживає. Помилка була завжди в
   * один бік: наслідки перебільшувалися.
   */
  const outage = useMemo(
    () => (outageId ? simulateOutage(allFacilities, edges, outageId) : null),
    [outageId, allFacilities, edges],
  );
  const impactedIds = useMemo(() => outage?.lost ?? new Set<string>(), [outage]);

  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;
  const selectedAnalytics = selectedId ? (analysis.perFacility.get(selectedId) ?? null) : null;

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

  const sendToPlatform = async () => {
    setPushState({ status: "sending" });
    const dependencies = pushableDependencies(allFacilities, edges);
    const split = pushSplit(dependencies);
    const result = await pushFn({ data: { facilities: allFacilities, events, dependencies } });

    if (!result.configured) {
      setPushState({ status: "done", ok: false, text: "Звʼязок із платформою не налаштований." });
      return;
    }
    if (!result.ok) {
      setPushState({
        status: "done",
        ok: false,
        text: `Платформа відхилила: ${result.error ?? "невідома помилка"}`,
      });
      return;
    }
    setPushState({
      status: "done",
      ok: true,
      // Розподіл показується разом із підсумком: пакет, що поїхав самими
      // здогадками, має бути видно одразу, а не потім у журналі.
      text: `Прийнято: ${result.facilitiesIngested} обʼєктів, ${result.dependenciesIngested} звʼязків (${split.observed} спостережених, ${split.inferred} виведених).`,
    });
  };

  const truncated = useMemo(
    () => facilitiesQuery.data?.truncatedCategories ?? [],
    [facilitiesQuery.data],
  );

  const facilitiesAge = useMemo(
    () =>
      ageOf(
        facilitiesQuery.data?.fetchedAt,
        FRESHNESS_THRESHOLDS.facilities.aging,
        FRESHNESS_THRESHOLDS.facilities.stale,
      ),
    [facilitiesQuery.data],
  );
  const eventsAge = useMemo(() => {
    // Вік найсвіжішої події: якщо найновіша стара, стрічка не жива.
    let newest: string | null = null;
    for (const e of allEvents) if (!newest || e.time > newest) newest = e.time;
    return ageOf(newest, FRESHNESS_THRESHOLDS.events.aging, FRESHNESS_THRESHOLDS.events.stale);
  }, [allEvents]);

  const sourceDown = sourceUnavailable(powerEmpty) || sourceUnavailable(subEmpty);

  /*
   * Сім джерел, кожне зі своїм способом бути не в порядку. Зведено в одне
   * місце: стан виводиться з того, що вже відомо, і нічого понад це не
   * припускається.
   */
  const sources = useMemo<SourceStatus[]>(() => {
    const unknownAge = ageOf(null, 1, 1);
    return [
      statusOf({
        id: "facilities",
        label: "Обʼєкти (OSM)",
        count: allFacilities.length,
        age: facilitiesAge,
        ...(facilitiesQuery.data?.degraded ? { degraded: true } : {}),
        ...(truncated.length > 0 ? { truncated: true } : {}),
      }),
      statusOf({
        id: "substations",
        label: "Підстанції по ділянках",
        count: [...subTiles.values()].reduce((n, t) => n + t.length, 0),
        age: unknownAge,
        ...(sourceUnavailable(subEmpty) ? { down: true } : {}),
        ...(subTilesQuery.data
          ? { coverage: { loaded: subTiles.size, total: subTilesQuery.data.tilesTotal } }
          : {}),
      }),
      statusOf({
        id: "power-lines",
        label: "ЛЕП 110 кВ+ (OSM)",
        count: powerLines.length,
        age: ageOf(
          powerLinesQuery.data?.retrievedAt,
          FRESHNESS_THRESHOLDS.facilities.aging,
          FRESHNESS_THRESHOLDS.facilities.stale,
        ),
        ...(sourceUnavailable(powerEmpty) ? { down: true } : {}),
        ...(powerLinesQuery.data
          ? { coverage: { loaded: powerTiles.size, total: powerLinesQuery.data.tilesTotal } }
          : {}),
      }),
      statusOf({
        id: "events",
        label: "Події (NASA, USGS)",
        count: allEvents.length,
        age: eventsAge,
      }),
      statusOf({
        id: "alerts",
        label: "Повітряні тривоги",
        count: regions.filter((r) => r.active).length,
        age: unknownAge,
      }),
      statusOf({
        id: "threats",
        label: "Повітряні цілі (OSINT)",
        count: threats.length,
        age: unknownAge,
      }),
      statusOf({ id: "zones", label: "Полігони тривог", count: zones.length, age: unknownAge }),
    ];
  }, [
    allFacilities.length,
    facilitiesAge,
    facilitiesQuery.data,
    truncated.length,
    subTiles,
    subEmpty,
    subTilesQuery.data,
    powerLines.length,
    powerLinesQuery.data,
    powerEmpty,
    powerTiles.size,
    allEvents.length,
    eventsAge,
    regions,
    threats.length,
    zones.length,
  ]);
  const { hiddenLinks, shownLinks } = useMemo(() => {
    const known = new Set(allFacilities.map((f) => f.id));
    const drawable = edges.filter((e) => known.has(e.from) && known.has(e.to));
    const sel = selectVisibleLinks(drawable, 1200);
    return { hiddenLinks: sel.hidden, shownLinks: sel.visible.length };
  }, [edges, allFacilities]);

  const worstSource = useMemo(() => worstState(sources), [sources]);

  const loading = facilitiesQuery.isLoading;
  const counts = useMemo(() => {
    const m = new Map<CategoryId, number>();
    for (const f of allFacilities) m.set(f.category, (m.get(f.category) ?? 0) + 1);
    return m;
  }, [allFacilities]);

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      {/*
        Смуга стану замість декоративного банера класифікації. У консолях
        такого класу зверху стоїть рядок, який каже, з чим саме ти працюєш; тут
        він каже правду про дані: рівень обстановки, стан джерел і частку
        звʼязків, що спираються на факт. Три речі, від яких залежить, чи можна
        діяти на побаченому.
      */}
      <div
        className={`flex h-6 shrink-0 items-center justify-center gap-4 border-b px-4 font-mono text-[10px] uppercase tracking-[0.16em] ${
          summary.level === "critical"
            ? "border-red-500/40 bg-red-500/10 text-red-300"
            : summary.level === "elevated"
              ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
        }`}
      >
        <span>{summary.label}</span>
        <span className="opacity-40">·</span>
        <span className="flex items-center gap-1.5">
          <span className={`size-1.5 rounded-full ${SOURCE_STATE_TONE[worstSource]}`} />
          джерела: {SOURCE_STATE_LABEL[worstSource]}
        </span>
        <span className="opacity-40">·</span>
        <span className="hidden sm:inline">
          факт {Math.round(groundedness.observedShare * 100)}% звʼязків
        </span>
      </div>

      <header className="z-20 grid h-14 shrink-0 grid-cols-[minmax(0,auto)_1fr] items-center gap-2 border-b border-border px-3 sm:flex sm:justify-between sm:gap-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
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

        <div className="flex min-w-0 items-center justify-end gap-1.5 sm:gap-2">
          <div className="flex shrink-0 items-center rounded border border-border p-0.5">
            <button
              onClick={() => setView("map")}
              className={`flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                view === "map" ? "bg-card text-foreground" : "text-muted-foreground"
              }`}
            >
              <MapIcon className="size-3" /> <span className="hidden sm:inline">Карта</span>
            </button>
            <button
              onClick={() => setView("analytics")}
              className={`flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                view === "analytics" ? "bg-card text-foreground" : "text-muted-foreground"
              }`}
            >
              <BarChart3 className="size-3" /> <span className="hidden sm:inline">Аналітика</span>
            </button>
          </div>
          <Button
            size="sm"
            variant="outline"
            title="Оновити дані"
            aria-label="Оновити дані"
            className="shrink-0 px-2 font-mono text-[10px] uppercase tracking-[0.12em] sm:px-3"
            onClick={() => {
              void facilitiesQuery.refetch();
              void eventsQuery.refetch();
              void alertsQuery.refetch();
              void threatsQuery.refetch();
              void zonesQuery.refetch();
            }}
          >
            <RefreshCw className={eventsQuery.isFetching ? "animate-spin" : ""} />
            <span className="hidden sm:inline">Оновити</span>
          </Button>
          <Button
            asChild
            size="sm"
            variant="outline"
            className="shrink-0 px-2 font-mono text-[10px] uppercase tracking-[0.12em] sm:px-3"
          >
            <Link to="/brief" title="Ситуаційний брифінг" aria-label="Ситуаційний брифінг">
              <FileText className="size-3" />
              <span className="hidden sm:inline">Брифінг</span>
            </Link>
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

      <SituationBar summary={summary} loading={loading} threats={threats.length} />

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
              analysis={analysis}
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

            {palanterQuery.data?.configured ? (
              <div className="rounded border border-border bg-card p-2.5">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  Платформа Palanter
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-1.5 h-7 px-2 font-mono text-[10px] uppercase"
                  disabled={pushState.status === "sending" || allFacilities.length === 0}
                  onClick={() => void sendToPlatform()}
                >
                  <Share2 className="size-3" />
                  {pushState.status === "sending" ? "Надсилання…" : "Передати картину"}
                </Button>
                {pushState.status === "done" ? (
                  <p
                    className={`mt-1.5 text-[10px] leading-relaxed ${pushState.ok ? "text-muted-foreground" : "text-destructive"}`}
                  >
                    {pushState.text}
                  </p>
                ) : (
                  <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                    Обʼєкти, події та звʼязки живлення разом із їх походженням — під онтологією,
                    рівнями доступу і журналом аудиту платформи. Похідні оцінки не надсилаються:
                    вони перераховуються з графа.
                  </p>
                )}
              </div>
            ) : null}

            {outageId ? (
              <div className="rounded border border-destructive/50 bg-destructive/10 p-2.5">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-destructive">
                  Симуляція відключення
                </p>
                <p className="mt-1 text-xs">
                  {byId.get(outageId)?.name ?? "—"} → {impactedIds.size}{" "}
                  {impactedIds.size === 1 ? "обʼєкт втрачає" : "обʼєктів втрачають"} живлення
                </p>
                {outage && !outage.hasSources ? (
                  <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                    У наборі немає жодної електростанції, тож рахувати шлях до генерації нема від
                    чого. Увімкніть категорію «Електростанції».
                  </p>
                ) : (
                  <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                    Рахується як втрата шляху до генерації: обʼєкт із резервним живленням не гасне.{" "}
                    {impactedIds.size > 0 ? (
                      <>
                        <span className="text-primary">{outage?.grounded.size ?? 0}</span> з них
                        підтверджено спостереженою топологією, решта тримається на виведених
                        звʼязках.
                      </>
                    ) : null}
                  </p>
                )}
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
              Дані: OpenStreetMap (обʼєкти), NASA EONET та GDACS (події), USGS (сейсміка),
              detoyshahed.in.ua (тривоги, полігони, повітряні цілі — OSINT).
              {facilitiesQuery.data?.fetchedAt
                ? ` Оновлено ${new Date(facilitiesQuery.data.fetchedAt).toLocaleTimeString("uk-UA")}.`
                : ""}
            </p>
            <SourceHealth sources={sources} />

            {/* Джерело мовчить — це стан, а не прогрес. */}
            {sourceDown ? (
              <p className="font-mono text-[10px] leading-relaxed text-destructive">
                Overpass не відповідає — довантаження призупинено, інтервал збільшено. Показане
                лишається дійсним, але покриття не зростає.
              </p>
            ) : null}

            {/* Приховані звʼязки: ховаються припущення, факти лишаються. */}
            {hiddenLinks > 0 && showLinks ? (
              <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
                На карті показано {shownLinks} звʼязків, {hiddenLinks} приховано через стелю
                малювання — ховаються виведені, спостережені показуються завжди.
              </p>
            ) : null}

            {/*
              Обрізаний набір виглядає точнісінько як повний. Категорія, що
              вперлася у власну стелю, — це не «стільки об'єктів існує», а
              «стільки ми дозволили собі попросити».
            */}
            {truncated.length > 0 ? (
              <p className="font-mono text-[10px] leading-relaxed text-amber-400/90">
                Набір неповний: {truncated.map((c) => CATEGORIES[c].label).join(", ")} — досягнуто
                межі запиту, тож обʼєктів насправді більше.
              </p>
            ) : null}
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
                  zones={zones}
                  threats={threats}
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

            {facilitiesQuery.isPlaceholderData ? (
              <div className="absolute inset-x-0 bottom-3 z-[500] mx-auto flex w-fit items-center gap-2 rounded border border-border bg-background/95 px-3 py-2 font-mono text-[10px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> Опорний набір показано; вантажимо повні
                дані з OpenStreetMap…
              </div>
            ) : facilitiesQuery.data?.source === "baseline" ? (
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

                {/*
                  Індекс критичності разом із розбором. Показувати саме число
                  без розбору означало б дати привід до дії, який неможливо
                  оскаржити: аналітик бачив би «73» і не міг сказати, з чим
                  саме він не згоден.
                */}
                {selectedAnalytics ? (
                  <div className="mt-3 rounded border border-border bg-card p-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                        Індекс критичності
                      </p>
                      <BandChip band={selectedAnalytics.band} score={selectedAnalytics.score} />
                    </div>
                    <div className="mt-2">
                      <CriticalityBreakdown
                        signals={selectedAnalytics.signals}
                        score={selectedAnalytics.score}
                        band={selectedAnalytics.band}
                      />
                    </div>
                  </div>
                ) : null}

                <div className="mt-3 rounded border border-border bg-card p-2">
                  <DependencyGraph
                    root={selected}
                    facilities={byId}
                    edges={edges}
                    onSelect={(f) => setSelectedId(f.id)}
                  />
                  {/*
                    Найважливіший підпис на цьому екрані. Граф змішує реальні
                    лінії з припущеннями за найближчим сусідом, і без цього
                    рядка вони виглядають однаково — аналітик діяв би на
                    здогадці так само впевнено, як на факті.
                  */}
                  <p className="mt-2 border-t border-border/60 pt-2 text-[10px] leading-relaxed text-muted-foreground">
                    {groundedness.observed > 0 ? (
                      <>
                        <span className="text-primary">
                          {Math.round(groundedness.observedShare * 100)}% звʼязків
                        </span>{" "}
                        — реальні лінії 110 кВ+ з OSM, решта виведена за найближчим сусідом
                        (припущення).
                      </>
                    ) : (
                      <>Усі звʼязки виведені за найближчим сусідом — це припущення, не топологія.</>
                    )}
                    {powerLinesQuery.data && powerTiles.size < powerLinesQuery.data.tilesTotal ? (
                      <>
                        {" "}
                        Завантажено {powerTiles.size} з {powerLinesQuery.data.tilesTotal} ділянок
                        ліній
                        {subTilesQuery.data
                          ? ` і ${subTiles.size} з ${subTilesQuery.data.tilesTotal} — підстанцій`
                          : ""}{" "}
                        — частка фактів ще зросте.
                      </>
                    ) : null}
                  </p>
                  {/*
                    Скільки реальних ліній ми не змогли використати. Без цього
                    рядка втрата виглядає як відсутність: «мало фактів» і «ми
                    викинули більшість фактів» — різні твердження, і діяти на
                    них треба по-різному.
                  */}
                  {observedGraph && observedGraph.linesWithUnknownEnd > 0 ? (
                    <p className="mt-1.5 text-[10px] leading-relaxed text-amber-400/90">
                      Зведено {observedGraph.matchedLines} з {observedGraph.totalLines} ліній.{" "}
                      {observedGraph.linesWithUnknownEnd} приходять на підстанції, яких немає в
                      наборі — це щонайменше {observedGraph.unknownEndpointClusters} відсутніх
                      вузлів, і стільки ж втрачених звʼязків.
                    </p>
                  ) : null}
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
