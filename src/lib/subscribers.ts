/**
 * Персональний радар: хто підписаний, на що і коли його можна будити.
 *
 * Чому це головна річ у боті. Канал відповідає на питання «що в небі над
 * країною». Людину ж цікавить рівно одне: «чи летить це на МЕНЕ». Різниця не
 * косметична — вона й вирішує, тримають бота на телефоні чи вимикають після
 * третьої непотрібної нічної нотифікації.
 *
 * Тому рішення «будити чи мовчати» винесене сюди, в чисту функцію, і покрите
 * тестами. Зіпсувати його дорого в обидва боки: промовчати про вхідну ціль —
 * не спрацювати тоді, коли єдиний раз і треба; розбудити зайвий раз — і бота
 * вимкнуть, після чого він не спрацює вже ніколи.
 *
 * Саме сховище (файл на диску) — окремо, у `subscriber-store.ts`: тут немає ні
 * мережі, ні файлової системи, ні годинника, крім переданого часу.
 */

import type { DangerIndex, DangerLevel, PersonalAssessment } from "./advisory";
import type { ThreatType } from "./air";
import { kyivHour } from "./kyiv";

/** На що будити. Порядок — від найвужчого до найширшого. */
export type AlertTier = "critical" | "inbound" | "all";

/** Що дозволено вночі (23:00–07:00 за Києвом). */
export type NightMode = "critical" | "all" | "silent";

export interface SubscriberPoint {
  lat: number;
  lon: number;
  /** Людська назва точки — найближчий обласний центр, не адреса. */
  label: string;
}

export interface Subscriber {
  chatId: number;
  /** `null` — людина написала боту, але точку ще не дала. */
  point: SubscriberPoint | null;
  radiusKm: number;
  tier: AlertTier;
  night: NightMode;
  /** Пауза без втрати налаштувань: `/stop` вимикає, `/my` вмикає назад. */
  muted: boolean;
  /** Власний код запрошення. */
  code: string;
  /** Код того, хто запросив (якщо прийшов за посиланням). */
  ref: string | null;
  invited: number;
  joinedAt: string;
  /** Стан останнього сповіщення — щоб не повторювати те саме. */
  lastAlertAt: number;
  lastAlertIds: string[];
  lastLevel: DangerLevel | null;
}

/** Типи, заради яких будять навіть того, хто просив тиші. */
export const CRITICAL_TYPES: ReadonlySet<ThreatType> = new Set<ThreatType>([
  "ballistic",
  "missile",
  "cruise",
  "kab",
]);

export const DEFAULT_RADIUS_KM = 50;
/** Мінімальна пауза між сповіщеннями про ту саму картину. */
export const ALERT_COOLDOWN_MS = 8 * 60 * 1000;
/**
 * Жорстка підлога між будь-якими двома сповіщеннями.
 *
 * Дедуп за ідентифікаторами цілей тримається на тому, що джерело зберігає id
 * треку між опитуваннями. Це припущення, а не гарантія: варто джерелу
 * перестворити трек з новим id — і «нова ціль» спрацює на тій самій фізичній
 * цілі. Тому поверх дедупу стоїть проста часова підлога. Ескалація рівня її
 * пробиває: саме заради цього випадку бот і потрібен.
 */
export const ALERT_FLOOR_MS = 4 * 60 * 1000;

/**
 * Код запрошення з `chatId`.
 *
 * Не сам `chatId` у base36: тоді посилання одного підписника видавало б
 * Telegram-ідентифікатор іншого. Перемішування (той самий множник, що в
 * `seedFrom` каналу) робить код стабільним і не оборотним оком; від колізій
 * захищає перевірка при погашенні — власник коду шукається в сховищі, а не
 * обчислюється назад.
 */
export function refCode(chatId: number): string {
  let h = 2166136261;
  const s = String(chatId);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(0, 7);
}

export function newSubscriber(chatId: number, at: string, ref: string | null = null): Subscriber {
  return {
    chatId,
    point: null,
    radiusKm: DEFAULT_RADIUS_KM,
    tier: "inbound",
    night: "critical",
    muted: false,
    code: refCode(chatId),
    ref: ref && ref !== refCode(chatId) ? ref : null,
    invited: 0,
    joinedAt: at,
    lastAlertAt: 0,
    lastAlertIds: [],
    lastLevel: null,
  };
}

/** Година за Києвом живе в `kyiv.ts` — її ділять і бот, і канал. */
export { kyivHour };

/** Ніч — 23:00–06:59 за Києвом. */
export function isNight(hourKyiv: number): boolean {
  return hourKyiv >= 23 || hourKyiv < 7;
}

export interface AlertDecision {
  send: boolean;
  /** Чому саме так — це видно в логах і в `/why`, тож формулювання людські. */
  reason: string;
  /** Цілі, про які йдеться (ідентифікатори — для дедупу наступного разу). */
  ids: string[];
  level: DangerLevel;
}

