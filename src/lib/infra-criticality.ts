import { CATEGORIES, type Facility, type GraphEdge, type Tier } from "./infra-types";
import { isObserved } from "./provenance";

/**
 * Структурна критичність обʼєктів мережі живлення.
 *
 * `analyzeNetwork` рахує низхідні вузли — скільки споживачів висить під
 * обʼєктом. Це правильна метрика, але вона систематично пропускає один клас
 * обʼєктів: вузол може мати мало прямих споживачів і бути єдиним звʼязком між
 * двома частинами мережі. Втрата такого вузла ділить мережу навпіл, хоча за
 * кількістю споживачів він виглядає другорядним.
 *
 * Тут два показники, які це ловлять:
 *
 * - **Посередництво (betweenness)** за алгоритмом Брандеса: частка найкоротших
 *   шляхів між іншими вузлами, що проходять через цей. Високе значення означає
 *   «через нього тече мережа», незалежно від кількості сусідів.
 * - **Мости**: ребра, видалення яких розриває компоненту звʼязності. Міст —
 *   це єдина лінія, що тримає частину мережі; її варто перевіряти першою.
 *
 * Обидва рахуються на неорієнтованому вигляді графа: для питання «що станеться,
 * якщо вузол зникне» напрям живлення не має значення — важлива сама наявність
 * звʼязку.
 *
 * ## Чому тут типізовані масиви, а не Map
 *
 * Перша версія цього модуля тримала граф у `Map<string, Set<string>>` і
 * виділяла чотири Map розміром V на кожне джерело обходу. Заміряно на
 * синтетичному графі того ж розміру, що й український набір: 500 вузлів —
 * 0.5 с, 1000 — 1.5 с, 2000 — 6.9 с, 4000 — 26.6 с. Зростання квадратичне,
 * і вся ця робота — виділення памʼяті, а не сам обхід.
 *
 * Тому граф зводиться один раз у CSR (offsets + targets у Int32Array), а
 * буфери обходу виділяються теж один раз і перевикористовуються між
 * джерелами. Складність та сама, O(V·E), але без алокацій у гарячому циклі.
 */

/**
 * Граф у форматі CSR: `targets[offsets[v] .. offsets[v+1])` — сусіди `v`.
 * Дублікати ребер прибираються: паралельна лінія між тією самою парою не має
 * подвоювати кількість найкоротших шляхів.
 */
interface Csr {
  ids: string[];
  offsets: Int32Array;
  targets: Int32Array;
}

function buildCsr(facilities: Facility[], edges: GraphEdge[]): Csr {
  const ids = facilities.map((f) => f.id);
  const index = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) index.set(ids[i]!, i);

  const v = ids.length;
  const degree = new Int32Array(v);
  // Пари (from,to) в обидва боки, без дублікатів і петель.
  const pairs: number[] = [];
  const seen = new Set<number>();
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    // Ребро до вузла поза набором — не звʼязок, який ми можемо показати.
    if (a === undefined || b === undefined || a === b) continue;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    // Ключ пари в одне число: V ≤ 2^21 для будь-якого реального набору.
    const key = lo * 2097152 + hi;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(a, b);
    degree[a] = degree[a]! + 1;
    degree[b] = degree[b]! + 1;
  }

  const offsets = new Int32Array(v + 1);
  for (let i = 0; i < v; i++) offsets[i + 1] = offsets[i]! + degree[i]!;
  const targets = new Int32Array(offsets[v]!);
  const cursor = offsets.slice(0, v);
  for (let i = 0; i < pairs.length; i += 2) {
    const a = pairs[i]!;
    const b = pairs[i + 1]!;
    targets[cursor[a]!] = b;
    cursor[a] = cursor[a]! + 1;
    targets[cursor[b]!] = a;
    cursor[b] = cursor[b]! + 1;
  }

  return { ids, offsets, targets };
}

export interface CentralityEntry {
  id: string;
  /** Нормалізовано до [0,1] відносно максимуму в цьому наборі. */
  score: number;
  raw: number;
}

