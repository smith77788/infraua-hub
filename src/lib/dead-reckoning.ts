import type { ThreatType } from "./air";
import { SPEED_RANGE_KMH } from "./threat-eta";

/**
 * Чесне протягування позначки між реальними оновленнями Нептуна.
 *
 * У тихі паузи джерело не шле нових позицій — заміряно, що та сама точка стоїть
 * у фіді від 38 до 674 секунд. Карта самого Нептуна в ці паузи «їде», бо
 * протягує ціль за курсом на оцінковій швидкості. Робимо так само, але ЧЕСНО:
 *   • лише для повільних цілей із передбачуваним прямим курсом (дрони);
 *   • швидкі (ракета/КАБ/авіація/балістика) НЕ протягуємо — там і курс менш
 *     певний, і ціна помилки в позиції несумісна з «приблизно»;
 *   • беремо НИЖНЮ межу швидкості типу (консервативно — радше недотягнути, ніж
 *     показати ціль далі, ніж вона є);
 *   • коло невизначеності при цьому росте, а на реальному оновленні позначка
 *     стрибає до правди. Проєкція — оцінка, і на карті вона позначена як оцінка.
 */

// Повільні типи з прямим курсом, які можна протягувати. Решта — ні.
const PROJECTABLE: ReadonlySet<ThreatType> = new Set(["shahed", "reactive", "recon", "unknown"]);

/**
 * Стеля протягування без нового реального оновлення. Далі позицію заморожуємо:
 * рухати ціль, про яку джерело мовчить понад це, — вже не оцінка, а вигадка.
 * Коло невизначеності весь цей час і так росло.
 */
export const PROJECTION_CAP_MS = 90_000;

/** Консервативна (нижня) швидкість типу для протягування, км/год. 0 — не тягнемо. */
export function projectionSpeedKmh(type: ThreatType | undefined): number {
  if (!type || !PROJECTABLE.has(type)) return 0;
  return SPEED_RANGE_KMH[type][0];
}

/**
 * Стеля швидкості протягування для типу (верхня межа діапазону). 0 — не тягнемо.
 * Використовуємо, щоб обрізати ЗАМІРЯНУ джерелом швидкість: заміряна точніша за
 * припущену нижню межу, але викид у даних не має жбурляти дрон за горизонт.
 */
export function maxProjectionSpeedKmh(type: ThreatType | undefined): number {
  if (!type || !PROJECTABLE.has(type)) return 0;
  return SPEED_RANGE_KMH[type][1];
}

/**
 * Швидкість для протягування цілі: ЗАМІРЯНА джерелом, якщо вона є (точніше за
 * припущення), інакше — консервативна нижня межа типу. Заміряну обрізаємо
 * стелею типу. Для швидких типів завжди 0 — їх не тягнемо.
 */
export function resolveProjectionSpeedKmh(
  type: ThreatType | undefined,
  measuredKmh: number | null | undefined,
): number {
  const floor = projectionSpeedKmh(type);
  if (floor <= 0) return 0; // непроєктований тип
  if (typeof measuredKmh === "number" && measuredKmh > 0) {
    return Math.min(measuredKmh, maxProjectionSpeedKmh(type));
  }
  return floor;
}

/** Скільки км протягуємо ціль за час ageMs (обрізаний стелею). */
export function projectedKm(speedKmh: number, ageMs: number): number {
  if (!(speedKmh > 0) || !(ageMs > 0)) return 0;
  const capped = Math.min(ageMs, PROJECTION_CAP_MS);
  return (speedKmh / 3600) * (capped / 1000);
}

const R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * Точка за пеленгом `bearingDeg` (° від півночі) на відстані `km` від (lat,lon).
 * Пряма геодезична задача — на десятках км похибка плоскої моделі вже помітна,
 * тож рахуємо по сфері.
 */
export function advance(
  lat: number,
  lon: number,
  bearingDeg: number,
  km: number,
): { lat: number; lon: number } {
  /*
   * Функція ТОТАЛЬНА: що прийшло поза числами — те й повертаємо, не множачи
   * NaN далі. Позиція звідси йде прямо на карту, а NaN там не падає й не
   * помітний — Leaflet просто не малює позначку. Мовчазне зникнення цілі
   * коштує стільки ж, як ненадіслане сповіщення. Знайдено фазингом.
   */
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { lat, lon };
  if (!Number.isFinite(bearingDeg) || !Number.isFinite(km)) return { lat, lon };
  if (!(km > 0)) return { lat, lon };
  const d = km / R_KM;
  const br = rad(bearingDeg);
  const la1 = rad(lat);
  const lo1 = rad(lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2),
    );
  return { lat: deg(la2), lon: deg(lo2) };
}
