import { describe, expect, it } from "bun:test";

import { parseOfficialAlerts, shortOblastName, stillAlerting } from "./official-alerts";

describe("shortOblastName", () => {
  it("офіційна назва зводиться до тієї, якою оперують пости й карта", () => {
    // Без цього звірка «чи триває тривога там, де була хвиля» не збіглася б
    // ніколи: джерело каже «Харківська область», хвиля — «Харківщина».
    expect(shortOblastName("Харківська область")).toBe("Харківщина");
    expect(shortOblastName("Запорізька область")).toBe("Запоріжжя");
    expect(shortOblastName("м. Київ")).toBe("м. Київ");
  });

  it("невідома назва лишається як є — вигадувати відповідність не можна", () => {
    expect(shortOblastName("Новоутворена область")).toBe("Новоутворена область");
  });
});

describe("parseOfficialAlerts", () => {
  it("бере лише області з активною тривогою", () => {
    expect(
      parseOfficialAlerts({
        states: {
          "Харківська область": { alertnow: true },
          "Львівська область": { alertnow: false },
          "Сумська область": { alertnow: true },
        },
      }),
    ).toEqual(["Сумщина", "Харківщина"]);
  });

  it("порожня відповідь — це «тривог немає», а не збій", () => {
    expect(parseOfficialAlerts({ states: {} })).toEqual([]);
  });

  it("зіпсована відповідь — null, і це НЕ те саме, що «тривог немає»", () => {
    // Найважливіше твердження в модулі: збій джерела, прочитаний як «чисто»,
    // дав би фальшивий відбій рівно тоді, коли перевірити його нічим.
    expect(parseOfficialAlerts(null)).toBeNull();
    expect(parseOfficialAlerts("<html>502</html>")).toBeNull();
    expect(parseOfficialAlerts({})).toBeNull();
  });
});

describe("stillAlerting", () => {
  it("рахує лише області хвилі", () => {
    // Тривога на Донеччині не має тримати відбій над Львівщиною.
    expect(stillAlerting(["Львівщина"], ["Донеччина", "Львівщина"])).toEqual(["Львівщина"]);
    expect(stillAlerting(["Львівщина"], ["Донеччина"])).toEqual([]);
  });

  it("порожньо — офіційний відбій скрізь, де була хвиля", () => {
    expect(stillAlerting(["Сумщина", "Харківщина"], [])).toEqual([]);
  });
});

describe("тривоги з районів Нептуна; застиглий ubilling (04.11, Рівне)", () => {
  it("область під тривогою, коли тривога хоч в одному її районі", async () => {
    const { oblastsFromLevels } = await import("./official-alerts");
    const out = oblastsFromLevels({
      oblasts: [{ oblast: "Луганська область", name: "Луганська область" }],
      raions: [
        { oblast: "Рівненська область" },
        { oblast: "Рівненська область" },
        { oblast: "Житомирська область" },
      ],
    });
    expect(out).toEqual(["Житомирщина", "Луганщина", "Рівненщина"]);
  });

  it("ubilling із кешем 30-годинної давнини — не свіжий; щойно оновлений — свіжий", async () => {
    const { ubillingFresh } = await import("./official-alerts");
    const now = Date.parse("2026-11-04T02:29:00Z");
    expect(ubillingFresh({ cachedat: "2026-11-02 19:46:42" }, now)).toBe(false);
    expect(ubillingFresh({ cachedat: "2026-11-04 04:25:00" }, now)).toBe(true);
    expect(ubillingFresh({}, now)).toBe(false);
  });
});