/**
 * До скількох вузлів рахувати посередництво точно.
 *
 * Заміряно на цій реалізації: 1000 вузлів — 32 мс, 2000 — 55 мс, 3000 —
 * 117 мс, 5000 — 314 мс, 8000 — 815 мс. Поточний набір обмежений 3210
 * обʼєктами (сума ліміта́ по категоріях у `infra.functions.ts`), тож він увесь
 * лежить у точній зоні; межа з запасом на випадок, якщо ліміти піднімуть.
 *
 * Вище неї береться вибірка опорних вузлів (Brandes–Pich): вартість стає
 * лінійною, але значення перетворюється на оцінку.
 */
export const EXACT_SOURCE_LIMIT = 4000;

/**
 * Скільки опорних вузлів брати, коли точний розрахунок надто дорогий.
 *
 * Заміряно проти точного значення на графі з 3000 вузлів: 200 опорних дають
 * збіг топ-50 42/50, 600 — 47/50, 1200 — 49/50. Рейтинг, за яким ухвалюють
 * рішення, не повинен губити вузли, тому взято 1200; це все одно дешевше за
 * точний розрахунок на графі, де вибірка взагалі вмикається.
 */
export const PIVOT_COUNT = 1200;

export interface BetweennessOptions {
  /**
   * Скільки джерел обходу використати. `undefined` — вирішити за розміром
   * графа. Значення менше за кількість вузлів дає оцінку, а не точне число.
   */
  sources?: number;
}

export interface BetweennessResult {
  entries: CentralityEntry[];
  /** Скільки джерел обходу реально пройдено. */
  sourcesUsed: number;
  /** `false` означає, що значення — оцінка за вибіркою опорних вузлів. */
  exact: boolean;
}

/**
 * Детермінований вибір опорних вузлів.
 *
 * Випадкова вибірка змушувала б рейтинг сіпатися між перерахунками на тих
 * самих даних, тож генератор із фіксованим зерном: та сама мережа завжди дає
 * той самий результат. Часткове перемішування Фішера–Йетса, бо рівномірний
 * крок по індексу корелював би з порядком завантаження обʼєктів (він
 * згрупований за категорією і географією).
 */
