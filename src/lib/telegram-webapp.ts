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

/**
 * Дані точки від Telegram. Поля, крім координат, пристрій може не дати — і
 * тоді вони `null`, а не відсутні.
 */
export interface TelegramLocationData {
  latitude?: number;
  longitude?: number;
  horizontal_accuracy?: number | null;
}

/**
 * Керування доступом до місця в Telegram (Bot API 8.0+).
 *
 * Існує тому, що всередині вікна Telegram `navigator.geolocation` НЕ ПРАЦЮЄ:
 * у власному WebView немає того діалогу дозволу, який дає браузер, тож виклик
 * або одразу відхиляється, або не викликає жодного зворотного виклику взагалі.
 * Зовні це виглядає рівно як «натиснув кнопку — нічого не сталося»: ні точки,
 * ні помилки, ні пояснення.
 */
export interface TelegramLocationManager {
  isInited?: boolean;
  isLocationAvailable?: boolean;
  isAccessRequested?: boolean;
  isAccessGranted?: boolean;
  init?: (callback?: () => void) => unknown;
  getLocation?: (callback: (data: TelegramLocationData | null) => void) => unknown;
  openSettings?: () => unknown;
}

export interface TelegramWebApp {
  initData?: string;
  LocationManager?: TelegramLocationManager;
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

/**
 * Результат спроби дізнатись місце. Причина названа окремо, бо кожна з них
 * вимагає ІНШОЇ дії від людини, а спільне «не вдалося» не підказує жодної.
 */
export type LocationOutcome =
  | { ok: true; lat: number; lon: number }
  | { ok: false; reason: "unsupported" | "unavailable" | "denied" | "timeout" };

/** Обгортка над зворотним викликом, яка не може зависнути назавжди. */
function withTimeout<T>(
  run: (resolve: (value: T) => void) => void,
  ms: number,
  onTimeout: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const finish = (value: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(onTimeout), ms);
    try {
      run(finish);
    } catch {
      finish(onTimeout);
    }
  });
}

/**
 * Питає місце через Telegram.
 *
 * Три речі, яких бракувало й через які кнопка «нічого не робила»:
 *
 *  1. `LocationManager` треба ІНІЦІАЛІЗУВАТИ перед першим використанням —
 *     без `init()` виклик `getLocation` просто не спрацьовує;
 *  2. кожен зворотний виклик обгорнутий строком. Telegram може не покликати
 *     його ніколи (старий клієнт, зачинене вікно), і без строку інтерфейс
 *     лишався б у стані «шукаю…» до перезавантаження сторінки;
 *  3. `unsupported` повертається окремо від `denied`. Перше означає «спитай
 *     браузер», друге — «доступ треба ввімкнути в налаштуваннях», і плутати їх
 *     означає вести людину не туди.
 */
export async function requestTelegramLocation(
  manager: TelegramLocationManager | undefined,
  timeoutMs = 12_000,
): Promise<LocationOutcome> {
  if (!manager || typeof manager.getLocation !== "function") {
    return { ok: false, reason: "unsupported" };
  }

  if (!manager.isInited && typeof manager.init === "function") {
    const inited = await withTimeout<boolean>(
      (resolve) => manager.init?.(() => resolve(true)),
      timeoutMs,
      false,
    );
    if (!inited) return { ok: false, reason: "timeout" };
  }

  if (manager.isLocationAvailable === false) return { ok: false, reason: "unavailable" };

  const data = await withTimeout<TelegramLocationData | null | "timeout">(
    (resolve) => manager.getLocation?.((d) => resolve(d)),
    timeoutMs,
    "timeout",
  );
  if (data === "timeout") return { ok: false, reason: "timeout" };
  // `null` від Telegram означає рівно одне: доступу не дали.
  if (!data || typeof data.latitude !== "number" || typeof data.longitude !== "number") {
    return { ok: false, reason: "denied" };
  }
  return { ok: true, lat: data.latitude, lon: data.longitude };
}

/**
 * Те саме через браузер — для звичайної вкладки, поза Telegram.
 *
 * Власний строк потрібен і тут: у WebView без дозволу `getCurrentPosition`
 * інколи не кличе ЖОДНОГО зі своїх зворотних викликів, і вбудований `timeout`
 * у таких випадках теж не спрацьовує.
 */
export async function requestBrowserLocation(
  geo: Geolocation | undefined,
  timeoutMs = 12_000,
): Promise<LocationOutcome> {
  if (!geo) return { ok: false, reason: "unsupported" };
  return withTimeout<LocationOutcome>(
    (resolve) =>
      geo.getCurrentPosition(
        (pos) => resolve({ ok: true, lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => resolve({ ok: false, reason: "denied" }),
        { timeout: timeoutMs, maximumAge: 60_000 },
      ),
    timeoutMs + 1000,
    { ok: false, reason: "timeout" },
  );
}

/** Пояснення для людини. Кожна причина веде до своєї дії, а не до «спробуйте ще». */
export function locationErrorText(
  reason: "unsupported" | "unavailable" | "denied" | "timeout",
): string {
  switch (reason) {
    case "unavailable":
      return "Пристрій не дає координат — служби місця вимкнені в системі.";
    case "denied":
      return "Доступ до місця не надано. Увімкніть його для цього бота — або вкажіть область вручну.";
    case "timeout":
      return "Telegram не відповів на запит місця. Спробуйте ще раз або вкажіть область вручну.";
    default:
      return "Тут визначити місце неможливо. Вкажіть область вручну.";
  }
}
