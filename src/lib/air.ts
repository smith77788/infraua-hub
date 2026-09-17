/**
 * Дані повітряної обстановки з відкритого джерела detoyshahed.in.ua:
 * — активні тривоги з реальними полігонами регіонів;
 * — активні інциденти (позначки повітряних цілей за даними OSINT-каналів).
 */

import type { ThreatQuality } from "./threat-quality";

/** Перетворення Web Mercator (EPSG:3857, метри) → WGS84 [lat, lon]. */
export function mercToLatLon(x: number, y: number): [number, number] {
  const lon = (x / 20037508.34) * 180;
  let lat = (y / 20037508.34) * 180;
  lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
  return [lat, lon];
}

/**
 * Тип повітряної цілі. Джерело позначок (detoyshahed) типу не віддає — його
 * визначаємо з тексту Telegram-каналів (див. classifyThreatType). `unknown` —
 * коли типу з тексту дістати не вдалось.
 */
export type ThreatType =
  | "shahed" // ударний БпЛА (Shahed/Герань)
  | "reactive" // реактивний БпЛА
  | "cruise" // крилата ракета
  | "missile" // ракета (загальне / С-300 / зен.)
  | "ballistic" // балістика (Іскандер/Кинджал)
  | "kab" // КАБ (керована авіабомба)
  | "recon" // розвідувальний БпЛА
  | "aircraft" // тактична авіація / пуск
  | "unknown";

// Порядок важливий: специфічніші типи перевіряємо раніше за загальні.
// Увага: у JS \b працює лише для ASCII, тож для кирилиці межі слова задаємо
// явно через lookbehind/lookahead за не-літерою.
const NB = "(?<![а-яґєіїa-z0-9])"; // початок слова (кирилиця/латиниця/цифри)
const NA = "(?![а-яґєіїa-z0-9])"; // кінець слова
const TYPE_PATTERNS: [ThreatType, RegExp][] = [
  ["ballistic", /баліст|кинджал|кинжал|іскандер|iskander|kh-?47|х-?47/i],
  [
    "kab",
    new RegExp(
      `${NB}каб(?:ів|ами|ах|и|ом|у|а)?${NA}|керован[аоі][^.]{0,8}авіабомб|умпк|${NB}фаб`,
      "i",
    ),
  ],
  ["cruise", /крилат|калібр|kalibr|kh-?101|х-?101|kh-?555|х-?555/i],
  ["missile", new RegExp(`ракет|${NB}с-?300${NA}|onyx|онікс|зеніт`, "i")],
  ["recon", /розвід|орлан|zala|supercam/i],
  [
    "aircraft",
    new RegExp(
      `${NB}міг${NA}|${NB}су-?\\d|бомбардувальн|тактичн[^.]{0,6}авіац|${NB}пуск|зліт|${NB}борт`,
      "i",
    ),
  ],
  ["reactive", /реактивн[а-яії]*\s*бпла|🏍/i],
  ["shahed", /шахед|shahed|герань|geran|мопед|бпла|дрон|uav|drone|🛵/i],
];

/** Визначає тип цілі з тексту OSINT-повідомлення. */
export function classifyThreatType(text: string): ThreatType {
  for (const [type, re] of TYPE_PATTERNS) if (re.test(text)) return type;
  return "unknown";
}

// Порядок «серйозності» — при злитті/виборі перемагає важчий тип.
/** Усі допустимі значення типу — джерело правди для нормалізації з мережі. */
const THREAT_TYPES: ReadonlySet<string> = new Set<ThreatType>([
  "shahed",
  "reactive",
  "cruise",
  "missile",
  "ballistic",
  "kab",
  "recon",
  "aircraft",
  "unknown",
]);

