import { describe, expect, it } from "bun:test";

import {
  circleAlertTargets,
  type CircleMemberPlace,
  renderRelativeAlarm,
  renderRelativeClear,
} from "./circle-oblast-alarm";

const mama: CircleMemberPlace = { chatId: 1, name: "Мама", oblasts: ["Сумщина"], muted: false };
const son: CircleMemberPlace = { chatId: 2, name: "Син", oblasts: ["Львівщина"], muted: false };
const sister: CircleMemberPlace = { chatId: 3, name: "Сестра", oblasts: ["Сумщина"], muted: false };

describe("circleAlertTargets", () => {
  it("тривога в мами доходить до сина", () => {
    const out = circleAlertTargets([mama, son], "Сумщина");
    expect(out).toEqual([{ chatId: 2, aboutNames: ["Мама"], oblast: "Сумщина" }]);
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

  it("двоє рідних в одній області дають ОДНУ звістку з двома іменами", () => {
    /*
     * Цей тест раніше вимагав протилежного — двох окремих звісток — і тим
     * закріплював ваду як задум. Одна сирена є однією подією, скільки б рідних
     * вона не зачепила; два повідомлення підряд про неї вчать не читати жодного.
     */
    const out = circleAlertTargets([mama, sister, son], "Сумщина");
    expect(out).toHaveLength(1);
    expect(out[0]!.chatId).toBe(2);
    expect(out[0]!.aboutNames.slice().sort()).toEqual(["Мама", "Сестра"]);
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

describe("одна тривога — одне повідомлення", () => {
  it("кілька рідних в одній області не дають кілька повідомлень", () => {
    /*
     * Родина майже завжди живе разом. Якщо в Харкові четверо рідних, то
     * єдиний, хто у Львові, дістав би ЧОТИРИ повідомлення про одну сирену —
     * «мама», «тато», «сестра», «брат» підряд. Саме так і вчаться не читати
     * повідомлення взагалі.
     */
    const members = [
      { chatId: 1, name: "мама", oblasts: ["Харківщина"], muted: false },
      { chatId: 2, name: "тато", oblasts: ["Харківщина"], muted: false },
      { chatId: 3, name: "сестра", oblasts: ["Харківщина"], muted: false },
      { chatId: 9, name: "я", oblasts: ["Львівщина"], muted: false },
    ];
    const targets = circleAlertTargets(members, "Харківщина");
    expect(targets).toHaveLength(1);
    expect(targets[0]!.chatId).toBe(9);
    expect(targets[0]!.aboutNames).toEqual(["мама", "тато", "сестра"]);
  });

  it("імена йдуть в одне речення, а не в три повідомлення", () => {
    const text = renderRelativeAlarm(["мама", "тато"], "Харківщина");
    expect(text).toContain("мама");
    expect(text).toContain("тато");
  });
});

describe("пауза сповіщень", () => {
  it("хто поставив /stop — звісток не отримує", () => {
    /*
     * `/stop` каже «🔕 Сповіщення на паузі». Без цієї межі обіцянка була
     * порожньою саме для кола — тобто для повідомлень, які найчастіше
     * приходять уночі.
     */
    const out = circleAlertTargets([mama, { ...son, muted: true }], "Сумщина");
    expect(out).toEqual([]);
  });

  it("але про нього самого рідним кажуть — він вимкнув свої сповіщення, а не зник", () => {
    const out = circleAlertTargets([{ ...mama, muted: true }, son], "Сумщина");
    expect(out).toHaveLength(1);
    expect(out[0]!.aboutNames).toEqual(["Мама"]);
  });
});

describe("імена в колі — чужий текст", () => {
  it("розмітка в імені не ламає повідомлення", () => {
    /*
     * Імʼя задає людина: `/circle імʼя <b>...`. Незекранований кутовий дужок
     * ламає HTML, і Telegram відхиляє повідомлення ЦІЛКОМ — тобто звістка про
     * тривогу в рідних не доходить узагалі. Саме так ця вада вже була в
     * `circle.ts` (запис 29) і повернулась у новому модулі.
     */
    const t = renderRelativeAlarm(['<b>хтось</b> & "лапки"'], "Сумщина");
    expect(t).toContain("&lt;b&gt;хтось&lt;/b&gt;");
    expect(t).toContain("&amp;");
    expect(t).not.toContain("<b>хтось</b> &");
  });

  it("назва області теж екранується", () => {
    const t = renderRelativeClear(["Мама"], "<script>");
    expect(t).toContain("&lt;script&gt;");
  });

  it("власна розмітка повідомлення лишається", () => {
    // Екранування не має зʼїсти наші ж теги — інакше зникне жирний заголовок.
    expect(renderRelativeAlarm(["Мама"], "Сумщина")).toContain("<b>");
  });
});
