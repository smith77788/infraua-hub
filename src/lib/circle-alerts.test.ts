import { describe, expect, it } from "bun:test";

import {
  circleAlertTargets,
  type CircleMemberPlace,
  renderRelativeAlarm,
  renderRelativeClear,
} from "./circle-alerts";

const mama: CircleMemberPlace = { chatId: 1, name: "Мама", oblasts: ["Сумщина"] };
const son: CircleMemberPlace = { chatId: 2, name: "Син", oblasts: ["Львівщина"] };
const sister: CircleMemberPlace = { chatId: 3, name: "Сестра", oblasts: ["Сумщина"] };

describe("circleAlertTargets", () => {
  it("тривога в мами доходить до сина", () => {
    const out = circleAlertTargets([mama, son], "Сумщина");
    expect(out).toEqual([{ chatId: 2, aboutName: "Мама", oblast: "Сумщина" }]);
  });

  it("сам той, у кого тривога, звістки про себе не отримує", () => {
    // Повідомлення про себе ж у третій особі виглядало б як помилка.
    const out = circleAlertTargets([mama, son], "Сумщина");
    expect(out.some((o) => o.chatId === mama.chatId)).toBe(false);
  });

  it("той, у кого тривога в тій самій області, теж не отримує — він уже знає", () => {
    // Рядок «у мами тривога» під власною сиреною лише заважає.
    const out = circleAlertTargets([mama, sister], "Сумщина");
    expect(out).toEqual([]);
  });

  it("двоє рідних в одній області дають дві звістки одному спостерігачу", () => {
    const out = circleAlertTargets([mama, sister, son], "Сумщина");
    expect(out.map((o) => o.aboutName).sort()).toEqual(["Мама", "Сестра"]);
    expect(new Set(out.map((o) => o.chatId))).toEqual(new Set([2]));
  });

  it("область без нікого з кола — нікого не турбуємо", () => {
    expect(circleAlertTargets([mama, son], "Одещина")).toEqual([]);
  });

  it("порожнє коло не ламає обхід", () => {
    expect(circleAlertTargets([], "Сумщина")).toEqual([]);
  });
});

describe("тексти", () => {
  it("називається область, а не точка — місце рідних лишається їхнім", () => {
    const text = renderRelativeAlarm(["Мама"], "Сумщина");
    expect(text).toContain("Мама");
    expect(text).toContain("Сумщина");
    expect(text).not.toMatch(/\d+\.\d{3,}/);
  });

  it("один рядок, а не потік: чужою тривогою нічим не допоможеш", () => {
    expect(renderRelativeAlarm(["Мама"], "Сумщина").split("\n")).toHaveLength(1);
    expect(renderRelativeClear(["Мама"], "Сумщина").split("\n")).toHaveLength(1);
  });

  it("кілька імен перелічуються в одному рядку", () => {
    expect(renderRelativeAlarm(["Мама", "Сестра"], "Сумщина")).toContain("Мама, Сестра");
  });
});
