/**
 * Накопичення СПОСТЕРЕЖЕНОГО треку цілі на клієнті.
 *
 * Проблема, яку це закриває (з розбору моніторів): вони малюють стрілку «на
 * око», людина бачить вектор на своє місто й панікує, а ціль іде зовсім інакше.
 * Чесна карта має розрізняти ДВІ різні речі:
 *   — де ціль РЕАЛЬНО була (спостережений трек) — суцільна лінія;
 *   — куди вона МОЖЕ полетіти за фізикою руху (екстраполяція) — пунктир.
 *
 * Джерело (neptun) віддає лише поточну позицію + курс, без історії. Але консоль
 * опитує його періодично, тож послідовні фікси однієї цілі (за стабільним id)
 * складаються в трек саме тут. Це також дає «куди вона летіла»: видно її
 * розвороти за останню годину, а не пряму стрілку.
 *
 * Чиста функція `updateHistory` (нову мапу повертає, стару не змінює) — щоб
 * покрити тестами без DOM і без таймерів.
 */

import { distanceKm } from "./infra-types";

export interface FixPoint {
  lat: number;
  lon: number;
  ts: number;
}

export interface TrackInput {
  id: string;
  lat: number;
  lon: number;
  /**
   * Коли позицію СПОСТЕРЕЖЕНО, мс. Без цього штампуємо часом опитування.
   *
   * Різниця не косметична, і вона заміряна: у живому фіді застій позиції
   * коливається від 38 до 674 секунд. Штампуючи фікс часом опитування, ми
   * приписуємо цілі рух, якого не було: між двома опитуваннями з різним
   * застоєм позиція зсувається на справжню відстань, але за вигаданий
   * інтервал. Саме звідси в треках беруться дрони на 1126 км/год.
   */
  observedAt?: number | undefined;
  /**
   * Спостережений трек від самого джерела.
   *
   * Найдешевший вимір у системі й доти викинутий: neptun віддає реальні
   * позиції з мітками часу разом із ціллю, а ми чекали двох власних опитувань,
   * щоб «побачити» рух. Тепер трек джерела сіє історію одразу — швидкість і
   * курс стають заміряними з першої ж появи цілі.
   */
  trail?: readonly { lat: number; lon: number; t: string }[] | undefined;
}

export interface UpdateOptions {
  /** Максимум точок у треку однієї цілі. */
  maxPoints?: number;
  /** Менший зсув вважаємо тим самим фіксом (шум/та сама позиція), не пишемо. */
  minMoveKm?: number;
  /** Треки старші за це (за останнім фіксом) прибираємо повністю. */
  maxAgeMs?: number;
}

/**
 * Додає поточні позиції цілей до історії й повертає ОНОВЛЕНУ мапу
 * `id → фікси у часовому порядку`. Дрібні зсуви не пишемо (та сама точка),
 * довгі треки підрізаємо, зниклі/застарілі цілі забуваємо.
 */
export function updateHistory(
  prev: Map<string, FixPoint[]>,
  threats: readonly TrackInput[],
  now: number,
  opts: UpdateOptions = {},
): Map<string, FixPoint[]> {
  const maxPoints = opts.maxPoints ?? 40;
  const minMoveKm = opts.minMoveKm ?? 1;
  const maxAgeMs = opts.maxAgeMs ?? 90 * 60 * 1000;

  const next = new Map<string, FixPoint[]>();
  const alive = new Set<string>();

  for (const t of threats) {
    alive.add(t.id);
    const past = prev.get(t.id) ?? [];
    // Час СПОСТЕРЕЖЕННЯ, а не опитування. Мітка з майбутнього — розбіжність
    // годинників, і брати її не можна: вона дала б відʼємний інтервал.
    const ts = t.observedAt !== undefined && t.observedAt <= now ? t.observedAt : now;
    const point: FixPoint = { lat: t.lat, lon: t.lon, ts };
    const seeded = seedFromTrail(past, t.trail, now, maxAgeMs);
    const last = seeded[seeded.length - 1];
    // Пишемо новий фікс лише коли ціль РЕАЛЬНО зрушила — інакше трек
    // роздувся б однаковими точками на кожному опитуванні. Той самий момент
    // часу теж не дублюємо: трек джерела вже міг його принести.
    const known = last && (distanceKm(last, point) < minMoveKm || last.ts >= ts);
    const merged = known ? seeded : [...seeded, point];
    next.set(t.id, merged.length > maxPoints ? merged.slice(merged.length - maxPoints) : merged);
  }

  // Цілі, яких уже немає у видачі, тримаємо ще трохи (щоб слід не зникав
  // миттєво), але прибираємо застарілі.
  for (const [id, pts] of prev) {
    if (alive.has(id)) continue;
    const last = pts[pts.length - 1];
    if (last && now - last.ts <= maxAgeMs) next.set(id, pts);
  }

  return next;
}

/**
 * Домішує до історії спостережений трек від джерела.
 *
 * Точки з міткою часу, які ми не бачили, стають повноцінними фіксами: вони
 * такі самі спостереження, лише чужі. Дублікати за часом не додаємо, майбутнє
 * і застаріле відкидаємо, результат лишається впорядкованим за часом — від
 * цього залежить кожна оцінка швидкості нижче за течією.
 */
function seedFromTrail(
  past: readonly FixPoint[],
  trail: readonly { lat: number; lon: number; t: string }[] | undefined,
  now: number,
  maxAgeMs: number,
): FixPoint[] {
  if (!trail || trail.length === 0) return [...past];
  const seen = new Set(past.map((p) => p.ts));
  const out = [...past];
  for (const raw of trail) {
    const ts = Date.parse(raw.t);
    if (!Number.isFinite(ts) || ts > now || now - ts > maxAgeMs) continue;
    if (!Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) continue;
    if (seen.has(ts)) continue;
    seen.add(ts);
    out.push({ lat: raw.lat, lon: raw.lon, ts });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** Точки треку як [lat, lon][] для Leaflet-полілінії (лише спостережене). */
export function trackLatLngs(pts: readonly FixPoint[] | undefined): [number, number][] {
  return (pts ?? []).map((p) => [p.lat, p.lon]);
}
