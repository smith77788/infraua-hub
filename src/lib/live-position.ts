/**
 * Де ціль ЗАРАЗ — між двома повідомленнями джерела.
 *
 * ## Що саме тут відбувається
 *
 * Джерело оновлює позначку дискретно: її ставить спостерігач, а не радар.
 * Заміряно на живих даних — найсвіжіша ціль 0,3 хв тому, найстаріша 7,9 хв,
 * медіана близько 2 хв. Тому позначка на карті стоїть нерухомо хвилинами, хоч
 * шахед за хвилину пролітає три кілометри.
 *
 * Тут остання спостережена позиція просувається вздовж ВИМІРЯНОГО курсу на час,
 * що минув. Це не вигадка руху: курс і швидкість виводяться з `trail` самого
 * джерела методом найменших квадратів (`estimateVelocity`), тобто з того, як
 * ціль РЕАЛЬНО рухалась останні хвилини.
 *
 * ## Чому це не порушує заборону вигадувати
 *
 * Дорахована позиція ніде не видає себе за спостережену: `basis` каже, звідки
 * вона, `aheadMin` — на скільки дорахована, `uncertaintyKm` росте з часом. Карта
 * малює її інакше, ніж підтверджену, і показує останній справжній фікс поряд.
 *
 * Мовчання дорожче за похибку: нерухома позначка теж бреше — вона стверджує, що
 * ціль там, де її бачили дві хвилини тому, і робить це без жодного застереження.
 *
 * ## Межі, взяті свідомо
 *
 * • **Не довше трьох хвилин.** Далі ціль могла звернути, бути збитою або просто
 *   вийти зі спостереження. Дорахувати її на десять хвилин — це намалювати
 *   вигадану ціль за двадцять кілометрів звідти, де вона востаннє була.
 * • **Лише коли рух справді виміряний.** Короткий трек, розсипані фікси, дивна
 *   швидкість — лишаємо позначку там, де її бачили.
 * • **Стоїть — значить стоїть.** Дуже повільний рух не просувається: це або
 *   похибка позиціювання, або ціль справді майже на місці.
 */

import { estimateVelocity, projectForward, trailToFixes, type Velocity } from "./trajectory";

/** Далі цієї межі дорахунок перетворюється на вигадку. */
export const MAX_RECKON_MS = 3 * 60 * 1000;

/**
 * Нижче цієї впевненості підгонки рух не вважається виміряним.
 *
 * `estimateVelocity` рахує впевненість як якість підгонки × кількість фіксів ×
 * тривалість. Пів — це «трек радше схожий на пряму, ніж ні».
 */
export const MIN_CONFIDENCE = 0.5;

/** Швидкості поза цим — не ціль, а помилка ототожнення позначок. */
const MIN_SPEED_KMH = 25;
const MAX_SPEED_KMH = 4000;

export interface LiveTarget {
  lat: number;
  lon: number;
  /** Трек від джерела: позиції з часом. */
  trail?: readonly { lat: number; lon: number; t: string }[];
  /** Власна оцінка розкиду від джерела, км. */
  uncertaintyKm?: number;
}

export interface LivePosition {
  lat: number;
  lon: number;
  /** `observed` — так її бачили; `reckoned` — дораховано від останнього фіксу. */
  basis: "observed" | "reckoned";
  /** На скільки хвилин дораховано вперед. Нуль для спостереженої. */
  aheadMin: number;
  /** Розкид на цей момент, км. */
  uncertaintyKm: number;
  /** Курс руху, якщо виміряний. */
  bearingDeg: number | null;
  /** Швидкість, км/год, якщо виміряна. */
  speedKmh: number | null;
  /** Остання СПОСТЕРЕЖЕНА позиція — карта показує її поряд із дорахованою. */
  observed: { lat: number; lon: number };
}

function still(target: LiveTarget, reason: Velocity | null): LivePosition {
  return {
    lat: target.lat,
    lon: target.lon,
    basis: "observed",
    aheadMin: 0,
    uncertaintyKm: target.uncertaintyKm ?? 0,
    bearingDeg: reason ? reason.bearingDeg : null,
    speedKmh: reason ? reason.speedKmh : null,
    observed: { lat: target.lat, lon: target.lon },
  };
}

/**
 * Позиція цілі на момент `now`.
 *
 * Завжди повертає щось: у найгіршому разі — те, що бачили. Порожньої відповіді
 * тут бути не може, бо позначку все одно треба десь намалювати.
 */
export function livePosition(
  target: LiveTarget,
  now: number,
  maxReckonMs: number = MAX_RECKON_MS,
): LivePosition {
  const fixes = trailToFixes(target.trail ?? []);
  if (fixes.length < 2) return still(target, null);

  const v = estimateVelocity(fixes);
  if (!v) return still(target, null);
  if (v.confidence < MIN_CONFIDENCE) return still(target, v);
  if (v.speedKmh < MIN_SPEED_KMH || v.speedKmh > MAX_SPEED_KMH) return still(target, v);

  /*
   * Відлік від ОСТАННЬОГО ФІКСУ треку, а не від «коли ми взяли дані»: рахувати
   * від власного запиту означало б просувати ціль на час, який вона провела
   * нерухомою в чужій базі.
   */
  const lastFix = fixes[fixes.length - 1]!;
  const aheadMs = now - lastFix.t;
  if (aheadMs <= 0) return still(target, v);
  if (aheadMs > maxReckonMs) return still(target, v);

  const aheadMin = aheadMs / 60_000;
  const p = projectForward(target, v, aheadMin);
  return {
    lat: p.lat,
    lon: p.lon,
    basis: "reckoned",
    aheadMin,
    // Беремо більше з двох: власний розкид джерела нікуди не дівається від того,
    // що ми дорахували рух.
    uncertaintyKm: Math.max(p.uncertaintyKm, target.uncertaintyKm ?? 0),
    bearingDeg: v.bearingDeg,
    speedKmh: v.speedKmh,
    observed: { lat: target.lat, lon: target.lon },
  };
}
