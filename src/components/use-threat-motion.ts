import { useEffect, useRef, useState } from "react";

import type { Threat } from "@/lib/air";
import { advance, PROJECTION_CAP_MS, projectedKm, projectionSpeedKmh } from "@/lib/dead-reckoning";

/**
 * Ціль із протягнутою (анімованою) позицією для карти.
 * `lat`/`lon` — де малювати ЗАРАЗ; `projKm` — на скільки км її протягнуто вперед
 * від останньої СПОСТЕРЕЖЕНОЇ точки (0 = стоїмо на факті). Карта росте кільце
 * невизначеності на `projKm` і позначає ціль як оцінку, коли `projKm > 0`.
 */
export interface DisplayThreat extends Threat {
  projKm: number;
}

interface Track {
  posKey: string; // підпис останньої СПОСТЕРЕЖЕНОЇ позиції
  obsLat: number;
  obsLon: number;
  anchorAt: number; // коли МИ вперше побачили цю позицію (наш годинник)
  heading: number | null;
  speedKmh: number;
  dispLat: number;
  dispLon: number;
  blendFrom: { lat: number; lon: number; at: number } | null;
}

const BLEND_MS = 1000; // плавна корекція від показаного до нової правди
const FRAME_MS = 200; // ~5 кадрів/с — досить для повільних дронів, дешево для React
const PROJECTED_MIN_KM = 0.2; // менше — вважаємо, що стоїмо на факті (без позначки «оцінка»)

const easeOut = (x: number) => 1 - (1 - x) * (1 - x);
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

function currentKm(tr: Track, now: number): number {
  return projectedKm(tr.speedKmh, now - tr.anchorAt);
}

/**
 * Плавний рух цілей між реальними оновленнями Нептуна.
 *
 * Два механізми в одному:
 *   • на РЕАЛЬНОМУ оновленні позиції — плавна корекція (blend ~1с) від того, де
 *     малювали, до нової правди, щоб не було ривка;
 *   • МІЖ оновленнями — чесна екстраполяція повільних цілей за курсом (див.
 *     dead-reckoning). Для швидких швидкість 0, тож вони лише плавно доїжджають
 *     на реальних оновленнях і стоять між ними — рівно як просив принцип чесності.
 *
 * Якір позиції перекочуємо ЛИШЕ коли позиція реально змінилась. Інакше кожен
 * полінг (та сама точка) скидав би проєкцію в нуль і ціль не рушала б.
 */
export function useThreatMotion(threats: Threat[]): DisplayThreat[] {
  const tracks = useRef<Map<string, Track>>(new Map());
  const [, forceTick] = useState(0);

  useEffect(() => {
    const now = Date.now();
    const map = tracks.current;
    const seen = new Set<string>();
    for (const t of threats) {
      seen.add(t.id);
      const posKey = `${t.lat.toFixed(5)},${t.lon.toFixed(5)}`;
      const heading =
        typeof t.heading === "number" && Number.isFinite(t.heading) ? t.heading : null;
      const speedKmh = heading !== null ? projectionSpeedKmh(t.type) : 0;
      const prev = map.get(t.id);
      if (!prev) {
        map.set(t.id, {
          posKey,
          obsLat: t.lat,
          obsLon: t.lon,
          anchorAt: now,
          heading,
          speedKmh,
          dispLat: t.lat,
          dispLon: t.lon,
          blendFrom: null,
        });
      } else if (prev.posKey !== posKey) {
        // Нова реальна позиція: коригуємо плавно від показаного до правди.
        prev.blendFrom = { lat: prev.dispLat, lon: prev.dispLon, at: now };
        prev.posKey = posKey;
        prev.obsLat = t.lat;
        prev.obsLon = t.lon;
        prev.anchorAt = now;
        prev.heading = heading;
        prev.speedKmh = speedKmh;
      } else {
        // Та сама позиція — якір НЕ чіпаємо, лише оновлюємо курс/швидкість.
        prev.heading = heading;
        prev.speedKmh = speedKmh;
      }
    }
    for (const id of [...map.keys()]) if (!seen.has(id)) map.delete(id);
    // Один негайний кадр, щоб нова ціль зʼявилась без чекання на інтервал.
    forceTick((n) => n + 1);
  }, [threats]);

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      let moving = false;
      for (const tr of tracks.current.values()) {
        const km = tr.heading !== null ? currentKm(tr, now) : 0;
        const target =
          km > 0
            ? advance(tr.obsLat, tr.obsLon, tr.heading as number, km)
            : { lat: tr.obsLat, lon: tr.obsLon };
        let disp = target;
        if (tr.blendFrom) {
          const f = Math.min(1, (now - tr.blendFrom.at) / BLEND_MS);
          disp = {
            lat: lerp(tr.blendFrom.lat, target.lat, easeOut(f)),
            lon: lerp(tr.blendFrom.lon, target.lon, easeOut(f)),
          };
          if (f >= 1) tr.blendFrom = null;
          else moving = true;
        }
        // Ще росте проєкція (не вперлись у стелю) — треба перемальовувати.
        if (km > 0 && now - tr.anchorAt < PROJECTION_CAP_MS) moving = true;
        tr.dispLat = disp.lat;
        tr.dispLon = disp.lon;
      }
      if (moving) forceTick((n) => n + 1);
    }, FRAME_MS);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  return threats.map((t) => {
    const tr = tracks.current.get(t.id);
    if (!tr) return { ...t, projKm: 0 };
    const km = tr.heading !== null ? currentKm(tr, now) : 0;
    return {
      ...t,
      lat: tr.dispLat,
      lon: tr.dispLon,
      projKm: km >= PROJECTED_MIN_KM ? km : 0,
    };
  });
}
