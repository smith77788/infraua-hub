/**
 * Попередження про небезпеку — і чесна межа того, що ми бачимо.
 *
 * ## Чому цей модуль існує
 *
 * У місті користувача пролунали вибухи. Офіційно було оголошено підвищений
 * рівень небезпеки. Консоль не показала ані цілей, ані попередження.
 *
 * Розбір показав дві різні причини, і жодна не була «помилкою в коді»:
 *
 * 1. **Попередження не було де показати.** Рівень тривоги у нас фарбував
 *    полігон на карті — і більше ніде не зʼявлявся. Людина, яка дивиться на
 *    консоль, бачила кольоровий контур і жодного слова «небезпека».
 *
 * 2. **Цілей того класу наш фід не має.** Заміряно двічі: у живому зрізі 37 із
 *    37 цілей були дронами (`uav`/`fpv`), нуль ракетних; в аудиті записано, що
 *    КАБи джерело «то бачить, то ні». Водночас офіційно діяла «Ракетна загроза
 *    (червоний рівень)» у 23 районах.
 *
 * Друге страшніше за перше. Порожня карта під час ракетної небезпеки читається
 * як «тихо» — хоча насправді означає «ми цього класу не відстежуємо». Монітор,
 * який мовчить про власну сліпоту, небезпечніший за відсутність монітора: на
 * нього покладаються.
 *
 * ## Що робить цей модуль
 *
 * Зводить ОФІЦІЙНЕ оголошення (факт) із тим, що є в НАШОМУ фіді (спостереження),
 * і каже, коли між ними розрив. Нічого не вигадує: клас небезпеки береться зі
 * слів самого джерела, наявність цілей — із того, що прийшло.
 */

import type { Threat, ThreatType } from "./air";
import { levelForOblast, reasonsFor, type AlertLevel, type AlertLevels } from "./alert-levels";

/**
 * Класи, про які попереджають офіційно.
 *
 * Розрізняти їх треба тому, що наш фід покриває їх по-різному, а не заради
 * повноти переліку.
 */
export type DangerClass = "missile" | "drone" | "aircraft" | "other";

/** Типи наших цілей, що належать до ракетного класу. */
const MISSILE_TYPES: ReadonlySet<ThreatType> = new Set<ThreatType>([
  "ballistic",
  "missile",
  "cruise",
  "kab",
]);

/**
 * Клас небезпеки зі слів джерела.
 *
 * Розбираємо текст, бо окремого поля джерело не дає. Невідоме формулювання
 * лишається `other` — вигадувати клас небезпечніше, ніж визнати, що не
 * розпізнали.
 */
export function classOfReason(reason: string): DangerClass {
  const r = reason.toLowerCase();
  if (/ракет|балістич|кр[иі]лат|каб|авіабомб/.test(r)) return "missile";
  if (/дрон|бпла|шахед|безпілот/.test(r)) return "drone";
  if (/авіац|літак|міг|ту-/.test(r)) return "aircraft";
  return "other";
}

export interface DangerNotice {
  /** `danger` — червоний рівень, `watch` — жовтий, `none` — нічого не оголошено. */
  level: "none" | "watch" | "danger";
  headline: string;
  /** Причини словами джерела. */
  reasons: string[];
  /**
   * Чого ми НЕ бачимо, хоч про це попереджають.
   *
   * `null` — розриву немає: або нічого не оголошено, або цілі того класу в нас
   * є. Непорожній рядок — головне речення всього модуля.
   */
  blindTo: string | null;
}

const BLIND: Record<string, string> = {
  missile:
    "Ракети й КАБи наш радар не відстежує: його джерело — повідомлення спостерігачів, " +
    "а вони встигають побачити дрон, але не балістику. Порожня карта зараз НЕ означає, що тихо.",
  aircraft: "Рух авіації наш радар показує лише уривками. Порожня карта зараз НЕ означає, що тихо.",
};

/**
 * Що сказати людині про її область.
 *
 * `oblast` — назва області людини. Без неї дивимось на всю країну: краще
 * сказати про ракетну небезпеку в сусідній області, ніж промовчати.
 */
export function dangerNotice(
  levels: AlertLevels | null,
  threats: readonly Threat[],
  oblast: string | null,
): DangerNotice {
  const quiet: DangerNotice = { level: "none", headline: "", reasons: [], blindTo: null };
  if (!levels) return quiet;

  const names = oblast
    ? [oblast]
    : [...new Set([...levels.oblasts, ...levels.raions].map((a) => a.oblast))];

  let worst: AlertLevel | null = null;
  const reasons = new Set<string>();
  for (const name of names) {
    const lvl = levelForOblast(levels, name);
    if (!lvl) continue;
    if (lvl === "red") worst = "red";
    else if (worst === null) worst = "yellow";
    for (const r of reasonsFor(levels, name)) reasons.add(r);
  }
  if (!worst) return quiet;

  const declared = new Set([...reasons].map(classOfReason));
  /*
   * Розрив шукаємо лише для класів, які ми справді покриваємо погано. Для
   * дронів фід працює — писати про сліпоту там означало б знецінити
   * попередження в тих випадках, де воно справжнє.
   */
  let blindTo: string | null = null;
  for (const cls of ["missile", "aircraft"] as const) {
    if (!declared.has(cls)) continue;
    const haveOne =
      cls === "missile"
        ? threats.some((t) => t.type !== undefined && MISSILE_TYPES.has(t.type))
        : threats.some((t) => t.type === "aircraft");
    if (!haveOne) {
      blindTo = BLIND[cls] ?? null;
      break;
    }
  }

  return {
    level: worst === "red" ? "danger" : "watch",
    headline:
      worst === "red"
        ? oblast
          ? `Небезпека — ${oblast}`
          : "Оголошено небезпеку"
        : oblast
          ? `Загроза — ${oblast}`
          : "Оголошено загрозу",
    reasons: [...reasons],
    blindTo,
  };
}
