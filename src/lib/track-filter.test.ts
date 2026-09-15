import { describe, expect, it } from "bun:test";

import { angleDelta, estimateMotion, type Fix, projectMotion } from "./track-filter";

/** Ціль, що летить рівно на північ зі сталою швидкістю. */
function straightNorth(speedKmh: number, count: number, stepMs = 120_000, from = 0): Fix[] {
  const out: Fix[] = [];
  for (let i = 0; i < count; i++) {
    const hours = (i * stepMs) / 3_600_000;
    out.push({ lat: 48 + (speedKmh * hours) / 111.32, lon: 30, ts: from + i * stepMs });
  }
  return out;
}

describe("angleDelta", () => {
  it("рахує через нуль, а не навколо", () => {
    expect(angleDelta(350, 10)).toBe(20);
    expect(angleDelta(10, 350)).toBe(-20);
    expect(angleDelta(0, 180)).toBe(180);
  });
});

describe("estimateMotion", () => {
  const now = 600_000;

  it("виводить курс і швидкість із самого руху, не з поля джерела", () => {
    const s = estimateMotion(straightNorth(180, 6), now, { type: "shahed", reportedHeading: 270 })!;
    expect(s.origin).toBe("observed");
    expect(s.headingDeg).toBeCloseTo(0, 0);
    expect(s.speedKmh).toBeGreaterThan(170);
    expect(s.speedKmh).toBeLessThan(190);
  });

  it("на рівному русі похибка мала, але НЕ нульова", () => {
    // Нульова похибка — це не впевненість, а відсутність перевірки.
    const s = estimateMotion(straightNorth(180, 6), now, { type: "shahed" })!;
    expect(s.headingSigma).toBeGreaterThan(0);
    expect(s.speedSigma).toBeGreaterThan(0);
    expect(s.headingSigma).toBeLessThan(10);
  });

  it("середнє курсів рахується циркулярно: 350° і 10° дають 0°, а не 180°", () => {
    // Арифметичне середнє тут показало б ціль, що летить у протилежний бік.
    const fixes: Fix[] = [
      { lat: 48, lon: 30, ts: 0 },
      { lat: 48.05, lon: 29.988, ts: 120_000 },
      { lat: 48.1, lon: 30.0, ts: 240_000 },
    ];
    const s = estimateMotion(fixes, 300_000, { type: "shahed" })!;
    expect(Math.min(s.headingDeg, 360 - s.headingDeg)).toBeLessThan(20);
  });

  it("стрибок через пів країни відкидається як помилка ототожнення", () => {
    // Два звіти про «ту саму» ціль із різних областей дають 900 км/год для
    // шахеда. Це не прискорення, це не та сама ціль.
    const fixes = [...straightNorth(180, 4), { lat: 52, lon: 24, ts: 360_000 }];
    const s = estimateMotion(fixes, 400_000, { type: "shahed" })!;
    expect(s.speedKmh).toBeLessThan(260);
  });

  it("руху ще не видно — чесно кажемо, що курс чужий", () => {
    const s = estimateMotion([{ lat: 48, lon: 30, ts: 0 }], 60_000, {
      type: "shahed",
      reportedHeading: 90,
    })!;
    expect(s.origin).toBe("reported");
    expect(s.headingDeg).toBe(90);
    expect(s.headingSigma).toBeGreaterThan(20);
  });

  it("немає ні руху, ні курсу — вести нема чого, і це окремий стан", () => {
    const s = estimateMotion([{ lat: 48, lon: 30, ts: 0 }], 60_000, { type: "shahed" })!;
    expect(s.origin).toBe("none");
    expect(s.headingSigma).toBe(180);
  });

  it("старі фікси не беруться до уваги", () => {
    const stale = straightNorth(180, 5, 120_000, 0);
    expect(estimateMotion(stale, 60 * 60 * 1000, { type: "shahed" })).toBeNull();
  });

  it("порожній набір не дає стану", () => {
    expect(estimateMotion([], 1000)).toBeNull();
  });

  it("розворот видно як кутову швидкість", () => {
    const fixes: Fix[] = [
      { lat: 48.0, lon: 30.0, ts: 0 },
      { lat: 48.06, lon: 30.0, ts: 120_000 },
      { lat: 48.11, lon: 30.04, ts: 240_000 },
      { lat: 48.14, lon: 30.11, ts: 360_000 },
    ];
    const s = estimateMotion(fixes, 400_000, { type: "shahed" })!;
    expect(s.turnRateDegMin).toBeGreaterThan(1);
  });
});

describe("projectMotion", () => {
  const state = estimateMotion(straightNorth(180, 6), 600_000, { type: "shahed" })!;

  it("веде ціль уперед на відстань швидкість × час", () => {
    const p = projectMotion(state, 20);
    expect(p.distanceKm).toBeCloseTo(60, 0);
    expect(p.lat).toBeGreaterThan(state.lat);
  });

  it("невизначеність РОСТЕ з горизонтом — у цьому вся суть", () => {
    const near = projectMotion(state, 5);
    const far = projectMotion(state, 40);
    expect(far.crossSigmaKm).toBeGreaterThan(near.crossSigmaKm);
    expect(far.alongSigmaKm).toBeGreaterThan(near.alongSigmaKm);
  });

  it("чужий курс дає ширше віяло, ніж спостережений", () => {
    // Оцінка на чужому твердженні не має виглядати такою ж певною, як на
    // власному спостереженні.
    const reported = estimateMotion([{ lat: 48, lon: 30, ts: 0 }], 60_000, {
      type: "shahed",
      reportedHeading: 0,
    })!;
    expect(projectMotion(reported, 20).crossSigmaKm).toBeGreaterThan(
      projectMotion(state, 20).crossSigmaKm,
    );
  });
});
