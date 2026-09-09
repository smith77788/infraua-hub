import type { Facility } from "./infra-types";
import type { GraphEdge } from "./infra-types";

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
 */

export interface Adjacency {
  neighbors: Map<string, Set<string>>;
}

function buildAdjacency(facilities: Facility[], edges: GraphEdge[]): Adjacency {
  const neighbors = new Map<string, Set<string>>();
  for (const f of facilities) neighbors.set(f.id, new Set());

  for (const e of edges) {
    // Ребро до вузла поза набором — не звʼязок, який ми можемо показати.
    if (!neighbors.has(e.from) || !neighbors.has(e.to) || e.from === e.to) continue;
    neighbors.get(e.from)!.add(e.to);
    neighbors.get(e.to)!.add(e.from);
  }
  return { neighbors };
}

export interface CentralityEntry {
  id: string;
  /** Нормалізовано до [0,1] відносно максимуму в цьому наборі. */
  score: number;
  raw: number;
}

/** Посередництво за Брандесом, O(V*E). */
export function betweenness(facilities: Facility[], edges: GraphEdge[]): CentralityEntry[] {
  const { neighbors } = buildAdjacency(facilities, edges);
  const ids = facilities.map((f) => f.id);
  const score = new Map<string, number>(ids.map((id) => [id, 0]));

  for (const source of ids) {
    const stack: string[] = [];
    const predecessors = new Map<string, string[]>(ids.map((id) => [id, []]));
    const sigma = new Map<string, number>(ids.map((id) => [id, 0]));
    const distance = new Map<string, number>(ids.map((id) => [id, -1]));

    sigma.set(source, 1);
    distance.set(source, 0);

    const queue: string[] = [source];
    let head = 0;
    while (head < queue.length) {
      const v = queue[head++]!;
      stack.push(v);
      for (const w of neighbors.get(v) ?? []) {
        if (distance.get(w) === -1) {
          distance.set(w, distance.get(v)! + 1);
          queue.push(w);
        }
        // Накопичуємо лише вздовж найкоротших шляхів.
        if (distance.get(w) === distance.get(v)! + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          predecessors.get(w)!.push(v);
        }
      }
    }

    const delta = new Map<string, number>(ids.map((id) => [id, 0]));
    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of predecessors.get(w)!) {
        delta.set(v, delta.get(v)! + (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!));
      }
      if (w !== source) score.set(w, score.get(w)! + delta.get(w)!);
    }
  }

  // На неорієнтованому графі кожна невпорядкована пара рахується двічі.
  const raw = ids.map((id) => ({ id, raw: score.get(id)! / 2 }));
  const max = Math.max(0, ...raw.map((r) => r.raw));
  return raw
    .map((r) => ({ ...r, score: max > 0 ? r.raw / max : 0 }))
    .sort((a, b) => b.raw - a.raw || a.id.localeCompare(b.id));
}

export interface Bridge {
  from: string;
  to: string;
}

/**
 * Мости — ребра, видалення яких збільшує кількість компонент звʼязності.
 * Ітеративний DFS: рекурсивний переповнив би стек на мережі звичайного розміру.
 */
export function bridges(facilities: Facility[], edges: GraphEdge[]): Bridge[] {
  const { neighbors } = buildAdjacency(facilities, edges);
  const discovery = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const found: Bridge[] = [];
  let timer = 0;

  for (const start of facilities.map((f) => f.id)) {
    if (discovery.has(start)) continue;
    parent.set(start, null);
    discovery.set(start, timer);
    low.set(start, timer);
    timer++;

    const stack: { node: string; iterator: Iterator<string> }[] = [
      { node: start, iterator: (neighbors.get(start) ?? new Set<string>()).values() },
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = frame.iterator.next();

      if (next.done) {
        stack.pop();
        const p = parent.get(frame.node);
        if (p != null) {
          low.set(p, Math.min(low.get(p)!, low.get(frame.node)!));
          if (low.get(frame.node)! > discovery.get(p)!) {
            found.push({ from: p, to: frame.node });
          }
        }
        continue;
      }

      const child = next.value;
      if (child === parent.get(frame.node)) continue;
      if (discovery.has(child)) {
        low.set(frame.node, Math.min(low.get(frame.node)!, discovery.get(child)!));
        continue;
      }

      parent.set(child, frame.node);
      discovery.set(child, timer);
      low.set(child, timer);
      timer++;
      stack.push({ node: child, iterator: (neighbors.get(child) ?? new Set<string>()).values() });
    }
  }

  return found;
}

