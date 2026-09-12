import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { buildObservedGraph, mergeGraphs, type PowerLine } from "@/lib/power-grid";
import { backoffMs, sourceUnavailable } from "@/lib/backoff";
import { applyFocus, focusLabel, type Focus } from "@/lib/focus";
import { formatVoltage, voltageClass, VOLTAGE_CLASS_LABEL } from "@/lib/osm-tags";
import { operatorProfile } from "@/lib/operators";
import { ageOf, FRESHNESS_THRESHOLDS } from "@/lib/freshness";
import { selectVisibleLinks } from "@/lib/map-links";
import { statusOf, worstState, type SourceStatus } from "@/lib/sources";
import { mergeTiles } from "@/lib/tiles";
import { summarize as summarizeProvenance } from "@/lib/provenance";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  FileText,
  Info,
  Loader2,
  Map as MapIcon,
  Network,
  RefreshCw,
  Filter,
  HelpCircle,
  Search,
  Share2,
  Table2,
  Waypoints,
  X,
  Zap,
} from "lucide-react";

import CriticalityBreakdown, { BandChip } from "@/components/CriticalityBreakdown";
import DependencyGraph from "@/components/DependencyGraph";
import EntityTable from "@/components/EntityTable";
import OperatorPanel from "@/components/OperatorPanel";
import SourceHealth from "@/components/SourceHealth";
import HudClock from "@/components/HudClock";
import MapLayers, { type LayerToggle } from "@/components/MapLayers";
import { INFRA_DISABLED_NOTICE, infraLayersOff } from "@/lib/infra-gate";
import MapLegend from "@/components/MapLegend";
import OrientationCard, { hasSeenOrientation } from "@/components/OrientationCard";
import SituationBar from "@/components/SituationBar";
import StatusStrip from "@/components/StatusStrip";
import TimelinePlayer, { TRAIL_MS } from "@/components/TimelinePlayer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getAlerts,
  getAlertZones,
  getEvents,
  getFacilities,
  getPowerLines,
  getFacilityTiles,
  getThreats,
} from "@/lib/infra.functions";
import { platformEntityId } from "@/lib/cases";
import { useSituationalFeeds } from "@/hooks/useSituationalFeeds";
import { roleOfSource } from "@/lib/osint-sources";
import { simulateOutage } from "@/lib/contingency";
import { projectThreats } from "@/lib/threat-eta";
import {
  buildThreatGraph,
  correlateAirThreats,
  summarizeAirThreat,
  type ThreatSeverity,
} from "@/lib/threat-correlation";
import {
  platformStatus,
  pushSplit,
  pushToPlatform,
  pushableDependencies,
} from "@/lib/platform.functions";
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
const ThreatGraph = lazy(() => import("@/components/ThreatGraph"));
const ThreatChains = lazy(() => import("@/components/ThreatChains"));
const CasePanel = lazy(() => import("@/components/CasePanel"));
const PlatformPanel = lazy(() => import("@/components/PlatformPanel"));

const TIME_WINDOWS = [
  { id: "24h", label: "24 год", hours: 24 },
  { id: "3d", label: "3 дні", hours: 72 },
  { id: "7d", label: "7 днів", hours: 168 },
  { id: "30d", label: "30 днів", hours: 720 },
] as const;
type WindowId = (typeof TIME_WINDOWS)[number]["id"];

// Короткі підписи типів цілей для панелей (повні силуети — на карті).
const AIR_TYPE_LABEL: Record<string, string> = {
  shahed: "Ударний БпЛА",
  reactive: "Реактивний БпЛА",
  cruise: "Крилата ракета",
  missile: "Ракета",
  ballistic: "Балістика",
  kab: "КАБ",
  recon: "Розвідник",
  aircraft: "Авіація",
  unknown: "Тип невідомий",
};

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

const AIR_SEV_LABEL: Record<ThreatSeverity, string> = {
  critical: "критично",
  high: "висока",
  medium: "середня",
};
const AIR_SEV_TONE: Record<ThreatSeverity, string> = {
  critical: "border-red-500/50 bg-red-500/10 hover:bg-red-500/15 text-red-200",
  high: "border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/15 text-amber-200",
  medium: "border-border bg-card hover:bg-accent/40",
};

