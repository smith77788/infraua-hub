/**
 * Офіційна повітряна тривога — і чому відбій дає лише вона.
 *
 * Досі канал оголошував «відбій», щойно переставав бачити цілі в OSINT. Це
 * була помилка того класу, який коштує життя: наші дані — це повідомлення
 * спостерігачів, а не радар. Ціль, якої ми не бачимо, не перестає летіти; а
 * людина, що вийшла з укриття за нашим постом, вийшла з нього рано.
 *
 * Тому відбій тепер прив'язаний до офіційного оголошення: поки в області, якої
 * торкалася хвиля, триває тривога, канал відбою не дає — хоч би скільки часу
 * ми нічого не бачили. Максимум, що він каже в цей проміжок, — «цілей не
 * бачимо, але тривога триває», і прямо застерігає не виходити з укриття.
 *
 * Джерело — ubilling (агрегат офіційних тривог). Тут лише розбір і звірка,
 * без мережі: саме тому це можна перевірити тестами.
 */

import { OBLASTS } from "./alerts";

interface UbillingPayload {
  states?: Record<string, { alertnow?: boolean } | null | undefined>;
}

/**
 * Назва області у тій самій формі, якою її знає решта системи.
 *
 * Джерело віддає офіційні назви («Харківська область»), а карта, пости й
 * `oblastOf` оперують короткими («Харківщина»). Без зведення до однієї форми
 * звірка «чи триває тривога там, де була хвиля» не збіглася б НІКОЛИ — і
 * відбій або не виходив би взагалі, або виходив би завжди.
 */
export function shortOblastName(raw: string): string {
  const known = OBLASTS[raw];
  if (known) return known.name;
  const trimmed = raw.trim();
  const byPrefix = Object.entries(OBLASTS).find(([full]) => full === trimmed);
  if (byPrefix) return byPrefix[1].name;
  // Невідома назва лишається як є: вигадувати відповідність — гірше, ніж
  // чесно не знайти збігу (звірка тоді просто вважатиме область тривожною).
  return trimmed;
}

/**
 * Області з активною офіційною тривогою, у коротких назвах.
 *
 * `null` означає «не вдалося дізнатися» — і це НЕ те саме, що «тривог немає».
 * Різниця тут вирішальна: збій джерела, прочитаний як «усе чисто», дав би
 * фальшивий відбій рівно тоді, коли перевірити його нічим.
 */
export function parseOfficialAlerts(payload: unknown): string[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const states = (payload as UbillingPayload).states;
  if (typeof states !== "object" || states === null) return null;
  const out: string[] = [];
  for (const [raw, state] of Object.entries(states)) {
    if (state?.alertnow) out.push(shortOblastName(raw));
  }
  return [...new Set(out)].sort();
}

/**
 * Області хвилі, де тривога ще триває. Порожньо — офіційний відбій скрізь.
 *
 * Звіряються саме області, яких торкалася хвиля, а не вся країна: тривога в
 * Донецькій області не має тримати відбій над Львівщиною, де все скінчилось.
 */
export function stillAlerting(touched: readonly string[], active: readonly string[]): string[] {
  const set = new Set(active);
  return touched.filter((o) => set.has(o)).sort();
}
