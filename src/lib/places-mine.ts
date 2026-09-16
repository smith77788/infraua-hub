/**
 * Мої місця: дім, робота, батьки, школа.
 *
 * ## Чому одна точка — це головне обмеження продукту
 *
 * Людина не живе в одній координаті. Вона хвилюється за дім, де зараз діти,
 * за роботу, куди поїде вранці, і за батьків в іншому місті — і саме останнє
 * будить її вночі найчастіше. Радар, який знає ОДНУ точку, на найважливіше
 * питання «а там як?» відповісти не може взагалі: людина мусить щоразу
 * переставляти свою точку туди-сюди, а переставивши — втрачає попередження
 * про себе.
 *
 * Тому місць кілька, у кожного власна назва, і сповіщення каже, ЗА ЯКЕ саме
 * воно прийшло. «Ціль на вас» і «ціль на дім батьків у Харкові» — два різні
 * повідомлення, і сплутати їх не можна.
 *
 * ## Межі, взяті свідомо
 *
 * • **Не більше пʼяти.** Не технічне обмеження, а змістове: людина, яка стежить
 *   за десятьма місцями, не встигає прочитати десять сповіщень і перестає
 *   читати будь-які. Пʼять — межа, за якою увага розсипається.
 * • **Перше місце головне.** Саме воно лишається «моїм» для команд, які знають
 *   лише одну точку, і саме з нього рахується все, що стосується самої людини.
 *   Так стара поведінка лишається цілою, а нова додається зверху.
 * • **Назву дає людина.** «Дім», «мама», «школа Соні» — це її слова, а не наші
 *   обласні центри. Автоматична назва лишається запасним варіантом.
 */

import type { SubscriberPoint } from "./subscribers";

/** Скільки місць має сенс тримати одній людині. Див. пояснення вгорі. */
export const MAX_PLACES = 5;

/** Найдовша назва місця — довша не вміщується в рядок сповіщення. */
export const PLACE_NAME_MAX = 24;

export interface MyPlace extends SubscriberPoint {
  /** Імʼя, яке дала людина: «дім», «мама», «школа Соні». */
  title: string;
  /** Коли додали — щоб порядок був стабільним, а не випадковим. */
  addedAt: number;
  /**
   * Власний радіус саме цього місця, км.
   *
   * Необовʼязковий, і це змістово: дім і дача тривожать по-різному (навколо
   * дачі поле, навколо дому — місто), але більшість людей радіус жодного разу
   * не змінять. Без значення діє радіус людини — так нове поле нічого не
   * ламає тим, хто про нього не знає.
   */
  radiusKm?: number;
}

export interface PlaceValidation {
  ok: boolean;
  value: string;
  error?: string;
}

/**
 * Назва місця.
 *
 * Порожня назва відхиляється не з педантизму: сповіщення «ціль на » читається
 * як поламане, а людина о третій ночі не має розбиратися, що саме поламалось.
 */
export function validatePlaceName(raw: string): PlaceValidation {
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return { ok: false, value, error: "Назва не може бути порожньою." };
  if (value.length > PLACE_NAME_MAX) {
    return { ok: false, value, error: `Назва довша за ${PLACE_NAME_MAX} символів.` };
  }
  return { ok: true, value };
}

/** Найбільший радіус, який ще має сенс: далі це вже не «моє місце», а область. */
export const PLACE_RADIUS_MAX_KM = 200;
/** Найменший: ближче за десять кілометрів наші дані все одно не розрізняють. */
export const PLACE_RADIUS_MIN_KM = 10;

/**
 * Розбір хвоста `/place дім Харків 30` — місто й, за бажанням, радіус.
 *
 * Радіус останнім числом, а не окремою командою: людина, яка вже пише назву й
 * місто, не піде вчити другий синтаксис заради одного числа. Числом може
 * закінчуватись і назва міста («南»?) — ні, українські назви числами не
 * закінчуються, тож двозначності тут немає.
 */
