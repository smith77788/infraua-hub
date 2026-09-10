import {
  CATEGORIES,
  distanceKm,
  type CategoryId,
  type Facility,
  type GraphEdge,
  type Tier,
} from "./infra-types";
import { isObserved } from "./provenance";

/**
 * Аналіз одиничної відмови (N-1): що справді знеструмиться, якщо цей вузол
 * зникне.
 *
 * ## Чому попередня відповідь була неправильною
 *
 * Досі це рахував `downstreamOf` — транзитивне замикання вниз за течією. Для
 * виведеного кістяка це було коректно за побудовою: `buildGraph` дає кожному
 * вузлові рівно одне вхідне ребро, тож резервування там не існує в принципі,
 * і «все, що нижче» справді дорівнює «все, що втратить живлення».
 *
 * Зі спостереженою топологією це перестало бути правдою. Підстанція,
 * підвішена на три реальні лінії 330 кВ, при відмові однієї з них живлення не
 * втрачає — а модель упевнено малювала її знеструмленою разом з усім, що
 * нижче. Помилка систематична й завжди в один бік: перебільшення наслідків.
 *
 * ## Що рахується натомість
 *
 * Вузол живиться, якщо від якогось джерела генерації до нього існує шлях.
 * Відмова вилучає вузол із графа; втраченими вважаються ті, хто мав шлях до
 * генерації і після вилучення не має жодного. Це і є класичний критерій N-1,
 * яким користуються диспетчери, а не наближення.
 *
 * ## Напрям ребер
 *
 * Спостережена лінія електропередач фізично двостороння: живлення тече в той
 * бік, у який його потребують. Тому спостережені ребра беруться
 * неорієнтованими. Виведені ребра — навпаки, орієнтовані: вони й означають
 * саме припущення «оце живить оце», і робити з них двосторонній звʼязок
 * означало б додати до здогадки ще одну.
 */

/** Категорії, які в цій моделі є джерелом живлення. */
const SOURCE_CATEGORIES = new Set(["power_plant"]);

interface DirectedGraph {
  ids: string[];
  index: Map<string, number>;
  offsets: Int32Array;
  targets: Int32Array;
  sources: number[];
}

function buildDirected(facilities: Facility[], edges: GraphEdge[]): DirectedGraph {
  const ids = facilities.map((f) => f.id);
  const index = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) index.set(ids[i]!, i);

  const v = ids.length;
  const degree = new Int32Array(v);
  const arcs: number[] = [];

  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    arcs.push(a, b);
    degree[a] = degree[a]! + 1;
    if (isObserved(e.provenance)) {
      // Реальна лінія передає в обидва боки.
      arcs.push(b, a);
      degree[b] = degree[b]! + 1;
    }
  }

  const offsets = new Int32Array(v + 1);
  for (let i = 0; i < v; i++) offsets[i + 1] = offsets[i]! + degree[i]!;
  const targets = new Int32Array(offsets[v]!);
  const cursor = offsets.slice(0, v);
  for (let i = 0; i < arcs.length; i += 2) {
    const a = arcs[i]!;
    targets[cursor[a]!] = arcs[i + 1]!;
    cursor[a] = cursor[a]! + 1;
  }

  const sources: number[] = [];
  for (let i = 0; i < v; i++) {
    if (SOURCE_CATEGORIES.has(facilities[i]!.category)) sources.push(i);
  }

  return { ids, index, offsets, targets, sources };
}

/**
 * Хто отримує живлення, якщо вилучити вузол `skip` (−1 — нікого не вилучати).
 * Буфери передаються ззовні, щоб перебір усіх кандидатів не виділяв памʼять
 * на кожному кроці.
 */
