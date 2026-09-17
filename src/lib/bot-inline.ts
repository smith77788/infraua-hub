/**
 * Inline-режим: радар працює в будь-якому чаті, куди бота ніхто не додавав.
 *
 * Це найдешевший канал поширення, який взагалі існує в Telegram. Людина в
 * сімейному чаті пише `@Radar_UAbot Харків` і надсилає живу картку обстановки.
 * Її бачать усі в чаті — разом із кнопкою «перевірити свою адресу». Жодного
 * додавання бота в групу, жодного дозволу адміністратора, жодної реклами: одна
 * людина приносить бота в чат, у якому він досі не був.
 *
 * Тому картка мусить бути самодостатньою: хто її прочитав, має зрозуміти
 * обстановку й звідки число, навіть якщо про бота чує вперше.
 *
 * Тут — тільки побудова відповіді (чиста функція). Надсилання — у сервері.
 */

import type { Threat, ThreatType } from "./air";
import { OBLASTS } from "./alerts";
import { oblastOf } from "./channel-post";
import { distanceKm } from "./infra-types";
import { swarmForecastFor } from "./swarm-forecast";
import { escapeHtml } from "./telegram";

const OBLAST_CENTERS = Object.values(OBLASTS)
  .filter((o, i, arr) => arr.findIndex((x) => x.code === o.code) === i)
  .map((o) => ({ name: o.name, lat: o.lat, lon: o.lon }));

const COURSE_8 = [
  "на північ",
  "на північний схід",
  "на схід",
  "на південний схід",
  "на південь",
  "на південний захід",
  "на захід",
  "на північний захід",
];

/**
 * Рядок руху рою — «куди й коли», за реально баченим рухом (swarm-forecast:
 * відсів стрибків, лише спостережений курс). `null`, коли рій розсипаний або
 * руху ще не видно — тоді про напрямок чесно мовчимо.
 */
function movementLine(threats: readonly Threat[], now: number): string | null {
  const f = swarmForecastFor(threats, now, OBLAST_CENTERS, { horizonMin: 40, cityRadiusKm: 55 });
  if (!f || f.swarm.coherence < 0.6) return null;
  const course = COURSE_8[Math.round((((f.swarm.bearingDeg % 360) + 360) % 360) / 45) % 8]!;
  const lead = f.reach[0];
  return lead
    ? `🧭 рух ${course} — на черзі: ${escapeHtml(lead.name)} (~${lead.etaMin} хв)`
    : `🧭 рух ${course}, ~${f.swarm.speedKmh} км/год`;
}

export interface InlineQuery {
  id: string;
  userId: number | undefined;
  query: string;
}

interface TelegramInlineUpdate {
  inline_query?: { id?: string; from?: { id?: number }; query?: string };
}

export function parseInlineQuery(update: unknown): InlineQuery | null {
  if (typeof update !== "object" || update === null) return null;
  const q = (update as TelegramInlineUpdate).inline_query;
  if (!q || typeof q.id !== "string") return null;
  return { id: q.id, userId: q.from?.id, query: (q.query ?? "").trim() };
}

const TYPE_LABEL: Record<ThreatType, string> = {
  shahed: "шахеди",
  reactive: "реактивні шахеди",
  cruise: "крилаті ракети",
  missile: "ракети",
  ballistic: "балістика",
  kab: "КАБи",
  recon: "розвідники",
  aircraft: "борти",
  unknown: "цілі",
};

/**
 * Пошук області за тим, що людина набрала.
 *
 * Збіг шукається по обох формах — офіційній («Харківська область») і живій
 * («Харківщина»), — бо в чаті пишуть другу, а в даних лежить перша. Порівняння
 * за початком рядка після зняття регістру: «харк» має знаходити Харківщину, бо
 * inline-запит набирають на ходу й дописувати назву до кінця ніхто не буде.
 */
export function matchOblast(query: string): { name: string; lat: number; lon: number } | null {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return null;
  for (const o of Object.values(OBLASTS)) {
    const short = o.name.toLowerCase();
    if (short.startsWith(q) || q.startsWith(short)) return { name: o.name, lat: o.lat, lon: o.lon };
  }
  for (const [full, o] of Object.entries(OBLASTS)) {
    if (full.toLowerCase().startsWith(q)) return { name: o.name, lat: o.lat, lon: o.lon };
  }
  return null;
}