export function parsePlaceTail(tail: string): { query: string; radiusKm?: number } {
  const m = /^(.*?)\s+(\d{1,3})$/.exec(tail.trim());
  if (!m) return { query: tail.trim() };
  const km = Number(m[2]);
  if (km < PLACE_RADIUS_MIN_KM || km > PLACE_RADIUS_MAX_KM) {
    // Число поза межами — це не радіус. Лишаємо його частиною назви, щоб
    // «Слобожанське 5» не перетворилось на «Слобожанське» з дивним радіусом.
    return { query: tail.trim() };
  }
  return { query: m[1]!.trim(), radiusKm: km };
}

/** Радіус місця: власний, якщо заданий, інакше — радіус людини. */
export function placeRadiusKm(place: MyPlace, fallbackKm: number): number {
  return place.radiusKm && place.radiusKm > 0 ? place.radiusKm : fallbackKm;
}

/** Чи можна додати ще одне місце. */
export function canAddPlace(places: readonly MyPlace[]): boolean {
  return places.length < MAX_PLACES;
}

/**
 * Додати місце.
 *
 * Однакова назва ЗАМІНЮЄ попередню, а не додає другу: людина, яка пише «дім»
 * удруге, хоче виправити координату, а не завести другий дім. Мовчазний дубль
 * дав би два сповіщення про одне місце — і саме тоді, коли їх найменше хочеться
 * читати.
 */
export function addPlace(
  places: readonly MyPlace[],
  place: Omit<MyPlace, "addedAt">,
  now: number,
): { places: MyPlace[]; replaced: boolean; error?: string } {
  const key = place.title.toLowerCase();
  const existingIndex = places.findIndex((p) => p.title.toLowerCase() === key);
  if (existingIndex >= 0) {
    const next = [...places];
    next[existingIndex] = { ...place, addedAt: places[existingIndex]!.addedAt };
    return { places: next, replaced: true };
  }
  if (!canAddPlace(places)) {
    return {
      places: [...places],
      replaced: false,
      error: `Більше ${MAX_PLACES} місць не буде: стільки сповіщень однаково не прочитати. Приберіть зайве командою /place прибрати <назва>.`,
    };
  }
  return { places: [...places, { ...place, addedAt: now }], replaced: false };
}

/** Прибрати місце за назвою. Регістр не має значення — людина пише як пише. */
export function removePlace(
  places: readonly MyPlace[],
  title: string,
): { places: MyPlace[]; removed: MyPlace | null } {
  const key = title.trim().toLowerCase();
  const found = places.find((p) => p.title.toLowerCase() === key) ?? null;
  return { places: places.filter((p) => p.title.toLowerCase() !== key), removed: found };
}

/**
 * Головне місце — те, з якого рахується все «про мене».
 *
 * Перше за часом додавання, а не перше в масиві: порядок у сховищі може
 * змінитися після відновлення з копії, і головне місце не має від цього
 * стрибати.
 */
export function primaryPlace(places: readonly MyPlace[]): MyPlace | null {
  if (!places.length) return null;
  return [...places].sort((a, b) => a.addedAt - b.addedAt)[0]!;
}

/**
 * Перехід зі старої моделі: одна точка стає місцем «Моя точка».
 *
 * Потрібен саме перехід, а не заміна: у сховищі вже лежать підписники з однією
 * точкою, і втратити її під час оновлення означало б мовчки перестати
 * попереджати тих, хто нам довірився.
 */
export function placesFromLegacy(
  point: SubscriberPoint | null,
  places: readonly MyPlace[] | undefined,
  now: number,
): MyPlace[] {
  if (places?.length) return [...places];
  if (!point) return [];
  return [{ ...point, title: "Моя точка", addedAt: now }];
}

/**
 * Як назвати місце у сповіщенні.
 *
 * Головне місце людини — це «ви»: «ціль на вас» природніше за «ціль на вашу
 * точку». Решта називається своїм імʼям, бо саме заради цієї різниці кілька
 * місць і потрібні.
 */
export function alertSubject(place: MyPlace, places: readonly MyPlace[]): string {
  const primary = primaryPlace(places);
  return primary && primary.title === place.title ? "вас" : place.title;
}

/**
 * Скільки мовчати про те саме місце. Двадцять хвилин — щоб налаштування
 * «стежу за батьками» не перетворилось на потік.
 */
