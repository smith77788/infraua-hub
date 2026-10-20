/**
 * Де ціль може бути ЗАРАЗ — з урахуванням курсу, а не колом.
 *
 * ## Чому не коло
 *
 * Пунктирне коло «де ціль може бути вже зараз» казало: за час від фіксації
 * ціль пролетіла N км — у будь-який бік. Але курс здебільшого відомий, і
 * ціль, що летить на захід, за ці хвилини не опинилась на сході. Коло
 * показувало незнання там, де знання є: половина його площі лежала ПОЗАДУ
 * цілі. Користувач: «ми знаємо траєкторію — чому ореоли по колу?»
 *
 * ## Що замість
 *
 * Множина можливих позицій = сектор уперед по курсу (на відстань зсуву) ⊕
 * диск заявленого джерелом розкиду (суміш Мінковського). Виходить «крапля»:
 * позаду — лише розкид джерела, попереду — витягнута зона польоту.
 *
 * Суцільне коло (розкид за джерелом) лишається колом свідомо: джерело каже
 * «±10 км» без осі — у якому напрямку воно помиляється, ми не знаємо.
 *
 * ## Ширина сектора — з того, наскільки курс відомий
 *
 * | курс                                  | півкут |
 * | ------------------------------------- | ------ |
 * | заміряний / джерело каже спостережений | ±20°   |
 * | припущений джерелом                    | ±90°   |
 *
 * ±90° для припущеного — не щедрість, а замір: у проєкті заміряно, що
 * припущений курс розходиться з реальним треком у медіані на 72°. Сектор
 * ±60° відрізав би правду в більшості випадків, тобто стверджував би знання,
 * якого немає. Передня півплощина чесна — і все одно прибирає половину кола:
 * ціль не летить назад. Значення — кандидат на калібрування заміром із проду
 * (`drift-accuracy`), а не догма.
 */

export const OBSERVED_SPREAD_DEG = 20;
export const PRESUMED_SPREAD_DEG = 90;

const KM_PER_DEG = 111.32;
/** Крок дискретизації дуг, градуси: на картинці 800 px — гладко, точок мало. */
const STEP_DEG = 10;

type Pt = [number, number];

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Опукла оболонка (монотонний ланцюг). Сектор ≤ 180° ⊕ диск — опуклий, тож оболонка точна. */
function hull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0)
      lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0)
      upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export interface SectorInput {
  lat: number;
  lon: number;
  /** Курс, ° від півночі. */
  courseDeg: number;
  /** Півкут сектора, ° (обрізається до 90: ширший сектор неопуклий і вже не «крапля»). */
  spreadDeg: number;
  /** Скільки ціль могла пролетіти від фіксації, км. */
  driftKm: number;
  /** Розкид позиції за джерелом, км. */
  statedKm: number;
}

/**
 * Контур «краплі» як багатокутник у [lat, lon], або `null` на зіпсованому
 * вході — тоді малюється коло, а не NaN, який на карті просто зник би.
 */
export function driftSector(s: SectorInput): [number, number][] | null {
  const ok = [s.lat, s.lon, s.courseDeg, s.spreadDeg, s.driftKm, s.statedKm].every(Number.isFinite);
  if (!ok || s.driftKm < 0 || s.statedKm < 0) return null;
  const half = Math.min(90, Math.max(0, s.spreadDeg));
  const kx = KM_PER_DEG * Math.cos((s.lat * Math.PI) / 180);
  if (!(kx > 0)) return null;

  // Межа сектора в км (схід, північ): вершина + дуга.
  const sector: Pt[] = [[0, 0]];
  const steps = Math.max(1, Math.ceil((2 * half) / STEP_DEG));
  for (let i = 0; i <= steps; i++) {
    const b = ((s.courseDeg - half + (2 * half * i) / steps) * Math.PI) / 180;
    sector.push([s.driftKm * Math.sin(b), s.driftKm * Math.cos(b)]);
  }
  // ⊕ диск розкиду: кожну точку межі обводимо колом, далі — оболонка.
  const pts: Pt[] = [];
  const ring = Math.max(8, Math.ceil(360 / STEP_DEG));
  for (const [x, y] of sector) {
    if (s.statedKm === 0) pts.push([x, y]);
    else
      for (let i = 0; i < ring; i++) {
        const a = (2 * Math.PI * i) / ring;
        pts.push([x + s.statedKm * Math.sin(a), y + s.statedKm * Math.cos(a)]);
      }
  }
  const h = hull(pts);
  if (h.length < 3) return null;
  return h.map(([x, y]) => [s.lat + y / KM_PER_DEG, s.lon + x / kx]);
}

/** Півкут для курсу: спостережений (чи заміряний) — вузько, припущений — півплощина. */
export function spreadFor(observed: boolean): number {
  return observed ? OBSERVED_SPREAD_DEG : PRESUMED_SPREAD_DEG;
}