/**
 * Звести тип, що прийшов ззовні, до відомого.
 *
 * Типи приходять із мережі, а таблиці підстановки (`Record<ThreatType, …>`)
 * припускають, що ключ завжди свій. Припущення трималося на типізації, якої в
 * рантаймі немає: варто джерелу віддати незнайоме значення — і пошук у таблиці
 * кидає виняток.
 *
 * Знайдено перебором граничних входів: невідомий тип валив `renderChannelPost`
 * ЦІЛКОМ. Тобто одна дивна ціль позбавляла поста весь канал — у продукті, де
 * мовчання і є найгіршою поразкою.
 *
 * Нормалізація на межі дешевша за оборону кожної таблиці окремо: невідоме
 * стає `unknown`, що чесно й означає «тип не визначено».
 */
export function normalizeThreatType(raw: unknown): ThreatType {
  return typeof raw === "string" && THREAT_TYPES.has(raw) ? (raw as ThreatType) : "unknown";
}

const TYPE_SEVERITY: Record<ThreatType, number> = {
  ballistic: 8,
  missile: 7,
  cruise: 6,
  kab: 5,
  reactive: 4,
  shahed: 3,
  aircraft: 2,
  recon: 1,
  unknown: 0,
};
export function moreSevereType(a: ThreatType, b: ThreatType): ThreatType {
  return TYPE_SEVERITY[b] > TYPE_SEVERITY[a] ? b : a;
}

/**
 * Коли НАЙСВІЖІШУ ціль насправді спостерегли.
 *
 * ## Навіщо окремо від «коли ми взяли дані»
 *
 * Це два різні годинники, і плутати їх небезпечно. «Коли взяли» показує, що
 * наш запит дійшов; «коли спостерегли» — що джерело ще живе. Сервер на збої
 * джерела віддає останню відому картину (і правильно робить: краще дані
 * хвилинної давності, ніж «небо чисте» там, де його ніхто не перевіряв), тож
 * відповідь приходить справна кожні пʼятнадцять секунд навіть тоді, коли
 * джерело мовчить годину.
 *
 * Без цього виміру радар показував би застиглі позначки з підписом «наживо» —
 * рівно те, від чого застерігає власний коментар у `connection-status.ts`:
 * тиха застигла картина небезпечніша за порожній екран.
 *
 * ## Чому `null` — це відповідь
 *
 * Порожнє небо не має віку спостереження: міряти нема чого. Повертати тоді
 * «дуже старо» означало б оголосити поломкою кожну тиху ніч, а це найшвидший
 * спосіб навчити людей не вірити банеру.
 */
export function observedAt(threats: readonly Threat[]): number | null {
  let newest: number | null = null;
  for (const t of threats) {
    // `lastSeen` — час найсвіжішого повідомлення у злитій позначці; `since` —
    // коли її підтвердили. Беремо перше наявне: друге старіше за означенням.
    const raw = t.lastSeen || t.since;
    if (!raw) continue;
    const ms = new Date(raw).getTime();
    if (!Number.isFinite(ms)) continue;
    if (newest === null || ms > newest) newest = ms;
  }
  return newest;
}

/**
 * Після якого віку спостереження на ньому не можна будити людей.
 *
 * Пʼятнадцять хвилин — не смак, а відстань: шахед за цей час долає близько
 * сорока кілометрів, тобто більше за будь-який особистий радіус. Позиція такого
 * віку вже не відповідає на питання «чи летить на мене» — ні «так», ні «ні».
 */
export const ALERT_MAX_OBSERVATION_AGE_MS = 15 * 60 * 1000;

/**
 * Чи застарі спостереження, щоб на них когось будити.
 *
 * Карта й сповіщення терплять різний вік, і це не непослідовність. Карті
 * показати останню відому картину з чесним банером — краще, ніж порожнеча:
 * людина сама бачить, що і коли. Сповіщення такої опції не має: воно будить
 * о третій ночі й не показує застережень, тож «в укриття» за годинною позицією
 * — це або зайва паніка, або, гірше, обіцянка прикриття, якого немає.
 *
 * Порожнє небо застарим не буває: будити нема про що, і повертати тут `true`
 * означало б вимикати радар щотихої ночі.
 */
