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
    "<b>Для власника</b>",
    "/admin — панель із кнопками",
    "/layers on · /layers off — перемкнути без кнопок",
    "/purge — прибрати з графа вже завантажені обʼєкти інфраструктури",
    "",
    `Повна картина — у консолі: <a href="${consoleUrl}">${escapeHtml(consoleUrl)}</a>`,
  ].join("\n");
}

/** Відповідь на невідому команду. Мовчати — гірше: виглядає як поломка. */
export function renderUnknown(command: string): string {
  return `Не знаю команди <code>/${escapeHtml(command)}</code>. Спробуйте /help`;
}

/**
 * Перелік команд для меню Telegram (`setMyCommands`).
 *
 * Корінь «команда не викликається»: бот НІКОЛИ не реєстрував свій перелік у
 * Telegram. Без цього кнопка меню й підказка по «/» порожні — команд не видно,
 * тож їх ніби й немає. setMyCommands це виправляє.
 *
 * Публічні команди бачать усі; адміністративні (зокрема /admin) додаються ЛИШЕ
 * у чат власника через scope `chat` — тому в меню власника вони є, а у чужому
 * меню їх немає. Так /admin і зʼявляється, і не світиться стороннім.
 */
export interface TgBotCommand {
  command: string;
  description: string;
}

export function publicCommands(): TgBotCommand[] {
  return [
    { command: "status", description: "Поточна обстановка: тривоги, події, джерела" },
    { command: "start", description: "Про систему та посилання на консоль" },
    { command: "help", description: "Що вміє бот" },
  ];
}

export function adminCommands(): TgBotCommand[] {
  return [
    { command: "admin", description: "Панель власника з кнопками" },
    { command: "layers", description: "Шари інфраструктури: on / off" },
    { command: "purge", description: "Прибрати завантажені обʼєкти з графа" },
  ];
}

/** Повний перелік для власника: спершу адмінські, далі публічні. */
export function ownerCommands(): TgBotCommand[] {
  return [...adminCommands(), ...publicCommands()];
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

/**
 * Власник розгортання — єдиний, хто може крутити вимикачі з чату.
 *
 * Ідентифікатор живе у змінній оточення `TELEGRAM_OWNER_ID`, а не в коді.
 * Двічі навмисно: це персональні дані, яким не місце в публічному репозиторії,
 * і це елемент контролю доступу — змінити його має бути можна, не випускаючи
 * нову збірку.
 *
 * Поки змінна не задана, адміністративних команд **не існує ні для кого** —
 * не «для всіх». Усталене значення відкритого доступу в елементі контролю
 * доступу — це не зручність, а дірка.
 */
export function isOwner(userId: number | undefined, configured: string | undefined): boolean {
  if (!configured || !configured.trim()) return false;
  if (typeof userId !== "number" || !Number.isFinite(userId)) return false;
  return configured.trim() === String(userId);
}

/** Хто надіслав команду. Потрібне окремо від `chatId`: у групі вони різні. */
export function senderId(update: unknown): number | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const id = (update as TelegramUpdate).message?.from?.id;
  return typeof id === "number" ? id : undefined;
}

/**
 * Відповідь тому, хто не власник.
 *
 * Не «команди не існує»: вона існує, і вдавати протилежне означає, що власник,
 * який помилився акаунтом, шукатиме поломку там, де її немає.
 */
export function renderNotOwner(): string {
  return "Ця команда доступна лише власнику розгортання.";
}

export interface LayersState {
  /** Чи віддаються шари зараз — обидві половини разом. */
  enabled: boolean;
  /** Чи дозволило розгортання (змінна оточення). */
  permitted: boolean;
  /** Положення ручки оператора. */
  switchedOn: boolean;
  changedBy?: string | null;
  changedAt?: string | null;
  reason?: string | null;
}

/**
 * Стан вимикача людською мовою.
 *
 * Дві половини показуються нарізно, бо «вимкнено» має два різні наслідки:
 * закриту ручку крутить ця ж команда, а закритий дозвіл — лише дашборд.
 * Одне слово «вимкнено» відправило б власника крутити не те.
 */
