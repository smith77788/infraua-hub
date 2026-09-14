/**
 * Запрошення: як бот росте без реклами.
 *
 * У цій ніші платний трафік не працює — людина ставить той монітор, який їй
 * переслав хтось, кому вона вірить. Тож єдиний чесний механізм зростання —
 * зробити пересилання вигідним для того, хто пересилає, і вимірюваним для нас.
 *
 * Три речі, і жодної більше:
 *  1. у кожного підписника є власне посилання `t.me/<бот>?start=r_<код>`;
 *  2. `/start` із таким payload зараховує запрошення тому, чий це код;
 *  3. `/invite` показує людині, скільки людей вона вже прикрила.
 *
 * Навмисно НЕ робимо: винагород, рівнів, «запроси 5 друзів — отримай доступ».
 * Радар, за який треба платити запрошеннями, — це радар, який комусь не
 * спрацює. Лічильник тут існує, щоб показати внесок, а не щоб торгувати ним.
 */

import { escapeHtml } from "./telegram";

/** Звідки прийшов перехід — щоб знати, який канал росту працює. */
export type ArrivalSource = "ref" | "channel" | "inline" | "direct";

export interface StartPayload {
  /** Код того, хто запросив (якщо був). */
  ref: string | null;
  from: ArrivalSource;
}

/**
 * Розбір payload із `/start`.
 *
 * Telegram дає до 64 символів і лише `A-Za-z0-9_-`. Формати: `r_<код>` —
 * запрошення від людини; `ch` — перехід із кнопки під постом каналу; `inl` —
 * із картки, надісланої через inline. Невідоме читається як прямий захід, а не
 * як помилка: посилання живуть довго, а формати змінюються.
 */
export function parseStartPayload(args: string): StartPayload {
  const raw = args.trim().split(/\s+/)[0] ?? "";
  if (!raw) return { ref: null, from: "direct" };
  if (raw === "ch" || raw === "channel") return { ref: null, from: "channel" };
  if (raw === "inl" || raw === "inline") return { ref: null, from: "inline" };
  const m = /^r[_-]([a-z0-9]{3,12})$/i.exec(raw);
  if (m) return { ref: m[1]!.toLowerCase(), from: "ref" };
  return { ref: null, from: "direct" };
}

/** Посилання-запрошення. Без username бота вставити нікуди — тоді `null`. */
export function inviteLink(botUsername: string | undefined, code: string): string | null {
  const name = botUsername?.trim().replace(/^@/, "");
  if (!name) return null;
  return `https://t.me/${name}?start=r_${code}`;
}

/** Посилання з-під поста каналу: той самий бот, помічений як «з каналу». */
export function channelLink(botUsername: string | undefined): string | null {
  const name = botUsername?.trim().replace(/^@/, "");
  return name ? `https://t.me/${name}?start=ch` : null;
}

function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

/**
 * Екран `/invite`.
 *
 * Головне тут — не лічильник, а готовий до пересилання текст: людина не має
 * вигадувати, що написати в сімейний чат. Тому саме повідомлення для
 * пересилання йде окремим рядком, який зручно скопіювати цілим.
 */
export function renderInvite(link: string | null, invited: number): string {
  if (!link) {
    return [
      "Посилання-запрошення поки недоступне: бот не знає власного імені в Telegram.",
      "",
      "<i>Це налаштування розгортання (<code>TELEGRAM_BOT_USERNAME</code>), а не ваша помилка.</i>",
    ].join("\n");
  }

  const counted =
    invited > 0
      ? `За вашим посиланням радар уже поставили <b>${invited}</b> ${plural(invited, "людина", "людини", "людей")}.`
      : "За вашим посиланням ще ніхто не прийшов.";

  return [
    "🤝 <b>Покличте своїх</b>",
    "",
    "Найкорисніше, що можна зробити з цим ботом, — переслати його тим, хто спить без телефона під рукою.",
    "",
    counted,
    "",
    "Ваше посилання:",
    `<code>${escapeHtml(link)}</code>`,
    "",
    "Текст, який можна переслати як є:",
    `<blockquote>Постав собі — воно пише, коли ціль іде саме на твою адресу, а не «десь по області». ${escapeHtml(link)}</blockquote>`,
  ].join("\n");
}
