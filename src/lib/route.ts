/**
 * Дорога: що чекає між пунктом А і пунктом Б.
 *
 * ## Питання, якого не ставив ніхто
 *
 * Усі монітори відповідають про ТОЧКУ. Але людина в дорозі — не точка: вона
 * буде в Полтаві через дві години, і тривога там зараз їй байдужа, а тривога
 * там через дві години — ні. Водій, який їде Київ→Харків, зараз не має жодного
 * способу дізнатися, що діється попереду, окрім як читати пости по всіх
 * областях і зводити їх у голові на ходу.
 *
 * ## Що робиться
 *
 * Маршрут — це ламана між двома точками (поки що пряма: маршрутизації доріг у
 * нас немає й вигадувати її не можна). По ній беруться контрольні точки, і для
 * кожної рахується те саме, що для точки людини: цілі поруч і офіційна тривога
 * в області.
 *
 * Головне — час. Точка за 300 км буде досягнута через три години, і показувати
 * там теперішню обстановку означало б лякати тим, що мине. Тому кожна ділянка
 * підписана часом, коли ви там будете, а обстановка подається як «зараз там»,
 * із прямо названою межею.
 *
 * ## Межа
 *
 * Пряма замість дороги, стала швидкість замість реальної, теперішня
 * обстановка замість прогнозу на три години вперед. Далі потрібні дані, яких у
 * нас немає: маршрутизація (OSRM/Valhalla) і прогноз на годинний горизонт.
 * Але й цього досі не давав ніхто.
 */

import { distanceKm } from "./infra-types";

export interface RoutePoint {
  lat: number;
  lon: number;
  label: string;
}

export interface RouteLeg {
  /** Назва найближчої області до цієї ділянки. */
  oblast: string;
  /** Через скільки хвилин від виїзду ви там будете. */
  etaMin: number;
  /** Скільки кілометрів від початку. */
  fromStartKm: number;
  /** Цілей поруч із ділянкою зараз. */
  threats: number;
  /** Офіційна тривога в цій області зараз. */
  alarm: boolean;
}

/** Типова швидкість автомобіля міжміською, км/год. Груба й чесно груба. */
export const ROAD_SPEED_KMH = 70;

/**
 * Контрольні точки вздовж прямої.
 *
 * Крок у 40 км узятий не з голови: це приблизно та відстань, на якій міняється
 * область, і водночас та, яку долають за пів години — тобто крок, на якому
 * обстановка встигає стати іншою.
 */
export function sampleRoute(
  from: RoutePoint,
  to: RoutePoint,
  stepKm = 40,
): { lat: number; lon: number; fromStartKm: number }[] {
  const total = distanceKm(from, to);
  const steps = Math.max(1, Math.round(total / stepKm));
  const out: { lat: number; lon: number; fromStartKm: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    out.push({
      lat: from.lat + (to.lat - from.lat) * f,
      lon: from.lon + (to.lon - from.lon) * f,
      fromStartKm: Math.round(total * f),
    });
  }
  return out;
}

export interface RouteReport {
  from: string;
  to: string;
  totalKm: number;
  totalMin: number;
  legs: RouteLeg[];
  /** Області з тривогою на маршруті. */
  alarmOblasts: string[];
}

export function buildRoute(
  from: RoutePoint,
  to: RoutePoint,
  lookup: (p: { lat: number; lon: number }) => { oblast: string; threats: number; alarm: boolean },
  opts: { stepKm?: number; speedKmh?: number } = {},
): RouteReport {
  const speed = opts.speedKmh ?? ROAD_SPEED_KMH;
  const samples = sampleRoute(from, to, opts.stepKm ?? 40);
  const totalKm = distanceKm(from, to);

  const legs: RouteLeg[] = [];
  for (const s of samples) {
    const info = lookup(s);
    const etaMin = Math.round((s.fromStartKm / speed) * 60);
    const last = legs[legs.length - 1];
    // Сусідні контрольні точки в одній області зливаються: маршрут із
    // вісьмома рядками «Полтавщина» — це не звіт, це шум.
    if (last && last.oblast === info.oblast) {
      last.threats = Math.max(last.threats, info.threats);
      last.alarm = last.alarm || info.alarm;
      continue;
    }
    legs.push({
      oblast: info.oblast,
      etaMin,
      fromStartKm: s.fromStartKm,
      threats: info.threats,
      alarm: info.alarm,
    });
  }

  return {
    from: from.label,
    to: to.label,
    totalKm: Math.round(totalKm),
    totalMin: Math.round((totalKm / speed) * 60),
    legs,
    alarmOblasts: legs.filter((l) => l.alarm).map((l) => l.oblast),
  };
}

function hhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} год ${m} хв` : `${m} хв`;
}

export function renderRoute(r: RouteReport): string {
  const lines = [
    `🛣 <b>${r.from} → ${r.to}</b>`,
    `${r.totalKm} км · орієнтовно ${hhmm(r.totalMin)}`,
    "",
  ];

  for (const leg of r.legs) {
    const when = leg.etaMin === 0 ? "зараз" : `через ${hhmm(leg.etaMin)}`;
    const state = leg.alarm
      ? "🔴 тривога"
      : leg.threats > 0
        ? `🟡 цілей поруч: ${leg.threats}`
        : "🟢 тихо";
    lines.push(`<b>${leg.oblast}</b> · ${when} — ${state}`);
  }

  lines.push("");
  lines.push(
    r.alarmOblasts.length > 0
      ? `⚠️ Зараз тривога: ${[...new Set(r.alarmOblasts)].join(", ")}`
      : "Зараз тривог на маршруті немає.",
  );
  lines.push(
    "",
    "<i>Обстановка ЗАРАЗ, а не прогноз на час прибуття: за три години вона буде інша. Маршрут — пряма між містами, не дорога.</i>",
  );
  return lines.join("\n");
}