function markSupplied(
  g: DirectedGraph,
  skip: number,
  supplied: Uint8Array,
  queue: Int32Array,
): number {
  supplied.fill(0);
  let tail = 0;
  for (const s of g.sources) {
    if (s === skip || supplied[s]) continue;
    supplied[s] = 1;
    queue[tail++] = s;
  }

  let head = 0;
  let count = tail;
  while (head < tail) {
    const node = queue[head++]!;
    const end = g.offsets[node + 1]!;
    for (let i = g.offsets[node]!; i < end; i++) {
      const w = g.targets[i]!;
      if (w === skip || supplied[w]) continue;
      supplied[w] = 1;
      queue[tail++] = w;
      count++;
    }
  }
  return count;
}

/**
 * Те саме, але вилучається **множина** вузлів.
 *
 * Окрема функція, а не узагальнення попередньої: одиничний перебір викликає ту
 * версію V разів, і заміна цілого числа на маску додала б їй заповнення масиву
 * на кожному кроці. Тут маска передається ззовні й перевикористовується так
 * само.
 */
function markSuppliedExcept(
  g: DirectedGraph,
  down: Uint8Array,
  supplied: Uint8Array,
  queue: Int32Array,
): number {
  supplied.fill(0);
  let tail = 0;
  for (const s of g.sources) {
    if (down[s] || supplied[s]) continue;
    supplied[s] = 1;
    queue[tail++] = s;
  }

  let head = 0;
  let count = tail;
  while (head < tail) {
    const node = queue[head++]!;
    const end = g.offsets[node + 1]!;
    for (let i = g.offsets[node]!; i < end; i++) {
      const w = g.targets[i]!;
      if (down[w] || supplied[w]) continue;
      supplied[w] = 1;
      queue[tail++] = w;
      count++;
    }
  }
  return count;
}

export interface OutageResult {
  /** Вузли, що втратили живлення саме через цю відмову. */
  lost: Set<string>;
  /**
   * Ті з утрачених, чия втрата підтверджується самою лише спостереженою
   * топологією, без виведених ребер.
   */
  grounded: Set<string>;
  /** Скільки вузлів модель узагалі бачить під живленням до відмови. */
  suppliedBefore: number;
  /** Чи є в наборі хоч одне джерело генерації. */
  hasSources: boolean;
}

const EMPTY_RESULT: OutageResult = {
  lost: new Set(),
  grounded: new Set(),
  suppliedBefore: 0,
  hasSources: false,
};

/**
 * Наслідки відмови одного вузла.
 *
 * Повертає ще й `grounded` — підмножину, яку видно без жодного припущення про
 * топологію. Решта втрачених залежить від виведених ребер, тобто від нашої
 * моделі, а не від мережі.
 */
export function simulateOutage(
  facilities: Facility[],
  edges: GraphEdge[],
  downId: string,
): OutageResult {
  const g = buildDirected(facilities, edges);
  const down = g.index.get(downId);
  if (down === undefined) return EMPTY_RESULT;

  const v = g.ids.length;
  const supplied = new Uint8Array(v);
  const queue = new Int32Array(v);
  const suppliedBefore = markSupplied(g, -1, supplied, queue);
  const before = supplied.slice();
  markSupplied(g, down, supplied, queue);

  const lost = new Set<string>();
  for (let i = 0; i < v; i++) {
    if (i !== down && before[i] && !supplied[i]) lost.add(g.ids[i]!);
  }

  // Той самий розрахунок без здогадок: що з цього ми можемо довести.
  const grounded = new Set<string>();
  const observedEdges = edges.filter((e) => isObserved(e.provenance));
  if (observedEdges.length > 0 && observedEdges.length < edges.length) {
    const og = buildDirected(facilities, observedEdges);
    const odown = og.index.get(downId);
    if (odown !== undefined) {
      const oSupplied = new Uint8Array(v);
      const oQueue = new Int32Array(v);
      markSupplied(og, -1, oSupplied, oQueue);
      const oBefore = oSupplied.slice();
      markSupplied(og, odown, oSupplied, oQueue);
      for (let i = 0; i < v; i++) {
        if (i !== odown && oBefore[i] && !oSupplied[i]) grounded.add(og.ids[i]!);
      }
    }
  } else if (observedEdges.length === edges.length) {
    for (const id of lost) grounded.add(id);
  }

  return { lost, grounded, suppliedBefore, hasSources: g.sources.length > 0 };
}

