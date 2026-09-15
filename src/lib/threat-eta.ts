/**
 * Проєкція траєкторії повітряної цілі на критичні обʼєкти — «коридор підльоту».
 *
 * Кореляція за близькістю (threat-correlation) відповідає на питання «які цілі
 * поруч з обʼєктом». Але коли джерело дає курс (neptun віддає heading), можна
 * відповісти на важливіше питання чергового: «куди летить ця ціль і скільки
 * часу до неї». Модуль бере ціль із курсом, проєктує її вперед у секторі
 * (±півкут коридору) і знаходить критичні обʼєкти на шляху, оцінюючи час
 * підльоту за типовою швидкістю типу цілі.
 *
 * Чиста, безстанова функція — рахується покадрово на клієнті, живе на Workers.
 */

import { distanceKm, type Facility } from "./infra-types";
import { CRITICAL_CATEGORIES } from "./threat-correlation";
import { courseIsObserved, displayRadiusKm, EMPTY_QUALITY } from "./threat-quality";
import type { Threat, ThreatType } from "./air";

/**
 * Швидкість за типом цілі — ДІАПАЗОНОМ, км/год.
 *
 * Одне число тут було небезпечним, і найгірше саме там, де ціль найчастіша.
 * «Шахед» у повідомленнях OSINT-каналів — це два різні апарати: поршнева
 * «Герань» іде понад 185 км/год, а її реактивна версія — до 600 км/год. Канал
 * пише про обидві однаково, «БпЛА» або «шахед», бо на слух і на позначці вони
 * не різняться.
 *
 * Отже таблиця з одним значенням 180 казала людині «у вас пів години» там, де
 * лишалося девʼять хвилин. Це не похибка оцінки, це втричі занижена тривога —
 * і в той бік, який коштує життя.
 *
 * Тому швидкість тепер діапазон, і він грає так само, як невизначеність
 * позиції: рівень тривоги читає ШВИДКИЙ край (найраніший приліт), а не
 * середину. Симетрія та сама, що в передтривозі — поспішити безпечно,
 * запізнитися ні.
 *
 * Звідки числа (відкриті джерела, орієнтири для оцінки часу, а не ТТХ і не
 * підстава для розпізнавання):
 *
 * - `shahed` 185..600 — поршнева «Герань»/Shahed-136 понад 185; реактивна
 *   Shahed-238 до 600. Обидві приходять у каналах під тією самою назвою, і
 *   саме тому діапазон такий широкий.
 * - `reactive` 500..600 — коли канал прямо назвав реактивний.
 * - `recon` 100..200 — розвідувальні БпЛА.
 * - `cruise` 700..970 — Х-101: крейсерська 700–720, максимальна близько 970.
 * - `kab` 700..1000 — планувальна авіабомба після скиду.
 * - `aircraft` 700..900 — тактична авіація.
 * - `ballistic` 3000..9400 — «Іскандер-М» 2100–2600 м/с; попереднє значення
 *   3000 км/год було заниженим більш ніж удвічі.
 * - `missile` 700..2000 — свідомо збірна категорія: сюди потрапляє і звичайна
 *   ракета, і зенітна в наземному застосуванні, яка значно швидша. Верхній
 *   край покриває другий випадок.
 * - `unknown` 120..600 — навмисно ОБМЕЖЕНИЙ діапазон безпілотних, а не «від
 *   розвідника до балістики». Балістику оголошують окремо й прямо, тож тягти
 *   її верхній край у кожну нерозпізнану позначку означало б підсвітити все
 *   підряд як найтерміновіше — а коли терміновим позначено все, не позначено
 *   нічого.
 */
export const SPEED_RANGE_KMH: Record<ThreatType, [slow: number, fast: number]> = {
  ballistic: [3000, 9400],
  missile: [700, 2000],
  cruise: [700, 970],
  kab: [700, 1000],
  aircraft: [700, 900],
  reactive: [500, 600],
  shahed: [185, 600],
  recon: [100, 200],
  unknown: [120, 600],
};

/**
 * НАЙІМОВІРНІША швидкість типу, км/год — для середньої оцінки часу.
 *
 * Саме найімовірніша, а не середина діапазону. Спокуса порахувати її з
 * діапазону автоматично велика, і вона хибна: для `shahed` середина між 185 і
 * 600 дала б близько 330 км/год — швидкість, якої не має ні поршнева «Герань»,
 * ні реактивна. Число, що не належить жодному з реальних апаратів, гірше за
 * обидва, бо воно однаково неправильне в усіх випадках.
 *
 * Тому тут стоїть найпоширеніший випадок, а рідкісний швидкий живе у ВЕРХНЬОМУ
 * краї діапазону. Разом вони кажуть людині те, що є насправді: «найімовірніше
 * стільки, але якщо це реактивний — утричі менше». Типова швидкість через це
 * лежить біля ПОВІЛЬНОГО краю діапазону — так і має бути.
 */
