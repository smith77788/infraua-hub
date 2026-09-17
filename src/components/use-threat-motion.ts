import { useEffect, useRef, useState } from "react";

import type { Threat } from "@/lib/air";
import { advance, projectedKm, resolveProjectionSpeedKmh } from "@/lib/dead-reckoning";
import { livePosition } from "@/lib/live-position";
import { courseIsObserved, EMPTY_QUALITY } from "@/lib/threat-quality";

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
const FRAME_MS = 120; // ~8 кадрів/с — плавніша корекція, все ще дешево для React
const PROJECTED_MIN_KM = 0.2; // менше — вважаємо, що стоїмо на факті (без позначки «оцінка»)
const MOVE_EPS = 1e-5; // ~1.1 м широти: поріг «зрушила», нижче якого не перемальовуємо

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
/**
 * Куди і як швидко тягнути позначку — і чи тягнути взагалі.
 *
 * ## Чому не можна брати `t.heading`
 *
 * Доти курс брався сирим із джерела. Заміряно за 40 хвилин спостережень живого
 * фіду, зіставляючи курс джерела з нашим власним треком тієї самої цілі:
 *
 * | позначка джерела | випадків | медіана розходження |
 * | ---------------- | -------- | ------------------- |
 * | спостережений    | 2        | 0°                  |
 * | припущений       | 9        | **72°**, 5 із 9 понад 60° |
 *
 * Припущених у видачі — 89%.
 *
 * ## Чому 60° — не довільне число
 *
 * Питання «тягнути чи лишити на місці» вирішується арифметикою, а не смаком.
 * Якщо ціль справді змістилась на d, то помилка «стояти» дорівнює d, а помилка
 * «тягнути під кутом θ до правди» — 2·d·sin(θ/2). Друге менше за перше рівно
 * при θ < 60°.
 *
 * θ = 30° → 0,52d (тягнути вдвічі точніше)
 * θ = 60° → 1,00d (однаково)
 * θ = 72° → 1,18d (**гірше, ніж стояти**)
 *
 * Тобто на заміряному розподілі протягування за ПРИПУЩЕНИМ курсом у медіані
 * гірше, ніж не рухати позначку зовсім. Аргумент «нерухома позначка теж бреше»
 * правильний — але діє лише всередині цих 60°, а припущені курси лежать поза
 * ними.
 *
 * ## Порядок довіри
 *
 * 1. Курс, ВИМІРЯНИЙ із треку джерела (`livePosition` — найменші квадрати,
 *    поріг упевненості, перевірка на правдоподібну швидкість). Це вимір.
 * 2. Курс, який джерело саме називає спостереженим.
 * 3. Інакше не тягнемо — позначка стоїть, а коло невизначеності росте.
 */
function projectionCourse(t: Threat, now: number): { heading: number | null; speedKmh: number } {
  const live = livePosition(
    {
      lat: t.lat,
      lon: t.lon,
      ...(t.trail ? { trail: t.trail } : {}),
      ...(t.quality?.uncertaintyKm != null ? { uncertaintyKm: t.quality.uncertaintyKm } : {}),
    },
    now,
  );
  // `reckoned` означає, що всі перевірки всередині пройдено: трек із двох і
  // більше фіксів, упевненість підгонки, правдоподібна швидкість, свіжий фікс.
  if (live.basis === "reckoned" && live.bearingDeg !== null && live.speedKmh !== null) {
    return { heading: live.bearingDeg, speedKmh: live.speedKmh };
  }
  const stated = typeof t.heading === "number" && Number.isFinite(t.heading) ? t.heading : null;
  if (stated !== null && courseIsObserved(t.quality ?? EMPTY_QUALITY)) {
    return { heading: stated, speedKmh: resolveProjectionSpeedKmh(t.type, t.quality?.speedKmh) };
  }
  return { heading: null, speedKmh: 0 };
}

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
      const { heading, speedKmh } = projectionCourse(t, now);
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
        }
        // Перемальовуємо ЛИШЕ коли позначка справді зрушила (>~1 м). Так карта
        // не репейнтиться на субпіксельний рух і не смикається у великий наліт,
        // а завмерла на стелі ціль перестає коштувати кадрів.
        if (
          Math.abs(disp.lat - tr.dispLat) > MOVE_EPS ||
          Math.abs(disp.lon - tr.dispLon) > MOVE_EPS
        )
          moving = true;
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