function pickPivots(v: number, count: number): Int32Array {
  const order = new Int32Array(v);
  for (let i = 0; i < v; i++) order[i] = i;

  let state = 0x9e3779b9;
  const next = () => {
    // xorshift32 — достатньо для вибірки і повністю відтворюваний.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };

  const k = Math.min(count, v);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(next() * (v - i));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  return order.slice(0, k);
}

function betweennessCsr(g: Csr, options: BetweennessOptions = {}): BetweennessResult {
  const v = g.ids.length;
  if (v === 0) return { entries: [], sourcesUsed: 0, exact: true };

  const requested = options.sources ?? (v > EXACT_SOURCE_LIMIT ? PIVOT_COUNT : v);
  const sourceCount = Math.max(1, Math.min(v, requested));
  const exact = sourceCount >= v;
  const sources = exact ? null : pickPivots(v, sourceCount);

  const score = new Float64Array(v);
  const sigma = new Float64Array(v);
  const delta = new Float64Array(v);
  const dist = new Int32Array(v).fill(-1);
  const queue = new Int32Array(v);
  const order = new Int32Array(v);
  // Списки попередників як звʼязані списки в спільному буфері: більше за
  // кількість напрямлених ребер їх бути не може.
  const predHead = new Int32Array(v).fill(-1);
  const predNode = new Int32Array(g.targets.length);
  const predNext = new Int32Array(g.targets.length);

  for (let si = 0; si < sourceCount; si++) {
    const s = sources ? sources[si]! : si;
    let visited = 0;
    let predCount = 0;

    dist[s] = 0;
    sigma[s] = 1;
    queue[0] = s;
    let head = 0;
    let tail = 1;

    while (head < tail) {
      const node = queue[head++]!;
      order[visited++] = node;
      const dNode = dist[node]!;
      const sNode = sigma[node]!;
      const end = g.offsets[node + 1]!;
      for (let i = g.offsets[node]!; i < end; i++) {
        const w = g.targets[i]!;
        if (dist[w] === -1) {
          dist[w] = dNode + 1;
          queue[tail++] = w;
        }
        // Накопичуємо лише вздовж найкоротших шляхів.
        if (dist[w] === dNode + 1) {
          sigma[w] = sigma[w]! + sNode;
          predNode[predCount] = node;
          predNext[predCount] = predHead[w]!;
          predHead[w] = predCount;
          predCount++;
        }
      }
    }

    for (let i = visited - 1; i >= 0; i--) {
      const w = order[i]!;
      const coeff = (1 + delta[w]!) / sigma[w]!;
      for (let p = predHead[w]!; p !== -1; p = predNext[p]!) {
        const node = predNode[p]!;
        delta[node] = delta[node]! + sigma[node]! * coeff;
      }
      if (w !== s) score[w] = score[w]! + delta[w]!;
    }

    // Скидаємо лише те, чого торкнулися: інакше повернулася б квадратична
    // вартість, від якої ми й пішли.
    for (let i = 0; i < visited; i++) {
      const node = order[i]!;
      dist[node] = -1;
      sigma[node] = 0;
      delta[node] = 0;
      predHead[node] = -1;
    }
  }

  // На неорієнтованому графі кожна невпорядкована пара рахується двічі.
  // За вибіркою значення масштабується до повного графа (Brandes–Pich).
  const scale = (exact ? 1 : v / sourceCount) / 2;
  const raw = g.ids.map((id, i) => ({ id, raw: score[i]! * scale }));
  const max = Math.max(0, ...raw.map((r) => r.raw));
  const entries = raw
    .map((r) => ({ ...r, score: max > 0 ? r.raw / max : 0 }))
    .sort((a, b) => b.raw - a.raw || a.id.localeCompare(b.id));

  return { entries, sourcesUsed: sourceCount, exact };
}

/** Посередництво за Брандесом. Точне на малих графах, оцінка на великих. */
export function betweenness(
  facilities: Facility[],
  edges: GraphEdge[],
  options?: BetweennessOptions,
): CentralityEntry[] {
  return betweennessCsr(buildCsr(facilities, edges), options).entries;
}

/** Те саме, але з відповіддю на питання «наскільки цьому числу вірити». */
export function betweennessDetailed(
  facilities: Facility[],
  edges: GraphEdge[],
  options?: BetweennessOptions,
): BetweennessResult {
  return betweennessCsr(buildCsr(facilities, edges), options);
}

export interface Bridge {
  from: string;
  to: string;
}

/**
 * Мости — ребра, видалення яких збільшує кількість компонент звʼязності.
 * Ітеративний DFS: рекурсивний переповнив би стек на мережі звичайного розміру.
 */
function bridgesCsr(g: Csr): Bridge[] {
  const v = g.ids.length;
  const disc = new Int32Array(v).fill(-1);
  const low = new Int32Array(v);
  const parent = new Int32Array(v).fill(-1);
  const stackNode = new Int32Array(v);
  const stackIter = new Int32Array(v);
  const found: Bridge[] = [];
  let timer = 0;

  for (let start = 0; start < v; start++) {
    if (disc[start] !== -1) continue;
    disc[start] = timer;
    low[start] = timer;
    timer++;

    let sp = 0;
    stackNode[0] = start;
    stackIter[0] = g.offsets[start]!;

    while (sp >= 0) {
      const node = stackNode[sp]!;
      if (stackIter[sp]! < g.offsets[node + 1]!) {
        const w = g.targets[stackIter[sp]!]!;
        stackIter[sp] = stackIter[sp]! + 1;
        if (w === parent[node]) continue;
        if (disc[w] === -1) {
          parent[w] = node;
          disc[w] = timer;
          low[w] = timer;
          timer++;
          sp++;
          stackNode[sp] = w;
          stackIter[sp] = g.offsets[w]!;
        } else if (disc[w]! < low[node]!) {
          low[node] = disc[w]!;
        }
        continue;
      }

      sp--;
      if (sp < 0) continue;
      const p = stackNode[sp]!;
      if (low[node]! < low[p]!) low[p] = low[node]!;
      // Жодного зворотного ребра з піддерева вище за `p` — значить, ребро
      // (p, node) єдине тримає це піддерево.
      if (low[node]! > disc[p]!) found.push({ from: g.ids[p]!, to: g.ids[node]! });
    }
  }

  return found;
}

export function bridges(facilities: Facility[], edges: GraphEdge[]): Bridge[] {
  return bridgesCsr(buildCsr(facilities, edges));
}

/** Компоненти звʼязності, найбільша перша. */
function componentsCsr(g: Csr): string[][] {
  const v = g.ids.length;
  const seen = new Uint8Array(v);
  const queue = new Int32Array(v);
  const found: string[][] = [];

  for (let start = 0; start < v; start++) {
    if (seen[start]) continue;
    seen[start] = 1;
    queue[0] = start;
    let head = 0;
    let tail = 1;
    const members: string[] = [];
    while (head < tail) {
      const node = queue[head++]!;
      members.push(g.ids[node]!);
      const end = g.offsets[node + 1]!;
      for (let i = g.offsets[node]!; i < end; i++) {
        const w = g.targets[i]!;
        if (!seen[w]) {
          seen[w] = 1;
          queue[tail++] = w;
        }
      }
    }
    found.push(members);
  }

  return found.sort((a, b) => b.length - a.length);
}

export function components(facilities: Facility[], edges: GraphEdge[]): string[][] {
  return componentsCsr(buildCsr(facilities, edges));
}

/**
 * Скільки вузлів висить нижче за течією від кожного обʼєкта за графом
 * живлення. Жила в `infra-analytics`, переїхала сюди: це метрика графа, і
 * критичності вона потрібна, щоб порахувати те саме на самих лише
 * спостережених ребрах.
 */
export function downstreamCounts(edges: GraphEdge[]): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.from);
    if (list) list.push(e.to);
    else adj.set(e.from, [e.to]);
  }
  const memo = new Map<string, Set<string>>();
  const reach = (id: string): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const set = new Set<string>();
    memo.set(id, set); // guard проти циклів
    for (const n of adj.get(id) ?? []) {
      if (!set.has(n)) {
        set.add(n);
        for (const m of reach(n)) set.add(m);
      }
    }
    return set;
  };
  const out = new Map<string, number>();
  for (const id of adj.keys()) out.set(id, reach(id).size);
  return out;
}

