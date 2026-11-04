import type { Threat, ThreatType } from "./air";

/**
 * Памʼять підтипу цілі: раз названий реактивним — реактивний до кінця польоту.
 *
 * ## Навіщо
 *
 * Нептун підтипу не дає: реактивний приходить як звичайний «БпЛА». Реактивним
 * (чи «Бандероллю») ціль робить свіжа згадка каналу з назвою її пункту — у
 * вікні `JET_WINDOW_MS` (20 хв), і вікно потрібне, щоб стара згадка не
 * чіплялась до нової хвилі.
 *
 * Але реактивний летить годину-дві, а канал називає його один раз біля
 * кожного міста. Щойно згадка старіла, ціль знову ставала шахедом. Знімок
 * користувача 01.11 0:23 Київ: на карті Київщина–Полтавщина–Черкащина лише
 * шахеди, хоча за пів години до того канали назвали реактивні на Звенигородку,
 * Красилів, Старокостянтинів, Павлоград, Гайсин — і саме ці треки Нептуна ще
 * летіли, вже як «шахеди».
 *
 * ## Правила
 *
 * - Памʼятаємо за id треку джерела. Новий трек того самого дрона отримує тип
 *   через ланцюжок наступників (`successor-chain`), а його id потрапляє сюди
 *   наступного ж кадру.
 * - Лише підвищення: шахед/невідомий → реактивний, а не навпаки. Памʼять не
 *   робить ціль менш небезпечною, ніж її називає джерело.
 * - `TTL_MS` від ОСТАННЬОГО кадру, у якому ціль мала цей тип: довше за
 *   найдовший політ, щоб не загубити тип посеред маршруту, але трек, що зник
 *   з неба, не тягне памʼять у наступну ніч.
 * - Памʼять — на томі (`toState`/`fromState`): без цього кожен деплой посеред
 *   нальоту робив усі реактивні шахедами (заміряно 31.10 22:32 UTC: перший
 *   кадр після рестарту — 48 із 48 шахеди). Раз на добу сервер прибирає
 *   відлетілі треки й переписує файл (`cleanup`).
 */

export const TTL_MS = 3 * 60 * 60_000;

/** Що памʼятаємо і що з чого можна підняти. */
const REMEMBERED: Partial<Record<ThreatType, ReadonlySet<ThreatType>>> = {
  reactive: new Set<ThreatType>(["shahed", "unknown"]),
  banderol: new Set<ThreatType>(["shahed", "reactive", "unknown", "cruise", "missile"]),
};

export class TypeMemory {
  private byId = new Map<string, { type: ThreatType; at: number }>();

  /** Підняти тип цілей, які раніше вже мали названий підтип. */
  apply(threats: readonly Threat[], now: number): Threat[] {
    this.prune(now);
    return threats.map((t) => {
      const m = t.id ? this.byId.get(t.id) : undefined;
      if (!m) return t;
      const from = REMEMBERED[m.type];
      return from?.has(t.type ?? "unknown") ? { ...t, type: m.type, typeFromChannels: true } : t;
    });
  }

  /** Запамʼятати цілі з підтипом із цього кадру. */
  note(threats: readonly Threat[], now: number): void {
    for (const t of threats) {
      if (!t.id || !t.type || !REMEMBERED[t.type]) continue;
      this.byId.set(t.id, { type: t.type, at: now });
    }
  }

  /** Забути підтип треку — коли його спростував замір (`contradictedBySpeed`). */
  forget(id: string): void {
    this.byId.delete(id);
  }

  get size(): number {
    return this.byId.size;
  }

  /**
   * Щоденне прибирання: викинути треки, що відлетіли (старші за `TTL_MS`).
   * Повертає, скільки викинуто, — для журналу й `/api/health`.
   */
  cleanup(now: number): number {
    const before = this.byId.size;
    this.prune(now);
    return before - this.byId.size;
  }

  /** Стан для тому: [id, тип, коли востаннє бачили з цим типом]. */
  toState(now: number): [string, ThreatType, number][] {
    this.prune(now);
    return [...this.byId].map(([id, m]) => [id, m.type, m.at]);
  }

  /**
   * Тотальна: битий чи чужий файл — порожня памʼять, а не виняток. Записи,
   * старші за `TTL_MS`, не відновлюємо: деплой після паузи не має повертати
   * учорашній наліт.
   */
  static fromState(raw: unknown, now: number): TypeMemory {
    const m = new TypeMemory();
    if (!Array.isArray(raw)) return m;
    for (const item of raw) {
      if (!Array.isArray(item)) continue;
      const [id, type, at] = item as unknown[];
      if (typeof id !== "string" || typeof at !== "number" || !Number.isFinite(at)) continue;
      if (typeof type !== "string" || !REMEMBERED[type as ThreatType]) continue;
      if (at > now || now - at > TTL_MS) continue;
      m.byId.set(id, { type: type as ThreatType, at });
    }
    return m;
  }

  /**
   * Злити з іншою памʼяттю: на кожен трек лишається свіжіший запис. Потрібне
   * при відновленні з тому, якщо карта встигла записати кадр раніше.
   */
  absorb(other: TypeMemory): void {
    for (const [id, m] of other.byId) {
      const mine = this.byId.get(id);
      if (!mine || mine.at < m.at) this.byId.set(id, m);
    }
  }

  private prune(now: number): void {
    for (const [id, m] of this.byId) if (now - m.at > TTL_MS) this.byId.delete(id);
  }
}

/**
 * Межа, нижче якої заміряна джерелом швидкість спростовує «реактивний» зі слів
 * каналу: поршнева «Герань» — до ~185 км/год, реактивна — 300+.
 *
 * Досі було навпаки: тип зі слів каналу вважався правдою, а замір —
 * «неправдоподібним для реактивного» і відкидався. Заміряно 01.11 05:55 UTC:
 * Борщагівка — «реактивний (канал)» при заміряних Нептуном 108 км/год.
 */
export const JET_REFUTE_KMH = 200;
/** «Бандероль» — ~500 км/год; заміряні 95 км/год (медіана 04.11) — це не вона. */
export const BANDEROL_REFUTE_KMH = 250;

/*
 * Застосовується двічі: до злиття звітів і ПІСЛЯ нього. Злиття
 * (`successor-chain`, `parallel-merge`) бере найнебезпечніший тип ланцюжка,
 * тобто знову робило реактивним те, що замір щойно спростував. Заміряно
 * 04.11: за тиждень 127 «реактивних» із заміряною Нептуном швидкістю —
 * медіана 109 км/год, як у шахедів (105); «Бандероль» — 95.
 *
 * Підтип від самого джерела треку не чіпаємо: Нептун його не дає, тож усе
 * реактивне й «Бандероль» тут — зі слів каналів.
 */
export function refuteJetBySpeed(threats: readonly Threat[], memory: TypeMemory): Threat[] {
  return threats.map((t) => {
    const limit =
      t.type === "reactive" ? JET_REFUTE_KMH : t.type === "banderol" ? BANDEROL_REFUTE_KMH : 0;
    if (!limit) return t;
    const kmh = t.quality?.speedKmh ?? t.quality?.reportedSpeedKmh;
    if (typeof kmh !== "number" || !(kmh > 0) || kmh >= limit) return t;
    memory.forget(t.id);
    for (const id of t.mergedIds ?? []) memory.forget(id);
    const { typeFromChannels: _drop, ...rest } = t;
    return { ...rest, type: "shahed" };
  });
}
