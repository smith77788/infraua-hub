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
