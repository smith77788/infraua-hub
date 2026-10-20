import type { Threat } from "./air";
import { driftPosition, type DriftBasis } from "./threat-drift";

/**
 * Система, яка міряє власну похибку.
 *
 * ## Навіщо
 *
 * Карта рухає цілі між фіксаціями (`threat-drift`), і обґрунтування цього —
 * арифметика на одному заміряному зрізі: «на зниженій швидкості тягнути в
 * медіані точніше, ніж стояти». Арифметика — не замір. Цей модуль перетворює
 * її на замір і робить це постійно, на кожній новій фіксації кожної цілі:
 *
 *   • де ми ПОКАЗУВАЛИ ціль у момент нової фіксації (рух за моделлю);
 *   • де стояла б нерухома позначка (стара фіксація);
 *   • де ціль насправді зафіксували.
 *
 * Дві відстані до правди — і видно, чи модель руху справді краща, для кожного
 * типу курсу окремо. Якщо для припущеного курсу виявиться гірше — це покаже
 * сам прод, а не здогадка, і рішення про рух можна буде переглянути цифрою.
 *
 * ## Чому шум «правди» не псує порівняння
 *
 * Нова фіксація теж неточна (джерело саме каже ±4…50 км). Але шум у ній
 * однаковий для обох кандидатів і від них не залежить, тож на великій вибірці
 * він зсуває обидві похибки, а не їхню РІЗНИЦЮ. Тому головне число тут —
 * частка випадків, де рух ближчий до правди (`driftWins`), а не абсолютні км.
 */

export interface DriftSample {
  basis: Exclude<DriftBasis, "none">;
  /** Скільки хвилин минуло між фіксаціями. */
  minutes: number;
  /** Відстань від показаної (протягнутої) позиції до нової фіксації, км. */
  driftErrKm: number;
  /** Відстань від нерухомої позначки до нової фіксації, км. */
  stillErrKm: number;
}

export interface BasisAccuracy {
  n: number;
  /**
   * Скільки разів модель тягнула ціль, а джерело підтвердило її на ТОМУ Ж
   * місці. У вибірку ці випадки не йдуть — це може бути передрук старого
   * повідомлення, а не новий вимір, — але й мовчки відкинути їх не можна: саме
   * в них рух програє. Тому лічильник стоїть поруч із `driftWins`, і зсув
   * заміру на користь руху видно одразу.
   */
  samePlace: number;
  medianDriftKm: number;
  medianStillKm: number;
  /** Частка випадків, де рух ближчий до правди, ніж нерухома позначка. */
  driftWins: number;
}

/*
 * Межі, в яких порівняння має сенс. Менше 30 с між фіксаціями — це те саме
 * повідомлення, перепідтверджене іншим каналом, а не новий вимір. Понад 20 хв —
 * модель руху давно вперлась у стелю, і порівняння міряло б уже не її.
 */
const MIN_GAP_MIN = 0.5;
const MAX_GAP_MIN = 20;
/** Скільки останніх вимірів тримати на тип курсу: свіжа картина, а не вся історія. */
const WINDOW = 500;

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(b.lat - a.lat) / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Вимір з пари «попередній запис → новий запис» тієї самої цілі, або `null`,
 * якщо це не нова фіксація чи модель цю ціль не рухала (тоді порівнювати
 * нічого: обидва кандидати — та сама точка).
 */
export function sampleFromFix(prev: Threat, next: Threat): DriftSample | null {
  const r = classifyFix(prev, next);
  return r && r !== "samePlace" ? r : null;
}

function classifyFix(prev: Threat, next: Threat): DriftSample | "samePlace" | null {
  const prevAt = Date.parse(prev.since);
  const nextAt = Date.parse(next.since);
  if (!Number.isFinite(prevAt) || !Number.isFinite(nextAt)) return null;
  const minutes = (nextAt - prevAt) / 60_000;
  if (!(minutes >= MIN_GAP_MIN) || minutes > MAX_GAP_MIN) return null;
  const shown = driftPosition(prev, nextAt);
  if (shown.basis === "none" || !(shown.km > 0)) return null;
  if (prev.lat === next.lat && prev.lon === next.lon) return "samePlace";
  const driftErrKm = haversineKm(shown, next);
  const stillErrKm = haversineKm(prev, next);
  if (!Number.isFinite(driftErrKm) || !Number.isFinite(stillErrKm)) return null;
  return { basis: shown.basis, minutes, driftErrKm, stillErrKm };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export class DriftAccuracy {
  private samples = new Map<DriftSample["basis"], DriftSample[]>();
  private samePlace = new Map<DriftSample["basis"], number>();

  record(s: DriftSample): void {
    const list = this.samples.get(s.basis) ?? [];
    list.push(s);
    if (list.length > WINDOW) list.splice(0, list.length - WINDOW);
    this.samples.set(s.basis, list);
  }

  observe(prev: Threat, next: Threat): void {
    const r = classifyFix(prev, next);
    if (r === "samePlace") {
      const basis = driftPosition(prev, Date.parse(next.since)).basis;
      if (basis !== "none") this.samePlace.set(basis, (this.samePlace.get(basis) ?? 0) + 1);
    } else if (r) this.record(r);
  }

  summary(): Partial<Record<DriftSample["basis"], BasisAccuracy>> {
    const out: Partial<Record<DriftSample["basis"], BasisAccuracy>> = {};
    const bases = new Set([...this.samples.keys(), ...this.samePlace.keys()]);
    for (const basis of bases) {
      const list = this.samples.get(basis) ?? [];
      const samePlace = this.samePlace.get(basis) ?? 0;
      if (!list.length && !samePlace) continue;
      const round = (x: number) => Math.round(x * 10) / 10;
      out[basis] = {
        n: list.length,
        samePlace,
        medianDriftKm: round(median(list.map((s) => s.driftErrKm))),
        medianStillKm: round(median(list.map((s) => s.stillErrKm))),
        driftWins: list.length
          ? Math.round(
              (list.filter((s) => s.driftErrKm < s.stillErrKm).length / list.length) * 100,
            ) / 100
          : 0,
      };
    }
    return out;
  }
}
