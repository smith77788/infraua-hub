import { moreSevereType, type Threat, type ThreatType } from "./air";
import { distanceKm } from "./infra-types";

/**
 * Два ОДНОЧАСНІ звіти про той самий дрон — одна ціль.
 *
 * ## Навіщо
 *
 * `successor-chain` зливає звіти, що йдуть ОДИН ЗА ОДНИМ (старий замовк —
 * новий зʼявився поруч). Але Нептун інколи веде той самий дрон двома треками
 * паралельно: два канали назвали сусідні села, і обидва треки оновлюються. На
 * карті це «дві іконки майже в одному місці» — саме так користувач і описав
 * дубль (опитувальник 01.11). Його правило: «зливати в одну ціль, якщо
 * джерела не вказують, що цілей можливо декілька».
 *
 * ## Правило
 *
 * Пара зливається, лише коли ВСЕ це правда:
 *
 * 1. обидва — дрони одного класу (ракету з дроном не зливаємо);
 * 2. джерело в кожного вказало ОДНУ ціль (`count === 1`): «2х БпЛА» — це вже
 *    джерело каже, що їх кілька;
 * 3. ближче `MAX_KM` одна від одної;
 * 4. курс відомий в обох і різниться не більше ніж на `MAX_HEADING_DIFF`:
 *    два дрони, що розходяться, — два дрони;
 * 5. обидва оновлені в межах `MAX_DT_MS` один від одного — одночасні звіти,
 *    а не старий і новий (то справа `successor-chain`).
 *
 * Лишається свіжіший трек; тип — найнебезпечніший із пари, джерела —
 * обʼєднані. Кожна ціль зливається щонайбільше з однією: ланцюжок «A≈B≈C»
 * через середню не стягує в одну точку весь рій.
 */

export const MAX_KM = 10;
export const MAX_HEADING_DIFF = 30;
export const MAX_DT_MS = 3 * 60_000;

const DRONES: ReadonlySet<ThreatType> = new Set<ThreatType>([
  "shahed",
  "reactive",
  "banderol",
  "decoy",
  "unknown",
]);

function timeOf(t: Threat): number {
  const ms = Date.parse(t.lastSeen || t.since || "");
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function headingDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

function sameDrone(a: Threat, b: Threat): boolean {
  if (!DRONES.has(a.type ?? "unknown") || !DRONES.has(b.type ?? "unknown")) return false;
  if ((a.count ?? 1) !== 1 || (b.count ?? 1) !== 1) return false;
  if (typeof a.heading !== "number" || typeof b.heading !== "number") return false;
  if (headingDiff(a.heading, b.heading) > MAX_HEADING_DIFF) return false;
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || Math.abs(ta - tb) > MAX_DT_MS) return false;
  return distanceKm(a, b) <= MAX_KM;
}

export function mergeParallelDuplicates(threats: readonly Threat[]): Threat[] {
  // Свіжіші — першими: вони й лишаються.
  const order = threats
    .map((t, i) => ({ t, i }))
    .sort((x, y) => (timeOf(y.t) || 0) - (timeOf(x.t) || 0));
  const taken = new Set<number>();
  const out = new Map<number, Threat>();
  for (const { t, i } of order) {
    if (taken.has(i)) continue;
    taken.add(i);
    let keep = t;
    // Найближчий партнер серед ще не взятих.
    let best: { j: number; km: number } | null = null;
    for (const { t: u, i: j } of order) {
      if (taken.has(j) || !sameDrone(t, u)) continue;
      const km = distanceKm(t, u);
      if (!best || km < best.km) best = { j, km };
    }
    if (best) {
      taken.add(best.j);
      const other = threats[best.j]!;
      const type = moreSevereType(t.type ?? "unknown", other.type ?? "unknown");
      const sources = [
        ...new Set([...(t.sources ?? [t.source]), ...(other.sources ?? [other.source])]),
      ].filter(Boolean);
      keep = {
        ...t,
        type,
        sources,
        reports: (t.reports ?? 0) + (other.reports ?? 0) || t.reports,
        mergedIds: [...(t.mergedIds ?? []), other.id, ...(other.mergedIds ?? [])],
        ...(type !== t.type && other.typeFromChannels ? { typeFromChannels: true } : {}),
      } as Threat;
    }
    out.set(i, keep);
  }
  // Порядок вихідного списку — стабільний для карти й тестів.
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
}
