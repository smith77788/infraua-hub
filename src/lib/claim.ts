/**
 * Твердження, яке не може існувати без свого походження.
 *
 * ## Що це виправляє
 *
 * У системі вже чотири різні способи сказати «наскільки цьому вірити»:
 * `provenance` (спостережено/виведено плюс 0..1), код Адміралтейства
 * (`source-credibility`), сигнали з прапорцем `grounded`
 * (`infra-criticality`) і рівні `critical/high/medium`
 * (`threat-correlation`). Кожен сам по собі продуманий. Разом вони не
 * складаються: аналітик бачить на одному екрані «0.35», «C3», «grounded:
 * false» і «high» — і не може ні порівняти їх, ні перенести висновок з
 * одного на інший.
 *
 * Гірше інше. Дисципліна походження трималася на домовленості, а не на типах,
 * — і домовленість уже зламалася: пʼять модулів, що виводять висновки, були
 * написані без неї. Не через недбалість, а тому що ніщо цього не вимагало.
 *
 * ## Чим це відрізняється від онтології Palantir
 *
 * Онтологія стежить за **типами** обʼєктів і звʼязків: цей вузол — Asset, це
 * ребро — SUPPLIES_POWER. Вона не стежить за тим, звідки взялося саме це
 * значення і наскільки йому можна вірити, — це лишається на совісті того, хто
 * пише код.
 *
 * Тут навпаки: похідне значення **неможливо створити, не назвавши його
 * походження**, бо конструктора без походження не існує. Не угода, якої
 * дотримуються, а форма, поза якою значення не збирається.
 *
 * ## Як складається впевненість
 *
 * За найслабшою ланкою, а не множенням. Це свідомий вибір, і він не
 * ймовірнісний: значення 0.35 у «найближчий сусід» — не ймовірність події, а
 * відверта оцінка методу, і перемножувати такі числа означало б удавати
 * обчислення, якого ми не робимо. Ланцюг висновків не буває надійнішим за
 * найслабший крок — це твердження, яке можна захищати; добуток — ні.
 */

export type LineageKind = "observed" | "inferred" | "combined";

export interface ObservedLineage {
  kind: "observed";
  /** Хто це стверджує. */
  source: string;
  /** Ідентифікатор у джерелі, щоб твердження можна було відкрити й перевірити. */
  ref?: string | undefined;
  retrievedAt?: string | undefined;
}

export interface InferredLineage {
  kind: "inferred";
  /** Назва методу — щоб можна було сказати, *як саме* це виведено. */
  method: string;
  params?: Record<string, string | number> | undefined;
  /** У чому межа цього методу. */
  caveat?: string | undefined;
}

export interface CombinedLineage {
  kind: "combined";
  method: string;
  /** Походження всіх входів — ланцюг не обривається на кроці. */
  from: Lineage[];
  caveat?: string | undefined;
}

export type Lineage = ObservedLineage | InferredLineage | CombinedLineage;

