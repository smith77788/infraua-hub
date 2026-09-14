import { describe, expect, it } from "bun:test";

import { formatDuration, kyivDate, kyivHour } from "./kyiv";

describe("kyivHour", () => {
  it("узимку Київ — UTC+2", () => {
    expect(kyivHour(new Date("2026-01-15T10:00:00Z"))).toBe(12);
  });
  it("улітку Київ — UTC+3, тож зашите зміщення помилялося б на годину", () => {
    expect(kyivHour(new Date("2026-07-15T10:00:00Z"))).toBe(13);
  });
});

describe("kyivDate", () => {
  it("доба рахується за Києвом, а не за UTC", () => {
    // 22:30 UTC 1 січня — це вже 00:30 другого січня в Києві.
    expect(kyivDate(new Date("2026-01-01T22:30:00Z"))).toBe("2026-01-02");
  });
});

describe("formatDuration", () => {
  it("години й хвилини", () => {
    expect(formatDuration(3 * 3600e3 + 20 * 60e3)).toBe("3 год 20 хв");
    expect(formatDuration(2 * 3600e3)).toBe("2 год");
    expect(formatDuration(45 * 60e3)).toBe("45 хв");
    expect(formatDuration(10e3)).toBe("менш ніж хвилина");
  });
});
