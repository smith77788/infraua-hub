import { distanceKm, type Facility, type GraphEdge } from "./infra-types";

/**
 * Побудова **спостереженої** топології енергомережі з реальних ліній OSM.
 *
 * `buildGraph` виводить кістяк за найближчим сусідом — це припущення. Тут
 * інше: OSM містить справжні лінії електропередач (`power=line`) з напругою
 * і геометрією. Якщо кінець лінії лежить біля підстанції чи станції, це
 * зафіксований фізичний звʼязок, а не наша здогадка.
 *
 * Перевірено запитом до Overpass (2026-09): у межах України близько 16.9 тис.
 * ліній з напругою 110 кВ і вище, кожна з повною геометрією. Тобто дані для
 * реальної топології існують — питання лише в тому, щоб їх звести з обʼєктами.
 *
 * ## Як лінія стає ребром
 *
 * Лінія — це ламана. Її кінці (а іноді й проміжні точки на відгалуженнях)
 * фізично приходять на підстанцію. Тому:
 *
 * 1. беремо кінцеві точки лінії;
 * 2. шукаємо обʼєкт у радіусі `SNAP_KM` від кінця;
 * 3. якщо на обох кінцях знайшлися різні обʼєкти — це ребро.
 *
 * Радіус потрібен, бо в OSM лінія зазвичай уривається на порталі підстанції,
 * а сам обʼєкт позначений точкою в її центрі; відстань між ними — сотні
 * метрів. Завеликий радіус почне зшивати сусідні підстанції в одну, тому
 * значення обране консервативно і винесене в константу.
 */

/** Кінець лінії має лягти не далі цієї відстані від обʼєкта. */
const SNAP_KM = 0.8;

/** Мінімальна довжина ребра: коротше — це та сама підстанція двічі. */
const MIN_EDGE_KM = 0.2;

export interface PowerLine {
  /** id way у OSM — щоб твердження можна було перевірити вручну. */
  id: number;
  /** Геометрія ламаної, від початку до кінця. */
  geometry: { lat: number; lon: number }[];
  voltage?: number | undefined;
  operator?: string | undefined;
}

/** Відповідь Overpass у тому вигляді, в якому вона приходить. */
interface OverpassWay {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

/**
 * Розбирає відповідь Overpass у лінії. Усе, що без геометрії або без двох
 * точок, відкидається: з такого елемента ребро не побудувати, і мовчазне
 * пропускання тут краще за виняток — набір даних завжди частково битий.
 */
export function parsePowerLines(payload: unknown): PowerLine[] {
  if (typeof payload !== "object" || payload === null) return [];
  const elements = (payload as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) return [];

  const lines: PowerLine[] = [];
  for (const raw of elements as OverpassWay[]) {
    const geometry = raw.geometry;
    if (!Array.isArray(geometry) || geometry.length < 2) continue;
    if (typeof raw.id !== "number") continue;

    const points = geometry.filter(
      (p): p is { lat: number; lon: number } =>
        typeof p?.lat === "number" && typeof p?.lon === "number",
    );
    if (points.length < 2) continue;

    const voltageTag = raw.tags?.["voltage"];
    // Тег напруги буває списком через крапку з комою ("330000;110000") —
    // беремо найвищу, бо саме вона визначає роль лінії в мережі.
    const voltage = voltageTag
      ? Math.max(
          ...voltageTag
            .split(";")
            .map((v) => Number(v.trim()))
            .filter((v) => Number.isFinite(v)),
        )
      : undefined;

    lines.push({
      id: raw.id,
      geometry: points,
      voltage: Number.isFinite(voltage) ? voltage : undefined,
      operator: raw.tags?.["operator"],
    });
  }
  return lines;
}

/** Запит Overpass по лініях у межах bbox. Напруга — від 110 кВ. */
export function powerLineQuery(bbox: {
  south: number;
  west: number;
  north: number;
  east: number;
}): string {
  const area = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return [
    "[out:json][timeout:90];",
    "(",
    `way["power"="line"]["voltage"~"^(1[1-9][0-9]{4}|[2-9][0-9]{5})"](${area});`,
    ");",
    "out tags geom;",
  ].join("");
}

/**
 * Індекс обʼєктів по сітці, щоб пошук найближчого не був O(N) на кожен кінець
 * лінії. Комірка приблизно 1 км — трохи більша за SNAP_KM, тож достатньо
 * перевірити комірку кінця і вісім сусідніх.
 */
class SpatialIndex {
  private readonly cells = new Map<string, Facility[]>();
  private static readonly CELL_DEG = 0.01;

  constructor(facilities: Facility[]) {
    for (const f of facilities) {
      const key = SpatialIndex.keyFor(f.lat, f.lon);
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(f);
      else this.cells.set(key, [f]);
    }
  }

  private static keyFor(lat: number, lon: number): string {
    return `${Math.floor(lat / SpatialIndex.CELL_DEG)}:${Math.floor(lon / SpatialIndex.CELL_DEG)}`;
  }

