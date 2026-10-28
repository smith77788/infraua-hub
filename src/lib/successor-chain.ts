/**
 * Один дрон — одна ціль: ланцюжок наступників серед треків джерела.
 *
 * ## Чому це потрібно
 *
 * Скарга користувача (28.10): «Нептун показує одну ціль, а наша консоль одразу
 * багато». Заміряно в ту саму хвилину (18:13 UTC): біля Житомира в API Нептуна
 * ЧОТИРИ треки, і в нас рівно ті самі чотири, координата в координату. Ми нічого
 * не вигадували. Але сайт Нептуна показує одну ціль, бо зливає треки власною
 * моделлю руху в потоці v2, а цей потік віддається лише його сайту (#105).
 *
 * API v1 при цьому всі чотири називає `active`, без жодної ознаки «замінено».
 * Тобто кожен звіт про той самий реактивний дрон у сусідньому селі стає новим
 * треком, а старий лишається висіти — ми бачили це й раніше: за 6,5 хв 46 пар
 * «старий замовк, новий з'явився поруч» (#116).
 *
 * ## Правило
 *
 * Новіший трек приймає старіший як ПОПЕРЕДНИКА, лише коли:
 *
 * 1. обидва — дрони (ракету з дроном не зливаємо);
 * 2. старіший ЗАМОВК щонайменше на `QUIET_MS` раніше. Паралельні дрони
 *    оновлюються майже одночасно, бо їх називають в одних і тих самих зведеннях,
 *    а передача сліду від села до села йде з паузою в хвилини;
 * 3. дрон ВСТИГ би долетіти: відстань ≤ швидкість × час + обидві невизначеності;
 * 4. у кожного треку щонайбільше ОДИН попередник і один наступник — ланцюжок
 *    описує шлях одного апарата, а не мішок усього, що було поруч.
 *
 * Швидкість — найімовірніша для типу × 1.5, а НЕ стеля діапазону. Стеля для
 * `shahed` — 600 км/год (бо під тією самою назвою ходить реактивний), і з нею
 * два поршневі шахеди за 40 км один від одного зливались би в один. Помилка тут
 * несиметрична: злити двох — сховати справжню ціль; не злити — показати зайву.
 * Друга безпечніша, тож межа обережна.
 *
 * Старі позиції ланцюжка не губляться: вони стають треком (`trail`) голови, тож
 * на карті видно, звідки дрон прилетів.
 */

import { moreSevereType, type Threat, type ThreatType } from "./air";
import { distanceKm } from "./infra-types";
import { SPEED_KMH, SPEED_RANGE_KMH } from "./threat-eta";
import { displayRadiusKm, EMPTY_QUALITY } from "./threat-quality";

/** Типи, які можна зливати між собою: ударні й невідомі БпЛА. */
const DRONE_CLASS: ReadonlySet<ThreatType> = new Set<ThreatType>([
  "shahed",
  "reactive",
  "banderol",
  "unknown",
]);

/** Мінімальна пауза: старіший мусить замовкнути раніше за новіший хоча б на стільки. */
export const QUIET_MS = 60_000;
/** Далі за цей проміжок звіти вже не про одну й ту саму ділянку польоту. */
export const MAX_GAP_MS = 15 * 60_000;
/** Запас до найімовірнішої швидкості типу. */
export const SPEED_MARGIN = 1.5;

