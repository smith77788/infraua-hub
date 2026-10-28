/**
 * Затримка сповіщення про тривогу — заміряна, а не відчута.
 *
 * Скарга користувача (28.10): «сповіщення про тривогу приходять із великою
 * затримкою від офіційної тривоги». Відповісти числом було нічим: бот знав,
 * коли сам побачив тривогу, але не знав, коли її ОГОЛОСИЛИ.
 *
 * Офіційний момент оголошення є в джерелі рівнів (Нептун, поле `since` кожного
 * району): це той самий зріз, з якого банер небезпеки бере колір. Для області
 * беремо НАЙРАНІШИЙ район — людина в будь-якому районі області чує сирену з
 * моменту, коли її оголосили хоча б десь, і чекає сповіщення від того ж часу.
 *
 * Тут лише облік. Що з цим робити — вирішує обхід; цей модуль нічого не шле.
 */

import { oblastKey, type AlertLevels } from "./alert-levels";

/** Коли офіційно оголошено тривогу в області — найраніший район, мс. */
export function officialStartOf(levels: AlertLevels | null, oblast: string): number | null {
  if (!levels) return null;
  const key = oblastKey(oblast);
  let first: number | null = null;
  for (const a of [...levels.oblasts, ...levels.raions]) {
    if (oblastKey(a.oblast) !== key) continue;
    const t = Date.parse(a.since);
    if (!Number.isFinite(t)) continue;
    if (first === null || t < first) first = t;
  }
  return first;
}

/**
 * Межа правдоподібності, с.
 *
 * Більше години — це не затримка, а давня тривога, яку ми щойно ПЕРШИЙ раз
 * побачили (скажімо, після перезапуску без пам'яті): рахувати її в затримку
 * означало б звинуватити обхід у тому, чого він не робив. Відʼємне — розбіжність
 * годинників; зводимо до нуля, а не викидаємо: ми справді не запізнились.
 */
export const MAX_PLAUSIBLE_LAG_SEC = 3600;

export interface LagSummary {
  /** Скільки подій заміряно від запуску процесу. */
  n: number;
  lastSec: number | null;
  medianSec: number | null;
  maxSec: number | null;
}

/** Кільце останніх замірів: питання завжди про останні години, а не про тиждень. */
export class LagLog {
  private readonly keep: number;
  private values: number[] = [];

  constructor(keep = 30) {
    this.keep = keep;
  }

  /** Записати одну подію. `null` — затримку не заміряно (немає офіційного часу). */
  record(detectedAt: number, officialAt: number | null): number | null {
    if (officialAt === null) return null;
    const sec = Math.max(0, Math.round((detectedAt - officialAt) / 1000));
    if (sec > MAX_PLAUSIBLE_LAG_SEC) return null;
    this.values = [...this.values, sec].slice(-this.keep);
    return sec;
  }

  summary(): LagSummary {
    const v = this.values;
    if (v.length === 0) return { n: 0, lastSec: null, medianSec: null, maxSec: null };
    const sorted = [...v].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
    return {
      n: v.length,
      lastSec: v[v.length - 1]!,
      medianSec: median,
      maxSec: sorted[sorted.length - 1]!,
    };
  }
}
