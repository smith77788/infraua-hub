import { classifyThreatType, type Threat } from "./air";

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
  return messages
    .filter((m) => m.at <= now && now - m.at <= JET_WINDOW_MS)
    .filter((m) => classifyThreatType(m.text) === "reactive")
    .map((m) => norm(m.text));
}

function mentions(text: string, stem: string): boolean {
  // Назва — з початку слова: «Ірпінь» не має знаходитись усередині іншого слова.
  const at = text.indexOf(stem);
  if (at < 0) return false;
  if (at === 0) return true;
  return !new RegExp(`[${LETTER}]`).test(text[at - 1]!);
}

/**
 * Дрони, чий пункт свіжо згадано як «реактивний БпЛА», — реактивні. Решта
 * цілей не змінюється: ракету чи КАБ ця ознака не чіпає, і поршневий дрон
 * без згадки лишається поршневим.
 */
export function applyJetType(threats: readonly Threat[], jetTexts: readonly string[]): Threat[] {
  if (jetTexts.length === 0) return threats as Threat[];
  return threats.map((t) => {
    if (t.type !== "shahed") return t;
    const stem = stemOf(t.name);
    if (!stem) return t;
    return jetTexts.some((x) => mentions(x, stem)) ? { ...t, type: "reactive" } : t;
  });
}
