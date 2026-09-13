import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import {
  compass,
  dangerIndex,
  debrisDrift,
  personalAssessment,
  skyState,
  verifyThreat,
  windowExposure,
} from "./advisory";
import type { SourceRole } from "./source-credibility";

function threat(p: Partial<Threat>): Threat {
  return {
    id: "t",
    name: "Ціль",
    lat: 50,
    lon: 30,
    source: "radar_top_ua",
    count: 1,
    since: "",
    expires: "",
    ...p,
  };
}

describe("compass", () => {
  it("перетворює азимут у румб", () => {
    expect(compass(0)).toBe("Пн");
    expect(compass(95)).toBe("Сх");
    expect(compass(null)).toBe("—");
  });
});

describe("verifyThreat", () => {
  const roleOf = (s: string): SourceRole =>
    s === "kpszsu" ? "official" : s === "radar_top_ua" ? "watch" : "unknown";

  it("офіційне джерело дає найвищий рівень", () => {
    const v = verifyThreat({ sources: ["kpszsu"], source: "kpszsu", reports: 1 }, roleOf);
    expect(v.level).toBe("official");
  });

  it("два незалежні джерела — підтверджено", () => {
    const v = verifyThreat(
      { sources: ["radar_top_ua", "watcher_2"], source: "radar_top_ua", reports: 2 },
      (s) => (s === "unknown" ? "unknown" : "watch"),
    );
    expect(v.level).toBe("corroborated");
    expect(v.independentSources).toBeGreaterThanOrEqual(2);
  });

  it("одне джерело — без підтвердження", () => {
    const v = verifyThreat(
      { sources: ["radar_top_ua"], source: "radar_top_ua", reports: 1 },
      roleOf,
    );
    expect(v.level).toBe("single");
  });

  it("агрегатор зі many звітами читається як підтверджений (neptun)", () => {
    // neptun.in.ua — невідома роль, але зводить багато каналів (reports).
    const v = verifyThreat(
      { source: "neptun.in.ua", reports: 11, confidence: "medium" },
      () => "unknown",
    );
    expect(v.level).toBe("corroborated");
  });

  it("висока впевненість джерела — підтверджено", () => {
    const v = verifyThreat(
      { source: "neptun.in.ua", reports: 1, confidence: "high" },
      () => "unknown",
    );
    expect(v.level).toBe("corroborated");
  });

  it("непідтверджене одиночне повідомлення без сигналів — unverified", () => {
    const v = verifyThreat({ source: "хтось", reports: 1 }, () => "unknown");
    expect(v.level).toBe("unverified");
  });
});

describe("skyState", () => {
  const me = { lat: 50.45, lon: 30.52 };

  it("небо чисте, коли цілей у радіусі немає", () => {
    const s = skyState([threat({ lat: 46, lon: 30 })], me, 100);
    expect(s.clear).toBe(true);
    expect(s.targets).toBe(0);
  });

  it("завжди несе застереження про межу знання", () => {
    const s = skyState([], me);
    expect(s.caveat).toContain("не є");
  });

  it("рахує найближчу ціль у радіусі", () => {
    const s = skyState([threat({ lat: 50.9, lon: 30.5 })], me, 150);
    expect(s.clear).toBe(false);
    expect(s.nearestKm).toBeGreaterThan(0);
  });
});

describe("windowExposure", () => {
  it("загроза зі сходу при вікнах на схід — небезпечно", () => {
    const w = windowExposure(95, "E");
    expect(w.exposed).toBe(true);
  });

  it("загроза із заходу при вікнах на схід — безпечно", () => {
    const w = windowExposure(280, "E");
    expect(w.exposed).toBe(false);
  });
});

describe("debrisDrift", () => {
  it("вітер з півночі зносить на південь", () => {
    const d = debrisDrift(0, 36); // 10 м/с
    expect(d.driftToLabel).toBe("південь");
    expect(d.driftMeters).toBeGreaterThan(0);
  });

  it("підписаний як оцінка, а не розрахунок", () => {
    expect(debrisDrift(0, 10).basis).toContain("оцінка порядку");
  });
});

describe("personalAssessment", () => {
  const me = { lat: 50.0, lon: 30.0 };

  it("ціль на південь із курсом на північ вважається вхідною", () => {
    // ціль південніше точки, курс 0° (на північ) → йде на мене
    const a = personalAssessment(
      [threat({ lat: 49.0, lon: 30.0, heading: 0, type: "shahed" })],
      me,
    );
    expect(a.inboundCount).toBe(1);
    expect(a.minutesToNearest).not.toBeNull();
  });

  it("ціль, що віддаляється, не вхідна", () => {
    const a = personalAssessment(
      [threat({ lat: 49.0, lon: 30.0, heading: 180, type: "shahed" })],
      me,
    );
    expect(a.inboundCount).toBe(0);
  });

  it("найближчі відсортовані: вхідні першими", () => {
    const a = personalAssessment(
      [
        threat({ id: "far", lat: 51.2, lon: 30.0 }),
        threat({ id: "inbound", lat: 49.0, lon: 30.0, heading: 0, type: "shahed" }),
      ],
      me,
    );
    expect(a.nearest[0]?.threat.id).toBe("inbound");
  });
});

describe("dangerIndex — спати чи в укриття", () => {
  const me = { lat: 50.0, lon: 30.0 };

  it("немає цілей поруч — спокійно, можна спати", () => {
    const a = personalAssessment([threat({ lat: 46, lon: 30 })], me);
    const d = dangerIndex(a);
    expect(d.level).toBe("calm");
    expect(d.verdict).toContain("можна спати");
    expect(d.percent).toBeLessThan(15);
  });

  it("швидка вхідна ціль поруч — в укриття", () => {
    // ціль за ~20 км південніше, курс 0° (на мене), тип shahed
    const a = personalAssessment(
      [threat({ lat: 49.8, lon: 30.0, heading: 0, type: "shahed" })],
      me,
    );
    const d = dangerIndex(a);
    expect(d.level).toBe("shelter");
    expect(d.percent).toBeGreaterThanOrEqual(70);
  });

  it("індекс завжди 0..100 і несе застереження", () => {
    const a = personalAssessment(
      [threat({ lat: 49.9, lon: 30.0, heading: 0, type: "shahed" })],
      me,
    );
    const d = dangerIndex(a);
    expect(d.percent).toBeGreaterThanOrEqual(0);
    expect(d.percent).toBeLessThanOrEqual(100);
    expect(d.caveat).toContain("не ймовірність");
  });

  it("НЕ називає себе ймовірністю влучання (правило проекту)", () => {
    const a = personalAssessment([], me);
    expect(dangerIndex(a).caveat).toContain("не радар");
  });
});
