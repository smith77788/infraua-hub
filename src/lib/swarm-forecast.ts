/**
 * Прогноз руху рою — зведення руху багатьох цілей в одну картину.
 *
 * Логіка окремо від панелей (WaveForecast/ActiveWaves), щоб її можна було
 * перевірити тестами, а не очима.
 *
 * ## Чому через estimateMotion, а не через estimateVelocity напряму
 *
 * Сира підгонка (`estimateVelocity`) тягнеться до викидів: один битий фікс
 * трейла — «та сама» ціль, помічена з різних кінців області під одним id, —
 * дає відрізок на сотні км/год і перекошує вектор. `estimateMotion` спершу
 * відсіює такі стрибки (per-type стеля швидкості) і позначає походження курсу.
 * Для прогнозу рою беремо ЛИШЕ `observed`: наша обіцянка — рух із реально
 * баченого зміщення, а не з поля heading джерела (те вже показують інші місця).
 */

import type { Threat } from "./air";
import { estimateMotion, type Fix } from "./track-filter";
import {
  reachedPlaces,
  swarmVector,
  trailToFixes,
  type ReachedPlace,
  type SwarmVector,
  type Velocity,
} from "./trajectory";
import { ALL_PLACES } from "./ua-cities";

const MIN_CONFIDENCE = 0.4;
/** Похибка курсу для observed лежить у [3; 60]°; звідси й шкала впевненості. */
const MAX_HEADING_SIGMA = 60;

function trailFixes(t: Threat): Fix[] {
  if (!t.trail) return [];
  return trailToFixes(t.trail).map((f) => ({ lat: f.lat, lon: f.lon, ts: f.t }));
}

/**
 * Вектор цілі з її трейла — лише коли курс СПОСТЕРЕЖЕНИЙ і впевненість достатня.
 * `null`, якщо руху ще не видно, курс лише з поля джерела, або дані биті.
 * Впевненість виводиться із заміряної похибки курсу: вужче віяло — твердіша
 * оцінка.
 */
export function observedVelocity(t: Threat, now: number): Velocity | null {
  const fixes = trailFixes(t);
  if (fixes.length < 2) return null;
  const state = estimateMotion(fixes, now, {
    ...(t.type ? { type: t.type } : {}),
    ...(typeof t.heading === "number" ? { reportedHeading: t.heading } : {}),
  });
  if (!state || state.origin !== "observed") return null;
  const confidence = Math.max(0, Math.min(1, (MAX_HEADING_SIGMA - state.headingSigma) / 57));
  if (confidence < MIN_CONFIDENCE) return null;
  return { bearingDeg: state.headingDeg, speedKmh: state.speedKmh, confidence };
}

export interface SwarmForecast {
  swarm: SwarmVector;
  reach: ReachedPlace[];
  /** Центр мас цілей зі спостереженим рухом — носій прогнозу. */
  centroid: { lat: number; lon: number };
  /** Скільки цілей із спостереженим рухом лягло в оцінку. */
  tracked: number;
}

/**
 * Прогноз рою по заданому переліку орієнтирів. `places` параметром, бо консоль
 * хоче міста (ALL_PLACES), а канал — обласні центри (грубший, «на черзі область»).
 * `null`, якщо руху ще не видно.
 */
export function swarmForecastFor(
  threats: readonly Threat[],
  now: number,
  places: readonly { name: string; lat: number; lon: number }[],
  opts: { horizonMin?: number; cityRadiusKm?: number } = {},
): SwarmForecast | null {
  const confident: { lat: number; lon: number; v: Velocity }[] = [];
  for (const t of threats) {
    const v = observedVelocity(t, now);
    if (v) confident.push({ lat: t.lat, lon: t.lon, v });
  }
  if (confident.length === 0) return null;
  const swarm = swarmVector(confident.map((c) => c.v));
  if (!swarm) return null;
  const centroid = {
    lat: confident.reduce((s, c) => s + c.lat, 0) / confident.length,
    lon: confident.reduce((s, c) => s + c.lon, 0) / confident.length,
  };
  const reach = reachedPlaces(centroid, swarm, places, {
    horizonMin: opts.horizonMin ?? 30,
    ...(opts.cityRadiusKm !== undefined ? { cityRadiusKm: opts.cityRadiusKm } : {}),
  }).slice(0, 3);
  return { swarm, reach, centroid, tracked: confident.length };
}

/** Загальний вектор рою + куди він виходить за горизонт. `null`, якщо руху нема. */
export function swarmForecast(threats: readonly Threat[], now: number): SwarmForecast | null {
  return swarmForecastFor(threats, now, ALL_PLACES);
}

/** Спільний вектор підмножини цілей (членів однієї хвилі). */
export function subsetVector(threats: readonly Threat[], now: number): SwarmVector | null {
  const vs: Velocity[] = [];
  for (const t of threats) {
    const v = observedVelocity(t, now);
    if (v) vs.push(v);
  }
  return swarmVector(vs);
}
