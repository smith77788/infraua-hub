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

describe("вік СПОСТЕРЕЖЕННЯ — другий годинник", () => {
  const NOW = Date.UTC(2026, 8, 16, 19, 0, 0);
  const min = (n: number) => NOW - n * 60_000;

  it("свіжа відповідь із застиглими спостереженнями — це НЕ «наживо»", () => {
    /*
     * Головний випадок, заради якого другий годинник і потрібен. На збої
     * джерела сервер свідомо віддає останню відому картину, тож відповідь
     * приходить справна кожні 15 секунд. За старим суддею радар писав би
     * «наживо» над позначками годинної давності.
     */
    const c = airConnection({
      online: true,
      hasData: true,
      feedUpdatedAt: min(0.2),
      observedAt: min(60),
      now: NOW,
    });
    expect(c.link).toBe("frozen");
    expect(c.banner).toBe(true);
    expect(c.detail).toContain("Останнє спостереження");
    expect(c.detail).toContain("останні відомі");
  });

  it("порожнє небо не оголошується поломкою", () => {
    /*
     * Тиха ніч — спостережень немає взагалі. Якби «невідомо» рахувалось за
     * «старо», банер висів би щоночі, і за тиждень йому перестали б вірити.
     */
    const c = airConnection({
      online: true,
      hasData: true,
      feedUpdatedAt: min(0.2),
      observedAt: null,
      now: NOW,
    });
    expect(c.link).toBe("live");
  });

  it("звичайна дискретність джерела не тривожить", () => {
    // Заміряно на живому джерелі: найстаріша ціль була 7,9 хв, медіана ~2 хв.
    const c = airConnection({
      online: true,
      hasData: true,
      feedUpdatedAt: min(0.2),
      observedAt: min(8),
      now: NOW,
    });
    expect(c.link).toBe("live");
  });

  it("спостереження між порогами дає «затримку», а не тишу", () => {
    const c = airConnection({
      online: true,
      hasData: true,
      feedUpdatedAt: min(0.2),
      observedAt: min(15),
      now: NOW,
    });
    expect(c.link).toBe("delayed");
    expect(c.detail).toContain("Останнє спостереження");
  });

  it("береться ГІРШИЙ із двох годинників, а не останній названий", () => {
    // Спостереження свіже, але відповіді немає давно — це теж поломка.
    const c = airConnection({
      online: true,
      hasData: true,
      feedUpdatedAt: min(40),
      observedAt: min(1),
      now: NOW,
    });
    expect(c.link).toBe("frozen");
    expect(c.detail).toContain("Фід не оновлюється");
  });

  it("без другого годинника поведінка лишається як була", () => {
    // Старі виклики не передають observedAt — вердикт не має від цього змінитись.
    const c = airConnection({ online: true, hasData: true, feedUpdatedAt: min(0.2), now: NOW });
    expect(c.link).toBe("live");
  });
});