export function renderLayers(state: LayersState): string {
  const lines: string[] = [
    state.enabled
      ? "🔴 <b>Шари критичної інфраструктури: УВІМКНЕНО</b>"
      : "🟢 <b>Шари критичної інфраструктури: вимкнено</b>",
    "",
    `Дозвіл розгортання: ${state.permitted ? "є" : "<b>немає</b>"}`,
    `Ручка оператора: ${state.switchedOn ? "увімк" : "вимк"}`,
  ];

  if (state.switchedOn && !state.permitted) {
    lines.push("");
    lines.push(
      "Ручка увімкнена, але розгортання цього не дозволяє — нічого не віддається. " +
        "Щоб дозволити, задайте <code>INFRA_LAYERS=on</code> у змінних консолі та платформи.",
    );
  }

  if (state.changedAt) {
    lines.push("");
    lines.push(
      `Останній оберт: ${escapeHtml(state.changedAt)}` +
        (state.reason ? ` — ${escapeHtml(state.reason)}` : ""),
    );
  }

  lines.push("");
  lines.push("<code>/layers on</code> · <code>/layers off</code>");
  return lines.join("\n");
}

/** Розбір аргументу `/layers`. `null` — аргументу не було, показуємо стан. */
export function parseLayersArg(args: string): boolean | null | "invalid" {
  const value = args.trim().toLowerCase();
  if (!value) return null;
  if (value === "on" || value === "увімк" || value === "1") return true;
  if (value === "off" || value === "вимк" || value === "0") return false;
  return "invalid";
}

/**
 * `withButtons` прибирає підказку про текстову команду: у панелі з кнопками
 * «Підтвердити: /purge yes» поруч із кнопкою «Так, прибрати» — це два різні
 * способи зробити одне, і читач гадає, чи вони роблять те саме.
 */
export function renderPurgePreview(
  wouldRetract: string[],
  sourcesInGraph: string[],
  withButtons = false,
): string {
  if (wouldRetract.length === 0) {
    return [
      "У графі немає партій інфраструктури — прибирати нічого.",
      "",
      sourcesInGraph.length > 0
        ? `Джерела в графі: ${sourcesInGraph.map(escapeHtml).join(", ")}`
        : "Граф порожній.",
    ].join("\n");
  }
  return [
    "<b>Буде прибрано з графа</b>",
    "",
    ...wouldRetract.map((s) => `• <code>${escapeHtml(s)}</code>`),
    "",
    withButtons ? "Це незворотно." : "Це незворотно. Підтвердити: <code>/purge yes</code>",
  ].join("\n");
}

export function renderPurgeDone(
  retracted: { source: string; nodesRemoved: number; edgesRemoved: number }[],
): string {
  if (retracted.length === 0) return "Прибирати не було чого.";
  const nodes = retracted.reduce((n, r) => n + r.nodesRemoved, 0);
  const edges = retracted.reduce((n, r) => n + r.edgesRemoved, 0);
  return [
    "<b>Прибрано з графа</b>",
    "",
    ...retracted.map((r) => `• <code>${escapeHtml(r.source)}</code> — ${r.nodesRemoved} вузлів`),
    "",
    `Разом: ${nodes} вузлів, ${edges} звʼязків.`,
  ].join("\n");
}

/** Коли платформа не налаштована — адмінкоманди спираються саме на неї. */
export function renderNoPlatform(): string {
  return [
    "Платформа не налаштована, а вимикач і граф живуть саме там.",
    "",
    "Задайте <code>PLATFORM_API_URL</code> і <code>PLATFORM_API_KEY</code> у змінних консолі.",
  ].join("\n");
}

/* ─── Адмін-панель із кнопками ──────────────────────────────────────────── */

/**
 * Натискання кнопки.
 *
 * Telegram шле його окремим типом оновлення, не повідомленням, і в ньому є
 * власний `from` — саме він каже, **хто натиснув**. Це не те саме, що автор
 * повідомлення з кнопками: панель можна переслати, і тоді тиснути буде інший.
 * Тому власник звіряється тут наново, а не «один раз, коли показували панель».
 */
