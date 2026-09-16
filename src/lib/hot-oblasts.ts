/**
 * Найгарячіші області за кількістю повітряних цілей — і скільки лишилось за кадром.
 *
 * Винесено з розмітки саме тому, що вада була тут, а не в стилях. Смуга на
 * карті показувала топ-3 і мовчала про решту. Поряд стоїть лічильник УСІХ
 * цілей, тож «🔥 Чернігівщина 4 · Одещина 4 · Харківщина 3» під написом
 * «повітряні цілі 17» читається як «сімнадцять розкладено ось так» — і читач
 * бачить, що одинадцять це не сімнадцять. Числа на екрані переставали
 * сходитись, хоча кожне окремо було правильне.
 *
 * Обрізка сама собою чесна: три області вміщаються на телефон, десять — ні.
 * Нечесним було мовчання про неї.
 */

import type { Threat } from "./air";
import { oblastOf } from "./channel-post";

export interface HotOblasts {
  /** Показані області: [назва, кількість цілей], від більшого. */
  top: [string, number][];
  /** Скільки областей лишилось за кадром. */
  restOblasts: number;
  /** Скільки цілей у тих областях — щоб сума на екрані сходилась із лічильником. */
  restTargets: number;
}

export function hotOblasts(threats: readonly Threat[], shown = 3): HotOblasts {
  const counts = new Map<string, number>();
  for (const t of threats) {
    const o = oblastOf(t.lat, t.lon);
    counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  // За кількістю, а за рівності — за назвою: порядок має бути стабільним, інакше
  // смуга смикається між тиками на однакових числах.
  const all = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const tail = all.slice(shown);
  return {
    top: all.slice(0, shown),
    restOblasts: tail.length,
    restTargets: tail.reduce((sum, [, n]) => sum + n, 0),
  };
}
