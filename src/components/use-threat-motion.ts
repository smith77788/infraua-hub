import { useEffect, useRef, useState } from "react";

import type { Threat } from "@/lib/air";
import { driftPosition, type DriftBasis } from "@/lib/threat-drift";

/**
 * Ціль із протягнутою (анімованою) позицією для карти.
 * `lat`/`lon` — де малювати ЗАРАЗ; `projKm` — на скільки км її протягнуто вперед
 * від останньої СПОСТЕРЕЖЕНОЇ точки (0 = стоїмо на факті). Карта росте кільце
 * невизначеності на `projKm` і позначає ціль як оцінку, коли `projKm > 0`.
 * `projBasis` — на чому протягування стоїть: заміряний, названий чи припущений
 * курс (див. `threat-drift`).
 */
export interface DisplayThreat extends Threat {
  projKm: number;
  projBasis: DriftBasis;
  /** Де ціль ЗАФІКСУВАЛИ — вершина «краплі» невизначеності (`drift-sector`). */
  fixLat: number;
  fixLon: number;
}

interface Track {
  posKey: string; // підпис останньої СПОСТЕРЕЖЕНОЇ позиції
  dispLat: number;
  dispLon: number;
  blendFrom: { lat: number; lon: number; at: number } | null;
}

const BLEND_MS = 1000; // плавна корекція від показаного до нової правди
/*
 * ~5 кадрів/с. Тепер рухається більшість цілей, а не одиниці, тож кожен кадр —
 * це перемальовка всіх позначок; 200 мс досі плавно (БпЛА за кадр проходить
 * ~10 м — менше пікселя навіть на зумі вулиці), але вдвічі дешевше за 120 мс.
 */
const FRAME_MS = 200;
const PROJECTED_MIN_KM = 0.2; // менше — вважаємо, що стоїмо на факті (без позначки «оцінка»)
const MOVE_EPS = 1e-5; // ~1.1 м широти: поріг «зрушила», нижче якого не перемальовуємо

const easeOut = (x: number) => 1 - (1 - x) * (1 - x);
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/**
 * Рух цілей між реальними оновленнями Нептуна.
 *
 * Де ціль ЗАРАЗ — вирішує одна чиста функція `driftPosition` (та сама модель,
 * якою свої цілі рухає Нептун, і та сама, що малює пост каналу). Хук додає до
 * неї лише одне: на РЕАЛЬНОМУ оновленні позиції — плавну корекцію (~1 с) від
 * того, де малювали, до нової правди, щоб не було ривка.
 */
export function useThreatMotion(threats: Threat[]): DisplayThreat[] {
  const tracks = useRef<Map<string, Track>>(new Map());
  const latest = useRef<Threat[]>(threats);
  const [, forceTick] = useState(0);

  useEffect(() => {
    latest.current = threats;
    const now = Date.now();
    const map = tracks.current;
    const seen = new Set<string>();
    for (const t of threats) {
      seen.add(t.id);
      const posKey = `${t.lat.toFixed(5)},${t.lon.toFixed(5)},${t.since}`;
      const prev = map.get(t.id);
      if (!prev) {
        const d = driftPosition(t, now);
        map.set(t.id, { posKey, dispLat: d.lat, dispLon: d.lon, blendFrom: null });
      } else if (prev.posKey !== posKey) {
        // Нова реальна позиція: коригуємо плавно від показаного до правди.
        prev.blendFrom = { lat: prev.dispLat, lon: prev.dispLon, at: now };
        prev.posKey = posKey;
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
      for (const t of latest.current) {
        const tr = tracks.current.get(t.id);
        if (!tr) continue;
        const target = driftPosition(t, now);
        let disp: { lat: number; lon: number } = target;
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
    const d = driftPosition(t, now);
    const projKm = d.km >= PROJECTED_MIN_KM ? d.km : 0;
    const projBasis: DriftBasis = projKm > 0 ? d.basis : "none";
    const fix = { fixLat: t.lat, fixLon: t.lon };
    if (!tr) return { ...t, projKm, projBasis, ...fix };
    return { ...t, lat: tr.dispLat, lon: tr.dispLon, projKm, projBasis, ...fix };
  });
}
