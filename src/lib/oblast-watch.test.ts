import { describe, expect, it } from "bun:test";

import {
  oblastTransitions,
  renderAlertCleared,
  renderAlertStarted,
  updateAlertStarts,
} from "./oblast-watch";

describe("oblastTransitions", () => {
  it("перший знімок не дає переходів — інакше редеплой став би сиреною", () => {
    // Найважливіше твердження модуля: без нього кожен перезапуск процесу
    // розсилав би «оголошено тривогу» всім, у кого вона вже тривала годину.
    expect(oblastTransitions(null, ["Сумщина", "Харківщина"])).toEqual([]);
  });

  it("нова область — початок, зникла — відбій", () => {
    expect(oblastTransitions(["Сумщина"], ["Харківщина"])).toEqual([
      { oblast: "Сумщина", kind: "cleared" },
      { oblast: "Харківщина", kind: "started" },
    ]);
  });

  it("незмінний стан не породжує повідомлень", () => {
    expect(oblastTransitions(["Сумщина"], ["Сумщина"])).toEqual([]);
  });

  it("порожній попередній стан — це не «перший знімок»", () => {
    // Порожній масив означає «тривог не було»; null означає «ми не знаємо».
    expect(oblastTransitions([], ["Сумщина"])).toEqual([{ oblast: "Сумщина", kind: "started" }]);
  });
});

describe("updateAlertStarts", () => {
  it("вже почата тривога зберігає свій початок", () => {
    const starts = new Map([["Сумщина", 1000]]);
    const next = updateAlertStarts(starts, ["Сумщина", "Харківщина"], 5000);
    expect(next.get("Сумщина")).toBe(1000);
    expect(next.get("Харківщина")).toBe(5000);
  });

  it("знята тривога забувається — інакше наступна порахувала б чужу тривалість", () => {
    const next = updateAlertStarts(new Map([["Сумщина", 1000]]), [], 5000);
    expect(next.size).toBe(0);
  });
});

describe("тексти", () => {
  it("початок називає джерело в першому ж рядку", () => {
    const text = renderAlertStarted("Сумщина", ["дім"]);
    expect(text).toContain("Повітряна тривога — Сумщина");
    expect(text).toContain("офіційна тривога, а не наша оцінка");
  });

  it("кілька місць в області перелічені, одне — ні", () => {
    expect(renderAlertStarted("Сумщина", ["дім", "робота"])).toContain("дім, робота");
    expect(renderAlertStarted("Сумщина", ["дім"])).not.toContain("Ваші місця");
  });

  it("відбій тут — справді відбій, і сказано це без застережень", () => {
    // Єдине місце в системі, де слово вживається без «ми перестали бачити».
    const text = renderAlertCleared("Сумщина", "2 год 15 хв");
    expect(text).toContain("Відбій — Сумщина");
    expect(text).toContain("2 год 15 хв");
    expect(text).toContain("Відбій офіційний");
  });

  it("без відомої тривалості текст не вигадує число", () => {
    expect(renderAlertCleared("Сумщина", null)).toContain("Офіційну тривогу знято");
  });
});
