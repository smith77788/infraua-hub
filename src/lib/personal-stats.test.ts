import { describe, expect, it } from "bun:test";

import {
  KEEP_DAYS,
  monthKey,
  recordAlarmMinutes,
  recordAlarmStart,
  recordAlert,
  recordLead,
  renderStats,
  summarizeMonth,
  summarizeWeek,
  weeklyDue,
  type PersonalStats,
} from "./personal-stats";

const AT = Date.UTC(2026, 8, 15, 12, 0, 0); // 15 вересня 2026, день
const NIGHT = Date.UTC(2026, 8, 15, 0, 30, 0); // 03:30 за Києвом — ніч
const MONTH_LATER = Date.UTC(2026, 9, 15, 12, 0, 0);

describe("monthKey", () => {
  it("ключ за київським часом, а не за UTC", () => {
    // 31 серпня 23:30 UTC — це вже 1 вересня у Києві.
    expect(monthKey(Date.UTC(2026, 7, 31, 23, 30))).toBe("2026-09");
  });
});

describe("накопичення", () => {
  it("рахує сповіщення в потрібному місяці", () => {
    let s: PersonalStats | undefined;
    s = recordAlert(s, AT);
    s = recordAlert(s, AT);
    expect(summarizeMonth(s, AT)?.alerts).toBe(2);
    expect(summarizeMonth(s, MONTH_LATER)).toBeNull();
  });

  it("сповіщення й офіційні тривоги — різні лічильники", () => {
    // Наше попередження і сирена — різні класи подій; злити їх означало б
    // приписати собі чужу роботу або чужій — нашу.
    let s = recordAlert(undefined, AT, { shelter: true });
    s = recordAlarmStart(s, AT);
    const sum = summarizeMonth(s, AT)!;
    expect(sum.alerts).toBe(1);
    expect(sum.shelterAlerts).toBe(1);
    expect(sum.alarms).toBe(1);
  });

  it("найдовша тривога — максимум, а не сума", () => {
    let s = recordAlarmMinutes(undefined, 30, 30, AT);
    s = recordAlarmMinutes(s, 15, 45, AT);
    s = recordAlarmMinutes(s, 10, 10, AT); // нова, коротка
    const sum = summarizeMonth(s, AT)!;
    expect(sum.alarmHours).toBeCloseTo(55 / 60, 1);
    expect(sum.longestAlarmMin).toBe(45);
  });

  it("нульове випередження теж подія, але не перемога", () => {
    /*
     * Викинути такі випадки означало б рахувати середнє лише по вдалих —
     * а це вже не вимір, а реклама.
     */
    let s = recordLead(undefined, 0, AT);
    s = recordLead(s, 6, AT);
    const sum = summarizeMonth(s, AT)!;
    expect(sum.aheadCount).toBe(1);
    expect(sum.leadCount).toBe(2);
    expect(sum.avgLeadMin).toBe(3); // (0 + 6) / 2
  });

  it("ніч зараховується один раз на добу, а не за кожну подію", () => {
    let s = recordAlert(undefined, NIGHT);
    s = recordAlert(s, NIGHT);
    expect(summarizeMonth(s, AT)!.nightsDisturbed).toBe(1);
  });

  it("день не рахується за розбуджену ніч", () => {
    const s = recordAlert(undefined, AT);
    expect(summarizeMonth(s, AT)!.nightsDisturbed).toBe(0);
  });

  it("доби не змішуються", () => {
    let s = recordAlarmMinutes(undefined, 30, 30, Date.UTC(2026, 8, 1, 12));
    s = recordAlarmMinutes(s, 60, 60, Date.UTC(2026, 8, 2, 12));
    expect(s.days).toHaveLength(2);
    expect(summarizeMonth(s, AT)!.alarmHours).toBeCloseTo(1.5, 1);
  });

  it("старі доби згортаються самі", () => {
    // Інакше сховище тихо росло б у тих, хто не заходить.
    let s: PersonalStats | undefined;
    for (let day = 1; day <= KEEP_DAYS + 10; day++) {
      s = recordAlert(s, Date.UTC(2026, 0, day, 12));
    }
    expect(s!.days).toHaveLength(KEEP_DAYS);
    // Лишились найсвіжіші: найстаріша доба — це (KEEP_DAYS + 10) − KEEP_DAYS + 1.
    expect(s!.days[s!.days.length - 1]!.date).toBe("2026-01-11");
  });

  it("порожня доба не записується взагалі", () => {
    // Того, кого не турбували, статистика не має коштувати нічого.
    const s: PersonalStats | undefined = undefined;
    expect(summarizeMonth(s, AT)).toBeNull();
  });
});

