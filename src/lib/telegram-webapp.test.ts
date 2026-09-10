import { describe, expect, it } from "bun:test";

import { isTelegramMiniApp, stableViewportCss, themeToCssVars } from "./telegram-webapp";

describe("isTelegramMiniApp", () => {
  it("вимагає підписаний initData, а не сам обʼєкт", () => {
    // Telegram лишає обʼєкт і в звичайному браузері, якщо сторінку відкрито
    // за посиланням із клієнта; ознака справжнього вікна — initData.
    expect(isTelegramMiniApp({ initData: "auth_date=1&hash=abc" })).toBe(true);
    expect(isTelegramMiniApp({ initData: "" })).toBe(false);
    expect(isTelegramMiniApp({})).toBe(false);
    expect(isTelegramMiniApp(undefined)).toBe(false);
  });
});

describe("themeToCssVars", () => {
  it("переносить кольори теми клієнта", () => {
    expect(themeToCssVars({ bg_color: "#101418", text_color: "#ffffff" })).toEqual({
      "--tg-bg": "#101418",
      "--tg-text": "#ffffff",
    });
  });

  it("не підставляє власні кольори замість відсутніх", () => {
    // Інакше користувач побачив би тему, якої не вибирав.
    expect(themeToCssVars({})).toEqual({});
    expect(themeToCssVars(undefined)).toEqual({});
  });

  it("відкидає порожні й неколірні значення", () => {
    expect(themeToCssVars({ bg_color: "", text_color: "не колір" })).toEqual({});
  });
});

describe("stableViewportCss", () => {
  it("дає висоту без панелей клієнта", () => {
    expect(stableViewportCss(742.4)).toBe("742px");
  });

  it("нічого не вигадує, коли висота невідома чи безглузда", () => {
    expect(stableViewportCss(undefined)).toBeNull();
    expect(stableViewportCss(0)).toBeNull();
    expect(stableViewportCss(-10)).toBeNull();
    expect(stableViewportCss(Number.NaN)).toBeNull();
  });
});