export const SPEED_KMH: Record<ThreatType, number> = {
  ballistic: 3000,
  missile: 800,
  cruise: 720, // крейсерська Х-101
  kab: 900,
  aircraft: 800,
  reactive: 550,
  shahed: 185, // поршнева «Герань» — найчастіший випадок
  recon: 120,
  unknown: 200,
};

/**
 * Діапазон швидкості для цієї цілі.
 *
 * Заміряна джерелом швидкість схлопує діапазон у точку: вона стосується саме
 * цієї цілі, а таблиця — лише її класу.
 */
export function speedRangeFor(
  type: ThreatType | undefined,
  measuredKmh: number | null,
): [number, number] {
  if (measuredKmh !== null && measuredKmh > 0) return [measuredKmh, measuredKmh];
  return SPEED_RANGE_KMH[type ?? "unknown"] ?? SPEED_RANGE_KMH.unknown;
}

export interface ThreatProjection {
  threat: Threat;
  facility: Facility;
  /** Відстань уздовж лінії погляду до обʼєкта, км. */
  distanceKm: number;
  /** Середня оцінка часу підльоту, хв. */
  etaMin: number;
  /**
   * Вилка часу підльоту, хв: від найранішого до найпізнішого.
   *
   * Одне число тут завжди було вигадкою. Позиція цілі відома з точністю, яку
   * джерело саме й називає — від 4 до 45 км, — і на швидкості шахеда сорок пʼять
   * кілометрів це чверть години різниці. «~7 хв» у такому разі не оцінка, а
   * випадкове число з інтервалу, поданe як вимір.
   */
  etaRangeMin: [number, number];
  /** Відхилення обʼєкта від курсу цілі, градуси (0 = точно по курсу). */
  offAxisDeg: number;
  /**
   * Швидкість заміряна джерелом, а не взята з таблиці типових.
   *
   * Різниця велика: типова швидкість шахеда 180 км/год, а джерело для живої
   * цілі показувало 99 км/год — майже вдвічі менше, тобто оцінка часу з
   * таблиці помилялась би вдвічі.
   */
  speedMeasured: boolean;
  /** Курс спостережений (true) чи припущений джерелом (false). */
  courseObserved: boolean;
}

export interface ProjectOptions {
  /** Півкут коридору проєкції, градуси (обʼєкт має бути в цьому секторі). */
  corridorDeg?: number;
  /** Максимальна дальність проєкції, км. */
  maxRangeKm?: number;
  /** Розглядати лише критичні категорії обʼєктів. */
  criticalOnly?: boolean;
  /** Скільки проєкцій повернути (найтерміновіші за ETA). */
  limit?: number;
}

/** Початковий азимут з точки `a` на точку `b`, градуси (0 = Пн, за годинниковою). */
export function bearingDeg(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((((Math.atan2(y, x) * 180) / Math.PI) % 360) + 360) % 360;
}

/** Найменша різниця між двома азимутами, градуси (0..180). */
export function angularDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Для цілей із відомим курсом знаходить критичні обʼєкти в коридорі підльоту й
 * оцінює час до них. Повертає список, відсортований за терміновістю (найменший
 * ETA перший). Один обʼєкт лишається лише з найшвидшою вхідною ціллю — щоб не
 * дублювати той самий обʼєкт від кількох цілей.
 */
