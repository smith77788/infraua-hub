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
 * ## Одна підгонка на весь проєкт
 *
 * Сам вектор швидкості рахує `trajectory.estimateVelocity` — метод найменших
 * квадратів у локальній системі координат. Він з'явився в паралельній сесії
 * раніше за цей модуль і математично кращий за посегментне усереднення, з
 * якого цей починався: підгонка складових уникає задачі про середнє кутів
 * узагалі, а R² дає готову міру якості.
 *
 * Тому тут лишився ШАР РІШЕНЬ, а не другий спосіб рахувати те саме (AGENTS.md
 * §7): відсів помилок ототожнення, походження курсу, кутова швидкість
 * розвороту й розклад невизначеності на «вздовж» і «впоперек» — те, чого
 * потребує `approach.ts` і чого підгонка сама по собі не дає.
 *
 * Далі цієї межі без НОВИХ ДАНИХ не пройти. Ми маємо позиції, які хтось
 * побачив і встиг повідомити, з точністю до населеного пункту й частотою в
 * хвилини. Кращу оцінку дає не кращий алгоритм, а радар або ADS-B — тобто
 * інший клас джерела. Усе, що можна вичавити з наявних спостережень, вичавлено
 * тут; далі починається вигадування.
 */

import { distanceKm } from "./infra-types";
import { SPEED_KMH } from "./threat-eta";
import type { ThreatType } from "./air";
import { estimateVelocity, type TrackFix } from "./trajectory";

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

  const clean = rejectJumps(recent, opts.type);
  const fitted = fitMotion(clean, opts.type);
  const fallbackSpeed = SPEED_KMH[opts.type ?? "unknown"] ?? SPEED_KMH.unknown;

  if (!fitted) {
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

  return { ...fitted, lat: last.lat, lon: last.lon, at: last.ts, origin: "observed" };
}

/**
 * Відсів помилок ототожнення.
 *
 * Два звіти про «ту саму» ціль із різних кінців області дають відрізок на
 * 900 км/год для шахеда. Це не прискорення, це різні цілі під одним
 * ідентифікатором — і така точка отруює підгонку сильніше за будь-який шум,
 * бо метод найменших квадратів тягнеться саме до викидів.
 *
 * Поріг per-type, а не глобальний: 900 км/год цілком правдоподібні для ракети
 * й неможливі для «мопеда».
 */
function rejectJumps(sorted: readonly Fix[], type: ThreatType | undefined): Fix[] {
  const cap = maxPlausibleKmh(type);
  const out: Fix[] = [];
  for (const f of sorted) {
    const prev = out[out.length - 1];
    if (prev) {
      const dtH = (f.ts - prev.ts) / 3_600_000;
      if (dtH > 0 && distanceKm(prev, f) / dtH > cap) continue;
    }
    out.push(f);
  }
  return out;
}

/**
 * Підгонка руху + заміряна похибка.
 *
 * Вектор дає `estimateVelocity` (найменші квадрати). Похибки беруться з
 * ЗАЛИШКІВ цієї ж підгонки — тобто з того, наскільки реальні фікси розійшлися
 * з прямою. Це вимір, а не налаштування: рівний політ дає вузьке віяло, а
 * ціль, що крутить, — широке, і жодної константи для цього не треба.
 */
function fitMotion(
  clean: readonly Fix[],
  type: ThreatType | undefined,
): Omit<MotionState, "lat" | "lon" | "at" | "origin"> | null {
  const asTrack: TrackFix[] = clean.map((f) => ({ lat: f.lat, lon: f.lon, t: f.ts }));
  const v = estimateVelocity(asTrack, { windowMs: FIX_WINDOW_MS, minSpanSec: 20 });
  if (!v) return null;

  const first = clean[0]!;
  const lastFix = clean[clean.length - 1]!;
  const spanH = (lastFix.ts - first.ts) / 3_600_000;
  const kLon = Math.cos((first.lat * Math.PI) / 180) * 111.32;
  const rad = (v.bearingDeg * Math.PI) / 180;
  const uE = Math.sin(rad);
  const uN = Math.cos(rad);

  // Залишки розкладаємо на «вздовж» і «впоперек» — саме в цих осях вони й
  // потрібні: перші кажуть про похибку швидкості, другі — про похибку курсу.
  let alongSq = 0;
  let crossSq = 0;
  let n = 0;
  let meanDist = 0;
  for (const f of clean) {
    const dtH = (f.ts - first.ts) / 3_600_000;
    const e = (f.lon - first.lon) * kLon;
    const nk = (f.lat - first.lat) * 111.32;
    const predicted = v.speedKmh * dtH;
    const along = e * uE + nk * uN;
    const cross = e * uN - nk * uE;
    alongSq += (along - predicted) ** 2;
    crossSq += cross ** 2;
    meanDist += Math.abs(along);
    n += 1;
  }
  const alongRms = Math.sqrt(alongSq / Math.max(1, n));
  const crossRms = Math.sqrt(crossSq / Math.max(1, n));
  meanDist = Math.max(1, meanDist / Math.max(1, n));

  // Похибка швидкості — розкид уздовж, віднесений до тривалості спостереження.
  const speedSigma = Math.max(v.speedKmh * 0.05, spanH > 0 ? alongRms / spanH : v.speedKmh * 0.3);
  // Похибка курсу — кут, під яким видно поперечний розкид із пройденої відстані.
  const headingSigma = Math.max(3, Math.min(60, (Math.atan2(crossRms, meanDist) * 180) / Math.PI));

  return {
    speedKmh: v.speedKmh,
    headingDeg: v.bearingDeg,
    speedSigma,
    headingSigma,
    turnRateDegMin: turnRate(clean, type),
    segments: clean.length - 1,
  };
}

/**
 * Кутова швидкість розвороту — за двома половинами треку.
 *
 * Підгонка сама по собі дає одну пряму й розвороту не бачить зовсім: ціль, що
 * описала дугу, і ціль, що летіла прямо, можуть дати той самий середній
 * вектор. Тому курс рахується окремо для першої й другої половини, а різниця
 * між ними, віднесена до часу, і є розворотом.
 *
 * Це та величина, що каже, наскільки далеко взагалі можна вести ціль прямою.
 */
function turnRate(clean: readonly Fix[], type: ThreatType | undefined): number {
  if (clean.length < 4) return 0;
  const mid = Math.floor(clean.length / 2);
  const firstHalf = clean.slice(0, mid + 1);
  const secondHalf = clean.slice(mid);
  const a = estimateVelocity(
    firstHalf.map((f) => ({ lat: f.lat, lon: f.lon, t: f.ts })),
    { windowMs: FIX_WINDOW_MS, minSpanSec: 10 },
  );
  const b = estimateVelocity(
    secondHalf.map((f) => ({ lat: f.lat, lon: f.lon, t: f.ts })),
    { windowMs: FIX_WINDOW_MS, minSpanSec: 10 },
  );
  void type;
  if (!a || !b) return 0;
  const dtMin =
    ((secondHalf[secondHalf.length - 1]!.ts + secondHalf[0]!.ts) / 2 -
      (firstHalf[firstHalf.length - 1]!.ts + firstHalf[0]!.ts) / 2) /
    60_000;
  if (dtMin <= 0.5) return 0;
  return angleDelta(a.bearingDeg, b.bearingDeg) / dtMin;
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
