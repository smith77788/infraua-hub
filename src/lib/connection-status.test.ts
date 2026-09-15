import { describe, expect, it } from "bun:test";

import { airConnection } from "./connection-status";

const BASE = 1_700_000_000_000;

describe("airConnection", () => {
  it("свіжий онлайн-фід — банера немає", () => {
    const c = airConnection({
      online: true,
      feedUpdatedAt: BASE,
      hasData: true,
      now: BASE + 30_000,
    });
    expect(c.link).toBe("live");
    expect(c.banner).toBe(false);
  });

  it("немає даних узагалі — найгірший стан, банер небезпеки", () => {
    const c = airConnection({ online: true, feedUpdatedAt: null, hasData: false, now: BASE });
    expect(c.link).toBe("nodata");
    expect(c.level).toBe("danger");
    expect(c.banner).toBe(true);
  });

  it("немає даних і немає мережі — деталь про звʼязок", () => {
    const c = airConnection({ online: false, feedUpdatedAt: null, hasData: false, now: BASE });
    expect(c.detail).toContain("звʼязок");
  });

  it("офлайн, але дані є — чесно кажемо, що це не поточна обстановка", () => {
    const c = airConnection({
      online: false,
      feedUpdatedAt: BASE,
      hasData: true,
      now: BASE + 2 * 60_000,
    });
    expect(c.link).toBe("offline");
    expect(c.level).toBe("danger");
    expect(c.detail).toContain("НЕ поточна");
  });

  it("онлайн, але фід застиг (>15 хв) — застигло", () => {
    const c = airConnection({
      online: true,
      feedUpdatedAt: BASE,
      hasData: true,
      now: BASE + 20 * 60_000,
    });
    expect(c.link).toBe("frozen");
    expect(c.level).toBe("danger");
  });

  it("онлайн, невелика затримка (3–15 хв) — попередження, не небезпека", () => {
    const c = airConnection({
      online: true,
      feedUpdatedAt: BASE,
      hasData: true,
      now: BASE + 6 * 60_000,
    });
    expect(c.link).toBe("delayed");
    expect(c.level).toBe("warn");
    expect(c.banner).toBe(true);
  });

  it("офлайн важливіший за застарілість: спершу кажемо про звʼязок", () => {
    // фід старий І мережі немає — має бути «offline», не «frozen»
    const c = airConnection({
      online: false,
      feedUpdatedAt: BASE,
      hasData: true,
      now: BASE + 30 * 60_000,
    });
    expect(c.link).toBe("offline");
  });
});