export interface Claim<T> {
  value: T;
  lineage: Lineage;
  /** 0..1 — порівнянна по всій системі оцінка довіри. */
  confidence: number;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Спостережене: зафіксоване в джерелі, не виведене нами.
 *
 * Впевненість за замовчуванням 1 — це й означає «спостережено». Але вона
 * задається, бо джерело буває ненадійним, і тоді чесніше сказати це числом,
 * ніж вдавати, що факт є факт.
 */
export function observed<T>(
  value: T,
  source: string,
  options: { ref?: string; retrievedAt?: string; confidence?: number } = {},
): Claim<T> {
  return {
    value,
    lineage: {
      kind: "observed",
      source,
      ref: options.ref,
      retrievedAt: options.retrievedAt,
    },
    confidence: clamp(options.confidence ?? 1),
  };
}

/** Виведене: результат нашого методу, з його назвою і межею. */
export function inferred<T>(
  value: T,
  method: string,
  confidence: number,
  options: { params?: Record<string, string | number>; caveat?: string } = {},
): Claim<T> {
  return {
    value,
    lineage: { kind: "inferred", method, params: options.params, caveat: options.caveat },
    confidence: clamp(confidence),
  };
}

/**
 * Похідне від інших тверджень.
 *
 * Впевненість — мінімум по входах, і її не можна підняти вручну: висновок не
 * буває надійнішим за те, з чого він зроблений. Знизити можна — сам метод
 * теж може бути слабким.
 */
export function combine<T>(
  inputs: readonly Claim<unknown>[],
  method: string,
  value: T,
  options: { caveat?: string; methodConfidence?: number } = {},
): Claim<T> {
  const weakest = inputs.length === 0 ? 1 : Math.min(...inputs.map((c) => c.confidence));
  const own = options.methodConfidence === undefined ? 1 : clamp(options.methodConfidence);
  return {
    value,
    lineage: {
      kind: "combined",
      method,
      from: inputs.map((c) => c.lineage),
      caveat: options.caveat,
    },
    confidence: Math.min(weakest, own),
  };
}

/** Чи стоїть твердження **цілком** на спостереженнях. */
export function isFullyObserved(lineage: Lineage): boolean {
  if (lineage.kind === "observed") return true;
  if (lineage.kind === "inferred") return false;
  return lineage.from.every(isFullyObserved);
}

/** Усі джерела, на які спирається твердження, без повторів. */
export function sourcesOf(lineage: Lineage): string[] {
  const out = new Set<string>();
  const walk = (l: Lineage) => {
    if (l.kind === "observed") out.add(l.source);
    else if (l.kind === "combined") l.from.forEach(walk);
  };
  walk(lineage);
  return [...out];
}

/** Методи, застосовані по дорозі, від зовнішнього до внутрішніх. */
export function methodsOf(lineage: Lineage): string[] {
  const out: string[] = [];
  const walk = (l: Lineage) => {
    if (l.kind === "inferred") out.push(l.method);
    else if (l.kind === "combined") {
      out.push(l.method);
      l.from.forEach(walk);
    }
  };
  walk(lineage);
  return out;
}

/**
 * Пояснення для людини: одне речення, яке можна прочитати вголос.
 *
 * Не дамп структури: аналітик має отримати відповідь на питання «звідки ти це
 * взяв», а не дерево, яке треба розбирати самому.
 */
export function explain(lineage: Lineage): string {
  switch (lineage.kind) {
    case "observed":
      return `зафіксовано в ${lineage.source}${lineage.ref ? ` (${lineage.ref})` : ""}`;
    case "inferred": {
      const params = lineage.params
        ? Object.entries(lineage.params)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")
        : "";
      return `виведено методом «${lineage.method}»${params ? ` (${params})` : ""}`;
    }
    case "combined": {
      const parts = lineage.from.map(explain);
      // Довгий ланцюг згортається: пояснення, яке не дочитують, не пояснює.
      const shown = parts.slice(0, 3).join("; ");
      const rest = parts.length > 3 ? ` та ще ${parts.length - 3}` : "";
      return `«${lineage.method}» на основі: ${shown}${rest}`;
    }
  }
}

/**
 * Код Адміралтейства в порівнянну шкалу.
 *
 * Шкала НАТО двовісна навмисно, і зводити її в одне число — втрата. Тому це
 * **не заміна** коду, а міст: код лишається на екрані як був, а число дає
 * можливість порівняти повідомлення OSINT із ребром графа, побудованим за
 * найближчим сусідом. Без такого мосту ці дві речі просто не порівнюються.
 *
 * Значення обрані так, щоб порядок відповідав шкалі, і навмисно не претендують
 * на ймовірнісний зміст.
 */
const RELIABILITY_WEIGHT: Record<string, number> = {
  A: 1,
  B: 0.85,
  C: 0.6,
  D: 0.4,
  E: 0.2,
  F: 0.3,
};
const CREDIBILITY_WEIGHT: Record<number, number> = {
  1: 1,
  2: 0.85,
  3: 0.6,
  4: 0.4,
  5: 0.25,
  6: 0.3,
};

export function fromAdmiralty(reliability: string, credibility: number): number {
  const r = RELIABILITY_WEIGHT[reliability.toUpperCase()];
  const c = CREDIBILITY_WEIGHT[credibility];
  // Невідомий код — не привід вигадати число: F і 6 обидва означають «оцінити
  // неможливо», і саме це повертається.
  if (r === undefined || c === undefined) return 0.3;
  return clamp(Math.min(r, c));
}
