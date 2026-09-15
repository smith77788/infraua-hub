/**
 * Черга доставки: що робити, коли попередити треба більше людей, ніж дозволено.
 *
 * ## Число, з якого все випливає
 *
 * Telegram документує для розсилки **близько 30 повідомлень на секунду**
 * (core.telegram.org/bots/faq). Платні розсилки піднімають стелю до 1000/с, але
 * вимагають 100 000 Stars на балансі й 100 000 активних користувачів на місяць.
 *
 * Отже безкоштовно: 30/с — це 1 800 людей за хвилину. Сто тисяч підписників —
 * **близько 55 хвилин** на одне сповіщення. Для повітряної тривоги це не
 * затримка, це відмова: шахед долає за той час 165 кілометрів.
 *
 * Це головна властивість системи, і з неї випливає все інше в цьому модулі.
 *
 * ## Тому: не «слати швидше», а «слати менше й у правильному порядку»
 *
 * 1. **Пріоритет.** Бюджет витрачається спершу на тих, кому в укриття. Коли
 *    черга довша за бюджет, ріжеться хвіст із найнижчим пріоритетом, а не
 *    випадкові люди в кінці масиву. Раніше порядок визначався тим, у якому
 *    порядку підписники лежали у файлі.
 *
 * 2. **Строк придатності.** Сповіщення «~4 хв до вас», доставлене через
 *    двадцять хвилин, гірше за мовчання: воно бреше про час і привчає не
 *    вірити. Прострочене не надсилається взагалі, і це рахується окремо — як
 *    втрата, а не як успіх.
 *
 * 3. **Повага до 429.** Раніше відмову з кодом 429 код просто логував і йшов
 *    далі, тобто в момент перевантаження бив у ту саму стіну щоразу. Telegram
 *    у цій відповіді каже `retry_after` — скільки чекати. Тепер це чекання
 *    справді витримується, і чергу на цей час зупинено всю.
 *
 * Модуль без мережі: надсилання приходить функцією. Тому порядок, ріжучі
 * рішення й реакція на 429 перевіряються тестами, а не спостереженням за
 * живим ботом під нальотом.
 */

/** Документована стеля безкоштовної розсилки, повідомлень/с. */
export const TELEGRAM_BROADCAST_PER_SEC = 30;

/**
 * Пріоритет. Числа зростають із терміновістю — порівнювати треба легко, а от
 * плутати місцями не можна: від порядку залежить, хто отримає попередження
 * першим, коли на всіх не вистачає.
 */
export enum Priority {
  /** Службове: підтвердження, відповіді на дію людини. */
  Routine = 0,
  /** Рух у бік точки, часу ще досить. */
  Watch = 1,
  /** Ціль іде на точку. */
  Attention = 2,
  /** В укриття зараз. */
  Shelter = 3,
}

export interface Envelope<P = unknown> {
  chatId: number;
  priority: Priority;
  /** Коли повідомлення втрачає сенс (мс епохи). */
  expiresAt: number;
  /** Корисне навантаження — модуль у нього не заглядає. */
  payload: P;
}

export interface SendOutcome {
  ok: boolean;
  status: number;
  /** Скільки секунд просить зачекати Telegram (з відповіді 429). */
  retryAfterSec?: number;
}

export type Sender<P> = (envelope: Envelope<P>) => Promise<SendOutcome>;

export interface DeliveryReport {
  sent: number;
  /** Не надіслано, бо втратило сенс раніше, ніж дійшла черга. */
  expired: number;
  /** Відкинуто через брак бюджету — з найнижчим пріоритетом. */
  dropped: number;
  /** Отримувач заблокував бота. */
  blocked: number[];
  /** Скільки разів Telegram просив зачекати. */
  throttled: number;
  failed: number;
}

/**
 * Порядок черги.
 *
 * Спершу пріоритет, далі — найближчий строк. Друге правило важливе саме для
 * рівних: серед двох «в укриття» першим має піти той, кому лишилось менше
 * часу, а не той, хто раніше опинився в масиві.
 */
