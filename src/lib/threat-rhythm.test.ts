import { describe, expect, it } from "bun:test";

import {
  accrueRhythm,
  accrueSnapshotRhythm,
  decayRhythm,
  MAX_ACCRUAL_MIN,
  summarizeRhythm,
  type RhythmBuckets,
} from "./threat-rhythm";

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

describe("внесок зрізу, нормований на час", () => {
  const snap = (n: number) => ({ oblasts: { Харківщина: { shahed: n } } });

  it("штатний тик важить рівно одиницю на ціль", () => {
    const b = accrueSnapshotRhythm({}, snap(4), 2, 5);
    expect(b["Харківщина"]?.[2]).toBe(4);
  });

  it("подвійна прогалина важить удвічі — ритм міряє небо, а не наші опитування", () => {
    const b = accrueSnapshotRhythm({}, snap(4), 2, 10);
    expect(b["Харківщина"]?.[2]).toBe(8);
  });

  it("два зайві тики поспіль дають те саме, що один штатний", () => {
    // Це і є суть нормування: після рестарту чи стороннього крона тиків
    // більше, і без нього та сама година набрала б удвічі.
    let a: RhythmBuckets = {};
    a = accrueSnapshotRhythm(a, snap(4), 2, 2.5);
    a = accrueSnapshotRhythm(a, snap(4), 2, 2.5);
    const b = accrueSnapshotRhythm({}, snap(4), 2, 5);
    expect(a["Харківщина"]?.[2]).toBeCloseTo(b["Харківщина"]?.[2] ?? 0, 6);
  });

  it("прогалина після рестарту обрізається стелею, а не вигадує наліт", () => {
    const huge = accrueSnapshotRhythm({}, snap(1), 2, 12 * 60);
    const capped = accrueSnapshotRhythm({}, snap(1), 2, MAX_ACCRUAL_MIN);
    expect(huge["Харківщина"]?.[2]).toBe(capped["Харківщина"]?.[2]);
  });

  it("нескінченність із битої позначки не потрапляє в гістограму", () => {
    // JSON.parse("1e400") дає Infinity, і воно пережило б будь-який редеплой.
    const b = accrueSnapshotRhythm(
      {},
      { oblasts: { Харківщина: { shahed: JSON.parse("1e400") as number, kab: 2 } } },
      3,
      5,
    );
    expect(b["Харківщина"]?.[3]).toBe(2);
    expect(Number.isFinite(b["Харківщина"]?.[3] ?? NaN)).toBe(true);
  });

  it("нульовий або відʼємний час нічого не додає", () => {
    expect(accrueSnapshotRhythm({}, snap(4), 2, 0)).toEqual({});
    expect(accrueSnapshotRhythm({}, snap(4), 2, -5)).toEqual({});
    expect(accrueSnapshotRhythm({}, snap(4), 2, NaN)).toEqual({});
  });
});