function timeOf(t: Threat): number {
  const ms = Date.parse(t.lastSeen || t.since || "");
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Швидкість, з якою рахуємо досяжність: найімовірніша × запас, але НЕ вище
 * стелі діапазону класу.
 *
 * Перша версія брала лише «найімовірніша × 1.5», і для реактивного це 825
 * км/год — вище за фізичну межу класу (300–600). На живих даних 28.10 це злило
 * «Синельникове → Розумівка»: 61 км за 249 с, тобто 887 км/год між центрами —
 * реактивний так не літає.
 */
function reachKmh(a: ThreatType | undefined, b: ThreatType | undefined): number {
  const one = (t: ThreatType | undefined): number => {
    const k = t ?? "unknown";
    const likely = SPEED_KMH[k] ?? SPEED_KMH.unknown;
    const top = (SPEED_RANGE_KMH[k] ?? SPEED_RANGE_KMH.unknown)[1];
    return Math.min(likely * SPEED_MARGIN, top);
  };
  return Math.max(one(a), one(b));
}

/** Чи міг той самий апарат бути спершу в `older`, а потім у `newer`. */
export function couldBeSame(older: Threat, newer: Threat): boolean {
  if (!DRONE_CLASS.has(older.type ?? "unknown") || !DRONE_CLASS.has(newer.type ?? "unknown")) {
    return false;
  }
  const to = timeOf(older);
  const tn = timeOf(newer);
  if (!Number.isFinite(to) || !Number.isFinite(tn)) return false;
  const gap = tn - to;
  if (gap < QUIET_MS || gap > MAX_GAP_MS) return false;
  /*
   * Похибки двох позицій — у квадратурі, а не простою сумою. Сума — це випадок,
   * коли обидві позиції хиблять рівно в протилежні боки; брати його за норму
   * означало б зливати ціль, яка майже напевно інша.
   */
  const ro = displayRadiusKm(older.quality ?? EMPTY_QUALITY);
  const rn = displayRadiusKm(newer.quality ?? EMPTY_QUALITY);
  const slack = Math.hypot(ro, rn);
  const reach = (reachKmh(older.type, newer.type) * gap) / 3_600_000 + slack;
  return distanceKm(older, newer) <= reach;
}

/**
 * Зводить ланцюжки в одну ціль на кожен.
 *
 * Жадібно від найновішого: голова шукає собі найсвіжішого можливого
 * попередника, той — свого, і так далі. Цілі не з класу дронів і без часу
 * проходять без змін.
 */
export function mergeSuccessorChains(threats: readonly Threat[]): Threat[] {
  /*
   * Зв'язуємо від найстарішого: кожен звіт — з НАЙБЛИЖЧИМ у часі можливим
   * наступником. Перша версія йшла від найновішого, і голова забирала собі
   * будь-якого досяжного попередника: на зрізі 28.10 Пулини «перестрибнули»
   * Житомир і забрали Оліївку. Ціль виходила та сама, але шлях — ні:
   * послідовні звіти про один дрон — це сусідні в часі звіти.
   */
  const candidates = threats
    .filter((t) => DRONE_CLASS.has(t.type ?? "unknown") && Number.isFinite(timeOf(t)))
    .sort((a, b) => timeOf(a) - timeOf(b));
  const predOf = new Map<Threat, Threat>();
  const hasSucc = new Set<Threat>();
  for (const p of candidates) {
    const s = candidates.find((c) => !predOf.has(c) && couldBeSame(p, c));
    if (!s) continue;
    predOf.set(s, p);
    hasSucc.add(p);
  }

  const absorbedBy = new Map<Threat, Threat[]>();
  for (const head of candidates) {
    if (hasSucc.has(head) || !predOf.has(head)) continue;
    const chain: Threat[] = [];
    for (let p = predOf.get(head); p; p = predOf.get(p)) chain.push(p);
    absorbedBy.set(head, chain);
  }

  const absorbed = new Set([...absorbedBy.values()].flat());
  return threats
    .filter((t) => !absorbed.has(t))
    .map((t) => {
      const chain = absorbedBy.get(t);
      if (!chain) return t;
      // Від найстарішого до голови: так трек читається як шлях.
      const path = [...chain].reverse();
      const before = path.flatMap((p) =>
        p.trail?.length ? p.trail : [{ lat: p.lat, lon: p.lon, t: p.lastSeen || p.since }],
      );
      const own = t.trail?.length
        ? t.trail
        : [{ lat: t.lat, lon: t.lon, t: t.lastSeen || t.since }];
      return {
        ...t,
        // Тип ланцюжка — найсерйозніший серед його ланок: реактивність, названа
        // в одному звіті, стосується всього шляху.
        type: path.reduce(
          (acc, p) => moreSevereType(acc, p.type ?? "unknown"),
          t.type ?? "unknown",
        ),
        trail: [...before, ...own],
        sources: [
          ...new Set([
            ...(t.sources ?? [t.source]),
            ...path.flatMap((p) => p.sources ?? [p.source]),
          ]),
        ],
        // Один апарат — і лічильник один: підсумовувати означало б рахувати
        // той самий дрон стільки разів, скільки сіл його назвали.
        count: Math.max(t.count || 1, ...path.map((p) => p.count || 1)),
      };
    });
}
