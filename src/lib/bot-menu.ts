/**
 * Меню бота як inline-кнопки: людина ТИСНЕ, а не згадує й друкує `/команди`.
 *
 * ## Навіщо
 *
 * Слеш-команди — бар'єр: їх треба знати напам'ять, набирати без помилок, а на
 * телефоні під тривогою це зайві секунди й зайва напруга. Кнопка під
 * повідомленням прибирає це геть: усе, що вміє бот, видно й досяжне одним
 * дотиком.
 *
 * ## Чому окремим модулем
 *
 * Розкладка й розбір натиску — чиста функція під тестами, без мережі й Telegram.
 * `server.ts` лише малює цю клавіатуру й, отримавши `cmd:<назва>`, проганяє її
 * через ТОЙ САМИЙ диспетчер команд. Одна логіка на текст і на кнопку — вони не
 * можуть розійтися.
 */

export const MENU_PREFIX = "cmd:";

export interface MenuAction {
  /** Та сама назва команди, що й у текстовому диспетчері (personalCommand). */
  cmd: string;
  label: string;
}

/** Порядок — за важливістю: головне зверху, службове внизу. */
export const MENU_ACTIONS: readonly MenuAction[] = [
  { cmd: "my", label: "📍 Мій радар" },
  { cmd: "status", label: "🌤 Що в небі" },
  { cmd: "shelter", label: "🛡 Укриття поруч" },
  { cmd: "route", label: "🚗 Дорога" },
  { cmd: "calm", label: "🌙 Тихі години" },
  { cmd: "lead", label: "⏱ Запас часу" },
  { cmd: "month", label: "📊 Статистика" },
  { cmd: "place", label: "⭐ Мої місця" },
  { cmd: "circle", label: "👥 Коло" },
  { cmd: "invite", label: "🤝 Запросити" },
  { cmd: "settings", label: "⚙️ Налаштування" },
  { cmd: "help", label: "❓ Довідка" },
];

const VALID = new Set(MENU_ACTIONS.map((a) => a.cmd));

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/** Клавіатура головного меню, `columns` кнопок у рядок. */
export function mainMenuKeyboard(columns = 2): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < MENU_ACTIONS.length; i += columns) {
    rows.push(
      MENU_ACTIONS.slice(i, i + columns).map((a) => ({
        text: a.label,
        callback_data: MENU_PREFIX + a.cmd,
      })),
    );
  }
  return { inline_keyboard: rows };
}

/**
 * Витягує команду з `callback_data` кнопки меню. `null` — це не кнопка меню
 * (хай її розбирають інші обробники) або невідома дія (не виконуємо чужого).
 */
export function parseMenuAction(data: string): string | null {
  if (!data.startsWith(MENU_PREFIX)) return null;
  const cmd = data.slice(MENU_PREFIX.length);
  return VALID.has(cmd) ? cmd : null;
}