/**
 * Будити чи мовчати.
 *
 * Порядок умов — від дешевих до дорогих, і кожна названа окремо, бо «не
 * надіслано» без причини читається як поломка.
 *
 * Ключове правило — **ескалація пробиває паузу**. Якщо рівень небезпеки виріс
 * (наприклад, до шахедів додалась балістика або час до підльоту впав), людину
 * повідомляють навіть усередині восьмихвилинної паузи: саме цей момент і є
 * той єдиний, заради якого бота тримають.
 */
export function decideAlert(
  sub: Subscriber,
  assess: PersonalAssessment,
  danger: DangerIndex,
  now: number,
  hourKyiv: number,
): AlertDecision {
  const level = danger.level;
  if (sub.muted) return { send: false, reason: "підписку поставлено на паузу", ids: [], level };
  if (!sub.point) return { send: false, reason: "точку не задано", ids: [], level };

  // Беремо лише те, що йде НА точку і в межах радіуса: ціль, що віддаляється,
  // не привід будити, навіть якщо вона поруч.
  const inbound = assess.nearest.filter((n) => n.inbound && n.distanceKm <= sub.radiusKm);
  if (inbound.length === 0) {
    return { send: false, reason: "нічого не йде на вашу точку", ids: [], level };
  }

  const critical = inbound.filter((n) => CRITICAL_TYPES.has(n.threat.type ?? "unknown"));
  const night = isNight(hourKyiv);

  // Нічний режим звужує те, що вже відібрав tier, і ніколи не розширює.
  let pool = inbound;
  if (sub.tier === "critical") pool = critical;
  if (night) {
    if (sub.night === "silent") {
      return { send: false, reason: "нічний режим: тиша", ids: [], level };
    }
    if (sub.night === "critical") pool = pool.filter((n) => critical.includes(n));
  }
  if (pool.length === 0) {
    return {
      send: false,
      reason: night ? "уночі будимо лише за критичними типами" : "тип цілі нижчий за ваш поріг",
      ids: [],
      level,
    };
  }

  const ids = pool.map((n) => n.threat.id).sort();
  const known = new Set(sub.lastAlertIds);
  const fresh = ids.filter((id) => !known.has(id));
  const escalated = rank(level) > rank(sub.lastLevel);
  const cooling = now - sub.lastAlertAt < ALERT_COOLDOWN_MS;

  if (escalated) return { send: true, reason: "обстановка загострилась", ids, level };
  if (now - sub.lastAlertAt < ALERT_FLOOR_MS) {
    return { send: false, reason: "щойно надсилали сповіщення", ids, level };
  }
  if (cooling && fresh.length === 0) {
    return { send: false, reason: "про ці цілі щойно повідомили", ids, level };
  }
  if (fresh.length === 0) {
    return { send: false, reason: "нових цілей на вашу точку немає", ids, level };
  }
  return { send: true, reason: "нова вхідна ціль", ids, level };
}

const LEVEL_RANK: Record<DangerLevel, number> = { calm: 0, watch: 1, attention: 2, shelter: 3 };
function rank(level: DangerLevel | null): number {
  return level ? LEVEL_RANK[level] : -1;
}

/** Стан після надісланого сповіщення — щоб наступне рішення бачило історію. */
export function markAlerted(sub: Subscriber, decision: AlertDecision, now: number): Subscriber {
  return { ...sub, lastAlertAt: now, lastAlertIds: decision.ids, lastLevel: decision.level };
}

/**
 * Забування: після тиші картина «нова» знову.
 *
 * Без цього людина, яку повідомили о 02:00, не отримала б сповіщення о 05:00
 * про ті самі за ідентифікатором цілі — хоча між ними була ціла спокійна
 * година, і друга хвиля для неї справді нова.
 */
export const ALERT_FORGET_MS = 45 * 60 * 1000;
export function forgetStale(sub: Subscriber, now: number): Subscriber {
  if (sub.lastAlertAt && now - sub.lastAlertAt > ALERT_FORGET_MS) {
    return { ...sub, lastAlertIds: [], lastLevel: null };
  }
  return sub;
}

/** Розбір значень із кнопок налаштувань. Невідоме — `null`, а не усталене. */
export function parseTier(value: string): AlertTier | null {
  return value === "critical" || value === "inbound" || value === "all" ? value : null;
}
export function parseNight(value: string): NightMode | null {
  return value === "critical" || value === "all" || value === "silent" ? value : null;
}
/** Радіус: від 10 до 200 км. Поза межами — найближча межа, не помилка. */
export function clampRadius(km: number): number {
  if (!Number.isFinite(km)) return DEFAULT_RADIUS_KM;
  return Math.max(10, Math.min(200, Math.round(km)));
}
