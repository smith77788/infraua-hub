import { describe, expect, it } from "bun:test";

import { renderShareCard } from "./share-card";
import { droneWeather } from "./drone-weather";
import type { DangerIndex, PersonalAssessment } from "./advisory";

const sky = (over: Partial<PersonalAssessment["sky"]> = {}): PersonalAssessment["sky"] => ({
  radiusKm: 50,
  clear: true,
  targets: 0,
  nearestKm: null,
  nearestType: null,
  verdict: "",
  caveat: "Офіційний відбій дають Повітряні Сили.",
  ...over,
});

const assessment = (over: Partial<PersonalAssessment> = {}): PersonalAssessment => ({
  point: { lat: 50, lon: 36 },
  nearest: [],
  inboundCount: 0,
  minutesToNearest: null,
  minutesToNearestLow: null,
  nearestBeyondKm: null,
  sky: sky(),
  ...over,
});

const danger = (over: Partial<DangerIndex> = {}): DangerIndex => ({
  percent: 5,
  level: "calm",
  verdict: "Спокійно, можна спати",
  caveat: "",
  ...over,
});

describe("renderShareCard", () => {
  it("знеособлена: назва місця, рівень, без координат і радіуса налаштувань", () => {
    const text = renderShareCard({
      placeLabel: "Харків",
      assessment: assessment({ inboundCount: 2, minutesToNearest: 9 }),
      danger: danger({ level: "shelter", verdict: "В укриття зараз" }),
      botLink: "https://t.me/bot?start=ch",
    });
    expect(text).toContain("Обстановка · Харків");
    expect(text).toContain("В укриття зараз");
    expect(text).toContain("~9 хв");
    expect(text).toContain("Перевір свою точку");
    expect(text).not.toContain("50"); // координати не просочуються
  });

  it("тиха точка — так і каже", () => {
    const text = renderShareCard({
      placeLabel: "Львів",
      assessment: assessment(),
      danger: danger(),
    });
    expect(text).toContain("Активних цілей у радіусі немає");
  });

  it("цілі поруч, але не на точку — окреме формулювання", () => {
    const text = renderShareCard({
      placeLabel: "Дніпро",
      assessment: assessment({ sky: sky({ clear: false, targets: 3, nearestKm: 22 }) }),
      danger: danger({ level: "watch" }),
    });
    expect(text).toContain("нічого не йде прямо на точку");
    expect(text).toContain("22 км");
  });

  it("сприятлива погода додається, без посилання — рядок опускається", () => {
    const text = renderShareCard({
      placeLabel: "Суми",
      assessment: assessment(),
      danger: danger(),
      weather: droneWeather({ windKmh: 5, precipMm: 0, cloudPct: 85 }),
    });
    expect(text).toContain("Погода на ніч");
    expect(text).not.toContain("Перевір свою точку");
  });
});
