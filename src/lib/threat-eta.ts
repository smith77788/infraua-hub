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
 * Типова крейсерська швидкість за типом цілі, км/год. Це відкриті орієнтовні
 * значення для оцінки часу, не точні ТТХ конкретного зразка — тому округлені й
 * консервативні. Використовуються лише для ETA-оцінки, не для ідентифікації.
 */
export const SPEED_KMH: Record<ThreatType, number> = {
  ballistic: 3000, // балістика — умовно, час до цілі малий у будь-якому разі
  missile: 800,
  cruise: 700,
  kab: 900, // планувальна авіабомба після скиду
  aircraft: 800,
  reactive: 500, // реактивний БпЛА
  shahed: 180,
  recon: 120,
  unknown: 250,
};

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
        etaRangeMin: [Math.round((near / speed) * 60), Math.round((far / speed) * 60)],
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
  /** Оцінка часу підльоту до міста, хв (за типовою швидкістю типу). */
  etaMin: number;
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
  const speed = SPEED_KMH[t.type ?? "unknown"] ?? SPEED_KMH.unknown;
  const out: CityETA[] = [];
  for (const c of cities) {
    const d = distanceKm(t, c);
    if (d < 3 || d > maxRangeKm) continue;
    if (angularDiff(t.heading, bearingDeg(t, c)) > corridorDeg) continue;
    out.push({
      name: c.name,
      distanceKm: Math.round(d),
      etaMin: Math.max(1, Math.round((d / speed) * 60)),
    });
  }
  out.sort((a, b) => a.etaMin - b.etaMin);
  return out.slice(0, opts.limit ?? 3);
}
