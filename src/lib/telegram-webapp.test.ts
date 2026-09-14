import { describe, expect, it } from "bun:test";

import {
  isTelegramMiniApp,
  locationErrorText,
  requestTelegramLocation,
  stableViewportCss,
  themeToCssVars,
} from "./telegram-webapp";

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

describe("requestTelegramLocation", () => {
  it("менеджера немає — це «спитай браузер», а не «доступ закрито»", async () => {
    // Плутати ці дві причини означає вести людину в налаштування Telegram
    // там, де вона просто відкрила звичайну вкладку.
    expect(await requestTelegramLocation(undefined)).toEqual({ ok: false, reason: "unsupported" });
  });

  it("ініціалізує менеджер перед першим використанням", async () => {
    // Без init() виклик getLocation просто не спрацьовує — саме це й виглядало
    // як «натиснув кнопку, нічого не сталося».
    let inited = false;
    const out = await requestTelegramLocation({
      isInited: false,
      init: (cb) => {
        inited = true;
        cb?.();
      },
      getLocation: (cb) => cb({ latitude: 50.45, longitude: 30.52 }),
    });
    expect(inited).toBe(true);
    expect(out).toEqual({ ok: true, lat: 50.45, lon: 30.52 });
  });

  it("вже ініціалізований менеджер не ініціалізується вдруге", async () => {
    let calls = 0;
    await requestTelegramLocation({
      isInited: true,
      init: () => {
        calls += 1;
      },
      getLocation: (cb) => cb({ latitude: 50, longitude: 30 }),
    });
    expect(calls).toBe(0);
  });

  it("null від Telegram означає рівно «доступу не дали»", async () => {
    const out = await requestTelegramLocation({ isInited: true, getLocation: (cb) => cb(null) });
    expect(out).toEqual({ ok: false, reason: "denied" });
  });

  it("вимкнені служби місця — окрема причина, не відмова людини", async () => {
    const out = await requestTelegramLocation({
      isInited: true,
      isLocationAvailable: false,
      getLocation: (cb) => cb(null),
    });
    expect(out).toEqual({ ok: false, reason: "unavailable" });
  });

  it("мовчання Telegram не залишає інтерфейс у стані «шукаю…» назавжди", async () => {
    // Головна причина скарги: без строку кнопка зависала до перезавантаження.
    const out = await requestTelegramLocation({ isInited: true, getLocation: () => {} }, 30);
    expect(out).toEqual({ ok: false, reason: "timeout" });
  });

  it("менеджер, що кидає, теж не вішає інтерфейс", async () => {
    const out = await requestTelegramLocation(
      {
        isInited: true,
        getLocation: () => {
          throw new Error("клієнт старий");
        },
      },
      30,
    );
    expect(out).toEqual({ ok: false, reason: "timeout" });
  });
});

describe("locationErrorText", () => {
  it("кожна причина веде до своєї дії, а не до «спробуйте ще»", () => {
    expect(locationErrorText("denied")).toContain("Увімкніть");
    expect(locationErrorText("unavailable")).toContain("вимкнені в системі");
    expect(locationErrorText("timeout")).toContain("не відповів");
    expect(locationErrorText("unsupported")).toContain("вручну");
  });
});