export function orderQueue<P>(queue: readonly Envelope<P>[]): Envelope<P>[] {
  return [...queue].sort((a, b) => b.priority - a.priority || a.expiresAt - b.expiresAt);
}

/**
 * Скільки повідомлень узагалі можна надіслати за відведений час.
 *
 * Чесна арифметика без запасу «на око»: бюджет — це швидкість на час, і якщо
 * черга довша, різницю хтось не отримає. Краще знати це числом наперед, ніж
 * виявити з мовчання людей.
 */
export function budgetFor(windowMs: number, perSec = TELEGRAM_BROADCAST_PER_SEC): number {
  return Math.max(0, Math.floor((windowMs / 1000) * perSec));
}

/**
 * Скільки часу потрібно, щоб дійти до кожного. Головне число для власника.
 */
export function timeToReachMs(count: number, perSec = TELEGRAM_BROADCAST_PER_SEC): number {
  if (perSec <= 0) return Infinity;
  return Math.ceil((count / perSec) * 1000);
}

export interface DeliveryOptions {
  /** Швидкість, повідомлень/с. */
  perSec?: number;
  /** Скільки часу відведено на цей прохід. */
  windowMs?: number;
  /** Пауза — щоб тести не чекали по-справжньому. */
  sleep?: (ms: number) => Promise<void>;
  /** Годинник — з тієї ж причини. */
  now?: () => number;
  /** Скільки разів пробувати після тимчасової відмови. */
  maxAttempts?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Проганяє чергу з дотриманням швидкості, пріоритету й строків.
 *
 * Свідомо послідовна: паралельні надсилання дали б сплеск понад документовану
 * стелю й повернулись би пачкою 429 — тобто швидше лише на вигляд.
 */
export async function deliver<P>(
  queue: readonly Envelope<P>[],
  send: Sender<P>,
  opts: DeliveryOptions = {},
): Promise<DeliveryReport> {
  const perSec = opts.perSec ?? TELEGRAM_BROADCAST_PER_SEC;
  const windowMs = opts.windowMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const maxAttempts = opts.maxAttempts ?? 2;

  const report: DeliveryReport = {
    sent: 0,
    expired: 0,
    dropped: 0,
    blocked: [],
    throttled: 0,
    failed: 0,
  };

  const ordered = orderQueue(queue);
  const budget = budgetFor(windowMs, perSec);
  // Хвіст, на який бюджету немає, відрізається ОДРАЗУ й рахується як втрата.
  // Тихо не дійти до кінця масиву — це та сама втрата, тільки непомічена.
  const take = ordered.slice(0, budget);
  report.dropped = ordered.length - take.length;

  const gapMs = Math.ceil(1000 / perSec);

  for (const envelope of take) {
    if (now() >= envelope.expiresAt) {
      // Прострочене не шлемо. «~4 хв до вас» через двадцять хвилин — це не
      // запізніле попередження, це неправда про час.
      report.expired += 1;
      continue;
    }

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const outcome = await send(envelope);

      if (outcome.ok) {
        report.sent += 1;
        break;
      }
      if (outcome.status === 403) {
        // Бота заблокували. Повторювати марно — і шкідливо: кожна спроба
        // витрачає бюджет, потрібний тим, хто чекає.
        report.blocked.push(envelope.chatId);
        break;
      }
      if (outcome.status === 429) {
        report.throttled += 1;
        const wait = Math.max(1, outcome.retryAfterSec ?? 1) * 1000;
        // Чекаємо СТІЛЬКИ, СКІЛЬКИ СКАЗАНО, і зупиняємо всю чергу: 429 — це
        // стан бота, а не цього повідомлення.
        await sleep(wait);
        if (now() >= envelope.expiresAt) {
          report.expired += 1;
          break;
        }
        if (attempt >= maxAttempts) {
          report.failed += 1;
          break;
        }
        continue;
      }
      if (attempt >= maxAttempts) {
        report.failed += 1;
        break;
      }
      await sleep(gapMs * attempt);
    }

    await sleep(gapMs);
  }

  return report;
}