export interface ContingencyEntry {
  id: string;
  /** Скільки вузлів лишиться без живлення при відмові цього одного. */
  lost: number;
  /** З них — у секторі життєзабезпечення. */
  lifeLost: number;
}

/**
 * Перебір усіх одиничних відмов: які з них коштують найдорожче.
 *
 * Це те, чого не дає жоден із наявних показників. Посередництво каже, через
 * кого тече мережа, залежності — скільки під ним висить; і тільки прямий
 * перебір відповідає на питання, яке ставить диспетчер: «яка одна відмова
 * знеструмить найбільше».
 *
 * Кандидати, з яких не виходить жодного ребра, пропускаються: живлення через
 * них не проходить, тож їхня відмова нікого не відрізає.
 */
export function rankContingencies(
  facilities: Facility[],
  edges: GraphEdge[],
  limit = 10,
): ContingencyEntry[] {
  const g = buildDirected(facilities, edges);
  const v = g.ids.length;
  if (v === 0 || g.sources.length === 0) return [];

  const isLife = facilities.map((f) => CATEGORIES[f.category].tier === "life");
  const supplied = new Uint8Array(v);
  const queue = new Int32Array(v);
  markSupplied(g, -1, supplied, queue);
  const before = supplied.slice();

  const out: ContingencyEntry[] = [];
  for (let candidate = 0; candidate < v; candidate++) {
    if (!before[candidate]) continue;
    if (g.offsets[candidate]! === g.offsets[candidate + 1]!) continue;

    markSupplied(g, candidate, supplied, queue);
    let lost = 0;
    let lifeLost = 0;
    for (let i = 0; i < v; i++) {
      if (i !== candidate && before[i] && !supplied[i]) {
        lost++;
        if (isLife[i]) lifeLost++;
      }
    }
    if (lost > 0) out.push({ id: g.ids[candidate]!, lost, lifeLost });
  }

  return out
    .sort((a, b) => b.lifeLost - a.lifeLost || b.lost - a.lost || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/**
 * ## Відмова за площею, а не за вузлом
 *
 * Критерій N-1 відповідає на питання «що буде, якщо відмовить оцей вузол».
 * Для мережі, яка старіє, це правильне питання. Для мережі під ударами — ні:
 * приліт не вибирає один вузол зі списку, він знімає **все, що є в радіусі**,
 * разом із лініями, що йшли повз. Підстанція і резервна лінія за два
 * кілометри від неї — не два незалежні відмови, а один.
 *
 * Тому тут перебираються не вузли, а **епіцентри**, і кожен кандидат забирає
 * все у своєму колі одразу. Різниця не косметична: мережа, що витримує будь-яку
 * одиничну відмову, може розсипатися від одного удару по вузлу, поруч з яким
 * стоїть її ж резерв.
 */

/** Наслідки відмови довільної множини вузлів. */
export function simulateMultiOutage(
  facilities: Facility[],
  edges: GraphEdge[],
  downIds: readonly string[],
): OutageResult {
  const g = buildDirected(facilities, edges);
  const v = g.ids.length;
  if (v === 0) return EMPTY_RESULT;

  const down = new Uint8Array(v);
  let anyDown = false;
  for (const id of downIds) {
    const index = g.index.get(id);
    if (index === undefined) continue;
    down[index] = 1;
    anyDown = true;
  }
  if (!anyDown) return { ...EMPTY_RESULT, hasSources: g.sources.length > 0 };

  const supplied = new Uint8Array(v);
  const queue = new Int32Array(v);
  const empty = new Uint8Array(v);
  const suppliedBefore = markSuppliedExcept(g, empty, supplied, queue);
  const before = supplied.slice();
  markSuppliedExcept(g, down, supplied, queue);

  const lost = new Set<string>();
  for (let i = 0; i < v; i++) {
    if (!down[i] && before[i] && !supplied[i]) lost.add(g.ids[i]!);
  }

  // Та сама відповідь без жодного припущення про топологію.
  const grounded = new Set<string>();
  const observedEdges = edges.filter((e) => isObserved(e.provenance));
  if (observedEdges.length === edges.length) {
    for (const id of lost) grounded.add(id);
  } else if (observedEdges.length > 0) {
    const og = buildDirected(facilities, observedEdges);
    const oDown = new Uint8Array(og.ids.length);
    for (const id of downIds) {
      const index = og.index.get(id);
      if (index !== undefined) oDown[index] = 1;
    }
    const oSupplied = new Uint8Array(og.ids.length);
    const oQueue = new Int32Array(og.ids.length);
    const oEmpty = new Uint8Array(og.ids.length);
    markSuppliedExcept(og, oEmpty, oSupplied, oQueue);
    const oBefore = oSupplied.slice();
    markSuppliedExcept(og, oDown, oSupplied, oQueue);
    for (let i = 0; i < og.ids.length; i++) {
      if (!oDown[i] && oBefore[i] && !oSupplied[i]) grounded.add(og.ids[i]!);
    }
  }

  return { lost, grounded, suppliedBefore, hasSources: g.sources.length > 0 };
}

/** Обʼєкти в колі заданого радіуса — те, що знімає один удар. */
export function facilitiesWithin(
  facilities: Facility[],
  center: { lat: number; lon: number },
  radiusKm: number,
): Facility[] {
  return facilities.filter((f) => distanceKm(f, center) <= radiusKm);
}

/**
 * Сітка в цілий градус для перебору кіл.
 *
 * Навмисно груба: покажчик лише звужує пошук, а точну відстань усе одно рахує
 * `distanceKm` на кандидатах. Вільна комірка коштує кількох зайвих обчислень і
 * ніколи не змінює відповіді, тоді як завузька могла б обрізати коло —
 * помилка, через яку удар «не зачепив би» те, що стоїть поруч.
 */
class GeoGrid {
  private readonly cells = new Map<string, Facility[]>();

  constructor(facilities: Facility[]) {
    for (const facility of facilities) {
      const key = `${Math.floor(facility.lat)}:${Math.floor(facility.lon)}`;
      const cell = this.cells.get(key);
      if (cell) cell.push(facility);
      else this.cells.set(key, [facility]);
    }
  }

  within(center: { lat: number; lon: number }, radiusKm: number): Facility[] {
    // Градус широти — близько 111 км; довготи — менше, і ще менше на північ.
    // Брати широтну міру для обох означає захопити зайве по довготі, і це
    // безпечний бік помилки.
    const span = Math.max(1, Math.ceil(radiusKm / 111));
    const baseLat = Math.floor(center.lat);
    const baseLon = Math.floor(center.lon);
    const found: Facility[] = [];
    for (let dLat = -span; dLat <= span; dLat++) {
      for (let dLon = -span; dLon <= span; dLon++) {
        for (const facility of this.cells.get(`${baseLat + dLat}:${baseLon + dLon}`) ?? []) {
          if (distanceKm(facility, center) <= radiusKm) found.push(facility);
        }
      }
    }
    return found;
  }
}

export interface Consequence {
  /** Прямо знищені — ті, що були в колі удару. */
  destroyed: string[];
  /** Знеструмлені через втрату шляху до генерації, крім знищених. */
  lost: string[];
  /** З утрачених — ті, чия втрата видно без жодного виведеного ребра. */
  grounded: string[];
  /** Розподіл наслідків за укрупненими секторами. */
  byTier: Record<Tier, number>;
  /** Знеструмлені обʼєкти життєзабезпечення поіменно: лікарні, водоканали. */
  lifeCritical: { id: string; name: string; category: CategoryId }[];
  /**
   * Втрачена генерація, МВт — сума `capacityMw` по станціях, що вибули.
   *
   * Рахується лише по обʼєктах, у яких це значення **є в джерелі**. Тег
   * `plant:output:electricity` в OSM заповнений далеко не скрізь, тож число
   * завжди занижене, і `capacityKnownFor` каже, по скількох воно взагалі
   * пораховане. Оцінювати потужність за типом станції означало б видати
   * припущення за замір.
   */
  lostCapacityMw: number;
  capacityKnownFor: number;
  capacityUnknownFor: number;
}

function emptyTiers(): Record<Tier, number> {
  return { energy: 0, life: 0, mobility: 0, comms: 0, industry: 0, gov: 0 };
}

/** Зводить наслідки відмови в те, що можна показати черговому. */
export function describeConsequence(
  facilities: Facility[],
  destroyedIds: readonly string[],
  outage: OutageResult,
): Consequence {
  const byId = new Map(facilities.map((f) => [f.id, f]));
  const destroyed = destroyedIds.filter((id) => byId.has(id));
  const lost = Array.from(outage.lost);

  const byTier = emptyTiers();
  const lifeCritical: Consequence["lifeCritical"] = [];
  let lostCapacityMw = 0;
  let capacityKnownFor = 0;
  let capacityUnknownFor = 0;

  // Знищені й знеструмлені разом: для того, хто дивиться на наслідки, різниця
  // між «немає обʼєкта» і «обʼєкт без живлення» не змінює того, що його немає.
  for (const id of [...destroyed, ...lost]) {
    const facility = byId.get(id);
    if (!facility) continue;
    byTier[CATEGORIES[facility.category].tier] += 1;
    if (CATEGORIES[facility.category].tier === "life") {
      lifeCritical.push({ id: facility.id, name: facility.name, category: facility.category });
    }
    if (facility.category === "power_plant") {
      if (typeof facility.capacityMw === "number" && Number.isFinite(facility.capacityMw)) {
        lostCapacityMw += facility.capacityMw;
        capacityKnownFor += 1;
      } else {
        capacityUnknownFor += 1;
      }
    }
  }

  return {
    destroyed,
    lost,
    grounded: Array.from(outage.grounded),
    byTier,
    lifeCritical,
    lostCapacityMw: Math.round(lostCapacityMw),
    capacityKnownFor,
    capacityUnknownFor,
  };
}

/** Наслідки удару по площі: усе в радіусі зникає одночасно. */
export function simulateAreaOutage(
  facilities: Facility[],
  edges: GraphEdge[],
  center: { lat: number; lon: number },
  radiusKm: number,
): Consequence {
  const inside = facilitiesWithin(facilities, center, radiusKm).map((f) => f.id);
  return describeConsequence(facilities, inside, simulateMultiOutage(facilities, edges, inside));
}

export interface AreaContingencyEntry {
  /** Обʼєкт, узятий за епіцентр. */
  centerId: string;
  centerName: string;
  lat: number;
  lon: number;
  /** Скільки обʼєктів у радіусі зникає одразу. */
  destroyed: number;
  /** Скільки додатково лишається без живлення. */
  lost: number;
  lifeLost: number;
  lostCapacityMw: number;
}

/**
 * Найдорожчі удари: перебір епіцентрів замість перебору вузлів.
 *
 * Кандидати — самі обʼєкти набору, а не сітка по країні: удар має ціль, і
 * рівномірна сітка витратила б більшу частину роботи на порожні квадрати. Це
 * і межа методу: епіцентр між двома обʼєктами, що зачепив обидва, тут не
 * зʼявиться, хоча в житті буває.
 */
export function rankAreaContingencies(
  facilities: Facility[],
  edges: GraphEdge[],
  radiusKm: number,
  options: { limit?: number; candidateCategories?: ReadonlySet<CategoryId> } = {},
): AreaContingencyEntry[] {
  const limit = options.limit ?? 10;
  const candidates = options.candidateCategories
    ? facilities.filter((f) => options.candidateCategories!.has(f.category))
    : facilities;

  // Граф і просторовий покажчик будуються один раз на весь перебір. Перша
  // версія викликала `simulateAreaOutage` на кожного кандидата, а та щоразу
  // збирала CSR наново й обходила всі обʼєкти в пошуку кола: заміряно на
  // 4000 вузлах і 600 кандидатах — 1.3 с там, де людина чекає на відповідь.
  const g = buildDirected(facilities, edges);
  const v = g.ids.length;
  if (v === 0 || g.sources.length === 0) return [];

  const grid = new GeoGrid(facilities);
  const isLife = facilities.map((f) => CATEGORIES[f.category].tier === "life");
  const capacity = facilities.map((f) =>
    f.category === "power_plant" &&
    typeof f.capacityMw === "number" &&
    Number.isFinite(f.capacityMw)
      ? f.capacityMw
      : 0,
  );

  const supplied = new Uint8Array(v);
  const queue = new Int32Array(v);
  const down = new Uint8Array(v);
  const empty = new Uint8Array(v);
  markSuppliedExcept(g, empty, supplied, queue);
  const before = supplied.slice();

  const out: AreaContingencyEntry[] = [];
  for (const center of candidates) {
    const inside = grid.within(center, radiusKm);
    if (inside.length === 0) continue;

    down.fill(0);
    for (const facility of inside) {
      const index = g.index.get(facility.id);
      if (index !== undefined) down[index] = 1;
    }
    markSuppliedExcept(g, down, supplied, queue);

    let destroyed = 0;
    let lost = 0;
    let lifeLost = 0;
    let lostCapacityMw = 0;
    for (let i = 0; i < v; i++) {
      if (down[i]) {
        destroyed++;
        if (isLife[i]) lifeLost++;
        lostCapacityMw += capacity[i]!;
      } else if (before[i] && !supplied[i]) {
        lost++;
        if (isLife[i]) lifeLost++;
        lostCapacityMw += capacity[i]!;
      }
    }
    if (destroyed === 0) continue;

    out.push({
      centerId: center.id,
      centerName: center.name,
      lat: center.lat,
      lon: center.lon,
      destroyed,
      lost,
      lifeLost,
      lostCapacityMw: Math.round(lostCapacityMw),
    });
  }

  return out
    .sort(
      (a, b) =>
        b.lifeLost - a.lifeLost ||
        b.destroyed + b.lost - (a.destroyed + a.lost) ||
        b.lostCapacityMw - a.lostCapacityMw ||
        a.centerId.localeCompare(b.centerId),
    )
    .slice(0, limit);
}

/**
 * N-1-1: друга відмова там, де перша вже сталася.
 *
 * Диспетчерське правило N-1 говорить про мережу в повному складі. Мережа під
 * ударами в повному складі не буває майже ніколи: один вузол у ремонті, другий
 * знищено місяць тому. Запас, який рахували по повній схемі, у цьому стані вже
 * витрачено, і наступна відмова коштує більше, ніж каже будь-який показник,
 * порахований до неї.
 */
export function rankSecondFailures(
  facilities: Facility[],
  edges: GraphEdge[],
  alreadyDown: readonly string[],
  limit = 10,
): ContingencyEntry[] {
  const g = buildDirected(facilities, edges);
  const v = g.ids.length;
  if (v === 0 || g.sources.length === 0) return [];

  const isLife = facilities.map((f) => CATEGORIES[f.category].tier === "life");
  const down = new Uint8Array(v);
  for (const id of alreadyDown) {
    const index = g.index.get(id);
    if (index !== undefined) down[index] = 1;
  }

  const supplied = new Uint8Array(v);
  const queue = new Int32Array(v);
  markSuppliedExcept(g, down, supplied, queue);
  // Базою є вже ушкоджена мережа, а не повна: інакше кожен кандидат отримав би
  // до свого рахунку наслідки першої відмови, яка сталася без нього.
  const before = supplied.slice();

  const out: ContingencyEntry[] = [];
  for (let candidate = 0; candidate < v; candidate++) {
    if (down[candidate] || !before[candidate]) continue;
    if (g.offsets[candidate]! === g.offsets[candidate + 1]!) continue;

    down[candidate] = 1;
    markSuppliedExcept(g, down, supplied, queue);
    down[candidate] = 0;

    let lost = 0;
    let lifeLost = 0;
    for (let i = 0; i < v; i++) {
      if (i !== candidate && before[i] && !supplied[i]) {
        lost++;
        if (isLife[i]) lifeLost++;
      }
    }
    if (lost > 0) out.push({ id: g.ids[candidate]!, lost, lifeLost });
  }

  return out
    .sort((a, b) => b.lifeLost - a.lifeLost || b.lost - a.lost || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export interface RepairStep {
  id: string;
  name: string;
  /** Скільки обʼєктів повертає живлення саме цей ремонт, з урахуванням попередніх. */
  restores: number;
  /** З них — життєзабезпечення. */
  restoresLife: number;
  /** Скільки лишається знеструмленими після цього кроку. */
  remaining: number;
}

/**
 * Черговість відновлення: який ремонт повертає найбільше.
 *
 * Жадібний вибір, і це не спрощення від ліні. Задача — максимальне покриття,
 * вона NP-складна, а жадібний алгоритм дає гарантовану частку (1 − 1/e ≈ 63%)
 * від найкращого можливого. Точний перебір коштував би експоненційно і
 * рахувався б довше, ніж триває сама аварія.
 *
 * Кроки перераховуються після кожного вибору: два ремонти часто повертають тих
 * самих споживачів, і сума їхніх окремих ефектів — не ефект від обох.
 */
export function planRestoration(
  facilities: Facility[],
  edges: GraphEdge[],
  downIds: readonly string[],
  limit = 5,
): RepairStep[] {
  const byId = new Map(facilities.map((f) => [f.id, f]));
  const remainingDown = new Set(downIds.filter((id) => byId.has(id)));
  if (remainingDown.size === 0) return [];

  const isLife = (id: string) => {
    const facility = byId.get(id);
    return facility ? CATEGORIES[facility.category].tier === "life" : false;
  };

  const plan: RepairStep[] = [];
  let current = simulateMultiOutage(facilities, edges, Array.from(remainingDown));

  for (let step = 0; step < limit && remainingDown.size > 0; step++) {
    let best: { id: string; restores: number; restoresLife: number; after: OutageResult } | null =
      null;

    for (const candidate of remainingDown) {
      const rest = Array.from(remainingDown).filter((id) => id !== candidate);
      const after = simulateMultiOutage(facilities, edges, rest);
      let restores = 0;
      let restoresLife = 0;
      for (const id of current.lost) {
        if (!after.lost.has(id)) {
          restores++;
          if (isLife(id)) restoresLife++;
        }
      }
      // Сам відремонтований обʼєкт теж повертається в мережу.
      restores += 1;
      if (isLife(candidate)) restoresLife += 1;

      if (
        best === null ||
        restoresLife > best.restoresLife ||
        (restoresLife === best.restoresLife && restores > best.restores)
      ) {
        best = { id: candidate, restores, restoresLife, after };
      }
    }

    if (!best) break;
    remainingDown.delete(best.id);
    current = best.after;
    plan.push({
      id: best.id,
      name: byId.get(best.id)?.name ?? best.id,
      restores: best.restores,
      restoresLife: best.restoresLife,
      remaining: current.lost.size + remainingDown.size,
    });
  }

  return plan;
}
