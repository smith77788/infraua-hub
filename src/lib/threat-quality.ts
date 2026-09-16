/**
 * Що джерело саме каже про власну точність — і чому це не можна викидати.
 *
 * `neptun.in.ua` віддає разом із позначкою чотири речі, яких консоль досі не
 * брала:
 *
 *   • `uncertaintyKm` — радіус невизначеності позиції, від 4 до 45 км;
 *   • `positionQuality` — `confirmed` чи `approx`;
 *   • `presumptiveCourse` — курс ПРИПУЩЕНИЙ, а не спостережений;
 *   • `lifecycle` — `uncertain` / `tracking` / `confirmed`.
 *
 * Це найважливіше з усього, що джерело передає, і саме це губилося. Заміри з
 * живої відповіді: з пʼятнадцяти цілей сім мали приблизну позицію, у трьох
 * радіус був 10 км, в однієї 45 км, а курс був припущений у восьми з
 * пʼятнадцяти — тобто **більш ніж у половини цілей стрілка на карті була
 * здогадкою**, намальованою так само впевнено, як спостережений трек.
 *
 * Наслідок не косметичний. Позначка ±45 км, показана крапкою, каже людині, що
 * ціль саме там. Коридор підльоту й час, пораховані з припущеного курсу,
 * виглядають як вимір. Людина, яка один раз повірила такому «за сім хвилин» і
 * побачила, що нічого не сталося, наступного разу не повірить і справжньому —
 * і це ціна, яку платять не ми.
 *
 * Правило проєкту тут просте й давнє: оцінене не видають за заміряне. Модуль
 * чистий і тестований — у ньому немає мережі, лише перетворення того, що
 * джерело сказало, на те, що можна показати.
 */

/** Наскільки точно джерело знає, ДЕ ціль. */
export type PositionQuality = "confirmed" | "approx";

/** Стадія ведення цілі. */
export type Lifecycle = "uncertain" | "tracking" | "confirmed";

export interface ThreatQuality {
  /** Радіус невизначеності позиції, км. `null` — джерело не сказало. */
  uncertaintyKm: number | null;
  position: PositionQuality | null;
  lifecycle: Lifecycle | null;
  /** true — курс припущений, а не спостережений. */
  presumptiveCourse: boolean;
  /** Заміряна швидкість, км/год, якщо джерело її дало. */
  speedKmh: number | null;
}

export const EMPTY_QUALITY: ThreatQuality = {
  uncertaintyKm: null,
  position: null,
  lifecycle: null,
  presumptiveCourse: false,
  speedKmh: null,
};

/**
 * Радіус, який малюємо, коли джерело мовчить.
 *
 * Мовчання — не «точно тут». Позначка без заявленої невизначеності приходить
 * від каналів, які називають населений пункт, а не координату, тож розкид
 * порядку розміру району — чесніша типова оцінка, ніж нуль. Значення свідомо
 * консервативне й позначається в інтерфейсі як припущення, а не як заміряне.
 */
export const ASSUMED_UNCERTAINTY_KM = 15;

/**
 * Радіус для показу: заявлений джерелом або консервативне припущення.
 *
 * Функція ТОТАЛЬНА — визначена для будь-якого входу, і це не педантизм.
 * `readQuality` чистить дані джерела, але тип каже лише `number | null`, а NaN
 * у TypeScript — цілком законне число. Радіус у NaN не падає й не помітний: він
 * тихо робить NaN усю вилку часу підльоту, а кожне порівняння з NaN хибне, тож
 * рішення «будити» просто перестає спрацьовувати. Знайдено фазингом
 * (`radar-fuzz.test.ts`), і ціна мовчазного відмовляння тут така сама, як у
 * ненадісланого сповіщення.
 */
export function displayRadiusKm(q: ThreatQuality): number {
  const km = q.uncertaintyKm;
  return typeof km === "number" && Number.isFinite(km) && km > 0 ? km : ASSUMED_UNCERTAINTY_KM;
}

/** Чи радіус — заміряний джерелом, чи наш запасний варіант. */
export function radiusIsStated(q: ThreatQuality): boolean {
  const km = q.uncertaintyKm;
  return typeof km === "number" && Number.isFinite(km) && km > 0;
}

function parsePosition(raw: unknown): PositionQuality | null {
  return raw === "confirmed" || raw === "approx" ? raw : null;
}

function parseLifecycle(raw: unknown): Lifecycle | null {
  return raw === "uncertain" || raw === "tracking" || raw === "confirmed" ? raw : null;
}

/**
 * Витягти якість із сирої відповіді джерела.
 *
 * Все, чого немає або що прийшло не в тому вигляді, стає `null`, а не
 * значенням за замовчуванням: «джерело не сказало» і «джерело сказало
 * `confirmed`» — різні твердження, і плутати їх тут означало б вигадувати
 * впевненість за джерело.
 */
export function readQuality(raw: {
  uncertaintyKm?: unknown;
  positionQuality?: unknown;
  lifecycle?: unknown;
  presumptiveCourse?: unknown;
  velocity?: unknown;
}): ThreatQuality {
  const km = raw.uncertaintyKm;
  const vel = raw.velocity as { speedKmh?: unknown } | undefined;
  const speed = vel && typeof vel === "object" ? vel.speedKmh : undefined;
  return {
    uncertaintyKm: typeof km === "number" && Number.isFinite(km) && km > 0 ? km : null,
    position: parsePosition(raw.positionQuality),
    lifecycle: parseLifecycle(raw.lifecycle),
    presumptiveCourse: raw.presumptiveCourse === true,
    speedKmh: typeof speed === "number" && Number.isFinite(speed) && speed > 0 ? speed : null,
  };
}

/**
 * Чи можна рахувати з цієї позначки коридор підльоту й час.
 *
 * Проєкція курсу на обʼєкт має сенс лише тоді, коли курс спостережений. З
 * припущеного курсу виходить стрілка, намальована по тому, куди ціль «мала б»
 * летіти, і побудований на ній коридор — це здогадка, підписана як розрахунок.
 */
export function courseIsObserved(q: ThreatQuality): boolean {
  return !q.presumptiveCourse;
}

/** Людський підпис стадії — рівно те, що сказало джерело. */
export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  uncertain: "не підтверджена",
  tracking: "ведеться",
  confirmed: "підтверджена",
};

export const POSITION_LABEL: Record<PositionQuality, string> = {
  confirmed: "позиція підтверджена",
  approx: "позиція приблизна",
};

/**
 * Один рядок про те, наскільки цій позначці можна вірити.
 *
 * Збирається з того, що сказало джерело, і мовчить про те, чого воно не
 * казало. Порожній рядок означає, що джерело не сказало нічого — і тоді краще
 * не писати нічого, ніж писати «дані відсутні»: людині, піднятій уночі, це не
 * допомагає ні прийняти рішення, ні відкласти його.
 */
export function qualityLine(q: ThreatQuality): string {
  const parts: string[] = [];
  if (q.lifecycle) parts.push(LIFECYCLE_LABEL[q.lifecycle]);
  if (q.uncertaintyKm !== null) parts.push(`±${Math.round(q.uncertaintyKm)} км`);
  else if (q.position) parts.push(POSITION_LABEL[q.position]);
  if (q.presumptiveCourse) parts.push("курс припущений");
  return parts.join(" · ");
}
