/**
 * Оцінка руху цілі за спостереженими фіксами — з чесною мірою невпевненості.
 *
 * ## Що тут не так було
 *
 * Уся система відповідала на головне питання («чи летить на мене») однією
 * прямою: береться поле `heading` від джерела, береться табличка типових
 * швидкостей — і ціль ведеться по лінійці. Саме тому ETA доводилось різати на
 * годині: далі пряма перестає бути схожою на правду.
 *
 * Але пряма була неправдою не лише на годині. Вона була нею завжди, просто на
 * п'ятій хвилині помилка ще не встигала вирости. Проблема не в горизонті — у
 * тому, що оцінка не мала ПОХИБКИ. «~22 хв» і «22 хв» виглядають однаково, хоч
 * перше могло означати «від 14 до 35».
 *
 * ## Що тут робиться
 *
 * Курс і швидкість більше не беруться на віру: вони ВИВОДЯТЬСЯ з послідовних
 * фіксів тієї самої цілі, а розкид між цими фіксами й дає похибку. Тобто
 * невпевненість не налаштована константою — вона заміряна на самих даних.
 *
 * Далі ціль ведеться не лінією, а розподілом: уздовж курсу невизначеність
 * росте від похибки швидкості, впоперек — від похибки курсу й від того, що
 * ціль маневрує. Виходить еліпс, який чесно розширюється з горизонтом.
 *
 * ## Де межа
 *
 * Далі цієї межі без НОВИХ ДАНИХ не пройти. Ми маємо позиції, які хтось
 * побачив і встиг повідомити, з точністю до населеного пункту й частотою в
 * хвилини. Кращу оцінку дає не кращий алгоритм, а радар або ADS-B — тобто
 * інший клас джерела. Усе, що можна вичавити з наявних спостережень, вичавлено
 * тут; далі починається вигадування.
 */

import { distanceKm } from "./infra-types";
import { bearingDeg, SPEED_KMH } from "./threat-eta";
import type { ThreatType } from "./air";

export interface Fix {
  lat: number;
  lon: number;
  /** Мітка часу спостереження, мс епохи. */
  ts: number;
}

export interface MotionState {
  /** Остання відома позиція. */
  lat: number;
  lon: number;
  at: number;
  /** Оцінена шляхова швидкість, км/год. */
  speedKmh: number;
  /** Оцінений курс, градуси (0 = Пн). */
  headingDeg: number;
  /** Похибка швидкості (стандартне відхилення), км/год. */
  speedSigma: number;
  /** Похибка курсу (стандартне відхилення), градуси. */
  headingSigma: number;
  /** Кутова швидкість розвороту, градусів за хвилину (знак = бік). */
  turnRateDegMin: number;
  /** Скільки відрізків між фіксами лягло в оцінку. */
  segments: number;
  /**
   * Звідки взявся курс.
   *
   * `observed` — виведено з руху між фіксами; `reported` — узято з поля
   * джерела, бо руху ще не видно; `none` — курсу немає взагалі, і проєкція
   * неможлива. Цю різницю не можна ховати: перша оцінка спирається на
   * спостереження, друга — на чуже твердження, третя не спирається ні на що.
   */
  origin: "observed" | "reported" | "none";
}

/** Скільки часу фікс лишається вартим уваги при оцінці руху. */
export const FIX_WINDOW_MS = 25 * 60 * 1000;
/** Менший зсув вважаємо шумом позиції, а не рухом. */
const MIN_SEGMENT_KM = 1.5;
/** Коротший відрізок часу дає ділення на майже нуль — швидкість вибухає. */
const MIN_SEGMENT_MS = 20_000;

/**
 * Фізична стеля швидкості за типом — удвічі від крейсерської.
 *
 * Потрібна не для точності, а для відсіювання: два звіти про «ту саму» ціль із
 * різних кінців області дають відрізок на 900 км/год для шахеда. Це не
 * прискорення, це помилка ототожнення, і вона отруює оцінку сильніше, ніж будь-
 * який шум.
 */
function maxPlausibleKmh(type: ThreatType | undefined): number {
  return (SPEED_KMH[type ?? "unknown"] ?? SPEED_KMH.unknown) * 2;
}

interface Segment {
  speedKmh: number;
  headingDeg: number;
  midTs: number;
  dtMs: number;
}

