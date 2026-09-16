import { describe, expect, it } from "bun:test";

import { emptyDiary, recordEvent, renderSummary, totals, weeklyDue } from "./diary";

const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe("щоденник", () => {
  it("рахує сповіщення й тривоги окремо — це різні класи подій", () => {
    let diary = emptyDiary(d("2026-03-01"));
    diary = recordEvent(diary, { kind: "alert", shelter: true }, d("2026-03-01"));
    diary = recordEvent(diary, { kind: "alarm", minutes: 90 }, d("2026-03-01"));
    const t = totals(diary);
    expect(t.alerts).toBe(1);
    expect(t.shelterAlerts).toBe(1);
    expect(t.alarms).toBe(1);
    expect(t.alarmMinutes).toBe(90);
  });

  it("ніч зараховується один раз на добу, а не за кожну подію", () => {
    let diary = emptyDiary(d("2026-03-01"));
    diary = recordEvent(diary, { kind: "alert", night: true }, d("2026-03-01"));
    diary = recordEvent(diary, { kind: "alert", night: true }, d("2026-03-01"));
    expect(totals(diary).nightsDisturbed).toBe(1);
  });

  it("доби не змішуються", () => {
    let diary = emptyDiary(d("2026-03-01"));
    diary = recordEvent(diary, { kind: "alarm", minutes: 30 }, d("2026-03-01"));
    diary = recordEvent(diary, { kind: "alarm", minutes: 60 }, d("2026-03-02"));
    expect(diary.days).toHaveLength(2);
    expect(totals(diary).alarmMinutes).toBe(90);
  });

  it("історія обрізається — місяць рівно стільки, скільки люди порівнюють", () => {
    let diary = emptyDiary(d("2026-01-01"));
    for (let i = 1; i <= 40; i++) {
      const day = `2026-01-${String(i).padStart(2, "0")}`;
      if (i > 31) break;
      diary = recordEvent(diary, { kind: "alarm", minutes: 10 }, d(day));
    }
    expect(diary.days.length).toBeLessThanOrEqual(31);
  });

  it("найгучніша доба знаходиться", () => {
    let diary = emptyDiary(d("2026-03-01"));
    diary = recordEvent(diary, { kind: "alarm", minutes: 10 }, d("2026-03-01"));
    for (let i = 0; i < 4; i++) {
      diary = recordEvent(diary, { kind: "alarm", minutes: 10 }, d("2026-03-02"));
    }
    expect(totals(diary).worstDate).toBe("2026-03-02");
    expect(totals(diary).worstAlarms).toBe(4);
  });
});

describe("renderSummary", () => {
  it("порожній підсумок не надсилається — це повідомлення без змісту", () => {
    expect(renderSummary(totals(emptyDiary(d("2026-03-01"))), "Тиждень")).toBeNull();
  });

  it("називає години під тривогою й розбуджені ночі", () => {
    let diary = emptyDiary(d("2026-03-01"));
    diary = recordEvent(diary, { kind: "alarm", minutes: 135, night: true }, d("2026-03-01"));
    diary = recordEvent(diary, { kind: "alert", shelter: true }, d("2026-03-02"));
    const text = renderSummary(totals(diary), "Ваш тиждень")!;
    expect(text).toContain("2 год 15 хв");
    expect(text).toContain("<b>1</b> ніч");
    expect(text).toContain("в укриття");
  });

  it("тон рівний: без похвали за те, що над домом літає", () => {
    let diary = emptyDiary(d("2026-03-01"));
    diary = recordEvent(diary, { kind: "alarm", minutes: 600 }, d("2026-03-01"));
    const text = renderSummary(totals(diary), "Місяць")!;
    expect(text).not.toMatch(/герой|молодц|витрим/i);
  });

  it("рахує лише те, що стосувалось місць людини — і каже це", () => {
    let diary = emptyDiary(d("2026-03-01"));
    diary = recordEvent(diary, { kind: "alert" }, d("2026-03-01"));
    expect(renderSummary(totals(diary), "Тиждень")!).toContain("ваших місць");
  });
});

describe("weeklyDue", () => {
  const monday = new Date("2026-03-02T09:00:00Z"); // понеділок
  it("понеділок уранці — час", () => {
    expect(weeklyDue(monday, null, 10)).toBe(true);
  });
  it("до десятої ще рано: у неділю ввечері його не читають", () => {
    expect(weeklyDue(monday, null, 8)).toBe(false);
  });
  it("не понеділок — не час", () => {
    expect(weeklyDue(new Date("2026-03-04T09:00:00Z"), null, 12)).toBe(false);
  });
  it("двічі за день не надсилаємо", () => {
    expect(weeklyDue(monday, "2026-03-02", 12)).toBe(false);
  });
});
