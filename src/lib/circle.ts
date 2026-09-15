/**
 * Коло: «я в порядку» замість двадцяти дзвінків після прильоту.
 *
 * Уся ніша — одномісна. Монітор каже людині про людину, і на цьому
 * закінчується. Але в реальності після кожного удару відбувається те саме:
 * десятки мільйонів людей одночасно пишуть «ти як?» рідним, мережа лягає,
 * відповідь іде двадцять хвилин, і ці двадцять хвилин — найгірші в добі.
 *
 * Це не проблема звʼязку, це проблема того, що ніхто не зробив для неї місця.
 * Тут воно є: кілька людей заводять коло, і після тривоги кожен одним дотиком
 * каже «я в порядку». Решта бачить це в одному повідомленні, не питаючи.
 *
 * ## Межі, узяті свідомо
 *
 * • Коло НЕ показує чужі координати. Ніколи. Видно лише імʼя, яке людина сама
 *   назвала, і час її відмітки. Місце розташування рідних — саме те, чого не
 *   можна зливати в чат, який можна переслати.
 * • Мовчання НЕ тлумачиться. «Не відповів» — це «не відповів», а не «щось
 *   сталося»: телефон розрядився, людина спить, немає мережі. Припущення тут
 *   коштувало б комусь ночі жаху на порожньому місці.
 * • Вступ — лише за кодом, який дає учасник. Жодного пошуку людей.
 */

import { escapeHtml } from "./telegram";

export interface CircleMemberView {
  chatId: number;
  name: string;
  /** Коли людина востаннє відмітилась. `null` — ще жодного разу. */
  okAt: number | null;
}

export interface Circle {
  code: string;
  name: string;
  ownerChatId: number;
  members: number[];
  createdAt: string;
}

/** Скільки відмітка вважається свіжою: після тривоги питають саме про «зараз». */
export const OK_FRESH_MS = 6 * 60 * 60 * 1000;

/**
 * Код кола — те, що диктують у телефон.
 *
 * Тому без цифр 0/1 і літер O/I/L: «нуль» і «О» на слух не відрізняються, а
 * помилка в коді означає, що людина мовчки не потрапить у коло рідних.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function makeCircleCode(seed: number): string {
  let n = Math.abs(Math.trunc(seed)) || 1;
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += CODE_ALPHABET[n % CODE_ALPHABET.length];
    n = Math.trunc(n / CODE_ALPHABET.length) + 7919 * (i + 1);
  }
  return out;
}

/** Нормалізує введений код: регістр і схожі символи прощаємо, решту — ні. */
export function normalizeCircleCode(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  // Після заміни 0 і 1 у коді бути не може — вони не в абетці. Значить, людина
  // продиктувала «о» замість «O»-подібного: повертаємо назад у абетку.
  const restored = cleaned.replace(/0/g, "Q").replace(/1/g, "J");
  return /^[A-Z0-9]{6}$/.test(restored) ? restored : null;
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "щойно";
  if (min < 60) return `${min} хв тому`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} год тому` : `${Math.floor(h / 24)} дн тому`;
}

/**
 * Стан кола.
 *
 * Порядок навмисний: спершу ті, хто ще не відмітився. Це єдина причина
 * відкрити цей екран — подивитись, кого ще немає.
 */
/*
 * Усе, що прийшло від людини, йде в повідомлення лише через `escapeHtml`.
 *
 * Повідомлення кола шлються з `parse_mode: "HTML"`, а імена — і своє, і назва
 * кола — людина задає сама. Без екранування це давало три різні поразки, і
 * найгірша з них тиха:
 *
 *   • `<a href="…">Мама</a>` — чуже посилання в чаті з виглядом нашого;
 *   • `Родина</b> ⚠️ <b>УВАГА` — підроблений текст від імені бота;
 *   • `<b` — зламана розмітка, Telegram відхиляє повідомлення ЦІЛКОМ, і
 *     «я в порядку» просто не доходить до рідних. Саме заради цього рядка
 *     коло й існує, тож зламати його — зламати всю функцію.
 */
export function renderCircle(
  circle: Circle,
  members: readonly CircleMemberView[],
  now: number,
): string {
  const fresh = (m: CircleMemberView) => m.okAt !== null && now - m.okAt <= OK_FRESH_MS;
  const waiting = members.filter((m) => !fresh(m));
  const done = members.filter(fresh);

  const lines = [
    `👨‍👩‍👧 <b>${escapeHtml(circle.name)}</b>`,
    "",
    `Відмітились: <b>${done.length}</b> з <b>${members.length}</b>`,
    "",
  ];

  for (const m of done) lines.push(`✅ ${escapeHtml(m.name)} — ${ago(now - (m.okAt ?? now))}`);
  for (const m of waiting) {
    const name = escapeHtml(m.name);
    lines.push(m.okAt === null ? `⬜️ ${name} — ще не відмічався` : `⬜️ ${name}`);
  }

  lines.push("");
  // Найважливіший рядок екрана. Без нього порожній квадратик читається як
  // «з людиною щось сталося» — а він означає рівно «людина не тиснула кнопку».
  lines.push(
    "<i>Порожня позначка означає лише те, що людина не відмічалась: розряджений телефон, сон, немає мережі. Це не сигнал про біду.</i>",
  );
  lines.push("");
  lines.push(`Код для запрошення: <code>${escapeHtml(circle.code)}</code>`);
  return lines.join("\n");
}

export function renderCircleHelp(): string {
  return [
    "👨‍👩‍👧 <b>Коло</b>",
    "",
    "Після тривоги — одна кнопка «я в порядку» замість двадцяти дзвінків. Рідні бачать відмітку, не питаючи.",
    "",
    "<code>/circle нова Родина</code> — створити коло",
    "<code>/circle код ABC123</code> — приєднатись за кодом",
    "",
    "<i>Коло не показує нічиїх координат — лише імʼя й час відмітки.</i>",
  ].join("\n");
}

/** Повідомлення решті кола про чиюсь відмітку. Один рядок — це сповіщення. */
export function renderPeerOk(name: string, circleName: string): string {
  return `✅ <b>${escapeHtml(name)}</b> у порядку · ${escapeHtml(circleName)}`;
}
