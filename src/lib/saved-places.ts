/**
 * Кілька місць замість однієї точки: дім, робота, батьки, дача.
 *
 * ## Чому одна точка — це помилка моделі, а не брак зручності
 *
 * Людина не живе в одній точці. Вона спить удома, працює за двадцять
 * кілометрів, а хвилюється за матір в іншій області. Радар з однією точкою
 * змушує щоразу обирати, за кого боятися, — і мовчить рівно про те, що людина
 * не вибрала.
 *
 * Гірше: він мовчить НЕПОМІТНО. Ніхто не бачить сповіщення, якого не було, і
 * тому людина роками вважає, що бот її прикриває, поки прилітає туди, де вона
 * не поставила точку.
 *
 * ## Модель
 *
 * Місць кілька, одне з них головне. Головне лишається в старому полі `point` —
 * не заради сумісності заради сумісності, а тому, що весь код, який уміє
 * «точку людини», продовжує працювати без змін, і його не треба переписувати
 * заради нової можливості.
 *
 * Сповіщення тепер підписані місцем: «🔴 В УКРИТТЯ — батьки, Суми» відповідає
 * на питання, якого раніше не існувало, бо точка була одна.
 */

export interface SavedPlace {
  /** Короткий ідентифікатор для кнопок: `callback_data` дає 64 байти. */
  id: string;
  /** Як людина сама назвала місце. */
  label: string;
  lat: number;
  lon: number;
  /** Радіус саме для цього місця: дім і дача тривожать по-різному. */
  radiusKm: number;
  /** Головне місце — те, що показує `/my` без аргументів. */
  primary: boolean;
}

export const MAX_PLACES = 5;

/**
 * Ідентифікатор із назви — короткий і передбачуваний.
 *
 * Не випадковий: людина може додати «дім» двічі, і другий раз має оновити
 * перший, а не завести близнюка, про якого вона не знатиме.
 */
export function placeId(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 12);
  if (base) return base;
  // Назва з самих значків — беремо стабільний відбиток, а не порожній рядок.
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0;
  return `p${Math.abs(h).toString(36).slice(0, 6)}`;
}

export interface AddResult {
  places: SavedPlace[];
  /** `replaced` — місце з такою назвою вже було; `full` — більше не влізе. */
  outcome: "added" | "replaced" | "full";
}

/**
 * Додає місце.
 *
 * Стеля є навмисно: десяток місць означає десяток сповіщень на одну хвилю, і
 * людина вимкне бота цілком. Пʼять покриває дім, роботу, двох рідних і дачу —
 * далі починається не турбота, а шум.
 */
export function addPlace(places: readonly SavedPlace[], place: SavedPlace): AddResult {
  const existing = places.findIndex((p) => p.id === place.id);
  if (existing >= 0) {
    const next = [...places];
    next[existing] = { ...place, primary: places[existing]!.primary };
    return { places: next, outcome: "replaced" };
  }
  if (places.length >= MAX_PLACES) return { places: [...places], outcome: "full" };
  // Перше місце автоматично головне: інакше людина додала б точку й не
  // отримувала нічого, доки не здогадалась її призначити.
  return {
    places: [...places, { ...place, primary: places.length === 0 }],
    outcome: "added",
  };
}

export function removePlace(places: readonly SavedPlace[], id: string): SavedPlace[] {
  const next = places.filter((p) => p.id !== id);
  // Головне не може зникнути разом із місцем: без нього `/my` перестав би
  // працювати, хоч місця лишились.
  if (next.length > 0 && !next.some((p) => p.primary)) {
    return next.map((p, i) => (i === 0 ? { ...p, primary: true } : p));
  }
  return next;
}

export function setPrimary(places: readonly SavedPlace[], id: string): SavedPlace[] {
  if (!places.some((p) => p.id === id)) return [...places];
  return places.map((p) => ({ ...p, primary: p.id === id }));
}

export function primaryPlace(places: readonly SavedPlace[]): SavedPlace | null {
  return places.find((p) => p.primary) ?? places[0] ?? null;
}

/**
 * Розбір `/place дім Харків` → назва + решта запиту.
 *
 * Назва — перше слово; усе інше йде в пошук міста. Так тому, що назви місць
 * короткі («дім», «мама»), а назви населених пунктів бувають із двох слів
 * («Кривий Ріг»), і зворотний поділ ламав би саме їх.
 */
export function parsePlaceArgs(args: string): { label: string; query: string } | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { label: parts[0]!.slice(0, 20), query: parts.slice(1).join(" ") };
}

export function renderPlaces(places: readonly SavedPlace[]): string {
  if (places.length === 0) {
    return [
      "📍 <b>Мої місця</b>",
      "",
      "Поки жодного. Радар з однією точкою мовчить про все, що поза нею, — і мовчить непомітно.",
      "",
      "<code>/place дім Харків</code> — додати місце",
      "<code>/place мама Суми</code> — ще одне",
      "",
      `<i>До ${MAX_PLACES} місць. Кожне зі своїм радіусом; сповіщення підписані назвою.</i>`,
    ].join("\n");
  }
  return [
    "📍 <b>Мої місця</b>",
    "",
    ...places.map((p) => `${p.primary ? "★" : "•"} <b>${p.label}</b> — ${p.radiusKm} км`),
    "",
    "<code>/place назва місто</code> — додати або змінити",
    "<code>/place -назва</code> — прибрати",
    "",
    "<i>★ — головне: його показує /my без аргументів.</i>",
  ].join("\n");
}