export interface CriticalitySignal {
  id: string;
  label: string;
  /** Скільки балів додав цей сигнал (до обмеження сотнею). */
  contribution: number;
  /** Чому цей сигнал взагалі існує. */
  reason: string;
  /** Що саме спрацювало — значення, сусід, кількість. */
  evidence: string;
  /**
   * Чи тримається сигнал на самих лише спостережених даних.
   *
   * Структурні сигнали рахуються на графі, де частина ребер виведена за
   * найближчим сусідом. Сигнал, який зникає, щойно прибрати припущення, — це
   * висновок про нашу здогадку, а не про мережу. `false` саме про це й
   * попереджає.
   */
  grounded: boolean;
}

export type CriticalityBand = "low" | "elevated" | "high" | "severe";

export const BAND_LABEL: Record<CriticalityBand, string> = {
  severe: "Критичний",
  high: "Високий",
  elevated: "Підвищений",
  low: "Базовий",
};

/** Порогові значення смуг — задокументовані, а не приховані в коді вигляду. */
export const BAND_THRESHOLD: Record<Exclude<CriticalityBand, "low">, number> = {
  severe: 70,
  high: 45,
  elevated: 20,
};

export interface CriticalityAssessment {
  id: string;
  score: number;
  band: CriticalityBand;
  signals: CriticalitySignal[];
}

function bandFor(score: number): CriticalityBand {
  if (score >= BAND_THRESHOLD.severe) return "severe";
  if (score >= BAND_THRESHOLD.high) return "high";
  if (score >= BAND_THRESHOLD.elevated) return "elevated";
  return "low";
}

/**
 * Вага сектора.
 *
 * До цього вона жила в `analyzeNetwork` як `TIER_WEIGHT[tier] * 38` — число,
 * що входило в оцінку без жодного пояснення. Тут воно те саме за суттю, але з
 * назвою і причиною: аналітик має бачити, що лікарня стоїть високо саме тому,
 * що це сектор життєзабезпечення, а не через якийсь прихований коефіцієнт.
 */