function Console() {
  const facilitiesFn = useServerFn(getFacilities);
  const eventsFn = useServerFn(getEvents);
  const powerLinesFn = useServerFn(getPowerLines);

  const facilitiesQuery = useQuery({
    queryKey: ["facilities"],
    queryFn: () => facilitiesFn(),
    staleTime: 30 * 60 * 1000,
    /*
     * Опорного набору тут більше немає, і це не втрата зручності.
     *
     * Він був статичним імпортом переліку ключових обʼєктів країни, тобто
     * їхав у клієнтському бандлі до кожного відвідувача — незалежно від
     * того, чи хтось його запитував, і незалежно від будь-якого вимикача.
     * Тепер він живе лише на сервері й лише за увімкненим вимикачем
     * (`src/lib/infra-gate.ts`).
     */
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
  const facilityTilesFn = useServerFn(getFacilityTiles);
  const [facTiles, setFacTiles] = useState<Map<string, Facility[]>>(() => new Map());
  const facTilesRef = useRef(facTiles);
  facTilesRef.current = facTiles;

  const [facEmpty, setFacEmpty] = useState(0);
  const facTilesQuery = useQuery({
    queryKey: ["facility-tiles"],
    queryFn: () => facilityTilesFn({ data: { have: [...facTilesRef.current.keys()] } }),
    staleTime: 60 * 1000,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data || facTilesRef.current.size >= data.tilesTotal) return false;
      return backoffMs(facEmpty);
    },
  });

  const newFacTiles = facTilesQuery.data?.tiles;
  useEffect(() => {
    if (!newFacTiles) return;
    if (newFacTiles.length === 0) {
      setFacEmpty((n) => n + 1);
      return;
    }
    setFacEmpty(0);
    setFacTiles((prev) =>
      mergeTiles(
        prev,
        newFacTiles.map((t) => ({ key: t.key, value: t.facilities })),
      ),
    );
  }, [newFacTiles]);

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
    // Повітряна обстановка змінюється щохвилини під час нальотів — тримаємо
    // короткий інтервал, щоб позначки зʼявлялись майже наживо.
    staleTime: 12 * 1000,
    refetchInterval: 15 * 1000,
  });
  // Ситуаційні фонові фіди (фронт, пожежі, Kp, інтернет-збої, погода) — в одному
  // місці, окремим хуком data-plane.
  const feeds = useSituationalFeeds();
  /*
   * Звʼязок з аналітичною платформою. Ключ лишається на сервері, тому і статус, і
   * саме надсилання — серверні функції. Незаданий звʼязок — штатний стан:
   * консоль самодостатня, і кнопки тоді просто немає.
   */
  const platformStatusFn = useServerFn(platformStatus);
  const pushFn = useServerFn(pushToPlatform);
  const palanterQuery = useQuery({
    queryKey: ["palanter-status"],
    queryFn: () => platformStatusFn(),
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
  const [showGraph, setShowGraph] = useState(false);
  /*
   * Панель звʼязків відкривається списком, а не графом. Питання під час
   * нальоту — «що під ударом і скільки часу», і на нього відповідає рядок із
   * назвою; граф вузлів корисний вужче — коли треба побачити спільну ціль — і
   * тому стоїть другою вкладкою.
   */
  const [linkView, setLinkView] = useState<"list" | "graph">("list");
  const [showFrontline, setShowFrontline] = useState(true);
  const [showFires, setShowFires] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [outageId, setOutageId] = useState<string | null>(null);
  const [view, setView] = useState<"map" | "analytics">("map");
  const [showTable, setShowTable] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showPlatform, setShowPlatform] = useState(false);
  const [focus, setFocus] = useState<Focus>(null);
  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [eventKind, setEventKind] = useState<keyof typeof EVENT_KINDS | null>(null);
  const [windowId, setWindowId] = useState<WindowId>("30d");
  const [playCursor, setPlayCursor] = useState<number | null>(null);

  /*
   * Вимикач шарів інфраструктури. Рішення ухвалює сервер (`infra-gate.ts`),
   * клієнт лише дізнається про нього з відповіді: так порожній набір не
   * читається як «джерело лежить», і ніхто не йде лагодити те, що вимкнули
   * навмисно. Поки відповіді немає — вважаємо вимкненим.
   */
  const infraDisabled = infraLayersOff(facilitiesQuery.data);

  // Перше відкриття: показуємо орієнтир, щоб консоль не була «незрозумілою».
  // Тільки на клієнті — інакше SSR і гідратація розійшлися б.
  useEffect(() => {
    if (!hasSeenOrientation()) setShowHelp(true);
  }, []);

  const allFacilities = useMemo(() => {
    const base = facilitiesQuery.data?.facilities ?? [];
    if (facTiles.size === 0) return base;
    // Ідентифікатор — це `${type}/${id}` з OSM, тож той самий обʼєкт із
    // загального запиту й з тайла зливається в один, а не подвоюється.
    const byId = new Map(base.map((f) => [f.id, f]));
    for (const tile of facTiles.values()) {
      for (const f of tile) if (!byId.has(f.id)) byId.set(f.id, f);
    }
    return [...byId.values()];
  }, [facilitiesQuery.data, facTiles]);
  const allEvents = useMemo(() => eventsQuery.data?.events ?? [], [eventsQuery.data]);
  const regions = useMemo(() => alertsQuery.data?.regions ?? [], [alertsQuery.data]);
  const activeAlarms = useMemo(() => regions.filter((r) => r.active).length, [regions]);
  const threats = useMemo(() => threatsQuery.data?.threats ?? [], [threatsQuery.data]);
  const zones = useMemo(() => zonesQuery.data?.zones ?? [], [zonesQuery.data]);
  const frontline = feeds.frontline;
  const fires = feeds.fires;
  // Одна привʼязка на консоль: її потребують і тривоги, і фокус по області.
  const regionOf = useMemo(() => assignRegions(allFacilities, regions), [allFacilities, regions]);
  const alarmIds = useMemo(() => {
    const active = new Set(regions.filter((r) => r.active).map((r) => r.code));
    if (!active.size) return new Set<string>();
    const s = new Set<string>();
    for (const [id, code] of regionOf) if (active.has(code)) s.add(id);
    return s;
  }, [regionOf, regions]);

  const windowHours = TIME_WINDOWS.find((w) => w.id === windowId)!.hours;
  const eventsInWindow = useMemo(() => {
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

  // Вид події — окремий фільтр від фокуса по обʼєктах: перший звужує стрічку,
  // другий набір обʼєктів, і плутати їх в одному перемикачі означало б
  // сховати одне за іншим.
  const events = useMemo(
    () => (eventKind ? eventsInWindow.filter((e) => e.kind === eventKind) : eventsInWindow),
    [eventsInWindow, eventKind],
  );
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

  const riskIds = useMemo(
    () => new Set(facilitiesAtRisk(allFacilities, events).keys()),
    [allFacilities, events],
  );
  const riskMap = useMemo(() => facilitiesAtRisk(allFacilities, events), [allFacilities, events]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byFilters = allFacilities.filter(
      (f) =>
        active.has(f.category) &&
        (!q || f.name.toLowerCase().includes(q) || (f.operator ?? "").toLowerCase().includes(q)),
    );
    return applyFocus(byFilters, focus, { riskIds, alarmIds, regionOf });
  }, [allFacilities, active, query, focus, riskIds, alarmIds, regionOf]);

  const summary = useMemo(
    () => summarize(allFacilities, riskMap, events, activeAlarms, alarmIds.size),
    [allFacilities, riskMap, events, activeAlarms, alarmIds],
  );

  /*
   * Повітряна загроза обʼєктам — порт шару кореляції з тактичного радара.
   * Курс цілі відкрите джерело не віддає, тож звʼязок рахується за близькістю
   * позначки до обʼєкта; активна тривога в регіоні підсилює рівень. Це
   * покадровий, безстановий розрахунок — працює прямо на Workers-деплої.
   */
  const airThreat = useMemo(
    // `roleOf` дає оцінці достовірності знати, що саме за джерелом стоїть:
    // канал спостереження чи переказ. Без цього всі канали важать однаково, і
    // одна позначка з новинної стрічки дає той самий рівень, що й три канали
    // спостереження при активній тривозі.
    () => correlateAirThreats(allFacilities, threats, { alarmIds, roleOf: roleOfSource }),
    [allFacilities, threats, alarmIds],
  );
  const airThreatSummary = useMemo(() => summarizeAirThreat(airThreat), [airThreat]);
  const threatGraph = useMemo(() => buildThreatGraph(airThreat, threats), [airThreat, threats]);

  // Проєкція курсу: коли джерело дає heading, рахуємо коридор підльоту й час до
  // критичних обʼєктів. Це відповідь на питання «куди летить», а не лише «що
  // поруч» — найцінніший зріз під час нальоту.
  const projections = useMemo(
    () => projectThreats(threats, allFacilities),
    [threats, allFacilities],
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

  /*
   * Зіставлення «ідентифікатор платформи → обʼєкт консолі» для приколотих у
   * справах. Справа переживає сеанс, а завантажений набір обʼєктів — ні, тож
   * зіставлення часткове за побудовою: що не завантажене, лишається
   * ідентифікатором і не вдає з себе посилання.
   */
  const platformIds = useMemo(() => {
    const m = new Map<string, Facility>();
    for (const f of allFacilities) m.set(platformEntityId(f.id), f);
    return m;
  }, [allFacilities]);
  const selectedAnalytics = selectedId ? (analysis.perFacility.get(selectedId) ?? null) : null;
  /*
   * Досьє будується з усього набору, а не з відфільтрованого: воно описує
   * організацію, а не те, що випадково пройшло поточний фільтр.
   */
  const operator = useMemo(
    () => (operatorId ? operatorProfile(operatorId, allFacilities, analysis.perFacility) : null),
    [operatorId, allFacilities, analysis.perFacility],
  );

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

  const sourceDown = sourceUnavailable(powerEmpty) || sourceUnavailable(facEmpty);

  /*
   * Сім джерел, кожне зі своїм способом бути не в порядку. Зведено в одне
   * місце: стан виводиться з того, що вже відомо, і нічого понад це не
   * припускається.
   */
  const sources = useMemo<SourceStatus[]>(() => {
    const unknownAge = ageOf(null, 1, 1);
    return [
      // Три джерела обʼєктів інфраструктури зникають зі зведення разом із
      // самими даними: рядок «Обʼєкти — 0» читався б як несправність.
      ...(infraDisabled
        ? []
        : [
            statusOf({
              id: "facilities",
              label: "Обʼєкти (OSM)",
              count: allFacilities.length,
              age: facilitiesAge,
              ...(facilitiesQuery.data?.degraded ? { degraded: true } : {}),
              ...(truncated.length > 0 ? { truncated: true } : {}),
            }),
            statusOf({
              id: "facility-tiles",
              label: "Обʼєкти по ділянках (тайли)",
              count: [...facTiles.values()].reduce((n, t) => n + t.length, 0),
              age: unknownAge,
              ...(sourceUnavailable(facEmpty) ? { down: true } : {}),
              ...(facTilesQuery.data
                ? { coverage: { loaded: facTiles.size, total: facTilesQuery.data.tilesTotal } }
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
          ]),
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
      // Ситуаційні фонові фіди — той самий data-plane, та сама панель: оператор
      // бачить стан усіх джерел в одному місці, а не по кутах.
      ...feeds.statuses,
    ];
  }, [
    infraDisabled,
    allFacilities.length,
    facilitiesAge,
    facilitiesQuery.data,
    truncated.length,
    facTiles,
    facEmpty,
    facTilesQuery.data,
    powerLines.length,
    powerLinesQuery.data,
    powerEmpty,
    powerTiles.size,
    allEvents.length,
    eventsAge,
    regions,
    threats.length,
    zones.length,
    feeds.statuses,
  ]);
  const { hiddenLinks, shownLinks } = useMemo(() => {
    const known = new Set(allFacilities.map((f) => f.id));
    const drawable = edges.filter((e) => known.has(e.from) && known.has(e.to));
    const sel = selectVisibleLinks(drawable, 3000);
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
      <StatusStrip
        worstSource={worstSource}
        observedShare={groundedness.observedShare}
        showInfra={!infraDisabled}
        spaceWeather={feeds.spaceWeather}
        outages={feeds.outages}
        weather={feeds.weather}
      />

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
          <span className="mx-1 hidden h-4 w-px bg-border xl:inline-block" />
          <ClientOnly fallback={null}>
            <HudClock />
          </ClientOnly>
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
            {infraDisabled ? null : (
              <button
                onClick={() => setView("analytics")}
                className={`flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                  view === "analytics" ? "bg-card text-foreground" : "text-muted-foreground"
                }`}
              >
                <BarChart3 className="size-3" /> <span className="hidden sm:inline">Аналітика</span>
              </button>
            )}
          </div>
          {view === "map" && !infraDisabled ? (
            <Button
              size="sm"
              variant={showTable ? "secondary" : "outline"}
              title="Таблиця обʼєктів"
              aria-label="Таблиця обʼєктів"
              className="shrink-0 px-2 font-mono text-[10px] uppercase tracking-[0.12em] sm:px-3"
              onClick={() => setShowTable((v) => !v)}
              aria-pressed={showTable}
            >
              <Table2 className="size-3" /> <span className="hidden sm:inline">Таблиця</span>
            </Button>
          ) : null}
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
            size="sm"
            variant="ghost"
            title="Як читати консоль"
            aria-label="Як читати консоль"
            className="shrink-0 px-2 font-mono text-[10px] uppercase tracking-[0.12em] sm:px-3"
            onClick={() => setShowHelp(true)}
          >
            <HelpCircle className="size-3" />
            <span className="hidden sm:inline">Як читати</span>
          </Button>
          <Button
            asChild
            size="sm"
            variant="ghost"
            className="hidden shrink-0 px-2 font-mono text-[10px] uppercase tracking-[0.12em] sm:inline-flex sm:px-3"
          >
            <Link to="/about" title="Про платформу" aria-label="Про платформу">
              <Info className="size-3" />
              <span className="hidden sm:inline">Про платформу</span>
            </Link>
          </Button>
        </div>
      </header>

      <SituationBar
        summary={summary}
        loading={loading}
        threats={threats.length}
        airThreat={airThreatSummary}
        focus={focus}
        onFocus={setFocus}
        eventKind={eventKind}
        onEventKind={setEventKind}
        showInfra={!infraDisabled}
      />

      {/*
        Активний фокус завжди видимий і знімається одним рухом. Мовчазний
        фільтр гірший за його відсутність: порожня карта читається як
        відсутність даних, а не як застосована умова.
      */}
      {focus ? (
        <div className="z-10 flex shrink-0 items-center gap-2 border-b border-primary/40 bg-primary/10 px-4 py-1.5">
          <Filter className="size-3 text-primary" />
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-primary">
            Фокус: {focusLabel(focus)} — {visible.length} обʼєктів
          </span>
          <button
            onClick={() => setFocus(null)}
            className="ml-auto flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3" /> Зняти
          </button>
        </div>
      ) : null}

      {view === "analytics" && !infraDisabled ? (
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
              onFocus={(f) => {
                setFocus(f);
                setView("map");
              }}
              onOperator={(op) => {
                setOperatorId(op);
                setView("map");
              }}
            />
          </Suspense>
        </ClientOnly>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* Filters */}
          <aside className="order-2 shrink-0 space-y-4 overflow-y-auto border-border p-4 lg:order-1 lg:w-72 lg:border-r">
            {infraDisabled ? (
              <div className="rounded border border-border bg-card p-2.5">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  Шари інфраструктури
                </p>
                <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                  {facilitiesQuery.data?.notice ?? INFRA_DISABLED_NOTICE} Карта показує обстановку:
                  тривоги, лінію фронту, пожежі, події та погоду.
                </p>
              </div>
            ) : (
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
            )}

            {infraDisabled ? null : (
              <>
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
                    showLinks
                      ? "border-primary/60 text-primary"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  <Waypoints className="size-3.5" /> Звʼязки живлення
                </button>
              </>
            )}

            <button
              onClick={() => setShowFrontline((v) => !v)}
              disabled={frontline.length === 0}
              className={`flex w-full items-center gap-2 rounded border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40 ${
                showFrontline
                  ? "border-red-500/60 text-red-300"
                  : "border-border text-muted-foreground"
              }`}
            >
              <AlertTriangle className="size-3.5" /> Лінія фронту (DeepState)
              {frontline.length > 0 ? (
                <span className="ml-auto font-mono text-[10px] opacity-70">{frontline.length}</span>
              ) : null}
            </button>

            <button
              onClick={() => setShowFires((v) => !v)}
              disabled={fires.length === 0}
              className={`flex w-full items-center gap-2 rounded border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40 ${
                showFires
                  ? "border-orange-500/60 text-orange-300"
                  : "border-border text-muted-foreground"
              }`}
            >
              <Activity className="size-3.5" /> Пожежі (NASA FIRMS, 24 год)
              {fires.length > 0 ? (
                <span className="ml-auto font-mono text-[10px] opacity-70">{fires.length}</span>
              ) : null}
            </button>

            {infraDisabled ? null : (
              <button
                onClick={() => setShowGraph((v) => !v)}
                disabled={threatGraph.nodes.length === 0}
                className={`flex w-full items-center gap-2 rounded border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40 ${
                  showGraph
                    ? "border-primary/60 text-foreground"
                    : "border-border text-muted-foreground"
                }`}
              >
                <Share2 className="size-3.5" /> Що під загрозою з повітря
                {threatGraph.nodes.length > 0 ? (
                  <span className="ml-auto font-mono text-[10px] opacity-70">
                    {threatGraph.nodes.length}
                  </span>
                ) : null}
              </button>
            )}

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

            {palanterQuery.data?.configured && !infraDisabled ? (
              <div className="rounded border border-border bg-card p-2.5">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  Аналітична платформа
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 font-mono text-[10px] uppercase"
                    disabled={pushState.status === "sending" || allFacilities.length === 0}
                    onClick={() => void sendToPlatform()}
                  >
                    <Share2 className="size-3" />
                    {pushState.status === "sending" ? "Надсилання…" : "Передати картину"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 font-mono text-[10px] uppercase"
                    onClick={() => setShowPlatform(true)}
                  >
                    <Network className="size-3" /> Аналітика
                  </Button>
                </div>
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
              Дані: {infraDisabled ? "" : "OpenStreetMap (обʼєкти), "}NASA EONET та GDACS (події),
              USGS (сейсміка), detoyshahed.in.ua (тривоги, полігони, повітряні цілі — OSINT).
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
          <div className="order-1 flex min-h-[52svh] min-w-0 flex-1 flex-col lg:order-2">
            <main className="relative min-h-0 flex-1">
              <ClientOnly fallback={<MapSkeleton />}>
                <Suspense fallback={<MapSkeleton />}>
                  <InfraMap
                    facilities={visible}
                    events={events}
                    edges={edges}
                    alerts={regions}
                    zones={zones}
                    threats={threats}
                    frontline={frontline}
                    showFrontline={showFrontline}
                    fires={fires}
                    showFires={showFires}
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
                    <Loader2 className="size-3 animate-spin" /> Завантаження обʼєктів з
                    OpenStreetMap
                  </span>
                </div>
              ) : null}

              {infraDisabled ? (
                <div className="absolute inset-x-0 bottom-14 z-[500] mx-auto w-fit rounded border border-border bg-background/95 px-3 py-2 text-center font-mono text-[10px] text-muted-foreground">
                  {facilitiesQuery.data?.notice ?? INFRA_DISABLED_NOTICE}
                </div>
              ) : facilitiesQuery.isFetching && allFacilities.length === 0 ? (
                <div className="absolute inset-x-0 bottom-14 z-[500] mx-auto flex w-fit items-center gap-2 rounded border border-border bg-background/95 px-3 py-2 font-mono text-[10px] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> Вантажимо дані з OpenStreetMap…
                </div>
              ) : facilitiesQuery.data?.source === "baseline" ? (
                <div className="absolute inset-x-0 bottom-14 z-[500] mx-auto w-fit rounded border border-amber-500/50 bg-background/95 px-3 py-2 font-mono text-[10px] text-amber-400">
                  Live-джерело OpenStreetMap недоступне — показано опорний перелік ключових
                  обʼєктів. Натисніть «Оновити» для повторної спроби.
                </div>
              ) : null}

              <TimelinePlayer onCursor={setPlayCursor} />
              <MapLayers
                layers={
                  [
                    // Шари, що малюють обʼєкти інфраструктури та звʼязки між
                    // ними, зникають разом із даними: перемикач, який нічого
                    // не вмикає, — обіцянка, якої консоль не виконає.
                    ...(infraDisabled
                      ? []
                      : [
                          {
                            key: "links",
                            label: "Звʼязки живлення",
                            active: showLinks,
                            color: "#22d3ee",
                          },
                        ]),
                    {
                      key: "frontline",
                      label: "Лінія фронту",
                      active: showFrontline,
                      disabled: frontline.length === 0,
                      color: "#a52714",
                    },
                    {
                      key: "fires",
                      label: "Пожежі (FIRMS)",
                      active: showFires,
                      disabled: fires.length === 0,
                      color: "#ff7a1a",
                    },
                    ...(infraDisabled
                      ? []
                      : [
                          {
                            key: "graph",
                            label: "Під загрозою",
                            active: showGraph,
                            disabled: threatGraph.nodes.length === 0,
                            color: "#ff4d4d",
                          },
                        ]),
                  ] satisfies LayerToggle[]
                }
                onToggle={(key) => {
                  if (key === "links") setShowLinks((v) => !v);
                  else if (key === "frontline") setShowFrontline((v) => !v);
                  else if (key === "fires") setShowFires((v) => !v);
                  else if (key === "graph") setShowGraph((v) => !v);
                }}
              />
              <MapLegend showInfra={!infraDisabled} />

              {showGraph ? (
                <div className="absolute inset-0 z-[600] flex flex-col bg-background/95 backdrop-blur-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
                    <div className="flex min-w-0 items-center gap-3 font-mono text-[11px] uppercase tracking-[0.1em]">
                      <span className="flex items-center gap-1.5 text-foreground">
                        <Share2 className="size-3.5" /> Що під загрозою з повітря
                      </span>
                      <span className="flex overflow-hidden rounded-md border border-border">
                        {(
                          [
                            ["list", "Список"],
                            ["graph", "Граф"],
                          ] as const
                        ).map(([id, label]) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() => setLinkView(id)}
                            className={`px-2.5 py-1 text-[10px] uppercase tracking-[0.1em] transition-colors ${
                              linkView === id
                                ? "bg-primary/15 text-foreground"
                                : "text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </span>
                      {linkView === "graph" ? (
                        <span className="hidden items-center gap-2 text-[9px] text-muted-foreground sm:flex">
                          <span className="flex items-center gap-1">
                            <span className="size-2 rounded-full bg-red-500" /> обʼєкт
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="size-2 rounded-full bg-amber-400" /> ціль
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="size-2 rounded-full bg-slate-500" /> канал
                          </span>
                          <span>наведіть — підсвітить ланцюжок</span>
                        </span>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 font-mono text-[10px] uppercase"
                      onClick={() => setShowGraph(false)}
                    >
                      Закрити
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 p-2">
                    <Suspense
                      fallback={
                        <div className="flex size-full items-center justify-center">
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        </div>
                      }
                    >
                      {linkView === "list" ? (
                        <ThreatChains
                          correlations={airThreat}
                          projections={projections}
                          onSelect={(id) => {
                            setSelectedId(id);
                            setShowGraph(false);
                          }}
                        />
                      ) : (
                        <ThreatGraph
                          graph={threatGraph}
                          onSelectAsset={(id) => {
                            setSelectedId(id);
                            setShowGraph(false);
                          }}
                        />
                      )}
                    </Suspense>
                  </div>
                </div>
              ) : null}

              {showPlatform ? (
                <Suspense
                  fallback={
                    <div className="absolute inset-0 z-[600] flex items-center justify-center bg-background/95">
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    </div>
                  }
                >
                  <PlatformPanel onClose={() => setShowPlatform(false)} />
                </Suspense>
              ) : null}
            </main>

            {/*
            Таблиця показує рівно те, що зараз на карті — ті самі фільтри й
            пошук. Два зрізи одних даних, що суперечать одне одному на сусідніх
            панелях, гірші за один.
          */}
            {showTable && !infraDisabled ? (
              <EntityTable
                facilities={visible}
                analytics={analysis.perFacility}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onOperator={setOperatorId}
                onClose={() => setShowTable(false)}
              />
            ) : null}
          </div>

          {/* Right panel */}
          <aside className="order-3 flex shrink-0 flex-col overflow-y-auto border-border p-4 lg:w-80 lg:border-l">
            {projections.length > 0 ? (
              <section className="mb-5">
                <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-red-300">
                  <Waypoints className="size-3" /> Коридор підльоту
                  <span
                    className="ml-auto rounded bg-red-500/15 px-1.5 py-0.5 text-red-300"
                    title="Критичні обʼєкти на курсі цілей із відомим heading — оцінка часу за типовою швидкістю типу"
                  >
                    {projections.length}
                  </span>
                </p>
                <div className="mt-2 space-y-1.5">
                  {projections.map((p) => (
                    <button
                      key={p.facility.id}
                      onClick={() => setSelectedId(p.facility.id)}
                      className="flex w-full items-center gap-2 rounded border border-red-500/30 bg-red-500/5 p-2 text-left transition-colors hover:bg-red-500/10"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] text-foreground">
                          {p.facility.name}
                        </span>
                        <span className="block font-mono text-[10px] text-muted-foreground">
                          {AIR_TYPE_LABEL[p.threat.type ?? "unknown"]} · {p.distanceKm} км · відхил.{" "}
                          {p.offAxisDeg}°
                        </span>
                      </span>
                      <span className="shrink-0 text-right font-mono">
                        <span className="block text-[13px] font-semibold text-red-300">
                          {p.etaMin < 1 ? "<1" : `~${p.etaMin}`}
                        </span>
                        <span className="block text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                          хв
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            {airThreat.length > 0 ? (
              <section className="mb-5">
                <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-red-300">
                  <AlertTriangle className="size-3" /> Повітряна загроза обʼєктам
                  <span className="ml-auto rounded bg-red-500/15 px-1.5 py-0.5 text-red-300">
                    {airThreat.length}
                  </span>
                </p>
                <div className="mt-2 space-y-1.5">
                  {airThreat.slice(0, 8).map((c) => (
                    <button
                      key={c.facility.id}
                      onClick={() => setSelectedId(c.facility.id)}
                      className={`flex w-full items-start gap-2 rounded border p-2 text-left transition-colors ${AIR_SEV_TONE[c.severity]}`}
                    >
                      <span
                        className="mt-1 size-2 shrink-0 rounded-full"
                        style={{ background: CATEGORIES[c.facility.category].color }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[11px] font-medium">
                            {c.facility.name}
                          </span>
                          <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wider">
                            {AIR_SEV_LABEL[c.severity]}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                          {CATEGORIES[c.facility.category].label} · ~{c.nearestKm} км
                          {c.threatCount > 1 ? ` · ${c.threatCount} позначок` : ""}
                          {c.inAlarmRegion ? " · ◎ тривога" : ""}
                        </span>
                      </span>
                    </button>
                  ))}
                  {airThreat.length > 8 ? (
                    <p className="font-mono text-[10px] text-muted-foreground">
                      …та ще {airThreat.length - 8} обʼєктів
                    </p>
                  ) : null}
                </div>
                <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-muted-foreground">
                  Звʼязок рахується за близькістю OSINT-позначок до обʼєкта (курс джерело не
                  віддає), тривога в регіоні підсилює рівень.
                </p>
              </section>
            ) : null}
            {operator ? (
              <OperatorPanel
                profile={operator}
                onSelect={(id) => {
                  setSelectedId(id);
                  setOperatorId(null);
                }}
                onClose={() => setOperatorId(null)}
              />
            ) : null}

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
                  <button
                    onClick={() => setOperatorId(selected.operator!)}
                    className="font-mono text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-primary"
                    title="Відкрити досьє оператора"
                  >
                    Оператор: {selected.operator}
                  </button>
                ) : null}
                {selected.voltage !== undefined || selected.capacityMw !== undefined ? (
                  <p className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[11px]">
                    {selected.voltage !== undefined ? (
                      <span
                        className="text-primary"
                        title={VOLTAGE_CLASS_LABEL[voltageClass(selected.voltage)!]}
                      >
                        {formatVoltage(selected.voltage)}
                      </span>
                    ) : null}
                    {selected.capacityMw !== undefined ? (
                      <span className="text-muted-foreground">{selected.capacityMw} МВт</span>
                    ) : null}
                  </p>
                ) : null}
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {selected.lat.toFixed(4)}, {selected.lon.toFixed(4)}
                </p>
                {selected.origin === "baseline" ? (
                  <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[10px] leading-relaxed text-amber-400">
                    Опорний запис: вписаний вручну, щоб консоль не була порожньою, коли
                    OpenStreetMap недоступний. Координати приблизні, запису в джерелі немає —
                    перевірити його ніде.
                  </p>
                ) : null}

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
                        {facTilesQuery.data
                          ? ` і ${facTiles.size} з ${facTilesQuery.data.tilesTotal} — ділянок обʼєктів`
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
                  {/*
                    Кнопка є лише тоді, коли є що відкрити. Опорні записи не
                    мають запису в джерелі, і посилання «в нікуди» видавало б
                    їх за перевірені.
                  */}
                  {selected.source ? (
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
                  ) : null}
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

            {/*
              Справи стоять одразу під інспектором, бо саме там зʼявляється те,
              що варто зберегти. Панель мовчить, коли звʼязок із платформою не
              налаштований: консоль самодостатня, і це штатний стан.
            */}
            <Suspense fallback={null}>
              <div className="mb-5">
                <CasePanel
                  facility={selected ?? undefined}
                  knownEntities={platformIds}
                  onOpenFacility={setSelectedId}
                />
              </div>
            </Suspense>

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

      {showHelp ? (
        <OrientationCard onClose={() => setShowHelp(false)} showInfra={!infraDisabled} />
      ) : null}
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
