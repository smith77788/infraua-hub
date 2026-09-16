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
import { courseIsObserved, displayRadiusKm, EMPTY_QUALITY, radiusIsStated } from "./threat-quality";

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
  /**
   * Вилка підльоту: [найраніше, найпізніше], хв.
   *
   * `citiesOnCourse` рахувала її завжди, а цей сигнал її викидав і друкував
   * одне число — і саме тут крилась хибна точність. На знімку з проду підпис
   * казав «~3 хв · ~10 км», тимчасом як наша власна невизначеність позиції
   * цілі була ±15 км, тобто БІЛЬША за відстань до міста: ціль могла бути вже
   * над містом, а могла й за двадцять пʼять хвилин ходу.
   */
  etaRangeMin: [number, number];
  distanceKm: number;
  /**
   * Наскільки ціль промине місто, км (0 — рівно на нього).
   *
   * «Іде на вас» і «пройде за двадцять кілометрів» — різні повідомлення, а
   * кутовий коридор їх не розрізняв: ті самі 30° на 60 км означають промах у
   * тридцять кілометрів, а на 10 км — у пʼять.
   */
  missKm: number;
  /** Розкид позиції найближчої цілі, км, і чи назвало його джерело. */
  uncertaintyKm: number;
  uncertaintyStated: boolean;
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
 * Міста під неминучою загрозою: ціль зі СПОСТЕРЕЖЕНИМ курсом іде на місто,
 * близько й підлітає за лічені хвилини. Агрегуємо за містом (скільки цілей,
 * найближча визначає підліт і тип). Чиста функція.
 *
 * Спостережений курс тут — умова, а не побажання, і це найсуворіше місце в
 * усьому продукті.
 *
 * Цей сигнал не схожий на решту: він адресний. Він каже конкретному місту
 * «ціль іде саме на вас, за сім хвилин» і кладе поруч зумовану карту з
 * перехрестям. Джерело ж позначає частину курсів як припущені — у живій
 * відповіді таких було вісім із пʼятнадцяти, — і побудувати на припущенні
 * адресне твердження означає бити тривогу в місто навмання.
 *
 * Звичайне правило «поспішити з попередженням безпечно» тут НЕ рятує, бо
 * тривогу воно не додає, а лише уточнює: загальна картина хвилі, обласна
 * тривога й персональний радар працюють для цієї людини незалежно від цього
 * сигналу. Відкинути непідкріплене уточнення — значить прибрати хибну
 * точність, а не прибрати попередження. А місто, яке двічі підняли навмання,
 * на третій раз не повірить — і це вже коштує життів, а не довіри.
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
    // Припущений курс не дає права на адресне твердження про місто.
    if (!courseIsObserved(t.quality ?? EMPTY_QUALITY)) continue;
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
      const q = t.quality ?? EMPTY_QUALITY;
      if (!cur) {
        byCity.set(h.name, {
          name: h.name,
          lat: ref.lat,
          lon: ref.lon,
          etaMin: h.etaMin,
          etaRangeMin: h.etaRangeMin,
          distanceKm: h.distanceKm,
          missKm: h.missKm,
          uncertaintyKm: displayRadiusKm(q),
          uncertaintyStated: radiusIsStated(q),
          count: 1,
          type,
        });
      } else {
        cur.count += 1;
        // Порівнюємо за НАЙРАНІШИМ краєм, як і сортування в citiesOnCourse:
        // «найближча ціль» — та, що може дійти раніше за всіх, а не та, чия
        // середня оцінка менша.
        if (h.etaRangeMin[0] < cur.etaRangeMin[0]) {
          cur.etaMin = h.etaMin;
          cur.etaRangeMin = h.etaRangeMin;
          cur.distanceKm = h.distanceKm;
          cur.missKm = h.missKm;
          cur.uncertaintyKm = displayRadiusKm(q);
          cur.uncertaintyStated = radiusIsStated(q);
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
  /*
   * Час — вилкою й тим самим формулюванням, що в каналі: коли нижній край
   * упирається в нуль, а верхній далеко, число «~3 хв» не просто неточне, воно
   * порожнє. Тоді кажемо те, що з нього насправді випливає.
   */
  const when = UK.etaTime(a.etaMin, a.etaRangeMin);
  /*
   * Розкид позиції називаємо просто в підписі, і окремо — чи це число джерела,
   * чи наше припущення за замовчуванням. Зумована карта показує цей розкид
   * колом, і підпис не має права виглядати впевненіше за власну картинку.
   */
  const spread = a.uncertaintyStated
    ? `позиція ±${a.uncertaintyKm} км за даними джерела`
    : `позиція ±${a.uncertaintyKm} км — джерело розкиду не вказало, це наша стеля`;
  /*
   * Заголовок каже, ЩО саме відбувається, а не просто «увага».
   *
   * Ціль, яка мине місто за двадцять кілометрів, — це не «на підльоті», і
   * назвати це однаково означало б витратити найгучніший сигнал продукту на
   * проліт повз. Поріг у 8 км — приблизно радіус міста: у цих межах курс уже
   * не відрізняє центр від околиці.
   */
  const head =
    a.missKm <= 8
      ? `❗️ <b>${a.name}</b> — ціль на підльоті`
      : `❗️ <b>${a.name}</b> — ціль проходить поруч`;
  const path =
    a.missKm <= 8
      ? `Підліт: <b>${when}</b> · відстань ~${a.distanceKm} км`
      : `Траверз: <b>${when}</b> · мине приблизно за ${a.missKm} км`;
  return [
    head,
    "",
    path,
    `Курсом сюди: <b>${what}</b>`,
    `<i>${spread}</i>`,
    "",
    "<i>оцінка за курсом і типовою швидкістю — не радар; бережіть себе 🙏</i>",
  ].join("\n");
}
