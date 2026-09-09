import { CATEGORIES, type Facility, type GraphEdge } from "./infra-types";
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