/** Компоненти звʼязності, найбільша перша. */
export function components(facilities: Facility[], edges: GraphEdge[]): string[][] {
  const { neighbors } = buildAdjacency(facilities, edges);
  const seen = new Set<string>();
  const found: string[][] = [];

  for (const f of facilities) {
    if (seen.has(f.id)) continue;
    const members: string[] = [];
    const queue = [f.id];
    seen.add(f.id);
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++]!;
      members.push(current);
      for (const next of neighbors.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    found.push(members);
  }

  return found.sort((a, b) => b.length - a.length);
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
}

export type CriticalityBand = "low" | "elevated" | "high" | "severe";

export interface CriticalityAssessment {
  id: string;
  score: number;
  band: CriticalityBand;
  signals: CriticalitySignal[];
}

function bandFor(score: number): CriticalityBand {
  if (score >= 70) return "severe";
  if (score >= 45) return "high";
  if (score >= 20) return "elevated";
  return "low";
}

export interface CriticalityInput {
  facilities: Facility[];
  edges: GraphEdge[];
  /** Скільки споживачів висить під обʼєктом — з `analyzeNetwork`. */
  dependents: Map<string, number>;
  /** Обʼєкти в радіусі активної події. */
  atRisk: Set<string>;
  /** Обʼєкти в зоні повітряної тривоги. */
  underAlarm: Set<string>;
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

  const centrality = new Map(betweenness(facilities, edges).map((c) => [c.id, c.score]));
  const bridgeEndpoints = new Set<string>();
  for (const b of bridges(facilities, edges)) {
    bridgeEndpoints.add(b.from);
    bridgeEndpoints.add(b.to);
  }

  const maxDependents = Math.max(1, ...Array.from(dependents.values()));
  const byId = new Map(facilities.map((f) => [f.id, f]));
  const out = new Map<string, CriticalityAssessment>();

  for (const facility of facilities) {
    const signals: CriticalitySignal[] = [];

    const central = centrality.get(facility.id) ?? 0;
    if (central >= 0.5) {
      signals.push({
        id: "brokerage",
        label: "Вузол-посередник",
        contribution: 30,
        reason:
          "Через нього проходить велика частка найкоротших шляхів мережі. Втрата такого вузла роз'єднує ділянки, навіть якщо прямих споживачів у нього небагато.",
        evidence: `посередництво ${central.toFixed(2)} з 1.00`,
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
      });
    }

    if (atRisk.has(facility.id)) {
      signals.push({
        id: "event_nearby",
        label: "Подія поруч",
        contribution: 15,
        reason: "У радіусі обʼєкта зафіксована активна подія — пожежа, сейсміка, шторм чи повінь.",
        evidence: "потрапляє в радіус активної події",
      });
    }

    if (underAlarm.has(facility.id)) {
      signals.push({
        id: "alarm",
        label: "Зона тривоги",
        contribution: 20,
        reason: "Обʼєкт у регіоні з активною повітряною тривогою.",
        evidence: "у зоні повітряної тривоги",
      });
    }

    const tier = byId.get(facility.id)?.category;
    if (tier === "power_plant" || tier === "substation") {
      signals.push({
        id: "energy_backbone",
        label: "Опора енергосистеми",
        contribution: 10,
        reason: "Генерація і високовольтні підстанції живлять решту секторів, тож їх відмова поширюється далі за власний сектор.",
        evidence: tier === "power_plant" ? "електростанція" : "підстанція 110кВ+",
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
