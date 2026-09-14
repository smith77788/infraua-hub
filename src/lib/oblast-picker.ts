/**
 * Вибір області кнопками — шлях до точки, який працює завжди.
 *
 * Причина існування. Запит геолокації в Telegram має щонайменше три способи
 * мовчки не спрацювати, і всі вони виглядають однаково — «натиснув, нічого не
 * сталося»:
 *
 *  • кнопка `request_location` у reply-клавіатурі показується на всіх
 *    клієнтах, але на компʼютері натискання нічого не робить: джерела
 *    координат там немає;
 *  • у вікні Mini App браузерний `navigator.geolocation` не працює, а
 *    `LocationManager` є лише на клієнтах Bot API 8.0+;
 *  • дозвіл можна не дати, відкликати або вимкнути служби місця в системі.
 *
 * Жоден із цих випадків не є помилкою коду, і жоден не можна виправити кодом.
 * Виправити можна інше: щоб людина НІКОЛИ не лишалась без способу задати
 * точку. Вибір області кнопками не потребує дозволів, координат від пристрою й
 * версії клієнта — він працює скрізь, де взагалі працює Telegram.
 *
 * Ціна названа чесно: центр області — це орієнтир на десятки кілометрів, а не
 * адреса. Тому кнопки лишаються ЗАПАСНИМ шляхом, а не єдиним, і в тексті
 * прямо сказано, як задати точку точніше.
 */

import { OBLASTS } from "./alerts";

export interface PickableOblast {
  code: string;
  name: string;
  lat: number;
  lon: number;
}

/**
 * Області для вибору — по одній на код.
 *
 * `OBLASTS` містить кілька ключів, що ведуть на той самий код («м. Київ» і
 * «Київ»), бо ключі там — це назви ВІД ДЖЕРЕЛ. У переліку кнопок дубль
 * виглядав би як помилка, тож беремо перший ключ на код.
 */
export const PICKABLE_OBLASTS: PickableOblast[] = Object.values(OBLASTS)
  .filter((o, i, arr) => arr.findIndex((x) => x.code === o.code) === i)
  .map((o) => ({ code: o.code, name: o.name, lat: o.lat, lon: o.lon }))
  .sort((a, b) => a.name.localeCompare(b.name, "uk"));

export function findOblastByCode(code: string): PickableOblast | undefined {
  return PICKABLE_OBLASTS.find((o) => o.code === code);
}

/** Скільки областей на сторінці. Три в ряд × чотири ряди — без прокрутки. */
export const PICKER_PAGE_SIZE = 12;
export const PICKER_PAGES = Math.ceil(PICKABLE_OBLASTS.length / PICKER_PAGE_SIZE);

export interface PickerButton {
  text: string;
  callback_data: string;
}

/**
 * Клавіатура вибору області.
 *
 * Коди навмисно короткі (`o:UA-63`): Telegram дає на `callback_data` 64 байти,
 * і назва області кирилицею з'їла б їх швидше, ніж здається — у UTF-8 це два
 * байти на літеру. Кнопка, що перевищила стелю, просто не працює.
 */
export function oblastKeyboard(
  page: number,
  extraRow: PickerButton[] = [],
): { inline_keyboard: PickerButton[][] } {
  const total = PICKER_PAGES;
  const safePage = ((page % total) + total) % total;
  const slice = PICKABLE_OBLASTS.slice(
    safePage * PICKER_PAGE_SIZE,
    safePage * PICKER_PAGE_SIZE + PICKER_PAGE_SIZE,
  );

  const rows: PickerButton[][] = [];
  for (let i = 0; i < slice.length; i += 3) {
    rows.push(slice.slice(i, i + 3).map((o) => ({ text: o.name, callback_data: `o:${o.code}` })));
  }
  if (total > 1) {
    rows.push([
      { text: "‹", callback_data: `op:${(safePage + total - 1) % total}` },
      { text: `${safePage + 1}/${total}`, callback_data: `op:${safePage}` },
      { text: "›", callback_data: `op:${(safePage + 1) % total}` },
    ]);
  }
  if (extraRow.length) rows.push(extraRow);
  return { inline_keyboard: rows };
}

/** Розбір натискання. `null` — кнопка не наша. */
export function parsePickerAction(
  data: string,
): { kind: "page"; page: number } | { kind: "pick"; oblast: PickableOblast } | null {
  if (data.startsWith("op:")) {
    const page = Number(data.slice(3));
    return Number.isFinite(page) ? { kind: "page", page } : null;
  }
  if (data.startsWith("o:")) {
    const oblast = findOblastByCode(data.slice(2));
    return oblast ? { kind: "pick", oblast } : null;
  }
  return null;
}
