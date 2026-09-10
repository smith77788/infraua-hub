/**
 * Telegram-бот: розбір оновлень і побудова відповіді.
 *
 * Логіка тут чиста і без мережі — саме тому її можна перевірити тестами, а не
 * лише «поклацати в чаті». Надсилання й обробка HTTP лежать у місці входу
 * (`src/server.ts`).
 *
 * ## Чому вебхук, а не окремий сервіс
 *
 * Консоль уже має публічний HTTPS-домен на Railway — рівно те, чого вимагає
 * Telegram. Окремий сервіс під бота коштував би грошей і розділив би бота з
 * даними, які він має показувати.
 */

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: { id?: number; type?: string };
    from?: { id?: number; first_name?: string; username?: string };
    text?: string;
  };
}

export interface BotCommand {
  chatId: number;
  command: string;
  args: string;
  /** Тип чату: кнопки Mini App приймаються лише в приватному. */
  chatType: string;
}

/**
 * Дістає команду з оновлення.
 *
 * `null` означає «нічого робити не треба» — і це нормальний, найчастіший
 * випадок: Telegram шле оновлення про редагування, вступи в чат, реакції.
 * Відповідати на все підряд означало б спамити.
 */
export function parseCommand(update: unknown): BotCommand | null {
  if (typeof update !== "object" || update === null) return null;
  const message = (update as TelegramUpdate).message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  if (typeof chatId !== "number" || typeof text !== "string") return null;

  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const chatType = message?.chat?.type ?? "private";

  // У групах команда приходить як `/status@Radar_UAbot` — суфікс треба зняти,
  // інакше бот у групі не відповідає ніколи.
  const [head, ...rest] = trimmed.split(/\s+/);
  const command = head!.slice(1).split("@")[0]!.toLowerCase();
  if (!command) return null;

  return { chatId, command, args: rest.join(" "), chatType };
}

/**
 * Перевірка секрету вебхука.
 *
 * Telegram надсилає його заголовком `X-Telegram-Bot-Api-Secret-Token`, якщо він
 * заданий при `setWebhook`. Без перевірки будь-хто, хто знає адресу, може
 * надсилати підроблені оновлення — адреса ж не таємниця.
 *
 * Порівняння постійного часу: звичайне `===` виходить із циклу на першому
 * розбіжному байті, і за часом відповіді секрет підбирається посимвольно.
 */
export function secretMatches(expected: string | undefined, received: string | null): boolean {
  if (!expected) return false;
  if (typeof received !== "string" || received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  }
  return diff === 0;
}

export interface SituationBrief {
  /** Області з активною тривогою. */
  alarmRegions: string[];
  /** Подій за добу. */
  eventsLastDay: number;
  /** Стан джерел: назва → чи відповідає. */
  sources: { name: string; ok: boolean }[];
  consoleUrl: string;
}

/** Екранування для parse_mode=HTML: інакше назва з `&` ламає повідомлення. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderStatus(brief: SituationBrief): string {
  const lines: string[] = [];

  if (brief.alarmRegions.length > 0) {
    lines.push(`🔴 <b>Повітряна тривога</b> — ${brief.alarmRegions.length} обл.`);
    // Довгий перелік ріже саме повідомлення, тож обмежуємо і кажемо, що
    // обмежили: «і ще 7» чесніше, ніж мовчки обрізаний список.
    const shown = brief.alarmRegions.slice(0, 8).map(escapeHtml);
    lines.push(
      shown.join(", ") +
        (brief.alarmRegions.length > 8 ? ` і ще ${brief.alarmRegions.length - 8}` : ""),
    );
  } else {
    lines.push("🟢 <b>Активних тривог немає</b>");
  }

  lines.push("");
  lines.push(`Подій за добу: <b>${brief.eventsLastDay}</b>`);

  const down = brief.sources.filter((s) => !s.ok);
  lines.push(
    down.length === 0
      ? `Джерела: усі ${brief.sources.length} відповідають`
      : `Джерела: не відповідають — ${down.map((s) => escapeHtml(s.name)).join(", ")}`,
  );

  lines.push("");
  lines.push(`<a href="${brief.consoleUrl}">Відкрити консоль</a>`);
  return lines.join("\n");
}

export function renderStart(consoleUrl: string): string {
  return [
    "<b>RADAR UA</b> — моніторинг критичної інфраструктури.",
    "",
    "Показує обʼєкти енергетики, води, транспорту та звʼязку, події з NASA, USGS і GDACS, повітряні тривоги, та граф залежностей із моделюванням відключень.",
    "",
    "Кожен звʼязок у графі позначений: спостережений із реальних ЛЕП чи виведений за припущенням. Це не косметика — висновок, що стоїть на здогадці, має виглядати інакше за висновок на факті.",
    "",
    "/status — поточна обстановка",
    "/help — що вміє бот",
    "",
    `<a href="${consoleUrl}">Відкрити консоль</a>`,
  ].join("\n");
}

export function renderHelp(consoleUrl: string): string {
  return [
    "<b>Команди</b>",
    "",
    "/status — тривоги, події за добу, стан джерел",
    "/start — про систему",
    "/help — цей текст",
    "",
    `Повна картина — у консолі: <a href="${consoleUrl}">${escapeHtml(consoleUrl)}</a>`,
  ].join("\n");
}

/** Відповідь на невідому команду. Мовчати — гірше: виглядає як поломка. */
export function renderUnknown(command: string): string {
  return `Не знаю команди <code>/${escapeHtml(command)}</code>. Спробуйте /help`;
}

/**
 * Кнопка, що відкриває консоль як Mini App.
 *
 * Telegram приймає `web_app` у клавіатурі **лише в приватному чаті** — у групі
 * такий запит відхиляється цілком, і повідомлення не доходить взагалі. Тому в
 * групі повертається `undefined`, і текст іде без кнопки: посилання в ньому
 * все одно є.
 */
export function miniAppKeyboard(
  url: string,
  chatType: string,
): { inline_keyboard: { text: string; web_app: { url: string } }[][] } | undefined {
  if (chatType !== "private") return undefined;
  return { inline_keyboard: [[{ text: "Відкрити консоль", web_app: { url } }]] };
}
