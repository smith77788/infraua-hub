import { classifyThreatType, type Threat, type ThreatType } from "./air";

/**
 * Реактивний дрон чи поршневий — з текстів каналів, бо Нептун цього не каже.
 *
 * ## Чому окремо
 *
 * Нептун знає підтип (`subtype: "jet"`), але віддає його лише у v2-потоці для
 * власного сайту (findings #105); REST і v1 дають усім дронам одне `uav` /
 * «БпЛА». Тож на нашій карті кожен реактивний Shahed-238 малювався поршневим
 * «Шахедом» — із його швидкістю (185 км/год замість ~500), а отже і з утричі
 * довшим «часом підльоту». Це не косметика: попередження запізнювалось.
 *
 * Канали спостереження пишуть підтип прямо: «🏍 Реактивний БпЛА курсом на
 * Димер». Заміряно 2026-10-20: 67 таких повідомлень у превʼю наших каналів,
 * кожне з точним часом (`<time datetime>`), кілька — за останні пів години.
 *
 * ## Правило
 *
 * Ціль Нептуна-дрон стає реактивною, якщо за останні `JET_WINDOW_MS` хоч один
 * канал назвав «реактивний БпЛА» разом із її населеним пунктом.
 *
 * Помилка тут несиметрична, і в безпечний бік: поршневий дрон, помилково
 * названий реактивним, отримує КОРОТШИЙ час підльоту — людину попередять
 * раніше, а не пізніше. Протилежна помилка (реактивний як поршневий) — та, що
 * була досі, — давала запас часу, якого немає.
 */

/** Наскільки свіжою має бути згадка: старша — вже про іншу хвилю. */
export const JET_WINDOW_MS = 20 * 60_000;

export interface ChannelMessage {
  at: number;
  text: string;
  /** Канал, звідки повідомлення, — для походження пуску (`launch-sightings`). */
  channel?: string;
}

/** Повідомлення з публічного превʼю t.me/s/<канал>: час + текст. */
const NAMED: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
};

/** HTML-сутності превʼю → символи. Невідома іменована — пробіл, як і було. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : " ";
    }
    return NAMED[e.toLowerCase()] ?? " ";
  });
}

export function parseChannelPage(html: string): ChannelMessage[] {
  const out: ChannelMessage[] = [];
  for (const chunk of html.split('class="tgme_widget_message_wrap').slice(1)) {
    const time = chunk.match(/<time[^>]*datetime="([^"]+)"/);
    const at = time ? Date.parse(time[1]!) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    const body = chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!body) continue;
    /*
     * Сутності — ДЕКОДУЄМО, а не замінюємо пробілом: інакше апостроф (`&#39;`)
     * ставав пробілом, і «Звʼягель», «Мʼятин» приходили як «Зв ягель», «М ятин» —
     * назви, яких немає в жодному довіднику (`channel-track`). Переноси рядків
     * лишаємо: переліки «Рівненщина - 1 Клевань - 1 Березне» йдуть рядками.
     */
    const text = decodeEntities(body[1]!.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, " "))
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim();
    if (text) out.push({ at, text });
  }
  return out;
}

