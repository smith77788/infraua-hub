/**
 * Дані повітряної обстановки з відкритого джерела detoyshahed.in.ua:
 * — активні тривоги з реальними полігонами регіонів;
 * — активні інциденти (позначки повітряних цілей за даними OSINT-каналів).
 */

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
export interface FrontlineArea {
  /** Кільця у форматі Leaflet: [lat, lon][]. */
  polygons: [number, number][][];
  color: string;
  status: string;
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
