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
 *
 * ## Друга половина: пропуски
 *
 * Частку підтверджених можна «покращити», просто мовчачи частіше. Тому поруч
 * рахується протилежне: кожне НАБЛИЖЕННЯ — свіжа фіксація цілі в радіусі
 * тривоги людини — отримує вирок:
 *
 *   • `warned` — попередження доставили за вікно до наближення;
 *   • `unwarned` — не доставили: це пропуск системи;
 *   • `quiet` — людина сама попросила тиші (нічний режим «тихо»).
 *
 * Люди на паузі (`/stop`) у облік не входять зовсім: вони відмовились від
 * сповіщень, і їхнє мовчання не є ні влучанням, ні пропуском. Пороги людини
 * (тир, «будити за N хв») у пропуск ЗАРАХОВУЮТЬСЯ — свідомо: ціль за 15 км, про
 * яку людина не дізналась, це пропуск, хай і з її власних налаштувань, і
 * число не має його ховати.
 */

export interface OpenAlert {
  chatId: number;
  lat: number;
  lon: number;
  radiusKm: number;
  at: number;
}

export type Outcome = "confirmed" | "unconfirmed";

export interface Closed {
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
  /** Наближення цілей у радіус тривоги — з вироком щодо попередження. */
  approaches: {
    warned: number;
    unwarned: number;
    quiet: number;
    /** warned / (warned + unwarned); `null` — наближень ще не було. */
    warnedShare: number | null;
  };
}

export type ApproachVerdict = "warned" | "unwarned" | "quiet";

export interface ApproachInput {
  chatId: number;
  lat: number;
  lon: number;
  radiusKm: number;
  /** Коли людині востаннє ДОСТАВИЛИ попередження про її власну точку. */
  lastAlertAt: number | null;
  /** Людина сама попросила тиші на цей момент. */
  quiet: boolean;
}

/** Серіалізований стан — для збереження на томі між перезапусками. */
export interface OutcomeState {
  v: 1;
  open: OpenAlert[];
  closed: Closed[];
  approaches: ApproachVerdict[];
  lastApproach: [number, number][];
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
/** Наближення рахуємо за свіжими фіксаціями: давня позначка — вже не подія. */
const FRESH_FIX_MS = 10 * 60_000;
/*
 * Одне наближення на людину за пів години. Інакше ціль, що кружляє поруч,
 * давала б вирок щообходу, і одна подія важила б, як двадцять.
 */
const APPROACH_DEDUP_MS = 30 * 60_000;

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
  private approaches: ApproachVerdict[] = [];
  private lastApproach = new Map<number, number>();

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

  /**
   * Чи зайшла цього обходу ціль у радіус тривоги людини — і якщо так, чи її
   * попередили. Вирок одразу: попередження, що прийде ПІСЛЯ наближення, вже
   * не попередження.
   */
  approach(a: ApproachInput, threats: readonly Threat[], now: number): ApproachVerdict | null {
    if (![a.lat, a.lon, a.radiusKm].every(Number.isFinite) || !(a.radiusKm > 0)) return null;
    const last = this.lastApproach.get(a.chatId);
    if (last !== undefined && now - last < APPROACH_DEDUP_MS) return null;
    const near = threats.some((t) => {
      const fixAt = Date.parse(t.since);
      return (
        Number.isFinite(fixAt) &&
        now - fixAt <= FRESH_FIX_MS &&
        Number.isFinite(t.lat) &&
        Number.isFinite(t.lon) &&
        haversineKm(a.lat, a.lon, t.lat, t.lon) <= a.radiusKm
      );
    });
    if (!near) return null;
    this.lastApproach.set(a.chatId, now);
    const warned =
      a.lastAlertAt !== null && a.lastAlertAt <= now && now - a.lastAlertAt <= OUTCOME_WINDOW_MS;
    const verdict: ApproachVerdict = warned ? "warned" : a.quiet ? "quiet" : "unwarned";
    this.approaches.push(verdict);
    if (this.approaches.length > MAX_CLOSED)
      this.approaches.splice(0, this.approaches.length - MAX_CLOSED);
    return verdict;
  }

  toState(): OutcomeState {
    return {
      v: 1,
      open: this.open,
      closed: this.closed,
      approaches: this.approaches,
      lastApproach: [...this.lastApproach],
    };
  }

  /**
   * Відновити з тому. Бите чи чуже — ігноруємо цілком: краще почати вибірку
   * з нуля, ніж змішати її з невідомо чим.
   */
  static fromState(raw: unknown): AlertOutcomes {
    const out = new AlertOutcomes();
    if (!raw || typeof raw !== "object" || (raw as { v?: unknown }).v !== 1) return out;
    const st = raw as OutcomeState;
    const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
    if (Array.isArray(st.open))
      out.open = st.open
        .filter((a) => a && [a.chatId, a.lat, a.lon, a.radiusKm, a.at].every(num))
        .slice(-MAX_OPEN);
    if (Array.isArray(st.closed))
      out.closed = st.closed
        .filter(
          (c) =>
            c &&
            (c.outcome === "confirmed" || c.outcome === "unconfirmed") &&
            (c.minToNear === null || num(c.minToNear)),
        )
        .slice(-MAX_CLOSED);
    if (Array.isArray(st.approaches))
      out.approaches = st.approaches
        .filter((v) => v === "warned" || v === "unwarned" || v === "quiet")
        .slice(-MAX_CLOSED);
    if (Array.isArray(st.lastApproach))
      for (const p of st.lastApproach)
        if (Array.isArray(p) && num(p[0]) && num(p[1])) out.lastApproach.set(p[0], p[1]);
    return out;
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
      approaches: (() => {
        const count = (v: ApproachVerdict) => this.approaches.filter((x) => x === v).length;
        const warned = count("warned");
        const unwarned = count("unwarned");
        return {
          warned,
          unwarned,
          quiet: count("quiet"),
          warnedShare:
            warned + unwarned ? Math.round((warned / (warned + unwarned)) * 100) / 100 : null,
        };
      })(),
    };
  }
}
