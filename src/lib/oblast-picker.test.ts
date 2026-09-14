import { describe, expect, it } from "bun:test";

import {
  findOblastByCode,
  oblastKeyboard,
  parsePickerAction,
  PICKABLE_OBLASTS,
  PICKER_PAGES,
  PICKER_PAGE_SIZE,
} from "./oblast-picker";

describe("перелік областей", () => {
  it("жодного дубля коду — «м. Київ» і «Київ» це одна кнопка", () => {
    const codes = PICKABLE_OBLASTS.map((o) => o.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("кожна область має координати", () => {
    for (const o of PICKABLE_OBLASTS) {
      expect(Number.isFinite(o.lat)).toBe(true);
      expect(Number.isFinite(o.lon)).toBe(true);
    }
  });
});

describe("клавіатура", () => {
  it("усі області доступні через сторінки — жодна не губиться", () => {
    // Якби остання сторінка обрізалась, частина країни просто не мала б
    // способу задати точку без дозволів.
    const seen = new Set<string>();
    for (let page = 0; page < PICKER_PAGES; page++) {
      for (const row of oblastKeyboard(page).inline_keyboard) {
        for (const b of row) if (b.callback_data.startsWith("o:")) seen.add(b.callback_data);
      }
    }
    expect(seen.size).toBe(PICKABLE_OBLASTS.length);
  });

  it("на сторінці не більше за оголошений розмір", () => {
    const picks = oblastKeyboard(0)
      .inline_keyboard.flat()
      .filter((b) => b.callback_data.startsWith("o:"));
    expect(picks.length).toBeLessThanOrEqual(PICKER_PAGE_SIZE);
  });

  it("коди кнопок вкладаються в 64 байти Telegram", () => {
    // Кирилична назва в UTF-8 — два байти на літеру; кнопка, що перевищила
    // стелю, просто не працює, і саме так фічі тихо вмирають.
    for (let page = 0; page < PICKER_PAGES; page++) {
      for (const b of oblastKeyboard(page, [
        { text: "x", callback_data: "geo" },
      ]).inline_keyboard.flat()) {
        expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
      }
    }
  });

  it("сторінки гортаються по колу, а не впираються в край", () => {
    const nav = oblastKeyboard(0).inline_keyboard.at(-1)!;
    expect(nav.some((b) => b.callback_data === `op:${PICKER_PAGES - 1}`)).toBe(true);
  });

  it("сторінка поза межами не ламає клавіатуру", () => {
    expect(oblastKeyboard(999).inline_keyboard.length).toBeGreaterThan(0);
    expect(oblastKeyboard(-5).inline_keyboard.length).toBeGreaterThan(0);
  });

  it("додатковий ряд («Точніше») лишається останнім", () => {
    const kb = oblastKeyboard(0, [{ text: "📍", callback_data: "geo" }]);
    expect(kb.inline_keyboard.at(-1)).toEqual([{ text: "📍", callback_data: "geo" }]);
  });
});

describe("parsePickerAction", () => {
  it("розбирає вибір і гортання", () => {
    expect(parsePickerAction("op:2")).toEqual({ kind: "page", page: 2 });
    const pick = parsePickerAction("o:UA-63");
    expect(pick?.kind).toBe("pick");
    expect(pick && "oblast" in pick && pick.oblast.name).toBe("Харківщина");
  });

  it("чужі кнопки віддає далі, а не ковтає", () => {
    // Інакше зникли б і персональні, і адмінські набори.
    expect(parsePickerAction("pv")).toBeNull();
    expect(parsePickerAction("l:on")).toBeNull();
    expect(parsePickerAction("o:НЕМАЄ")).toBeNull();
  });
});

describe("findOblastByCode", () => {
  it("невідомий код не вигадує області", () => {
    expect(findOblastByCode("UA-99")).toBeUndefined();
  });
});