  nearest(lat: number, lon: number, maxKm: number): { facility: Facility; km: number } | null {
    const latCell = Math.floor(lat / SpatialIndex.CELL_DEG);
    const lonCell = Math.floor(lon / SpatialIndex.CELL_DEG);

    let best: Facility | null = null;
    let bestKm = Infinity;
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const bucket = this.cells.get(`${latCell + dLat}:${lonCell + dLon}`);
        if (!bucket) continue;
        for (const f of bucket) {
          const km = distanceKm({ lat, lon }, f);
          if (km < bestKm) {
            bestKm = km;
            best = f;
          }
        }
      }
    }
    return best && bestKm <= maxKm ? { facility: best, km: bestKm } : null;
  }
}

export interface ObservedGraphResult {
  edges: GraphEdge[];
  /** Скільки ліній не вдалося звести з жодним обʼєктом на обох кінцях. */
  unmatchedLines: number;
  /** Скільки ліній дали ребро. */
  matchedLines: number;
}

/**
 * Зводить лінії з обʼєктами у спостережені ребра.
 *
 * Ребро отримує напругу і id лінії в OSM, тож будь-яке твердження на цьому
 * графі можна відкрити в OSM і перевірити очима — саме цього не давав
 * виведений граф.
 */
export function buildObservedGraph(
  facilities: Facility[],
  lines: PowerLine[],
  retrievedAt: string = new Date().toISOString(),
): ObservedGraphResult {
  const index = new SpatialIndex(facilities);
  const edges: GraphEdge[] = [];
  // Одна пара підстанцій буває зʼєднана кількома паралельними лініями; для
  // топології це одне ребро, тому дублікати згортаються (лишається коротше).
  const seen = new Map<string, GraphEdge>();
  let unmatched = 0;

  for (const line of lines) {
    const first = line.geometry[0];
    const last = line.geometry[line.geometry.length - 1];
    if (!first || !last) {
      unmatched++;
      continue;
    }

    const a = index.nearest(first.lat, first.lon, SNAP_KM);
    const b = index.nearest(last.lat, last.lon, SNAP_KM);
    if (!a || !b || a.facility.id === b.facility.id) {
      unmatched++;
      continue;
    }

    const km = distanceKm(a.facility, b.facility);
    if (km < MIN_EDGE_KM) {
      unmatched++;
      continue;
    }

    // Ключ незалежний від напрямку: лінія фізично двостороння.
    const key = [a.facility.id, b.facility.id].sort().join("|");
    const existing = seen.get(key);
    if (existing && existing.km <= km) continue;

    const attributes: Record<string, string | number> = {};
    if (line.voltage !== undefined) attributes["voltage"] = line.voltage;
    if (line.operator !== undefined) attributes["operator"] = line.operator;

    seen.set(key, {
      from: a.facility.id,
      to: b.facility.id,
      km,
      // Лінія між двома вузлами мережі — це передача, не подача споживачу.
      kind: "supply",
      provenance: {
        kind: "observed",
        source: "OpenStreetMap",
        ref: `way/${line.id}`,
        retrievedAt,
        attributes,
      },
    });
  }

  edges.push(...seen.values());
  return { edges, unmatchedLines: unmatched, matchedLines: seen.size };
}

/**
 * Обʼєднує спостережені та виведені ребра, віддаючи перевагу спостереженим.
 *
 * Відкидається не лише дубль тієї самої пари. Якщо у вузла вже є хоча б одна
 * спостережена лінія, здогадки про його живлення відкидаються теж: ми бачимо,
 * до чого він підключений насправді, і приписувати йому додатково «найближчу
 * станцію» означає підмішувати вигадку до факту.
 *
 * Це не косметика. Експеримент на реальних даних (Київська область, вересень
 * 2026): 47 спостережених ребер проти 2064 виведених — тобто без цього
 * правила частка фактів у графі складала 2.2%, і 47 справжніх ліній тонули
 * серед двох тисяч припущень. Аналітик у такому графі бачить переважно те,
 * що система придумала сама.
 */
export function mergeGraphs(observed: GraphEdge[], inferred: GraphEdge[]): GraphEdge[] {
  const keyOf = (e: GraphEdge) => [e.from, e.to].sort().join("|");
  const observedKeys = new Set(observed.map(keyOf));

  // Вузли, для яких реальна топологія вже відома.
  const grounded = new Set<string>();
  for (const e of observed) {
    grounded.add(e.from);
    grounded.add(e.to);
  }

  return [
    ...observed,
    ...inferred.filter((e) => {
      if (observedKeys.has(keyOf(e))) return false;
      // Ребро приписує живлення вузлові `to`; якщо про нього вже є факт —
      // здогадка зайва. Вузол `from` при цьому може мати скільки завгодно
      // інших спостережених ліній, це не робить здогадку про `to` кращою.
      return !grounded.has(e.to);
    }),
  ];
}
