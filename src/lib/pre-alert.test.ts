import { describe, expect, it } from "bun:test";

import {
  alertPhase,
  leadMinutes,
  leadWorthTelling,
  preAlertFooter,
  preAlertHeader,
  renderOfficialConfirmed,
} from "./pre-alert";

describe("alertPhase", () => {
  it("тривоги над областю немає — наше попередження випереджає сирену", () => {
    expect(alertPhase(["Сумщина"], "Харківщина")).toBe("pre");
  });
  it("тривога вже оголошена — попередження не передтривога", () => {
    expect(alertPhase(["Харківщина"], "Харківщина")).toBe("official");
  });
  it("джерело мовчить — фази не вигадуємо", () => {
    // Назвати передтривогою те, чого ми не перевірили, означало б заявити, що
    // офіційної немає, не знаючи цього.
    expect(alertPhase(null, "Харківщина")).toBe("unknown");
  });
});

describe("замір випередження", () => {
  it("рахується від моменту НАШОГО попередження", () => {
    expect(leadMinutes(0, 7 * 60_000)).toBe(7);
  });
  it("відʼємного випередження не буває", () => {
    expect(leadMinutes(10 * 60_000, 0)).toBe(0);
  });
  it("нуль і надто велике не звітуємо", () => {
    // Менше за хвилину — збіг; понад пів години — майже напевно не наша
    // заслуга, і хвалитися цим означало б привчати до декоративних чисел.
    expect(leadWorthTelling(0)).toBe(false);
    expect(leadWorthTelling(6)).toBe(true);
    expect(leadWorthTelling(45)).toBe(false);
  });
});

describe("тексти", () => {
  it("передтривога мусить називати себе передтривогою", () => {
    expect(preAlertHeader()).toContain("ПЕРЕДТРИВОГА");
    expect(preAlertHeader()).toContain("ще не оголошували");
    expect(preAlertFooter()).toContain("не офіційна тривога");
  });

  it("підтвердження звітує числом, коли воно варте звіту", () => {
    expect(renderOfficialConfirmed("Харківщина", 6)).toContain("на <b>6 хв</b> раніше");
  });

  it("сумнівне випередження не згадується взагалі", () => {
    const text = renderOfficialConfirmed("Харківщина", 90);
    expect(text).toContain("Офіційну тривогу оголошено");
    expect(text).not.toContain("раніше за сирену");
  });

  it("навіть тут відбій лишається офіційним", () => {
    expect(renderOfficialConfirmed("Харківщина", null)).toContain("лише після офіційного");
  });
});

describe("фаза за двома словниками назв", () => {
  /*
   * Заміряно, а не припущено: `official` приходить від джерела тривог у формі
   * «Рівненська область», а `oblast` — від `oblastOf` у формі «Рівненщина».
   * Доти порівняння рядків не збігалось ніколи, і фаза завжди була «pre».
   */
  it("народна назва точки знаходить офіційну тривогу", () => {
    expect(alertPhase(["Рівненська область"], "Рівненщина")).toBe("official");
  });

  it("офіційна назва теж працює — ми нічого не зламали", () => {
    expect(alertPhase(["Рівненська область"], "Рівненська область")).toBe("official");
  });

  it("чужа область лишається передтривогою", () => {
    expect(alertPhase(["Рівненська область"], "Львівщина")).toBe("pre");
  });

  it("місто Київ не зараховується за Київщину", () => {
    expect(alertPhase(["Київська область"], "м. Київ")).toBe("pre");
  });
});
