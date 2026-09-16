/**
 * «У мами тривога» — те, через що люди насправді не сплять.
 *
 * ## Чого не закриває персональний радар
 *
 * Над людиною може бути тихо, а вона не спатиме, бо тривога в іншому місті — у
 * матері, у дитини в гуртожитку, у чоловіка у відрядженні. Зараз єдиний спосіб
 * це знати — читати чужі обласні канали або дзвонити. Обидва погані: перший
 * шумить, другий будить того, за кого хвилюєшся.
 *
 * Коло рідних у боті вже є — воно вміє «я в порядку» після удару. Але це
 * відповідь ПІСЛЯ. Тут — до: коли в області когось із кола оголошують тривогу,
 * решта кола дізнається одним рядком, нікого не розбудивши.
 *
 * ## Межі, узяті свідомо
 *
 * • **Жодних координат.** Повідомляється область, а не точка: «У мами тривога —
 *   Сумщина». Місце розташування рідних лишається їхнім.
 * • **Один рядок, не потік.** Про початок і про відбій — і все. Хвиля, цілі,
 *   курси — це вже нав'язування чужої тривоги, від якої людина нічим не
 *   допоможе.
 * • **Мовчання не тлумачиться** — як і скрізь у колі: відсутність відмітки не
 *   означає біди.
 */

export interface CircleAlertTarget {
  /** Кому повідомити. */
  chatId: number;
  /** Про кого. */
  aboutName: string;
  oblast: string;
}

export interface CircleMemberPlace {
  chatId: number;
  name: string;
  oblasts: string[];
}

/**
 * Кому з кола розіслати звістку про тривогу в чужій області.
 *
 * Сам той, у кого тривога, сюди не потрапляє: він і так отримає власне
 * сповіщення, а друге — про себе ж, у третій особі — виглядало б як помилка.
 */
export function circleAlertTargets(
  members: readonly CircleMemberPlace[],
  oblast: string,
): CircleAlertTarget[] {
  const affected = members.filter((m) => m.oblasts.includes(oblast));
  if (affected.length === 0) return [];
  const out: CircleAlertTarget[] = [];
  for (const watcher of members) {
    for (const who of affected) {
      if (who.chatId === watcher.chatId) continue;
      // Якщо у спостерігача тривога в тій самій області, він уже знає — і
      // рядок «у мами тривога» під власною сиреною лише заважає.
      if (watcher.oblasts.includes(oblast)) continue;
      out.push({ chatId: watcher.chatId, aboutName: who.name, oblast });
    }
  }
  return out;
}

export function renderRelativeAlarm(names: readonly string[], oblast: string): string {
  const who = names.length === 1 ? names[0]! : names.join(", ");
  return `🔴 <b>Тривога в рідних</b> · ${who} — ${oblast}`;
}

export function renderRelativeClear(names: readonly string[], oblast: string): string {
  const who = names.length === 1 ? names[0]! : names.join(", ");
  return `🟢 <b>Відбій у рідних</b> · ${who} — ${oblast}`;
}