const LETTER = "а-яіїєґ";

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/["'`ʼ’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Основа назви для пошуку в тексті: «Бровари» має знайтись і в «у Броварах».
 * Короткі назви не обрізаємо — «Київ» без закінчення ставав би «ки» й
 * збігався з чим завгодно.
 */
function stemOf(place: string): string | null {
  const n = norm(place);
  if (n.length < 4) return null;
  return n.length > 5 ? n.slice(0, -2) : n;
}

/** Нормалізовані тексти свіжих повідомлень про РЕАКТИВНІ дрони. */
export function jetMentions(messages: readonly ChannelMessage[], now: number): string[] {
  return typeMentions(messages, now, "reactive");
}

/** Нормалізовані тексти свіжих повідомлень, що називають саме цей тип. */
export function typeMentions(
  messages: readonly ChannelMessage[],
  now: number,
  type: ThreatType,
): string[] {
  /*
   * Рядок, а не весь допис. Агрегатори пишуть списками — «Реактивний на
   * Любеч / БПЛА на Куликівку», — і коли тип брався з усього допису, слово
   * «реактивний» в одному рядку робило реактивними всі пункти сусідніх рядків.
   * Заміряно на проді 31.10 ~15:40 UTC: 41 такий допис зробив реактивними 62
   * з 80 цілей Нептуна (у самого Нептуна підтипу не було в жодної).
   */
  return messages
    .filter((m) => m.at <= now && now - m.at <= JET_WINDOW_MS)
    .flatMap((m) => m.text.split(/\n|•|;|\|/))
    .filter((line) => classifyThreatType(line) === type)
    .map((line) => norm(line));
}

const NOT_WORD = new RegExp(`[^${LETTER}'ʼ’-]`);

function mentions(text: string, stem: string): boolean {
  // Назва — з початку слова: «Ірпінь» не має знаходитись усередині іншого слова.
  let at = text.indexOf(stem);
  while (at >= 0) {
    const startsWord = at === 0 || !new RegExp(`[${LETTER}]`).test(text[at - 1]!);
    /*
     * І не назва області: «на Харківщині», «Полтавська область» — це край, а
     * не пункт. Основа «харк» інакше робила реактивним Харків від кожної
     * згадки Харківщини.
     */
    const word = text.slice(at).split(NOT_WORD)[0] ?? "";
    const region =
      /щин|^волин/.test(word) ||
      (/^\s+обл/.test(text.slice(at + word.length)) && /ськ(?:а|ій|у|ої)$/.test(word));
    if (startsWord && !region) return true;
    at = text.indexOf(stem, at + 1);
  }
  return false;
}

/**
 * Дрони, чий пункт свіжо згадано як «реактивний БпЛА», — реактивні. Решта
 * цілей не змінюється: ракету чи КАБ ця ознака не чіпає, і поршневий дрон
 * без згадки лишається поршневим.
 */
export function applyJetType(threats: readonly Threat[], jetTexts: readonly string[]): Threat[] {
  return applyMentionedType(threats, jetTexts, "reactive", new Set(["shahed"]));
}

/**
 * «Бандероль» за згадкою в каналах — так само, як реактивність: Нептун у v1 і
 * REST такого підтипу не має, і ціль приходить як «БпЛА» чи «ракета». Тоді
 * вона летіла б зі швидкістю поршневого шахеда (185) або «Калібру» (720)
 * замість ~500, і без ракетного класу — тобто не будила б уночі.
 */
export function applyBanderolType(threats: readonly Threat[], texts: readonly string[]): Threat[] {
  return applyMentionedType(
    threats,
    texts,
    "banderol",
    new Set<ThreatType>(["shahed", "reactive", "unknown", "cruise", "missile"]),
  );
}

function applyMentionedType(
  threats: readonly Threat[],
  texts: readonly string[],
  to: ThreatType,
  from: ReadonlySet<ThreatType>,
): Threat[] {
  if (texts.length === 0) return threats as Threat[];
  return threats.map((t) => {
    if (!from.has(t.type ?? "unknown")) return t;
    const stem = stemOf(t.name);
    if (!stem) return t;
    return texts.some((x) => mentions(x, stem)) ? { ...t, type: to } : t;
  });
}

/** Вікно, у якому рахуємо, чи канали говорять про цілі (`airActivityOf`). */
export const AIR_ACTIVITY_WINDOW_MS = 20 * 60_000;
const ALL_CLEAR = /(?<![а-яіїєґ])(?:відбій|отбой|зняли|сняли|чисто|тихо)/i;

/**
 * Скільки свіжих дописів і каналів говорять про цілі в повітрі.
 *
 * Потрібне, щоб розрізнити «Нептун порожній, бо тихо» і «Нептун порожній,
 * бо збій». 27.10 о 23:39 UTC Нептун віддавав 0 цілей, а за ті самі 30 хв
 * канали дали 42 дописи з названим типом: КАБи на Харківщині, реактивний біля
 * Славутича, дрон у районі Ріпок; за 8 хв Нептун показав 8 цілей.
 *
 * Лише дописи з названим апаратом і без «відбою»: «Відбій по балістиці» —
 * теж допис із типом, але про те, що загрози вже нема.
 */
export function airActivityOf(
  messages: readonly ChannelMessage[],
  now: number,
): { messages: number; channels: number } {
  const recent = messages.filter(
    (m) =>
      m.at <= now &&
      now - m.at <= AIR_ACTIVITY_WINDOW_MS &&
      !ALL_CLEAR.test(m.text) &&
      classifyThreatType(m.text) !== "unknown",
  );
  return { messages: recent.length, channels: new Set(recent.map((m) => m.channel)).size };
}