const SECTOR_SIGNAL: Record<Tier, { label: string; contribution: number; reason: string }> = {
  life: {
    label: "Життєзабезпечення",
    contribution: 24,
    reason:
      "Відмова б'є по людях напряму й негайно: лікарні та водоканали не мають запасу часу, на відміну від решти секторів.",
  },
  energy: {
    label: "Опора енергосистеми",
    contribution: 22,
    reason:
      "Генерація і високовольтні підстанції живлять решту секторів, тож їх відмова поширюється далі за власний сектор.",
  },
  comms: {
    label: "Звʼязок",
    contribution: 16,
    reason: "Без звʼязку решта секторів втрачає керованість, навіть лишаючись справною.",
  },
  gov: {
    label: "Держуправління",
    contribution: 16,
    reason: "Вузол ухвалення рішень і координації реагування.",
  },
  mobility: {
    label: "Мобільність",
    contribution: 14,
    reason: "Через ці вузли йде евакуація і підвіз ресурсу; відмова обмежує реагування.",
  },
  industry: {
    label: "Промисловість",
    contribution: 10,
    reason: "Наслідки відмови переважно економічні й розгортаються повільніше.",
  },
};

export interface CriticalityInput {
  facilities: Facility[];
  edges: GraphEdge[];
  /** Скільки споживачів висить під обʼєктом — з `analyzeNetwork`. */
  dependents: Map<string, number>;
  /** Обʼєкти в радіусі активної події. */
  atRisk: Set<string>;
  /** Обʼєкти в зоні повітряної тривоги. */
  underAlarm: Set<string>;
  /** Скільки джерел обходу брати для посередництва; за замовчуванням — за розміром. */
  centralitySources?: number;
}

/**
 * Пояснювана критичність: кожен бал приходить від названого сигналу з
 * причиною і доказом.
 *
 * Це не прикраса. Оцінка, яку не можна розібрати, все одно призводить до дій —
 * і ніхто не може сказати, чи вона знайшла справжню вразливість, чи просто
 * корелює з чимось стороннім. Тому «85» тут завжди розкладається на конкретні
 * рядки, з якими аналітик може не погодитись поіменно.
 */