export interface CallbackPress {
  callbackId: string;
  userId: number | undefined;
  chatId: number;
  messageId: number;
  data: string;
}

interface TelegramCallbackUpdate {
  callback_query?: {
    id?: string;
    from?: { id?: number };
    message?: { message_id?: number; chat?: { id?: number } };
    data?: string;
  };
}

export function parseCallback(update: unknown): CallbackPress | null {
  if (typeof update !== "object" || update === null) return null;
  const query = (update as TelegramCallbackUpdate).callback_query;
  if (!query) return null;
  const callbackId = query.id;
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = query.data;
  if (typeof callbackId !== "string" || typeof data !== "string") return null;
  if (typeof chatId !== "number" || typeof messageId !== "number") return null;
  return { callbackId, userId: query.from?.id, chatId, messageId, data };
}

/**
 * Коди кнопок.
 *
 * Короткі, бо Telegram дає на `callback_data` 64 байти — і це не запас, а
 * стеля, за якою кнопка просто не працює.
 */
export const ADMIN_ACTIONS = {
  layersOn: "l:on",
  layersOff: "l:off",
  purgePreview: "p:dry",
  purgeConfirm: "p:go",
  refresh: "r",
} as const;

export type AdminAction = (typeof ADMIN_ACTIONS)[keyof typeof ADMIN_ACTIONS];

export function isAdminAction(data: string): data is AdminAction {
  return (Object.values(ADMIN_ACTIONS) as string[]).includes(data);
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

/**
 * Кнопки панелі під поточний стан.
 *
 * Показується дія, а не стан: «Увімкнути шари» під вимкненими. Кнопка, що
 * називає поточне положення, читається як «зараз так» рівно настільки ж, як і
 * «натисни, щоб стало так», і половина людей зрозуміє її навпаки — а ціна
 * помилки тут в один бік значно вища.
 */
export function adminKeyboard(state: LayersState): InlineKeyboard {
  const rows: InlineButton[][] = [];

  if (state.switchedOn) {
    rows.push([{ text: "🔻 Вимкнути шари", callback_data: ADMIN_ACTIONS.layersOff }]);
  } else {
    rows.push([
      {
        // Дозволу немає — кнопка лишається, але чесно каже, що сама по собі
        // нічого не покаже: інакше натиснув, нічого не змінилося, і виглядає
        // як поломка.
        text: state.permitted ? "🔺 Увімкнути шари" : "🔺 Увімкнути (дозволу немає)",
        callback_data: ADMIN_ACTIONS.layersOn,
      },
    ]);
  }

  rows.push([{ text: "🧹 Прибрати з графа", callback_data: ADMIN_ACTIONS.purgePreview }]);
  rows.push([{ text: "🔄 Оновити", callback_data: ADMIN_ACTIONS.refresh }]);
  return { inline_keyboard: rows };
}

/** Кнопки підтвердження чистки. Незворотну дію не роблять одним дотиком. */
export function purgeKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "⚠️ Так, прибрати", callback_data: ADMIN_ACTIONS.purgeConfirm }],
      [{ text: "← Назад", callback_data: ADMIN_ACTIONS.refresh }],
    ],
  };
}

export function renderAdminPanel(state: LayersState): string {
  return (
    ["<b>⚙️ Адмін-панель</b>", "", renderLayers(state)]
      .join("\n")
      // У панелі з кнопками підказка про текстові команди зайва.
      .replace("\n\n<code>/layers on</code> · <code>/layers off</code>", "")
  );
}

/** Короткий спливний напис на самій кнопці. Telegram дає 200 символів. */
export function callbackToast(action: AdminAction, state: LayersState): string {
  switch (action) {
    case ADMIN_ACTIONS.layersOn:
      return state.enabled ? "Шари увімкнено" : "Ручку увімкнено, але дозволу розгортання немає";
    case ADMIN_ACTIONS.layersOff:
      return "Шари вимкнено";
    case ADMIN_ACTIONS.purgePreview:
      return "Перевіряю, що є в графі…";
    case ADMIN_ACTIONS.purgeConfirm:
      return "Прибрано";
    default:
      return "Оновлено";
  }
}
