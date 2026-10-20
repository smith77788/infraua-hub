import type { Threat, ThreatType } from "./air";
import { advance } from "./dead-reckoning";
import { livePosition } from "./live-position";
import { courseIsObserved, EMPTY_QUALITY } from "./threat-quality";

/**
 * Де малювати ціль ЗАРАЗ — за тією самою моделлю, якою свої цілі рухає Нептун.
 *
 * ## Чому саме так
 *
 * Скарга була конкретна: «Нептун показує рух майже всіх цілей, ми — малий
 * відсоток». Перевірено на коді самого Нептуна (клієнт neptun.in.ua, 2026-10-20)
 * і на нашому: різниця не в даних, а в двох наших обмеженнях.
 *
 * 1. Стеля 90 с від моменту, коли МИ отримали точку. Навіть ціль зі
 *    спостереженим курсом проходила 3–4 км і завмирала, а Нептун веде її до
 *    12 хв від часу фіксації.
 * 2. Ціль із ПРИПУЩЕНИМ курсом не рухалась зовсім, а таких — більшість.
 *
 * ## Чому рухати припущений курс тепер чесно
 *
 * Попередня заборона спиралась на правильну арифметику: якщо ціль пройшла d, то
 * «стояти» помиляється на d, а «тягнути на ту саму d під кутом θ до правди» — на
 * 2·d·sin(θ/2), і при заміряній медіані θ = 72° тягнути гірше. Але ця
 * арифметика — для тягнення на ПОВНУ відстань.
 *
 * Нептун тягне припущений курс на зниженій швидкості: для БпЛА 50 км/год проти
 * реальних ~185, тобто на частку p ≈ 0,27 пройденого. Помилка тоді
 * √(1 + p² − 2p·cos θ)·d:
 *
 * | θ (розходження курсу) | стояти | тягнути на 0,27d |
 * | --------------------- | ------ | ---------------- |
 * | 30°                   | 1,00d  | 0,78d            |
 * | 72° (заміряна медіана)| 1,00d  | 0,95d            |
 * | 82° (беззбитковість)  | 1,00d  | 1,00d            |
 * | 180° (найгірше)       | 1,00d  | 1,27d            |
 *
 * Тобто на заміряному розподілі протягування на зниженій швидкості в медіані
 * точніше за нерухому позначку, а найгірший випадок обмежений. До того ж шлях
 * має стелю за часом і відстанню для кожного типу, а коло невизначеності росте
 * на весь протягнутий шлях: карта й далі каже «десь тут», а не «точно тут».
 *
 * ## Порядок довіри до курсу
 *
 * 1. `measured` — курс і швидкість, виміряні з треку (`livePosition`) або
 *    заміряні самим джерелом (`velocity`);
 * 2. `stated` — курс, який джерело називає спостереженим, на швидкості типу;
 * 3. `presumed` — припущений курс на зниженій швидкості;
 * 4. `none` — курсу немає: позначка стоїть на фіксі.
 */

export type DriftBasis = "measured" | "stated" | "presumed" | "none";

export interface Drift {
  lat: number;
  lon: number;
  /** На скільки км протягнуто від останньої фіксації. */
  km: number;
  basis: DriftBasis;
  /** Чи ще рухається (не вперлась у стелю часу чи відстані). */
  moving: boolean;
}

/** Класи руху Нептуна. Наші типи зводимо до них — див. `driftClass`. */
type DriftClass = "uav" | "recon" | "missile" | "fixed" | "unknown";

interface DriftLimits {
  /** Скільки хвилин від фіксації ще тягнемо. */
  maxMin: number;
  /** Найдовший шлях протягування, км. */
  maxKm: number;
  /** Швидкість для курсу, який джерело називає спостереженим, км/год. */
  statedKmh: number;
  /** Швидкість для припущеного курсу, км/год. */
  presumedKmh: number;
}

/*
 * Числа — з клієнта Нептуна, а не наші: мета — та сама картина, що в нього, і
 * будь-яке «покращення» тут знову розвело б дві карти. КАБ, балістику й
 * авіацію за НАЗВАНИМ курсом він не тягне (швидкість 0) — ми теж; за
 * ЗАМІРЯНОЮ швидкістю — тягне в межах стелі, як і ми.
 */
