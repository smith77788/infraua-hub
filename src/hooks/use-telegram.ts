import { useEffect, useState } from "react";

import {
  isTelegramMiniApp,
  stableViewportCss,
  themeToCssVars,
  type TelegramWebApp,
} from "@/lib/telegram-webapp";

/**
 * Підключення консолі до Telegram Mini App.
 *
 * Усе робиться після монтування, а не під час рендеру: сторінка збирається на
 * сервері, де `window` не існує, а значення з Telegram різні на сервері й у
 * клієнті — це те саме розходження гідратації, яке вже ламало плеєр часу.
 */
export function useTelegram(): { inTelegram: boolean } {
  const [inTelegram, setInTelegram] = useState(false);

  useEffect(() => {
    const webApp = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram
      ?.WebApp;
    if (!isTelegramMiniApp(webApp) || !webApp) return;

    setInTelegram(true);
    // Каже Telegram, що сторінка готова — доти показується його заставка.
    webApp.ready?.();
    // Без цього Mini App відкривається半-екраном і карта отримує смужку.
    webApp.expand?.();

    const root = document.documentElement;
    for (const [name, value] of Object.entries(themeToCssVars(webApp.themeParams))) {
      root.style.setProperty(name, value);
    }
    // Шапка в колір застосунку, інакше зверху лишається смуга чужого кольору.
    const bg = webApp.themeParams?.bg_color;
    if (bg) webApp.setHeaderColor?.(bg);

    const applyHeight = () => {
      const height = stableViewportCss(webApp.viewportStableHeight);
      if (height) root.style.setProperty("--tg-viewport", height);
    };
    applyHeight();

    // Telegram міняє висоту при відкритті клавіатури й розгортанні вікна.
    window.addEventListener("resize", applyHeight);
    return () => window.removeEventListener("resize", applyHeight);
  }, []);

  return { inTelegram };
}
