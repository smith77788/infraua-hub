import { describe, expect, it } from "bun:test";

import { accrueRhythm, decayRhythm, summarizeRhythm, type RhythmBuckets } from "./threat-rhythm";

describe("accrueRhythm", () => {
  it("накопичує вагу в правильне відро години", () => {
    let b: RhythmBuckets = {};
    b = accrueRhythm(b, "Харківська", 3, 5);
    b = accrueRhythm(b, "Харківська", 3, 2);
    expect(b["Харківська"]![3]).toBe(7);
  });

  it("нормалізує годину поза 0..23", () => {
    let b: RhythmBuckets = {};
    b = accrueRhythm(b, "Київська", 25, 1); // 25 → 1
    expect(b["Київська"]![1]).toBe(1);
  });

  it("ігнорує порожню область і нульову вагу", () => {
    let b: RhythmBuckets = {};
    b = accrueRhythm(b, "", 3, 5);
    b = accrueRhythm(b, "Сумська", 3, 0);
    expect(Object.keys(b)).toHaveLength(0);
  });

  it("лікує биту позначку з коротким масивом", () => {
    const b = accrueRhythm({ Одеська: [1, 2] }, "Одеська", 10, 1);
    expect(b["Одеська"]).toHaveLength(24);
    expect(b["Одеська"]![10]).toBe(1);
  });
});

describe("summarizeRhythm", () => {
  it("без даних — чесно каже, що їх мало", () => {
    const s = summarizeRhythm({}, "Львівська");
    expect(s.confident).toBe(false);
    expect(s.total).toBe(0);
    expect(s.label).toContain("мало даних");
  });

  it("знаходить нічний пік і рахує нічну частку", () => {
    let b: RhythmBuckets = {};
    for (const h of [2, 2, 2, 3, 3]) b = accrueRhythm(b, "Харківська", h, 4);
    b = accrueRhythm(b, "Харківська", 14, 4); // трохи вдень
    const s = summarizeRhythm(b, "Харківська");
    expect(s.confident).toBe(true);
    expect(s.peakHours).toContain(2);
    expect(s.nightShare).toBeGreaterThan(0.7);
    expect(s.label).toContain("пік");
  });

  it("мало спостережень — пік не оголошується впевнено", () => {
    let b: RhythmBuckets = {};
    b = accrueRhythm(b, "Полтавська", 1, 3);
    const s = summarizeRhythm(b, "Полтавська");
    expect(s.confident).toBe(false);
    expect(s.label).toContain("формується");
  });
});

describe("decayRhythm", () => {
  it("зменшує ваги й прибирає згаслі області", () => {
    const b: RhythmBuckets = { A: new Array(24).fill(0).map((_, i) => (i === 5 ? 100 : 0)) };
    b["B"] = new Array(24).fill(0.005);
    const d = decayRhythm(b, 0.5);
    expect(d["A"]![5]).toBe(50);
    expect(d["B"]).toBeUndefined();
  });
});
