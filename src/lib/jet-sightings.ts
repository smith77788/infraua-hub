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
}

/** Повідомлення з публічного превʼю t.me/s/<канал>: час + текст. */
export function parseChannelPage(html: string): ChannelMessage[] {
  const out: ChannelMessage[] = [];
  for (const chunk of html.split('class="tgme_widget_message_wrap').slice(1)) {
    const time = chunk.match(/<time[^>]*datetime="([^"]+)"/);
    const at = time ? Date.parse(time[1]!) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    const body = chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!body) continue;
    const text = body[1]!
      .replace(/<br\s*\/?>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
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
