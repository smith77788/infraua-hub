import { describe, expect, it } from "bun:test";

import { MENU_ACTIONS, MENU_PREFIX, mainMenuKeyboard, parseMenuAction } from "./bot-menu";

describe("mainMenuKeyboard", () => {
  it("розкладає всі дії у рядки по стільки, скільки задано", () => {
    const kb = mainMenuKeyboard(2);
    const flat = kb.inline_keyboard.flat();
    expect(flat).toHaveLength(MENU_ACTIONS.length);
    expect(kb.inline_keyboard.every((row) => row.length <= 2)).toBe(true);
  });

  it("кожна кнопка несе callback_data cmd:<назва>", () => {
    for (const row of mainMenuKeyboard().inline_keyboard) {
      for (const btn of row) {
        expect(btn.callback_data.startsWith(MENU_PREFIX)).toBe(true);
        expect(btn.text.length).toBeGreaterThan(0);
      }
    }
  });

  it("callback_data вкладається в ліміт Telegram (64 байти)", () => {
    for (const row of mainMenuKeyboard().inline_keyboard) {
      for (const btn of row) {
        expect(Buffer.byteLength(btn.callback_data, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe("parseMenuAction", () => {
  it("повертає команду для відомої кнопки", () => {
    expect(parseMenuAction("cmd:my")).toBe("my");
    expect(parseMenuAction("cmd:month")).toBe("month");
  });

  it("null для чужого callback_data (хай розбирають інші обробники)", () => {
    expect(parseMenuAction("gate:sub")).toBeNull();
    expect(parseMenuAction("pick:oblast:12")).toBeNull();
  });

  it("null для невідомої дії (не виконуємо чужого)", () => {
    expect(parseMenuAction("cmd:drop_database")).toBeNull();
    expect(parseMenuAction("cmd:")).toBeNull();
  });

  it("кожна дія меню розбирається назад у себе", () => {
    for (const a of MENU_ACTIONS) {
      expect(parseMenuAction(MENU_PREFIX + a.cmd)).toBe(a.cmd);
    }
  });
});
