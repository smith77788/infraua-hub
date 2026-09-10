/**
 * Робота консолі всередині Telegram (Mini App).
 *
 * Telegram відкриває сторінку у власному вебовому вікні й передає їй тему та
 * розміри через `window.Telegram.WebApp`. Без цього консоль усередині Telegram
 * виглядає як чужа сторінка у чужій оболонці: свої кольори поверх теми
 * клієнта, вміст під системною панеллю, кнопка «назад» не працює.
 *
 * Тут — чисті функції без доступу до DOM, щоб їх можна було перевірити
 * тестами. Все, що торкається `window`, лежить у хуку.
 */

export interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
}

export interface TelegramWebApp {
  initData?: string;
  colorScheme?: "light" | "dark";
  themeParams?: TelegramThemeParams;
  viewportStableHeight?: number;
  isExpanded?: boolean;
  ready?: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  BackButton?: { show: () => void; hide: () => void; onClick: (cb: () => void) => void };
}

/**
 * Чи ми справді всередині Telegram.
 *
 * Наявності обʼєкта замало: Telegram лишає його і в звичайному браузері, якщо
 * сторінку відкрито за посиланням із клієнта. Ознака справжнього Mini App —
 * непорожній `initData`, який Telegram підписує й передає лише своєму вікну.
 */
export function isTelegramMiniApp(webApp: TelegramWebApp | undefined): boolean {
  return typeof webApp?.initData === "string" && webApp.initData.length > 0;
}

/**
 * Перекладає тему Telegram у наші CSS-змінні.
 *
 * Повертає лише те, що прийшло: підставляти власні кольори замість відсутніх
 * означало б показати користувачеві тему, якої він не вибирав. Порожній
 * результат — нормальний, тоді лишається наша власна.
 */
export function themeToCssVars(params: TelegramThemeParams | undefined): Record<string, string> {
  if (!params) return {};
  const vars: Record<string, string> = {};
  const put = (name: string, value: string | undefined) => {
    // Telegram інколи шле порожній рядок замість відсутнього кольору.
    if (typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value)) vars[name] = value;
  };
  put("--tg-bg", params.bg_color);
  put("--tg-text", params.text_color);
  put("--tg-hint", params.hint_color);
  put("--tg-link", params.link_color);
  put("--tg-button", params.button_color);
  put("--tg-button-text", params.button_text_color);
  put("--tg-secondary-bg", params.secondary_bg_color);
  return vars;
}

/**
 * Висота, яку насправді можна зайняти.
 *
 * `viewportStableHeight` — це висота без клавіатури й панелей Telegram. Вона
 * менша за `100vh`, і саме тому консоль на весь екран у Mini App їхала під
 * системну панель.
 */
export function stableViewportCss(height: number | undefined): string | null {
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return null;
  return `${Math.round(height)}px`;
}
