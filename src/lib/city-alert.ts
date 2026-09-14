/**
 * Адресний сигнал «ціль підходить до міста» — зумована локальна карта в канал.
 *
 * Загальний пост показує країну; мешканцю Полтави з нього не видно, що саме
 * ЗАРАЗ на його місто заходить шахед за сім хвилин. Цей сигнал — інша річ: рідкісний,
 * прицільний, з наближеною картою й перехрестям на самому місті. Жоден монітор
 * цієї ніші так не робить — усі шлють однакову оглядову картинку на всіх.
 *
 * Спрацьовує лише на НЕМИНУЧЕ: ціль із відомим курсом, близько й підлітає за
 * лічені хвилини. Курс невідомий — сигналу немає (напрямок не вигадуємо). Кулдаун
 * не дає бити в те саме місто щотику. Уся логіка тут — чисті функції, під тестами;
 * відправлення й памʼять кулдауна — у сервері.
 */

import type { Threat, ThreatType } from "./air";
import { OBLASTS } from "./alerts";
import { UK } from "./channel-lexicon";
import { citiesOnCourse } from "./threat-eta";

export interface CityRef {
  name: string;
  lat: number;
  lon: number;
}

/** Обласні центри (публічні координати) як орієнтири для адресного сигналу. */
export const ALERT_CITIES: CityRef[] = Object.values(OBLASTS)
  .filter((o, i, arr) => arr.findIndex((x) => x.code === o.code) === i)
  .map((o) => ({ name: o.name, lat: o.lat, lon: o.lon }));

export interface CityAlert {
  name: string;
  lat: number;
  lon: number;
  /** Підліт найближчої цілі, хв. */
  etaMin: number;
  distanceKm: number;
  /** Скільки цілей ідуть курсом на це місто. */
  count: number;
  /** Тип найближчої (найшвидшої за підльотом) цілі. */
  type: ThreatType;
}

export interface CityAlertOpts {
  /** Тільки неминуче: підліт не більший за це, хв (default 12). */
  maxEtaMin?: number;
  /** І близьке: не далі за це, км (default 60). */
  maxDistanceKm?: number;
  /** Коридор курсу довкола пеленга на місто, ° (default 30). */
  corridorDeg?: number;
  /** Скільки міст за раз (default 1) — сигнал має лишатись рідкісним. */
  limit?: number;
}

/**
 * Міста під неминучою загрозою: ціль із відомим курсом іде на місто, близько й
 * підлітає за лічені хвилини. Агрегуємо за містом (скільки цілей, найближча
 * визначає підліт і тип). Чиста функція.
 */
export function cityAlerts(
  threats: readonly Threat[],
  cities: readonly CityRef[] = ALERT_CITIES,
  opts: CityAlertOpts = {},
): CityAlert[] {
  const maxEtaMin = opts.maxEtaMin ?? 12;
  const maxDistanceKm = opts.maxDistanceKm ?? 60;
  const corridorDeg = opts.corridorDeg ?? 30;

  const byCity = new Map<string, CityAlert>();
  for (const t of threats) {
    const hits = citiesOnCourse(t, cities, {
      corridorDeg,
      maxRangeKm: maxDistanceKm,
      limit: cities.length,
    });
    for (const h of hits) {
      if (h.etaMin > maxEtaMin || h.distanceKm > maxDistanceKm) continue;
      const ref = cities.find((c) => c.name === h.name);
      if (!ref) continue;
      const type: ThreatType = t.type ?? "unknown";
      const cur = byCity.get(h.name);
      if (!cur) {
        byCity.set(h.name, {
          name: h.name,
          lat: ref.lat,
          lon: ref.lon,
          etaMin: h.etaMin,
          distanceKm: h.distanceKm,
          count: 1,
          type,
        });
      } else {
        cur.count += 1;
        if (h.etaMin < cur.etaMin) {
          cur.etaMin = h.etaMin;
          cur.distanceKm = h.distanceKm;
          cur.type = type;
        }
      }
    }
  }
  return [...byCity.values()].sort((a, b) => a.etaMin - b.etaMin).slice(0, opts.limit ?? 1);
}

/**
 * Відсіює міста, по яких сигнал давали недавно (кулдаун), і повертає оновлену
 * памʼять. Чиста: сервер тримає `lastAlertedAt` між тиками. Без кулдауна той
 * самий шахед на підльоті бив би в місто щоп'ять хвилин.
 */
export function selectFreshCityAlerts(
  alerts: readonly CityAlert[],
  lastAlertedAt: Readonly<Record<string, number>>,
  now: number,
  cooldownMs: number,
): { fresh: CityAlert[]; lastAlertedAt: Record<string, number> } {
  const next: Record<string, number> = { ...lastAlertedAt };
  const fresh: CityAlert[] = [];
  for (const a of alerts) {
    const last = next[a.name];
    // Немає запису — місто ще не сигналили: сигнал свіжий.
    if (last !== undefined && now - last < cooldownMs) continue;
    next[a.name] = now;
    fresh.push(a);
  }
  return { fresh, lastAlertedAt: next };
}

/** Підпис адресного сигналу — коротко, українською, у голосі каналу. */
export function cityAlertCaption(a: CityAlert): string {
  const what = `${a.count} ${UK.typeName(a.type, a.count)}`;
  return [
    `❗️ <b>${a.name}</b> — ціль на підльоті`,
    "",
    `Орієнтовний підліт: <b>~${a.etaMin} хв</b> · ~${a.distanceKm} км`,
    `Курсом сюди: <b>${what}</b>`,
    "",
    "<i>оцінка за курсом і типовою швидкістю — не радар; бережіть себе 🙏</i>",
  ].join("\n");
}