export const PLACE_COOLDOWN_MS = 20 * 60 * 1000;

/** Стан сповіщень по місцях: назва → коли востаннє казали. */
export type PlaceAlertState = Record<string, number>;

export interface PlaceDecision {
  send: boolean;
  reason: string;
}

/**
 * Чи попереджати про ДРУГОРЯДНЕ місце.
 *
 * Правило свідомо суворіше за правило для себе, і це не економія повідомлень.
 * Про власну точку людина може діяти на будь-якому рівні — спуститися, відійти
 * від вікна, стежити. Про дім батьків за триста кілометрів вона не може
 * зробити НІЧОГО, крім як хвилюватись; «підвищена готовність» там — це чиста
 * тривога без дії, а такі сповіщення швидко вчать не читати жодних.
 *
 * Тому про чуже місце кажемо лише тоді, коли там справді серйозно, і не
 * частіше, ніж раз на двадцять хвилин.
 */
export function decidePlaceAlert(
  place: MyPlace,
  level: string,
  state: PlaceAlertState | undefined,
  now: number,
): PlaceDecision {
  if (level !== "shelter") {
    return { send: false, reason: "для чужого місця кажемо лише про серйозне" };
  }
  const last = state?.[place.title.toLowerCase()];
  if (last !== undefined && now - last < PLACE_COOLDOWN_MS) {
    return { send: false, reason: "про це місце щойно казали" };
  }
  return { send: true, reason: "серйозно у місці, за яким стежите" };
}

/** Записати, що про місце сказали. */
export function markPlaceAlerted(
  state: PlaceAlertState | undefined,
  place: MyPlace,
  now: number,
): PlaceAlertState {
  return { ...(state ?? {}), [place.title.toLowerCase()]: now };
}

/**
 * Текст сповіщення про чуже місце.
 *
 * Окремий від власного навмисно: людина має з першого слова бачити, що це НЕ
 * про неї. Сплутати «в укриття» про себе з «у Харкові серйозно» — це або
 * зайва паніка, або пропущене власне попередження.
 */
export function renderPlaceAlert(place: MyPlace, detail: string, caveat: string): string {
  return [
    `📍 <b>${escapeHtmlPlace(place.title)}</b> — там зараз серйозно`,
    "",
    detail,
    "",
    `<i>${escapeHtmlPlace(caveat)}</i>`,
  ].join("\n");
}

/** Локальне екранування — модуль лишається без залежностей від бота. */
function escapeHtmlPlace(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Перелік місць для людини.
 *
 * Головне місце підписане окремо: саме з нього рахується все, що стосується
 * самої людини, і плутати його з місцями, за якими вона лише стежить, не можна.
 */
export function renderPlaces(places: readonly MyPlace[]): string {
  if (!places.length) {
    return [
      "📍 <b>Мої місця</b>",
      "",
      "Радар поки знає лише вашу точку. Додайте місця, за які хвилюєтесь:",
      "",
      "<code>/place мама Харків</code>",
      "<code>/place робота Львів</code>",
      "",
      "<i>Про ваше власне місце кажемо на будь-якому рівні; про решту — лише коли там серйозно, бо на відстані вдіяти нічого не можна, а зайва тривога вчить не читати жодної.</i>",
    ].join("\n");
  }
  const main = primaryPlace(places);
  const lines = ["📍 <b>Мої місця</b>", ""];
  for (const p of places) {
    const mark = main && p.title === main.title ? " · ваша точка" : "";
    const radius = p.radiusKm ? ` · ${p.radiusKm} км` : "";
    lines.push(
      `• <b>${escapeHtmlPlace(p.title)}</b> — ${escapeHtmlPlace(p.label)}${radius}${mark}`,
    );
  }
  lines.push("");
  lines.push(`Ще можна додати: ${MAX_PLACES - places.length}`);
  lines.push("");
  lines.push("<code>/place мама Харків</code> — додати або змінити");
  lines.push("<code>/place дача Ірпінь 30</code> — свій радіус для місця");
  lines.push("<code>/place прибрати мама</code> — прибрати");
  return lines.join("\n");
}