/**
 * Найменша різниця кутів зі знаком, у проміжку (−180; 180].
 *
 * Розворот рівно на 180° віддається як +180, а не −180: обидва числа
 * позначають той самий кут, але відʼємне читається як «ліворуч», хоч бік тут
 * не визначений.
 */
export function angleDelta(from: number, to: number): number {
  const d = (((to - from) % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

/**
 * Циркулярне середнє курсів із вагами.
 *
 * Звичайне арифметичне тут не працює: середнє між 350° і 10° дорівнює 180°,
 * тобто рівно протилежному напрямку. Помилка, яка на картинці виглядає як
 * ціль, що летить назад.
 */
function weightedMeanHeading(values: readonly { headingDeg: number; w: number }[]): {
  mean: number;
  sigma: number;
} {
  let sx = 0;
  let sy = 0;
  let wsum = 0;
  for (const { headingDeg, w } of values) {
    const rad = (headingDeg * Math.PI) / 180;
    sx += Math.sin(rad) * w;
    sy += Math.cos(rad) * w;
    wsum += w;
  }
  if (wsum === 0) return { mean: 0, sigma: 180 };
  const mean = ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360;
  // Довжина результанта R: 1 — курси збігаються, 0 — розкидані рівномірно.
  // Кругове стандартне відхилення √(−2 ln R) — стандартна міра для кутів.
  const R = Math.min(1, Math.hypot(sx, sy) / wsum);
  const sigma = R <= 1e-6 ? 180 : Math.min(180, (Math.sqrt(-2 * Math.log(R)) * 180) / Math.PI);
  return { mean, sigma };
}

/**
 * Оцінює рух цілі з її фіксів.
 *
 * Свіжіші відрізки важать більше: ціль, що розвернулась хвилину тому, важливіша
 * за те, як вона летіла двадцять хвилин тому. Вага спадає вдвічі кожні пʼять
 * хвилин — не тому, що це «правильне» число, а тому, що воно приблизно
 * відповідає тому, як часто джерело оновлює позицію.
 */
export function estimateMotion(
  fixes: readonly Fix[],
  now: number,
  opts: { type?: ThreatType; reportedHeading?: number | undefined } = {},
): MotionState | null {
  const recent = fixes
    .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon))
    .filter((f) => now - f.ts <= FIX_WINDOW_MS)
    .sort((a, b) => a.ts - b.ts);
  const last = recent[recent.length - 1];
  if (!last) return null;

  const cap = maxPlausibleKmh(opts.type);
  const segments: Segment[] = [];
  for (let i = 1; i < recent.length; i++) {
    const a = recent[i - 1]!;
    const b = recent[i]!;
    const dtMs = b.ts - a.ts;
    if (dtMs < MIN_SEGMENT_MS) continue;
    const d = distanceKm(a, b);
    if (d < MIN_SEGMENT_KM) continue; // стояла на місці — напрямку тут немає
    const speedKmh = d / (dtMs / 3_600_000);
    if (speedKmh > cap) continue; // стрибок: майже напевно не та сама ціль
    segments.push({ speedKmh, headingDeg: bearingDeg(a, b), midTs: (a.ts + b.ts) / 2, dtMs });
  }

  const fallbackSpeed = SPEED_KMH[opts.type ?? "unknown"] ?? SPEED_KMH.unknown;

  if (segments.length === 0) {
    // Руху ще не видно. Лишається те, що сказало джерело — і це чесно
    // позначається: оцінка спирається на чуже твердження, не на спостереження.
    const reported = opts.reportedHeading;
    if (typeof reported !== "number" || !Number.isFinite(reported)) {
      return {
        lat: last.lat,
        lon: last.lon,
        at: last.ts,
        speedKmh: fallbackSpeed,
        headingDeg: 0,
        speedSigma: fallbackSpeed * 0.5,
        headingSigma: 180,
        turnRateDegMin: 0,
        segments: 0,
        origin: "none",
      };
    }
    return {
      lat: last.lat,
      lon: last.lon,
      at: last.ts,
      speedKmh: fallbackSpeed,
      headingDeg: ((reported % 360) + 360) % 360,
      // Швидкість узята з таблички типів, курс — з чужого поля. Похибки
      // великі й названі великими, а не сховані за виглядом точного числа.
      speedSigma: fallbackSpeed * 0.35,
      headingSigma: 25,
      turnRateDegMin: 0,
      segments: 0,
      origin: "reported",
    };
  }

  const halfLifeMs = 5 * 60 * 1000;
  const weighted = segments.map((s) => ({
    ...s,
    w: Math.pow(0.5, (now - s.midTs) / halfLifeMs),
  }));
  const wsum = weighted.reduce((n, s) => n + s.w, 0) || 1;

  const speedKmh = weighted.reduce((n, s) => n + s.speedKmh * s.w, 0) / wsum;
  const speedVar = weighted.reduce((n, s) => n + s.w * (s.speedKmh - speedKmh) ** 2, 0) / wsum;
  const { mean: headingDeg, sigma: headingScatter } = weightedMeanHeading(weighted);

  // Розворот: як швидко міняється курс між сусідніми відрізками. Це не окрема
  // модель, а спостережена величина — і саме вона каже, наскільки далеко
  // можна вести ціль прямою.
  let turnRateDegMin = 0;
  if (weighted.length >= 2) {
    let sum = 0;
    let n = 0;
    for (let i = 1; i < weighted.length; i++) {
      const a = weighted[i - 1]!;
      const b = weighted[i]!;
      const dtMin = (b.midTs - a.midTs) / 60_000;
      if (dtMin <= 0.5) continue;
      sum += angleDelta(a.headingDeg, b.headingDeg) / dtMin;
      n += 1;
    }
    if (n > 0) turnRateDegMin = sum / n;
  }

  // Одного відрізка замало, щоб побачити розкид: беремо консервативну оцінку
  // замість нуля. Нульова похибка при одному вимірі — це не впевненість, це
  // відсутність перевірки.
  const oneSegment = weighted.length < 2;
  return {
    lat: last.lat,
    lon: last.lon,
    at: last.ts,
    speedKmh,
    headingDeg,
    speedSigma: oneSegment ? speedKmh * 0.3 : Math.max(Math.sqrt(speedVar), speedKmh * 0.08),
    headingSigma: oneSegment ? 20 : Math.max(headingScatter, 4),
    turnRateDegMin,
    segments: weighted.length,
    origin: "observed",
  };
}

export interface Projection {
  /** Найімовірніша позиція через `minutes`. */
  lat: number;
  lon: number;
  minutes: number;
  /** Невизначеність уздовж курсу, км (1σ). */
  alongSigmaKm: number;
  /** Невизначеність упоперек курсу, км (1σ). */
  crossSigmaKm: number;
  /** Пройдена відстань за цей час, км. */
  distanceKm: number;
}

const EARTH_KM = 6371;

function movePoint(lat: number, lon: number, headingDeg: number, km: number) {
  const d = km / EARTH_KM;
  const t = (headingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 =
    l1 +
    Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: (p2 * 180) / Math.PI, lon: (((l2 * 180) / Math.PI + 540) % 360) - 180 };
}

/**
 * Веде ціль уперед і каже, наскільки цьому можна вірити.
 *
 * Уздовж курсу невизначеність росте прямо з похибки швидкості. Упоперек —
 * з похибки курсу (чим далі, тим ширше віяло) і з того, що ціль маневрує:
 * спостережений розворот, продовжений на горизонт, дає додаткове зміщення, і
 * ми зараховуємо його саме в невизначеність, а не в середню траєкторію. Бо
 * розворот, який тривав хвилину, міг скінчитись одразу після останнього фікса.
 */
export function projectMotion(state: MotionState, minutes: number): Projection {
  const hours = minutes / 60;
  const distance = state.speedKmh * hours;
  // Середню траєкторію ведемо по прямій від ОСТАННЬОГО курсу. Продовжувати
  // розворот означало б стверджувати, що ціль і далі крутить із тією самою
  // кутовою швидкістю, — а цього ми не знаємо.
  const point = movePoint(state.lat, state.lon, state.headingDeg, distance);

  const alongSigmaKm = state.speedSigma * hours;
  const headingSpreadKm = distance * Math.tan(Math.min(60, state.headingSigma) * (Math.PI / 180));
  // Скільки в бік могла б відвести ціль, якби розворот тривав увесь горизонт.
  const turnSpreadKm =
    distance *
    Math.abs(Math.sin(Math.min(90, Math.abs(state.turnRateDegMin) * minutes) * (Math.PI / 180)));

  return {
    ...point,
    minutes,
    alongSigmaKm,
    crossSigmaKm: Math.hypot(headingSpreadKm, turnSpreadKm),
    distanceKm: distance,
  };
}