export function observationsTooOldForAlerts(
  threats: readonly Threat[],
  now: number,
  maxAgeMs: number = ALERT_MAX_OBSERVATION_AGE_MS,
): boolean {
  if (threats.length === 0) return false;
  const seen = observedAt(threats);
  // Цілі є, а часу спостереження немає — судити нема на чому, тож не заважаємо.
  if (seen === null) return false;
  return now - seen > maxAgeMs;
}

export interface Threat {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** OSINT-канал-джерело повідомлення. */
  source: string;
  /** Тип цілі, визначений з тексту Telegram (може бути `unknown`). */
  type?: ThreatType;
  count: number;
  since: string;
  expires: string;
  /** OSM-ідентифікатор місця позначки — той самий пункт від різних каналів. */
  osmId?: number;
  /** Скільки окремих повідомлень злилось у цю позначку та з яких каналів. */
  reports?: number;
  sources?: string[];
  /** Час найсвіжішого повідомлення у злитій позначці (для індикації свіжості). */
  lastSeen?: string;
  /** Курс цілі в градусах (0=Пн), якщо джерело його дає. */
  heading?: number;
  /** Рівень впевненості джерела: low/medium/high. */
  confidence?: string;
  /**
   * Що джерело каже про власну точність: радіус невизначеності, чи
   * підтверджена позиція, чи курс лише припущений, чи є заміряна швидкість.
   *
   * Довго губилося, і саме через це карта малювала позначку ±45 км крапкою, а
   * коридор підльоту з припущеного курсу — як розрахунок. Див. threat-quality.ts.
   */
  quality?: ThreatQuality;
  /**
   * Спостережений трек із джерела — де ціль РЕАЛЬНО була.
   *
   * Не плутати з екстраполяцією: тут лише зафіксовані положення, і тільки їх
   * можна малювати суцільною лінією.
   */
  trail?: { lat: number; lon: number; t: string }[];
  /** Ціль над морем — джерело позначає це окремо. */
  sea?: boolean;
  /** Область (регіон), якщо джерело її дає — для аналізу активності по областях. */
  region?: string;
}

/**
 * Скільки цілей у цій позначці — з чужого JSON у число, якому можна вірити.
 *
 * `?? 1` тут не досить, і це не теорія. У JSON немає літерала `NaN`, але
 * `JSON.parse("1e400")` дає **Infinity** — цілком законне число з погляду
 * формату. Далі воно тече сумою в знімок неба, звідти в пік хвилі, і в канал
 * іде рядок «всього в небі: Infinity». Жодного падіння при цьому не буде.
 *
 * Верхньої стелі навмисно НЕМАЄ: вигадана межа мовчки обрізала б справжній
 * масований наліт, а це гірше за велике число. Відсікаємо рівно те, що не є
 * числом у звичайному сенсі.
 */
export function readCount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
  const n = Math.floor(raw);
  return n >= 1 ? n : 1;
}

function threatDistanceKm(a: Threat, b: Threat): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Зливає повітряні цілі-дублікати в одну позначку. Джерело — потік
 * OSINT-повідомлень від багатьох каналів (radar_top_ua, chyste_nebo, kpszsu…):
 * той самий пункт (`osmId`) або сусідні точки в радіусі `radiusKm` стягуються в
 * одну позначку. Свідомо БЕЗ транзитивних ланцюжків: інакше під час масованої
 * атаки ланцюг «місто → передмістя → сусіднє місто» стяг би пів-країни в одну
 * точку й сховав реальні окремі цілі. Тому злиття жадібне навколо ядра —
 * кандидат мусить бути близько саме до ядра кластера, а не до будь-якого члена.
 *
 * Ядром стає найсвіжіша позначка (актуальна позиція); `lastSeen` несе час
 * останнього сигналу; звіти/канали агрегуються.
 *
 * Важливо: під час нальоту 100–200 РІЗНИХ позначок по країні — це переважно
 * реальна картина, а не дублі. Тому радіус помірний, а візуальне згортання в
 * купки робить кластеризація на карті за масштабом, а не це злиття.
 */
