import { describe, expect, it } from "bun:test";

import { estimateMotion, type Fix } from "./track-filter";

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

describe("радіус застосовується до переліку, а не лише до лічильника", () => {
  const point = { lat: 50.45, lon: 30.52 };
  // Ціль за ~630 км на схід, курсом на захід — тобто «дивиться» на точку.
  const far: Threat = {
    id: "far",
    name: "далека",
    lat: 50.45,
    lon: 39.4,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    type: "shahed",
    heading: 270,
  };

  it("ціль за сотні кілометрів не потрапляє в перелік", () => {
    // Саме це бачив користувач: «шахед — 721 км на Сх, іде на вас, ~240 хв».
    // Особистий радар, який каже таке, навчає не вірити — і справжнє
    // сповіщення потім теж прочитають як шум.
    const a = personalAssessment([far], point, { radiusKm: 50 });
    expect(a.nearest).toHaveLength(0);
    expect(a.inboundCount).toBe(0);
  });

  it("але про неї сказано окремо: «поза радіусом», а не замовчано", () => {
    const a = personalAssessment([far], point, { radiusKm: 50 });
    expect(a.nearestBeyondKm).toBeGreaterThan(500);
  });

  it("порожнє небо — і поза радіусом порожньо", () => {
    expect(personalAssessment([], point, { radiusKm: 50 }).nearestBeyondKm).toBeNull();
  });

  it("ціль у межах радіуса лишається в переліку", () => {
    const near: Threat = { ...far, id: "near", lon: 31.2 };
    const a = personalAssessment([near], point, { radiusKm: 100 });
    expect(a.nearest).toHaveLength(1);
    expect(a.nearestBeyondKm).toBeNull();
  });
});

/*
 * Невизначеність, яку джерело заявляє саме, ріже в обидва боки: ціль може бути
 * вже ближче, ніж її позначка. Рівень тривоги мусить читати нижній край вилки,
 * інакше він систематично запізнюється рівно на половину невизначеності.
 */
describe("особиста оцінка — невизначеність джерела доходить до рівня", () => {
  const point = { lat: 50, lon: 30 };
  const q = (uncertaintyKm: number, speedKmh: number | null = null) => ({
    uncertaintyKm,
    position: "approx" as const,
    lifecycle: "tracking" as const,
    presumptiveCourse: false,
    speedKmh,
  });

  /** Ціль на північ від точки, курсом строго на південь — тобто просто на нас. */
  const inbound = (lat: number, quality: ReturnType<typeof q>) =>
    threat({ lat, lon: 30, heading: 180, type: "shahed", quality });

  it("вилка часу ширшає разом із заявленим радіусом", () => {
    const tight = personalAssessment([inbound(51, q(4))], point);
    const loose = personalAssessment([inbound(51, q(45))], point);
    const w = (a: typeof tight) => {
      const r = a.nearest[0]!.etaRangeMin!;
      return r[1] - r[0];
    };
    expect(w(loose)).toBeGreaterThan(w(tight));
  });

  it("найбезпечніше прочитання ніколи не пізніше за середнє", () => {
    const a = personalAssessment([inbound(51, q(45))], point);
    expect(a.minutesToNearestLow).not.toBeNull();
    expect(a.minutesToNearestLow!).toBeLessThanOrEqual(a.minutesToNearest!);
  });

  it("широка невизначеність піднімає рівень, а не занижує його", () => {
    const tight = dangerIndex(personalAssessment([inbound(51, q(4))], point));
    const loose = dangerIndex(personalAssessment([inbound(51, q(45))], point));
    expect(loose.percent).toBeGreaterThanOrEqual(tight.percent);
  });

  it("заміряна швидкість використовується замість типової", () => {
    const measured = personalAssessment([inbound(51, q(4, 99.4))], point);
    const typical = personalAssessment([inbound(51, q(4))], point);
    expect(measured.nearest[0]!.speedMeasured).toBe(true);
    expect(typical.nearest[0]!.speedMeasured).toBe(false);
    // 99 км/год проти типових 180 для шахеда — летить довше.
    expect(measured.nearest[0]!.etaMin!).toBeGreaterThan(typical.nearest[0]!.etaMin!);
  });

  it("ціль, що не йде на точку, вилки не отримує", () => {
    const away = threat({ lat: 51, lon: 30, heading: 0, type: "shahed", quality: q(10) });
    const a = personalAssessment([away], point);
    expect(a.nearest[0]!.inbound).toBe(false);
    expect(a.nearest[0]!.etaRangeMin).toBeNull();
    expect(a.minutesToNearestLow).toBeNull();
  });
});

