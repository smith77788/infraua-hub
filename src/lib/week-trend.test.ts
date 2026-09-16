import { describe, expect, it } from "bun:test";

import { accrueDaily, summarizeWeek, type WeekTrend } from "./week-trend";

describe("accrueDaily", () => {
  it("накопичує й ігнорує сміття", () => {
    let t: WeekTrend = {};
    t = accrueDaily(t, "Харківська", "2026-09-16", 5);
    t = accrueDaily(t, "Харківська", "2026-09-16", 3);
    t = accrueDaily(t, "", "2026-09-16", 5);
    t = accrueDaily(t, "Харківська", "bad-date", 5);
    t = accrueDaily(t, "Харківська", "2026-09-16", 0);
    expect(t["Харківська"]!["2026-09-16"]).toBe(8);
    expect(t[""]).toBeUndefined();
  });

  it("підрізає історію старшу за два тижні", () => {
    let t: WeekTrend = {};
    t = accrueDaily(t, "A", "2026-09-01", 5); // старе
    t = accrueDaily(t, "A", "2026-09-20", 5); // свіже
    expect(t["A"]!["2026-09-01"]).toBeUndefined();
    expect(t["A"]!["2026-09-20"]).toBe(5);
  });
});

describe("summarizeWeek", () => {
  it("зростання тижня оголошується при >20%", () => {
    let t: WeekTrend = {};
    // минулий тиждень: 2026-09-02..08 по 2; поточний: 09-09..15 по 4
    for (const d of ["02", "03", "04", "05", "06", "07", "08"]) {
      t = accrueDaily(t, "Сумська", `2026-09-${d}`, 2);
    }
    for (const d of ["09", "10", "11", "12", "13", "14", "15"]) {
      t = accrueDaily(t, "Сумська", `2026-09-${d}`, 4);
    }
    const s = summarizeWeek(t, "Сумська", "2026-09-15");
    expect(s.thisWeek).toBe(28);
    expect(s.lastWeek).toBe(14);
    expect(s.direction).toBe("up");
    expect(s.deltaPct).toBe(100);
    expect(s.label).toContain("активніше");
  });

  it("спад тижня", () => {
    let t: WeekTrend = {};
    for (const d of ["02", "03", "04", "05", "06", "07", "08"]) {
      t = accrueDaily(t, "Одеська", `2026-09-${d}`, 10);
    }
    for (const d of ["09", "10"]) t = accrueDaily(t, "Одеська", `2026-09-${d}`, 2);
    const s = summarizeWeek(t, "Одеська", "2026-09-15");
    expect(s.direction).toBe("down");
    expect(s.label).toContain("тихіше");
  });

  it("тихий тиждень і відсутність минулого", () => {
    const s = summarizeWeek({}, "Львівська", "2026-09-15");
    expect(s.thisWeek).toBe(0);
    expect(s.direction).toBe("flat");
    expect(s.label).toContain("тихо");
  });

  it("знаходить найгарячіший день тижня", () => {
    let t: WeekTrend = {};
    t = accrueDaily(t, "Київська", "2026-09-15", 20); // вівторок
    t = accrueDaily(t, "Київська", "2026-09-14", 3);
    const s = summarizeWeek(t, "Київська", "2026-09-15");
    expect(s.busiestDay).toBe("вівторок");
    expect(s.busiestDayCount).toBe(20);
  });
});