export function fuseThreats(threats: Threat[], radiusKm = 8): Threat[] {
  // Свіжіші — раніше: ядром кластера стає останній за часом сигнал.
  const sorted = [...threats].sort((a, b) => (b.since || "").localeCompare(a.since || ""));
  const used = new Set<number>();
  const out: Threat[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const core = sorted[i];
    if (!core) continue;
    const members: Threat[] = [core];
    used.add(i);
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const cand = sorted[j];
      if (!cand) continue;
      const samePlace = core.osmId != null && cand.osmId != null && core.osmId === cand.osmId;
      if (samePlace || threatDistanceKm(core, cand) <= radiusKm) {
        used.add(j);
        members.push(cand);
      }
    }
    const sources = [...new Set(members.map((m) => m.source).filter(Boolean))];
    let lastSeen = core.since;
    for (const m of members) if ((m.since || "") > lastSeen) lastSeen = m.since;
    // Тип кластера — найсерйозніший серед членів (ракета важливіша за БпЛА).
    let type: ThreatType = "unknown";
    for (const m of members) type = moreSevereType(type, m.type ?? "unknown");
    out.push({
      ...core,
      type,
      count: members.reduce((n, m) => n + (m.count || 1), 0),
      reports: members.length,
      sources,
      lastSeen,
    });
  }
  return out;
}

export interface AlertZone {
  region: string;
  type: string;
  /** Зовнішні кільця у форматі Leaflet: [lat, lon][]. */
  polygons: [number, number][][];
}

/** Ділянка лінії фронту (DeepState): кільця + колір статусу. */
/**
 * Що саме означає полігон DeepState.
 *
 * Стрічка джерела — не карта окупації, а робоча мапа редакції: у ній поруч
 * лежать окупована територія, звільнена у 2022-му, стрілки напрямків ударів,
 * позначки підрозділів і відверто сатиричні полігони на чужі регіони. Усе це
 * приходить однаковими полігонами з однаковим червонуватим `stroke`, і карта,
 * що малює їх усі, показує не лінію фронту, а червону пляму на півконтиненту.
 */
export type FrontlineKind = "occupied" | "liberated" | "direction" | "unknown" | "other";

export interface FrontlineArea {
  /** Кільця у форматі Leaflet: [lat, lon][]. */
  polygons: [number, number][][];
  color: string;
  status: string;
  kind: FrontlineKind;
}

/**
 * Класифікація за назвою полігона — єдиним, що джерело дає.
 *
 * Порядок перевірок має значення: «Звільнено 25.03» мусить читатися як
 * звільнене, а не як щось інше через збіг підрядка.
 */
export function frontlineKind(name: string): FrontlineKind {
  const value = name
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .trim();
  if (!value) return "unknown";
  if (value.startsWith("звільнено")) return "liberated";
  if (value.startsWith("напрямок удару")) return "direction";
  if (value.startsWith("статус невідомий")) return "unknown";
  // «Окуповано», «Окупований Крим», «Окупована …», «ОРДЛО».
  if (value.startsWith("окупов") || value.startsWith("ордло")) return "occupied";
  return "other";
}

/** Термоточка активної пожежі (NASA FIRMS, VIIRS/MODIS, 24 год). */
export interface FirePoint {
  lat: number;
  lon: number;
  /** Fire Radiative Power, МВт (інтенсивність). */
  frp: number;
  /** Впевненість детекції: low | nominal | high (VIIRS) або 0–100 (MODIS). */
  confidence: string;
  acqDate: string;
  acqTime: string;
  daynight: string;
}

/** Поточна погода (open-meteo) — вітер важить для БпЛА й поширення пожеж. */
export interface WeatherNow {
  tempC: number;
  windKmh: number;
  /** Напрямок вітру, градуси (звідки дме). */
  windDir: number;
  precip: number;
  degraded: boolean;
}
