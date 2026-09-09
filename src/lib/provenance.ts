/**
 * Походження знання.
 *
 * Проблема, яку це вирішує, ширша за граф. Система показує поруч дві речі
 * різної природи: те, що справді зафіксовано в джерелі, і те, що вона сама
 * вивела з припущення. Якщо вони виглядають однаково, аналітик не може
 * відрізнити факт від здогадки — і діє на здогадці так само впевнено.
 *
 * Конкретний випадок, з якого це виросло: граф залежностей будувався за
 * найближчим сусідом (підстанція ← найближча електростанція в радіусі 250 км).
 * Це розумна евристика, але вона не є топологією мережі. Всі висновки
 * «що вимкнеться, якщо цей вузол впаде» стояли на вигаданих ребрах, поданих
 * як факт.
 *
 * Тому кожне ребро тепер несе своє походження, а не лише значення. Це
 * платформенний примітив: будь-яке похідне знання в системі має бути
 * позначене як похідне, з методом, параметрами і тим, наскільки йому можна
 * вірити.
 */

/** Спостережено: зафіксовано в зовнішньому джерелі, не виведено нами. */
export interface ObservedProvenance {
  kind: "observed";
  /** Яке джерело це стверджує. */
  source: string;
  /** Ідентифікатор у джерелі, щоб твердження можна було перевірити вручну. */
  ref?: string;
  /** Коли отримано — дані про інфраструктуру застарівають. */
  retrievedAt: string;
  /** Додаткові факти з джерела (напруга, оператор тощо). */
  attributes?: Record<string, string | number>;
}

/** Виведено: результат нашого власного припущення. */
export interface InferredProvenance {
  kind: "inferred";
  /** Назва методу — щоб можна було сказати, *як саме* це виведено. */
  method: string;
  /** Параметри методу: інший радіус дав би інший граф. */
  params: Record<string, string | number>;
  /**
   * 0..1 — наскільки методу можна вірити. Це не ймовірність, а відверта
   * оцінка: «найближчий сусід у радіусі 120 км» — слабке припущення, і
   * значення має це показувати.
   */
  confidence: number;
  /** Чому цей метод взагалі застосовано і в чому його межа. */
  caveat: string;
}

export type Provenance = ObservedProvenance | InferredProvenance;

export function isObserved(p: Provenance): p is ObservedProvenance {
  return p.kind === "observed";
}

/** Спостережене вважається достовірним; виведене — за своєю оцінкою. */
export function confidenceOf(p: Provenance): number {
  return p.kind === "observed" ? 1 : p.confidence;
}

/** Короткий підпис для інтерфейсу. */
export function provenanceLabel(p: Provenance): string {
  return p.kind === "observed" ? `Джерело: ${p.source}` : `Припущення: ${p.method}`;
}

/**
 * Повне пояснення — те, що аналітик має побачити, перш ніж діяти на цьому
 * твердженні.
 */
export function provenanceDetail(p: Provenance): string {
  if (p.kind === "observed") {
    const attrs = p.attributes
      ? Object.entries(p.attributes)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      : "";
    const ref = p.ref ? ` (${p.ref})` : "";
    return `Зафіксовано в ${p.source}${ref}, отримано ${p.retrievedAt}${attrs ? `. ${attrs}` : ""}.`;
  }
  const params = Object.entries(p.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return `Виведено методом «${p.method}» (${params}), впевненість ${Math.round(
    p.confidence * 100,
  )}%. ${p.caveat}`;
}

/**
 * Зведення по набору тверджень: скільки з них спостережені, а скільки
 * система придумала сама. Показувати це поруч із будь-яким висновком —
 * дешевий спосіб не дати сплутати одне з іншим.
 */
export interface ProvenanceSummary {
  total: number;
  observed: number;
  inferred: number;
  /** Частка спостережених, 0..1. */
  observedShare: number;
  /** Середня впевненість по всьому набору. */
  meanConfidence: number;
}

export function summarize(items: { provenance: Provenance }[]): ProvenanceSummary {
  const total = items.length;
  if (total === 0) {
    return { total: 0, observed: 0, inferred: 0, observedShare: 0, meanConfidence: 0 };
  }
  let observed = 0;
  let confidenceSum = 0;
  for (const item of items) {
    if (isObserved(item.provenance)) observed++;
    confidenceSum += confidenceOf(item.provenance);
  }
  return {
    total,
    observed,
    inferred: total - observed,
    observedShare: observed / total,
    meanConfidence: confidenceSum / total,
  };
}
