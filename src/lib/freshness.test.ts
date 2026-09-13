import { describe, expect, it } from "bun:test";

import { ageFromEpoch, ageOf, FRESHNESS_THRESHOLDS } from "./freshness";

const NOW = new Date("2026-09-09T12:00:00.000Z").getTime();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe("ageOf", () => {
  it("розрізняє свіже, застаріле і зовсім старе", () => {
    expect(ageOf(ago(5), 60, 1440, NOW).freshness).toBe("fresh");
    expect(ageOf(ago(120), 60, 1440, NOW).freshness).toBe("aging");
    expect(ageOf(ago(2000), 60, 1440, NOW).freshness).toBe("stale");
  });

  it("не вигадує вік, якого не знає", () => {
    expect(ageOf(null, 60, 1440, NOW).freshness).toBe("unknown");
    expect(ageOf("", 60, 1440, NOW).freshness).toBe("unknown");
    expect(ageOf("не дата", 60, 1440, NOW).freshness).toBe("unknown");
  });

  it("вважає час із майбутнього збоєм джерела, а не свіжістю", () => {
    // Інакше зламаний годинник на джерелі виглядав би як «щойно оновлено».
    const future = new Date(NOW + 60 * 60_000).toISOString();
    expect(ageOf(future, 60, 1440, NOW).freshness).toBe("unknown");
  });

  it("невелике випередження годинника не ламає показ", () => {
    const skew = new Date(NOW + 60_000).toISOString();
    expect(ageOf(skew, 60, 1440, NOW).freshness).toBe("fresh");
    expect(ageOf(skew, 60, 1440, NOW).minutes).toBe(0);
  });

  it("пише вік по-людськи", () => {
    expect(ageOf(ago(0.2), 60, 1440, NOW).label).toBe("щойно");
    expect(ageOf(ago(30), 60, 1440, NOW).label).toBe("30 хв тому");
    expect(ageOf(ago(180), 60, 1440, NOW).label).toBe("3 год тому");
    expect(ageOf(ago(3 * 1440), 60, 1440, NOW).label).toBe("3 дн тому");
  });

  it("пороги різні для обʼєктів і подій", () => {
    // Перелік підстанцій не змінюється роками, тривога протухає за хвилини —
    // один поріг на всіх був би неправдою про якесь із джерел.
    expect(FRESHNESS_THRESHOLDS.facilities.stale).not.toBe(FRESHNESS_THRESHOLDS.events.stale);
  });
});

describe("ageFromEpoch", () => {
  const NOW = 1_700_000_000_000;

  it("0 до першого завантаження — час невідомий", () => {
    expect(ageFromEpoch(0, 3, 15, NOW).freshness).toBe("unknown");
    expect(ageFromEpoch(undefined, 3, 15, NOW).freshness).toBe("unknown");
  });

  it("щойно взятий фід — свіжий", () => {
    expect(ageFromEpoch(NOW - 30_000, 3, 15, NOW).freshness).toBe("fresh");
  });

  it("давно не оновлювався — застарілий", () => {
    expect(ageFromEpoch(NOW - 20 * 60_000, 3, 15, NOW).freshness).toBe("stale");
  });
});
