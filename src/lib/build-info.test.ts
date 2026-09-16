import { describe, expect, it } from "bun:test";

import { buildStamp, renderBuild, shellIsStale, shortSha } from "./build-info";

describe("shortSha", () => {
  it("сім символів, як у git", () => {
    expect(shortSha("88fe9e2c0d1e2f3a4b5c")).toBe("88fe9e2");
  });

  it("порожнє не вдає із себе хеш", () => {
    expect(shortSha(undefined)).toBe("—");
    expect(shortSha("   ")).toBe("—");
  });
});

describe("buildStamp", () => {
  it("бере хеш Railway і каже, що він саме звідти", () => {
    const s = buildStamp({ RAILWAY_GIT_COMMIT_SHA: "abc1234def" });
    expect(s.short).toBe("abc1234");
    expect(s.source).toBe("railway");
  });

  it("порядок джерел: Railway переважає загальні", () => {
    const s = buildStamp({ RAILWAY_GIT_COMMIT_SHA: "aaaaaaa", BUILD_SHA: "bbbbbbb" });
    expect(s.source).toBe("railway");
  });

  it("порожній рядок не рахується за значення", () => {
    // Інакше «є змінна, але порожня» виглядало б як відома збірка.
    expect(buildStamp({ RAILWAY_GIT_COMMIT_SHA: "  " }).source).toBe("unknown");
  });

  it("невідомо — це відповідь, а не вигадка", () => {
    const s = buildStamp({});
    expect(s.sha).toBeNull();
    expect(s.source).toBe("unknown");
  });
});

describe("shellIsStale", () => {
  it("однакові мітки — оболонка свіжа", () => {
    expect(shellIsStale("abc", "abc")).toBe(false);
  });

  it("різні мітки — оболонка зі сховища", () => {
    expect(shellIsStale("old", "new")).toBe(true);
  });

  it("без однієї з міток відповіді немає", () => {
    /*
     * `false` тут було б твердженням «усе свіже», зробленим без підстав, —
     * а це саме той різновид тихої брехні, від якого й заводиться перевірка.
     */
    expect(shellIsStale(null, "new")).toBeNull();
    expect(shellIsStale("old", null)).toBeNull();
  });
});

describe("renderBuild", () => {
  const now = Date.UTC(2026, 8, 16, 12, 0, 0);

  it("показує короткий хеш і джерело", () => {
    const t = renderBuild(
      buildStamp({ RAILWAY_GIT_COMMIT_SHA: "abc1234def" }),
      now - 30 * 60_000,
      now,
    );
    expect(t).toContain("abc1234");
    expect(t).toContain("Railway");
    expect(t).toContain("30 хв");
  });

  it("каже прямо, коли хеша немає, і називає змінну", () => {
    const t = renderBuild(buildStamp({}), now, now);
    expect(t).toContain("RAILWAY_GIT_COMMIT_SHA");
  });
});
