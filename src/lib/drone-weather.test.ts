import { describe, expect, it } from "bun:test";

import { droneWeather } from "./drone-weather";

describe("droneWeather", () => {
  it("штиль, без опадів, суцільна хмарність — льотна ніч", () => {
    const v = droneWeather({ windKmh: 6, precipMm: 0, cloudPct: 85 });
    expect(v.band).toBe("favorable");
    expect(v.score).toBeGreaterThanOrEqual(66);
    expect(v.reasons.join(" ")).toContain("прикриття");
  });

  it("штормовий вітер із дощем — нельотна погода", () => {
    const v = droneWeather({ windKmh: 48, precipMm: 3, cloudPct: 90 });
    expect(v.band).toBe("adverse");
    expect(v.score).toBeLessThan(40);
  });

  it("помірні умови дають змінний вердикт", () => {
    const v = droneWeather({ windKmh: 20, precipMm: 0, cloudPct: 50 });
    expect(v.band).toBe("mixed");
  });

  it("жоден єдиний чинник не дає крайнього вердикту сам по собі", () => {
    // Лише штиль, без даних про опади/хмари — ще не «льотна ніч».
    const onlyCalm = droneWeather({ windKmh: 5, precipMm: 0 });
    expect(onlyCalm.score).toBeLessThan(90);
  });

  it("мороз знижує оцінку", () => {
    const warm = droneWeather({ windKmh: 10, precipMm: 0, cloudPct: 60, tempC: 2 });
    const cold = droneWeather({ windKmh: 10, precipMm: 0, cloudPct: 60, tempC: -15 });
    expect(cold.score).toBeLessThan(warm.score);
  });

  it("оцінка завжди в межах 0..100 і має застереження", () => {
    const v = droneWeather({ windKmh: 999, precipMm: 999 });
    expect(v.score).toBeGreaterThanOrEqual(0);
    expect(v.score).toBeLessThanOrEqual(100);
    expect(v.caveat).toContain("не прогноз атаки");
  });
});
