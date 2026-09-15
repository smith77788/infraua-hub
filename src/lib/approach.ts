/**
 * Найближче зближення: відповідь на «чи летить на мене» числом із похибкою.
 *
 * ## Що заміняє
 *
 * Досі відповідь була двійкова: курс цілі в секторі ±60° на точку — «іде на
 * вас», поза сектором — мовчання. Сектор нічого не знає ні про відстань, ні
 * про те, наскільки впевнено ми знаємо курс. Ціль за 8 км із курсом на 55°
 * повз вас вважалась вхідною так само, як ціль, що йде рівно в лоб, — а
 * промахнеться вона на сім кілометрів.
 *
 * ## Що замість
 *
 * Класична задача про найближче зближення, тільки не по прямій, а по
 * розподілу. Траєкторія з `track-filter` дає не лінію, а віяло; точка людини
 * проєктується на цю траєкторію, і виходять дві величини:
 *
 *  • **уздовж** — скільки цілі ще летіти до траверзу (звідси час, із похибкою);
 *  • **впоперек** — на скільки вона промине точку (звідси шанс пройти ближче
 *    за заданий радіус).
 *
 * Шанс береться з нормального розподілу поперечного відхилення, ширина якого
 * заміряна на самих спостереженнях, а не призначена.
 *
 * ## Чого це НЕ означає
 *
 * Це шанс, що ОЦІНЕНА ТРАЄКТОРІЯ пройде ближче за N кілометрів. Не ймовірність
 * влучання, не ймовірність ураження й не прогноз роботи ППО. Ціль може
 * змінити курс, її можуть збити, вона може не нести боєголовки. Плутати ці
 * речі — значить обіцяти знання, якого не існує в жодного джерела цієї ніші.
 */

import { distanceKm } from "./infra-types";
import { bearingDeg } from "./threat-eta";
import { angleDelta, type MotionState, projectMotion } from "./track-filter";

/**
 * Функція помилок — наближення Абрамовіца–Стіґана 7.1.26.
 *
 * Максимальна абсолютна похибка 1.5·10⁻⁷, що на два порядки менше за будь-яку
 * похибку вхідних даних тут. Береться формула, а не бібліотека: одна функція
 * не варта залежності, а перевіряється вона табличними значеннями в тестах.
 */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return sign * y;
}

/** Функція розподілу нормального закону. */
export function normalCdf(x: number, mean = 0, sigma = 1): number {
  if (sigma <= 0) return x >= mean ? 1 : 0;
  return 0.5 * (1 + erf((x - mean) / (sigma * Math.SQRT2)));
}

export interface Approach {
  /** Відстань до точки зараз, км. */
  currentKm: number;
  /** Скільки летіти до траверзу, км уздовж курсу. Відʼємне — вже позаду. */
  alongKm: number;
  /** На скільки промине точку за середньою оцінкою, км (завжди ≥ 0). */
  missKm: number;
  /** Найімовірніший час до траверзу, хв. `null` — ціль віддаляється. */
  etaMin: number | null;
  /** Межі часу з похибки швидкості, хв. */
  etaLowMin: number | null;
  etaHighMin: number | null;
  /** Ширина віяла в точці траверзу, км (1σ). */
  crossSigmaKm: number;
  /** Ціль наближається (траверз попереду). */
  approaching: boolean;
}

/**
 * Геометрія зближення.
 *
 * Ціль ведеться прямою від останнього курсу; точка людини розкладається на
 * складову вздовж і впоперек цієї прямої. Це та сама задача, що в морській
 * навігації (CPA), — і саме тому вона тут доречна: питання буквально те саме.
 */
export function closestApproach(state: MotionState, point: { lat: number; lon: number }): Approach {
  const currentKm = distanceKm(state, point);
  const off = angleDelta(state.headingDeg, bearingDeg(state, point));
  const rad = (off * Math.PI) / 180;
  const alongKm = currentKm * Math.cos(rad);
  const missKm = Math.abs(currentKm * Math.sin(rad));

  if (alongKm <= 0 || state.speedKmh <= 0) {
    return {
      currentKm,
      alongKm,
      missKm: currentKm,
      etaMin: null,
      etaLowMin: null,
      etaHighMin: null,
      crossSigmaKm: 0,
      approaching: false,
    };
  }

  const etaMin = (alongKm / state.speedKmh) * 60;
  // Межі часу — з похибки швидкості. Одне число «~22 хв» приховує, що
  // насправді це «між 16 і 31»; діапазон не менш корисний і не бреше.
  const fast = state.speedKmh + state.speedSigma;
  const slow = Math.max(1, state.speedKmh - state.speedSigma);
  const crossSigmaKm = projectMotion(state, etaMin).crossSigmaKm;

  return {
    currentKm,
    alongKm,
    missKm,
    etaMin,
    etaLowMin: (alongKm / fast) * 60,
    etaHighMin: (alongKm / slow) * 60,
    crossSigmaKm,
    approaching: true,
  };
}

/**
 * Шанс, що траєкторія пройде ближче за `radiusKm`.
 *
 * Поперечне відхилення вважається нормальним із центром у середній оцінці
 * промаху й шириною, заміряною на спостереженнях. Тоді шукане — це просто
 * площа під кривою між −r і +r.
 *
 * `0`, коли ціль віддаляється або траверз далі за горизонт: шанс, порахований
 * на пів години вперед, — це вже не оцінка руху, а ворожіння.
 */
export function passChance(
  state: MotionState,
  point: { lat: number; lon: number },
  radiusKm: number,
  horizonMin = 45,
): number {
  if (state.origin === "none") return 0; // курсу немає — вести нема чого
  const a = closestApproach(state, point);
  if (!a.approaching || a.etaMin === null || a.etaMin > horizonMin) return 0;

  const sigma = Math.max(a.crossSigmaKm, 0.5); // нульової ширини не буває
  const hi = normalCdf(radiusKm, a.missKm, sigma);
  const lo = normalCdf(-radiusKm, a.missKm, sigma);
  return Math.max(0, Math.min(1, hi - lo));
}

/**
 * Поріг, за яким варто турбувати людину.
 *
 * Не «будь-яка ціль у секторі», а «шанс проходу ближче за радіус вище за
 * поріг». Двадцять відсотків — свідомо низько: ціна пропущеного попередження
 * незрівнянно вища за ціну зайвого, і цей перекіс має бути видимим числом, а
 * не схованим у формулюванні.
 */
export const ALERT_CHANCE_THRESHOLD = 0.2;

/** Час словами з чесним діапазоном: «18–26 хв», а не вигадано точне «22 хв». */
export function etaPhraseFrom(a: Approach): string | null {
  if (!a.approaching || a.etaMin === null) return null;
  const low = Math.max(1, Math.round(a.etaLowMin ?? a.etaMin));
  const high = Math.max(low, Math.round(a.etaHighMin ?? a.etaMin));
  if (high > 60) return "понад годину";
  return low === high ? `~${low} хв` : `${low}–${high} хв`;
}

/**
 * Шанс словами.
 *
 * Відсотки навмисно грубі: «37%» створює враження точності, якої в цих даних
 * немає. Людині потрібне рішення, а не третя значуща цифра.
 */
export function chanceWords(chance: number): string {
  if (chance >= 0.7) return "дуже ймовірно пройде поруч";
  if (chance >= 0.4) return "імовірно пройде поруч";
  if (chance >= ALERT_CHANCE_THRESHOLD) return "може пройти поруч";
  return "радше промине";
}
