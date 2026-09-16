import { describe, expect, it } from "bun:test";

import {
  KEEP_LEADS,
  KEEP_MONTHS,
  monthKey,
  recordAlarmMinutes,
  recordAlert,
  recordLead,
  renderStats,
  summarizeMonth,
  type PersonalStats,
} from "./personal-stats";

const AT = Date.UTC(2026, 8, 15, 12, 0, 0); // 15 вересня 2026
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
    expect(sum.avgLeadMin).toBe(3); // (0 + 6) / 2
  });

  it("памʼятає обмежену кількість випереджень", () => {
    let s: PersonalStats | undefined;
    for (let i = 0; i < KEEP_LEADS + 10; i++) s = recordLead(s, 5, AT);
    expect(s!.months[0]!.leads).toHaveLength(KEEP_LEADS);
  });

  it("старі місяці згортаються самі", () => {
    // Інакше сховище тихо росло б у тих, хто не заходить.
    let s: PersonalStats | undefined;
    for (let m = 0; m < KEEP_MONTHS + 3; m++) s = recordAlert(s, Date.UTC(2026, m, 15, 12));
    expect(s!.months).toHaveLength(KEEP_MONTHS);
    // Лишились найсвіжіші.
    expect(s!.months[s!.months.length - 1]!.month).toBe("2026-06");
  });
});

describe("renderStats — чесно в обидва боки", () => {
  it("тихий місяць не вигадує подій", () => {
    expect(renderStats(null)).toContain("не турбували");
  });

  it("каже прямо, коли випередити не вдалося", () => {
    let s = recordAlert(undefined, AT);
    s = recordAlarmMinutes(s, 60, 60, AT);
    const t = renderStats(summarizeMonth(s, AT));
    expect(t).toContain("не вдалося жодного разу");
  });

  it("показує заміряне випередження, коли воно було", () => {
    let s = recordAlert(undefined, AT);
    s = recordLead(s, 7, AT);
    const t = renderStats(summarizeMonth(s, AT));
    expect(t).toContain("раніше за сирену");
    expect(t).toContain("7");
  });

  it("не обіцяє даних про те, де пролітали цілі", () => {
    // Такі дані цінні рівно для того, хто планує удари.
    const s = recordAlert(undefined, AT);
    expect(renderStats(summarizeMonth(s, AT))).toContain("не зберігаємо");
  });
});