export function projectThreats(
  threats: Threat[],
  facilities: Facility[],
  opts: ProjectOptions = {},
): ThreatProjection[] {
  const corridorDeg = opts.corridorDeg ?? 22;
  const maxRangeKm = opts.maxRangeKm ?? 200;
  const criticalOnly = opts.criticalOnly ?? true;
  const limit = opts.limit ?? 8;

  const targets = criticalOnly
    ? facilities.filter((f) => CRITICAL_CATEGORIES.has(f.category))
    : facilities;

  const all: ThreatProjection[] = [];
  for (const t of threats) {
    if (typeof t.heading !== "number" || !Number.isFinite(t.heading)) continue;
    const q = t.quality ?? EMPTY_QUALITY;
    // Заміряна швидкість б'є типову: таблиця — це орієнтир для класу, а
    // джерело міряло саме цю ціль.
    const speed = q.speedKmh ?? SPEED_KMH[t.type ?? "unknown"] ?? SPEED_KMH.unknown;
    // Вилка часу ширшає з ДВОХ незалежних причин: ми не знаємо точно, де ціль,
    // і не знаємо точно, що це за апарат. «Шахед» — це і 185 км/год, і 600.
    const [slow, fast] = speedRangeFor(t.type, q.speedKmh);
    const uncertainty = displayRadiusKm(q);
    const observed = courseIsObserved(q);
    for (const f of targets) {
      const d = distanceKm(t, f);
      if (d < 1 || d > maxRangeKm) continue;
      const off = angularDiff(t.heading, bearingDeg(t, f));
      if (off > corridorDeg) continue;
      // Вилка часу — з невизначеності самої позиції: ціль може бути вже на
      // `uncertainty` км ближче або настільки ж далі.
      const near = Math.max(0, d - uncertainty);
      const far = d + uncertainty;
      all.push({
        threat: t,
        facility: f,
        distanceKm: Math.round(d * 10) / 10,
        etaMin: Math.round((d / speed) * 60),
        // Найраніше: ціль ближче, ніж показано, І швидша, ніж типова для класу.
        // Найпізніше: далі й повільніше. Обидва краї — не фантазія, а межі
        // того, чого джерело про цю ціль не сказало.
        etaRangeMin: [Math.round((near / fast) * 60), Math.round((far / slow) * 60)],
        offAxisDeg: Math.round(off),
        speedMeasured: q.speedKmh !== null,
        courseObserved: observed,
      });
    }
  }

  // Один обʼєкт — одна (найтерміновіша) вхідна ціль.
  all.sort((a, b) => a.etaMin - b.etaMin || a.offAxisDeg - b.offAxisDeg);
  const seen = new Set<string>();
  const out: ThreatProjection[] = [];
  for (const p of all) {
    if (seen.has(p.facility.id)) continue;
    seen.add(p.facility.id);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

export interface CityETA {
  name: string;
  /** Найімовірніша оцінка часу підльоту до міста, хв. */
  etaMin: number;
  /**
   * Вилка часу, хв — від найранішого до найпізнішого.
   *
   * Та сама причина, що й усюди: позиція відома з точністю, яку називає
   * джерело, а «шахед» покриває і 185 км/год, і 600. Одне число тут іде в
   * канал на всю країну, тож ціна вигаданої точності тут найбільша.
   */
  etaRangeMin: [number, number];
  distanceKm: number;
}

/**
 * Міста на курсі цілі з оцінкою часу підльоту — «куди летить і за скільки».
 *
 * Те саме, що projectThreats, але ціль проєктується не на критичні обʼєкти, а
 * на МІСТА (обласні центри): відповідь корисна навіть коли шар інфраструктури
 * вимкнено. Курс невідомий → порожньо (не вигадуємо напрямок). Чиста функція.
 */
export function citiesOnCourse(
  t: Threat,
  cities: readonly { name: string; lat: number; lon: number }[],
  opts: { corridorDeg?: number; maxRangeKm?: number; limit?: number } = {},
): CityETA[] {
  if (typeof t.heading !== "number" || !Number.isFinite(t.heading)) return [];
  const corridorDeg = opts.corridorDeg ?? 35;
  const maxRangeKm = opts.maxRangeKm ?? 160;
  const q = t.quality ?? EMPTY_QUALITY;
  const speed = q.speedKmh ?? SPEED_KMH[t.type ?? "unknown"] ?? SPEED_KMH.unknown;
  const [slow, fast] = speedRangeFor(t.type, q.speedKmh);
  const u = displayRadiusKm(q);
  const out: CityETA[] = [];
  for (const c of cities) {
    const d = distanceKm(t, c);
    if (d < 3 || d > maxRangeKm) continue;
    if (angularDiff(t.heading, bearingDeg(t, c)) > corridorDeg) continue;
    out.push({
      name: c.name,
      distanceKm: Math.round(d),
      etaMin: Math.max(1, Math.round((d / speed) * 60)),
      etaRangeMin: [
        Math.max(1, Math.round((Math.max(0, d - u) / fast) * 60)),
        Math.max(1, Math.round(((d + u) / slow) * 60)),
      ],
    });
  }
  // Сортуємо за НАЙРАНІШИМ часом: перше місто в переліку — те, куди ціль може
  // дійти раніше за всіх, а не те, куди вона дійде найімовірніше.
  out.sort((a, b) => a.etaRangeMin[0] - b.etaRangeMin[0] || a.etaMin - b.etaMin);
  return out.slice(0, opts.limit ?? 3);
}