function countByType(threats: readonly Threat[]): Map<ThreatType, number> {
  const m = new Map<ThreatType, number>();
  for (const t of threats) {
    const type = t.type ?? "unknown";
    m.set(type, (m.get(type) ?? 0) + 1);
  }
  return m;
}

function typeSummary(threats: readonly Threat[]): string {
  const entries = [...countByType(threats).entries()].sort((a, b) => b[1] - a[1]);
  return entries.map(([type, n]) => `${n} ${TYPE_LABEL[type]}`).join(", ");
}

/** Картка по всій країні. */
export function countryCard(
  threats: readonly Threat[],
  now: number = Date.now(),
): { title: string; text: string } {
  if (threats.length === 0) {
    return {
      title: "Небо чисте",
      text: [
        "🟢 <b>Повітряних цілей не фіксуємо</b>",
        "",
        "<i>за даними OSINT · це не офіційний відбій</i>",
      ].join("\n"),
    };
  }
  const byOblast = new Map<string, number>();
  for (const t of threats) {
    const o = oblastOf(t.lat, t.lon);
    byOblast.set(o, (byOblast.get(o) ?? 0) + 1);
  }
  const top = [...byOblast.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const move = movementLine(threats, now);
  return {
    title: `У небі ${threats.length} — ${top[0]?.[0] ?? ""}`,
    text: [
      `🛰 <b>У небі зараз: ${threats.length}</b>`,
      escapeHtml(typeSummary(threats)),
      ...(move ? ["", move] : []),
      "",
      ...top.map(([name, n]) => `📍 <b>${escapeHtml(name)}</b>: ${n}`),
      "",
      "<i>за даними OSINT · не офіційне джерело</i>",
    ].join("\n"),
  };
}

/** Картка по області: усе в радіусі 90 км від обласного центру. */
export function oblastCard(
  threats: readonly Threat[],
  oblast: { name: string; lat: number; lon: number },
  now: number = Date.now(),
): { title: string; text: string } {
  const near = threats.filter((t) => distanceKm(t, oblast) <= 90);
  if (near.length === 0) {
    return {
      title: `${oblast.name} — чисто`,
      text: [
        `🟢 <b>${escapeHtml(oblast.name)}: цілей не фіксуємо</b>`,
        "",
        "<i>за даними OSINT · це не офіційний відбій</i>",
      ].join("\n"),
    };
  }
  const move = movementLine(near, now);
  return {
    title: `${oblast.name} — ${near.length} у небі`,
    text: [
      `🛸 <b>${escapeHtml(oblast.name)}: ${near.length} у небі</b>`,
      escapeHtml(typeSummary(near)),
      ...(move ? ["", move] : []),
      "",
      "<i>за даними OSINT · не офіційне джерело</i>",
    ].join("\n"),
  };
}

export interface InlineArticle {
  type: "article";
  id: string;
  title: string;
  description: string;
  input_message_content: {
    message_text: string;
    parse_mode: "HTML";
    link_preview_options: { is_disabled: true };
  };
  reply_markup?: { inline_keyboard: { text: string; url: string }[][] };
}

function article(
  id: string,
  card: { title: string; text: string },
  description: string,
  link: string | null,
): InlineArticle {
  return {
    type: "article",
    id,
    title: card.title,
    description,
    input_message_content: {
      message_text: card.text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    },
    ...(link
      ? {
          reply_markup: {
            inline_keyboard: [[{ text: "🎯 Перевірити свою адресу", url: link }]],
          },
        }
      : {}),
  };
}

/**
 * Відповідь на inline-запит.
 *
 * Перший результат завжди відповідає набраному (область, якщо її впізнали),
 * другий — країна. Порядок саме такий, бо перший варіант надсилають, не
 * читаючи списку, — і якщо людина набрала область, вона хоче область.
 */
export function inlineResults(
  threats: readonly Threat[],
  query: string,
  link: string | null,
  now: number = Date.now(),
): InlineArticle[] {
  const out: InlineArticle[] = [];
  const oblast = matchOblast(query);
  if (oblast) {
    out.push(
      article(`o:${oblast.name}`, oblastCard(threats, oblast, now), "обстановка в області", link),
    );
  }
  out.push(article("country", countryCard(threats, now), "обстановка по Україні", link));
  return out;
}
