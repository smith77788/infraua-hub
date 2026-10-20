import type { Threat } from "./air";

/**
 * Чи справдилось попередження — облік, а не відчуття.
 *
 * ## Навіщо
 *
 * Люди вимикають сповіщення, коли бот будить «не про них». Досі система не
 * знала про себе головного: яка частка її попереджень справджується. Без цього
 * числа будь-яке «тепер точніше» — твердження без заміру, а налаштування
 * порогів — смак.
 *
 * Тут кожне ДОСТАВЛЕНЕ попередження про небезпеку над людиною відкриває
 * запис: де людина, який у неї радіус, коли попередили. Далі кожен обхід
 * дивиться на фактичні фіксації цілей:
 *
 *   • фіксація будь-якої цілі в межах радіуса за вікно — `confirmed`;
 *   • вікно минуло, а жодна ціль у радіус не зайшла — `unconfirmed`.
 *
 * Радіус тут — ТРИВОГИ (`concernRadiusKm`, до 15 км), а не спостереження
 * (усталено 50 км). Попередження й так означає, що ціль у радіусі
 * спостереження, тож перевірка проти нього справджувалась би завжди й не
 * казала б нічого. Питання людини — «чи пролетіло поруч».
 *
 * ## Що це число означає, а що — ні
 *
 * `unconfirmed` — НЕ «хибна тривога». Ціль могли збити, вона могла відвернути
 * або джерело перестало давати її позиції. Число каже рівно одне: «наближення
 * в радіус ми не побачили». Тому й назва не «хибні», а «не підтвердились».
 *
 * Будь-яка ціль, а не лише та, про яку попереджали, — свідомо: Нептун часто
 * заводить нове повідомлення про ту саму ціль новим треком, і збіг за id
 * занижував би підтвердження. Питання людини — «чи було біля мене», а не «чи
 * той самий трек».
 *
 * Відстань — від ЦЕНТРУ фіксації, без поправки на її розкид: поправка на
 * користь підтвердження завищила б точність саме там, де ми найменше знаємо.
 */

export interface OpenAlert {
  chatId: number;
  lat: number;
  lon: number;
  radiusKm: number;
  at: number;
}

export type Outcome = "confirmed" | "unconfirmed";

interface Closed {
  outcome: Outcome;
  /** Хвилини від попередження до першої фіксації в радіусі (для `confirmed`). */
  minToNear: number | null;
}

export interface OutcomeSummary {
  /** Скільки попереджень ще чекають на вирок. */
  open: number;
  /** Скільки вже мають вирок (у ковзному вікні). */
  closed: number;
  confirmed: number;
  unconfirmed: number;
  /** Частка підтверджених серед тих, що мають вирок; `null` — вироків ще нема. */
  confirmedShare: number | null;
  /** Медіана хвилин від попередження до появи цілі в радіусі. */
  medianMinToNear: number | null;
}

/*
 * 45 хв — довше за типовий підліт дрона від кордону області до міста, і
 * набагато довше за ракету. Після цього «ціль таки прилетіла» вже не наслідок
 * того попередження, а нова подія.
 */
export const OUTCOME_WINDOW_MS = 45 * 60_000;
/** Фіксація трохи старша за попередження ще рахується: вона й могла його викликати. */
const FIX_SLACK_MS = 5 * 60_000;
const MAX_OPEN = 5000;
const MAX_CLOSED = 1000;

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(bLat - aLat) / 2) ** 2 +
    Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export class AlertOutcomes {
  private open: OpenAlert[] = [];
  private closed: Closed[] = [];

  /** Попередження ДОСТАВЛЕНО — відкриваємо запис. */
  record(a: OpenAlert): void {
    if (![a.lat, a.lon, a.radiusKm, a.at].every(Number.isFinite) || !(a.radiusKm > 0)) return;
    this.open.push(a);
    // Переповнення — найстаріші без вироку йдуть геть, а не в «не підтвердились»:
    // ми їх не перевірили, і вигадувати їм вирок означало б псувати число.
    if (this.open.length > MAX_OPEN) this.open.splice(0, this.open.length - MAX_OPEN);
  }

  /** Звірити відкриті записи з фактичними фіксаціями цілей на момент `now`. */
  resolve(threats: readonly Threat[], now: number): void {
    const keep: OpenAlert[] = [];
    for (const a of this.open) {
      const near = threats.some((t) => {
        // Лише фіксація, датована не раніше за попередження (з малим запасом):
        // давня позначка поруч нічого не каже про те, чи справдилось ЦЕ
        // попередження. Без дати — не рахуємо зовсім.
        const fixAt = Date.parse(t.since);
        return (
          Number.isFinite(fixAt) &&
          fixAt >= a.at - FIX_SLACK_MS &&
          Number.isFinite(t.lat) &&
          Number.isFinite(t.lon) &&
          haversineKm(a.lat, a.lon, t.lat, t.lon) <= a.radiusKm
        );
      });
      if (near) this.close({ outcome: "confirmed", minToNear: Math.max(0, (now - a.at) / 60_000) });
      else if (now - a.at > OUTCOME_WINDOW_MS)
        this.close({ outcome: "unconfirmed", minToNear: null });
      else keep.push(a);
    }
    this.open = keep;
  }

  private close(c: Closed): void {
    this.closed.push(c);
    if (this.closed.length > MAX_CLOSED) this.closed.splice(0, this.closed.length - MAX_CLOSED);
  }

  summary(): OutcomeSummary {
    const confirmed = this.closed.filter((c) => c.outcome === "confirmed");
    const closed = this.closed.length;
    const lead = median(confirmed.map((c) => c.minToNear ?? 0));
    return {
      open: this.open.length,
      closed,
      confirmed: confirmed.length,
      unconfirmed: closed - confirmed.length,
      confirmedShare: closed ? Math.round((confirmed.length / closed) * 100) / 100 : null,
      medianMinToNear: lead === null ? null : Math.round(lead * 10) / 10,
    };
  }
}