describe("оцінка руху витісняє перевірку сектора", () => {
  const point = { lat: 50.0, lon: 30.0 };
  /** Ціль на південь від точки, іде на північ — тобто просто на неї. */
  function northbound(lonOffsetKm: number): { threat: Threat; fixes: Fix[] } {
    const lon = 30 + lonOffsetKm / 71.6;
    const fixes: Fix[] = Array.from({ length: 5 }, (_, i) => ({
      lat: 49.335 + (180 * ((i * 120_000) / 3_600_000)) / 111.32,
      lon,
      ts: i * 120_000,
    }));
    const last = fixes[fixes.length - 1]!;
    return {
      threat: {
        id: "t",
        name: "ціль",
        lat: last.lat,
        lon: last.lon,
        source: "neptun.in.ua",
        count: 1,
        since: "",
        expires: "",
        type: "shahed",
        heading: 0,
      },
      fixes,
    };
  }

  it("ціль, що промине за 30 км, більше не вважається вхідною", () => {
    // Сектор ±60° зараховував її як «іде на вас» — звідси половина зайвих
    // сповіщень. Тепер рахується справжній промах.
    const { threat, fixes } = northbound(30);
    const motion = estimateMotion(fixes, 480_000, { type: "shahed" });
    const a = personalAssessment([threat], point, {
      radiusKm: 100,
      concernKm: 15,
      motionOf: () => motion,
    });
    expect(a.nearest[0]!.missKm).toBeGreaterThan(25);
    expect(a.inboundCount).toBe(0);
  });

  it("ціль у лоб лишається вхідною — і несе шанс та межі часу", () => {
    const { threat, fixes } = northbound(0);
    const motion = estimateMotion(fixes, 480_000, { type: "shahed" });
    const n = personalAssessment([threat], point, {
      radiusKm: 100,
      concernKm: 15,
      motionOf: () => motion,
    }).nearest[0]!;
    expect(n.inbound).toBe(true);
    expect(n.chance!).toBeGreaterThan(0.5);
    const [low, high] = n.etaRangeMin!;
    expect(low).toBeLessThanOrEqual(n.etaMin!);
    expect(high).toBeGreaterThanOrEqual(n.etaMin!);
  });

  it("руху ще не видно — лишається стара перевірка сектора, а не мовчання", () => {
    // Гірша оцінка краща за відсутність оцінки: перший фікс теж має щось казати.
    const { threat } = northbound(0);
    const a = personalAssessment([threat], point, { radiusKm: 150, motionOf: () => null });
    expect(a.inboundCount).toBe(1);
  });
});

describe("рівень тривоги мусить РОЗРІЗНЯТИ, а не завжди кричати", () => {
  const KYIV = { lat: 50.45, lon: 30.52 };
  const NOW = Date.parse("2026-09-17T01:00:00Z");

  /** Шахед за `km` на південь, курсом рівно на точку. */
  function shahed(km: number, speedKmh: number | null): Threat {
    return {
      id: "a",
      name: "Шахед",
      lat: KYIV.lat - km / 111.32,
      lon: KYIV.lon,
      source: "neptun.in.ua",
      count: 1,
      since: "",
      expires: "",
      lastSeen: new Date(NOW - 60_000).toISOString(),
      type: "shahed",
      heading: 0,
      quality: {
        uncertaintyKm: 4,
        position: "confirmed",
        lifecycle: "confirmed",
        presumptiveCourse: false,
        speedKmh,
      },
    };
  }

  const level = (km: number, speedKmh: number | null = null): string =>
    dangerIndex(personalAssessment([shahed(km, speedKmh)], KYIV, { radiusKm: 120, now: NOW }))
      .level;

  it("далека ціль без заміряної швидкості більше не «в укриття»", () => {
    /*
     * Було: нижній край вилки для «шахеда» бере 600 км/год (реактивна
     * «Герань»), тож рівень «в укриття» мала КОЖНА ціль у радіусі ста
     * кілометрів. Шкала не розрізняла нічого саме в найчастішому випадку, а
     * рівень, який завжди найвищий, не означає нічого.
     */
    expect(level(100)).toBe("watch");
    expect(level(80)).toBe("attention");
  });

  it("близька ціль лишається «в укриття» — асиметрія на місці", () => {
    expect(level(10)).toBe("shelter");
    expect(level(20)).toBe("shelter");
  });

  it("найшвидший край усе ще пробиває, коли ціль може бути вже над головою", () => {
    // Особливий випадок, а не основа: при найшвидшому прочитанні ≤5 хв ціль
    // справді може бути поруч, і тут поспіх важить більше за розрізнення.
    const a = personalAssessment([shahed(50, null)], KYIV, { radiusKm: 120, now: NOW });
    expect(a.minutesToNearestLow).toBeLessThanOrEqual(5);
    expect(dangerIndex(a).level).toBe("shelter");
  });

  it("заміряна швидкість і таблиця класу дають однаковий рівень на дальніх", () => {
    // Узгодженість, якої доти не було: з виміром 80 км давало «увагу», без
    // виміру — «в укриття». Одна й та сама ціль, два різні рівні.
    for (const km of [80, 100]) expect(level(km)).toBe(level(km, 180));
  });

  it("шкала монотонна: далі — не небезпечніше", () => {
    const rank: Record<string, number> = { calm: 0, watch: 1, attention: 2, shelter: 3 };
    const seq = [10, 20, 30, 40, 50, 60, 80, 100].map((km) => rank[level(km)]!);
    expect(seq.every((v, i) => i === 0 || v <= seq[i - 1]!)).toBe(true);
  });
});