export function assessCriticality(input: CriticalityInput): Map<string, CriticalityAssessment> {
  const { facilities, edges, dependents, atRisk, underAlarm } = input;

  // Один звід графа на всі три метрики: раніше він будувався двічі.
  const csr = buildCsr(facilities, edges);
  const sourceOpts =
    input.centralitySources === undefined ? {} : { sources: input.centralitySources };
  const central = betweennessCsr(csr, sourceOpts);
  const centrality = new Map(central.entries.map((c) => [c.id, c.score]));
  const bridgeEndpoints = new Set<string>();
  for (const b of bridgesCsr(csr)) {
    bridgeEndpoints.add(b.from);
    bridgeEndpoints.add(b.to);
  }

  /*
   * Та сама структура, порахована на самих лише спостережених ребрах.
   *
   * Граф живлення змішує реальні ЛЕП із кістяком «найближчий сусід». Сигнал
   * «вузол-посередник», що спирається на вигадані ребра, — це висновок про
   * нашу здогадку, а не про мережу, і виглядає він точнісінько так само, як
   * висновок про факт. Тому кожен структурний сигнал перевіряється ще раз без
   * припущень, і різниця стає видимою.
   */
  const observedEdges = edges.filter((e) => isObserved(e.provenance));
  const hasMixedProvenance = observedEdges.length > 0 && observedEdges.length < edges.length;
  const observedCsr = hasMixedProvenance ? buildCsr(facilities, observedEdges) : null;
  const observedCentrality = observedCsr
    ? new Map(betweennessCsr(observedCsr, sourceOpts).entries.map((c) => [c.id, c.score]))
    : null;
  const observedBridgeEndpoints = new Set<string>();
  if (observedCsr) {
    for (const b of bridgesCsr(observedCsr)) {
      observedBridgeEndpoints.add(b.from);
      observedBridgeEndpoints.add(b.to);
    }
  }
  const observedDependents = hasMixedProvenance ? downstreamCounts(observedEdges) : null;

  /**
   * Коли всі ребра спостережені — структура і так стоїть на фактах. Коли
   * жодного немає — вона цілком тримається на припущеннях. Проміжний випадок
   * розвʼязується перерахунком.
   */
  const allObserved = observedEdges.length === edges.length;
  const groundedStructural = (holdsWithoutGuesses: boolean) =>
    allObserved ? true : hasMixedProvenance ? holdsWithoutGuesses : false;

  // Точність посередництва впливає на висновок, тож вона видима в доказі, а не
  // прихована: оцінка за вибіркою і точне число — різні твердження.
  const centralityNote = central.exact
    ? ""
    : ` (оцінка за ${central.sourcesUsed} опорними вузлами з ${facilities.length})`;

  const maxDependents = Math.max(1, ...Array.from(dependents.values()));
  const byId = new Map(facilities.map((f) => [f.id, f]));
  const out = new Map<string, CriticalityAssessment>();

  for (const facility of facilities) {
    const signals: CriticalitySignal[] = [];

    const brokerage = centrality.get(facility.id) ?? 0;
    if (brokerage >= 0.5) {
      signals.push({
        id: "brokerage",
        label: "Вузол-посередник",
        contribution: 30,
        reason:
          "Через нього проходить велика частка найкоротших шляхів мережі. Втрата такого вузла роз'єднує ділянки, навіть якщо прямих споживачів у нього небагато.",
        evidence: `посередництво ${brokerage.toFixed(2)} з 1.00${centralityNote}`,
        grounded: groundedStructural((observedCentrality?.get(facility.id) ?? 0) >= 0.5),
      });
    }

    if (bridgeEndpoints.has(facility.id)) {
      signals.push({
        id: "bridge",
        label: "Єдиний звʼязок",
        contribution: 25,
        reason:
          "Кінець ребра, видалення якого розриває мережу на частини. Це єдина лінія, що тримає ділянку — її варто перевіряти першою.",
        evidence: "входить у міст графа живлення",
        grounded: groundedStructural(observedBridgeEndpoints.has(facility.id)),
      });
    }

    const deps = dependents.get(facility.id) ?? 0;
    if (deps > 0 && deps >= maxDependents * 0.25) {
      signals.push({
        id: "dependents",
        label: "Багато споживачів",
        contribution: 20,
        reason: "Під обʼєктом висить помітна частка мережі живлення.",
        evidence: `${deps} низхідних вузлів (максимум у мережі — ${maxDependents})`,
        grounded: groundedStructural(
          (observedDependents?.get(facility.id) ?? 0) >= maxDependents * 0.25,
        ),
      });
    }

    if (atRisk.has(facility.id)) {
      signals.push({
        id: "event_nearby",
        label: "Подія поруч",
        contribution: 15,
        reason: "У радіусі обʼєкта зафіксована активна подія — пожежа, сейсміка, шторм чи повінь.",
        evidence: "потрапляє в радіус активної події",
        grounded: true,
      });
    }

    if (underAlarm.has(facility.id)) {
      signals.push({
        id: "alarm",
        label: "Зона тривоги",
        contribution: 20,
        reason: "Обʼєкт у регіоні з активною повітряною тривогою.",
        evidence: "у зоні повітряної тривоги",
        grounded: true,
      });
    }

    const category = byId.get(facility.id)?.category;
    if (category) {
      const tier = CATEGORIES[category].tier;
      signals.push({
        id: "sector",
        label: SECTOR_SIGNAL[tier].label,
        contribution: SECTOR_SIGNAL[tier].contribution,
        reason: SECTOR_SIGNAL[tier].reason,
        evidence: CATEGORIES[category].label,
        grounded: true,
      });
    }

    const total = signals.reduce((sum, s) => sum + s.contribution, 0);
    // Обмеження сотнею, щоб довгий хвіст дрібних сигналів не переважив один
    // серйозний. Внески лишаються видимими, тож обмеження нічого не ховає.
    const score = Math.min(100, total);
    out.set(facility.id, { id: facility.id, score, band: bandFor(score), signals });
  }

  return out;
}