const LIMITS: Record<DriftClass, DriftLimits> = {
  uav: { maxMin: 12, maxKm: 30, statedKmh: 150, presumedKmh: 50 },
  recon: { maxMin: 12, maxKm: 24, statedKmh: 120, presumedKmh: 40 },
  missile: { maxMin: 5, maxKm: 30, statedKmh: 400, presumedKmh: 400 },
  fixed: { maxMin: 4, maxKm: 10, statedKmh: 0, presumedKmh: 0 },
  unknown: { maxMin: 6, maxKm: 10, statedKmh: 80, presumedKmh: 40 },
};

function driftClass(type: ThreatType | undefined): DriftClass {
  switch (type) {
    case "shahed":
    case "reactive":
      return "uav";
    case "recon":
      return "recon";
    case "missile":
    case "cruise":
      return "missile";
    case "kab":
    case "ballistic":
    case "aircraft":
      return "fixed";
    default:
      return "unknown";
  }
}

function still(t: Threat, basis: DriftBasis = "none"): Drift {
  return { lat: t.lat, lon: t.lon, km: 0, basis, moving: false };
}

/**
 * Позиція цілі на момент `now`.
 *
 * Відлік — від часу, яким джерело датує позицію (`since`: для Нептуна це
 * `confirmedAt`, від нього ж рахує і його клієнт), а не від нашого прийому.
 * Інакше ціль, що пролежала п'ять хвилин у чужій базі, стартувала б у нас із
 * нуля й відставала б від тієї самої цілі на карті Нептуна.
 *
 * Функція ТОТАЛЬНА: на будь-якому зіпсованому вході повертає позицію фіксу, а
 * не NaN — позначка з NaN на карті просто зникає, і ніхто цього не помітить.
 */
export function driftPosition(t: Threat, now: number): Drift {
  if (!Number.isFinite(t.lat) || !Number.isFinite(t.lon)) return still(t);
  const anchorAt = Date.parse(t.since || t.lastSeen || "");
  if (!Number.isFinite(anchorAt)) return still(t);
  const minutes = (now - anchorAt) / 60_000;
  if (!(minutes > 0)) return still(t);

  const lim = LIMITS[driftClass(t.type)];
  const q = t.quality ?? EMPTY_QUALITY;
  const heading = typeof t.heading === "number" && Number.isFinite(t.heading) ? t.heading : null;

  let course: { bearing: number; kmh: number; basis: DriftBasis } | null = null;
  const live = livePosition(
    {
      lat: t.lat,
      lon: t.lon,
      ...(t.trail ? { trail: t.trail } : {}),
      ...(q.uncertaintyKm != null ? { uncertaintyKm: q.uncertaintyKm } : {}),
    },
    now,
  );
  if (live.basis === "reckoned" && live.bearingDeg !== null && live.speedKmh !== null) {
    course = { bearing: live.bearingDeg, kmh: live.speedKmh, basis: "measured" };
  } else if (heading !== null && q.speedKmh !== null && q.speedKmh > 0) {
    course = { bearing: heading, kmh: q.speedKmh, basis: "measured" };
  } else if (heading !== null && courseIsObserved(q)) {
    course = { bearing: heading, kmh: lim.statedKmh, basis: "stated" };
  } else if (heading !== null) {
    course = { bearing: heading, kmh: lim.presumedKmh, basis: "presumed" };
  }
  if (!course || !(course.kmh > 0) || !(lim.maxKm > 0)) return still(t);

  const km = Math.min(lim.maxKm, (course.kmh * Math.min(minutes, lim.maxMin)) / 60);
  /*
   * Після стелі позначка СТОЇТЬ там, куди дійшла, а не стрибає назад на фікс.
   * Обидві точки на той момент — оцінки однакової давнини, а стрибок назад
   * читається як «ціль розвернулась», чого ніхто не спостерігав.
   */
  const p = advance(t.lat, t.lon, course.bearing, km);
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return still(t);
  return {
    lat: p.lat,
    lon: p.lon,
    km,
    basis: course.basis,
    moving: minutes < lim.maxMin && km < lim.maxKm,
  };
}
