/**
 * Напрямок «хвилі» рою — куди зміщується маса цілей і які області на черзі.
 *
 * Береться круговий (циркулярний) середній курс усіх цілей, що мають heading.
 * Прогноз даємо ТІЛЬКИ коли напрямок справді виражений (курси збігаються) і
 * цілей достатньо — інакше мовчимо: хибний прогноз гірший за його відсутність.
 * Наступні області — проєкція центра мас уперед по цьому курсу на найближчі
 * обласні центри, яких ще немає під ціллю. Чиста функція, тестована.
 */

import type { Threat } from "./air";
import { distanceKm } from "./infra-types";
import { bearingDeg } from "./threat-eta";

export interface SwarmForecast {
  /** Домінантний курс рою, градуси (0 = Пн). */
  heading: number;
  /** Румб українською: «на північний захід». */
  course: string;
  /** Скільки цілей із курсом увійшло. */
  count: number;
  /** Області, ймовірно наступні на шляху (0..3). */
  next: string[];
}

const COURSE_8 = [
  "на північ",
  "на північний схід",
  "на схід",
  "на південний схід",
  "на південь",
  "на південний захід",
  "на захід",
  "на північний захід",
];
function coursePhrase(headingDeg: number): string {
  return COURSE_8[Math.round((((headingDeg % 360) + 360) % 360) / 45) % 8]!;
}

/** Точка на відстані `km` від `p` за курсом `headingDeg` (0 = Пн). */
function destPoint(
  p: { lat: number; lon: number },
  headingDeg: number,
  km: number,
): { lat: number; lon: number } {
  const th = (headingDeg * Math.PI) / 180;
  const dLat = (km * Math.cos(th)) / 111.32;
  const dLon = (km * Math.sin(th)) / (111.32 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: p.lat + dLat, lon: p.lon + dLon };
}

export function swarmForecast(
  threats: readonly Threat[],
  cities: readonly { name: string; lat: number; lon: number }[],
  opts: { minCount?: number; minConcentration?: number } = {},
): SwarmForecast | null {
  const minCount = opts.minCount ?? 3;
  const minConcentration = opts.minConcentration ?? 0.6;

  const withCourse = threats.filter(
    (t) => typeof t.heading === "number" && Number.isFinite(t.heading),
  );
  if (withCourse.length < minCount) return null;

  // Циркулярне середнє курсів + довжина результанта R (0..1) як міра узгодженості.
  let sx = 0;
  let sy = 0;
  let clat = 0;
  let clon = 0;
  for (const t of withCourse) {
    const h = ((t.heading as number) * Math.PI) / 180;
    sx += Math.sin(h);
    sy += Math.cos(h);
    clat += t.lat;
    clon += t.lon;
  }
  const n = withCourse.length;
  const R = Math.hypot(sx, sy) / n;
  if (R < minConcentration) return null; // курси надто різні — не прогнозуємо

  const heading = (Math.round((Math.atan2(sx, sy) * 180) / Math.PI) + 360) % 360;
  const centroid = { lat: clat / n, lon: clon / n };
  const ahead = destPoint(centroid, heading, 130);

  // Області попереду за курсом: близькі до точки проєкції й у секторі курсу.
  const scored = cities
    .map((c) => ({ c, d: distanceKm(ahead, c) }))
    .filter(({ c }) => {
      const off = Math.abs(((bearingDeg(centroid, c) - heading + 540) % 360) - 180);
      return off <= 45;
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(({ c }) => c.name);

  return { heading, course: coursePhrase(heading), count: n, next: scored };
}