describe("підсумок за тиждень", () => {
  it("бере останні сім діб, включно з поточною", () => {
    let s: PersonalStats | undefined;
    for (let day = 1; day <= 20; day++) s = recordAlert(s, Date.UTC(2026, 8, day, 12));
    // 20 вересня: у вікно потрапляють 14–20 вересня.
    expect(summarizeWeek(s, Date.UTC(2026, 8, 20, 12))!.alerts).toBe(7);
  });

  it("найгучніша доба — та, де найбільше тривог", () => {
    let s = recordAlarmStart(undefined, Date.UTC(2026, 8, 18, 12));
    s = recordAlarmStart(s, Date.UTC(2026, 8, 19, 12));
    s = recordAlarmStart(s, Date.UTC(2026, 8, 19, 15));
    const sum = summarizeWeek(s, Date.UTC(2026, 8, 20, 12))!;
    expect(sum.worstDate).toBe("2026-09-19");
    expect(sum.worstAlarms).toBe(2);
  });
});

describe("renderStats — чесно в обидва боки", () => {
  it("тихий місяць не вигадує подій", () => {
    expect(renderStats(null)).toContain("не турбували");
  });

  it("коли випередити не вдалося — чесно, але з підтримкою, без жала", () => {
    let s = recordAlert(undefined, AT);
    s = recordAlarmMinutes(s, 60, 60, AT);
    const t = renderStats(summarizeMonth(s, AT));
    // Факт не ховається (сирена була раніша), але подано тепло, не докором.
    expect(t).toContain("сирена звучала раніше за нас");
    expect(t).toContain("стараємось випередити");
    expect(t).not.toContain("не вдалося жодного разу");
  });

  it("підсумок із подіями лишає тепле слово підтримки", () => {
    let s = recordAlert(undefined, AT);
    s = recordAlarmMinutes(s, 60, 60, AT);
    expect(renderStats(summarizeMonth(s, AT))).toContain("Бережіть себе");
  });

  it("показує заміряне випередження разом зі знаменником", () => {
    // «1 раз із 2» — інакше середнє читалось би як середнє по вдалих.
    let s = recordAlert(undefined, AT);
    s = recordLead(s, 7, AT);
    s = recordLead(s, 0, AT);
    const t = renderStats(summarizeMonth(s, AT));
    expect(t).toContain("Раніше за сирену");
    expect(t).toContain("із 2");
  });

  it("називає місяць словом, а тиждень — тижнем", () => {
    const s = recordAlert(undefined, AT);
    expect(renderStats(summarizeMonth(s, AT))).toContain("Ваш вересень");
    expect(renderStats(summarizeWeek(s, AT))).toContain("Ваш тиждень");
  });

  it("не обіцяє даних про те, де пролітали цілі", () => {
    // Такі дані цінні рівно для того, хто планує удари.
    const s = recordAlert(undefined, AT);
    expect(renderStats(summarizeMonth(s, AT))).toContain("не зберігаємо");
  });
});

describe("weeklyDue", () => {
  const monday = new Date("2026-09-14T09:00:00Z");

  it("не турбує до ранку", () => {
    expect(weeklyDue(monday, null, 8)).toBe(false);
  });

  it("надсилається в понеділок після десятої", () => {
    expect(weeklyDue(monday, null, 10)).toBe(true);
  });

  it("не надсилається двічі за ту саму добу", () => {
    expect(weeklyDue(monday, "2026-09-14", 11)).toBe(false);
  });

  it("не надсилається в інші дні тижня", () => {
    expect(weeklyDue(new Date("2026-09-16T09:00:00Z"), null, 11)).toBe(false);
  });
});
