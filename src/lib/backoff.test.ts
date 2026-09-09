import { describe, expect, it } from "bun:test";

import { backoffMs, sourceUnavailable, UNAVAILABLE_AFTER } from "./backoff";

describe("backoffMs", () => {
  it("перша спроба — базовий інтервал", () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(-1)).toBe(60_000);
  });

  it("росте з кожною порожньою відповіддю", () => {
    expect(backoffMs(1)).toBe(120_000);
    expect(backoffMs(2)).toBe(240_000);
    expect(backoffMs(3)).toBe(480_000);
  });

  it("має стелю, щоб повернення джерела не чекали годинами", () => {
    // Без стелі система переставала б помічати, що джерело ожило.
    expect(backoffMs(50)).toBe(15 * 60_000);
    expect(backoffMs(1000)).toBe(15 * 60_000);
  });

  it("не спадає з ростом невдач", () => {
    let prev = 0;
    for (let i = 0; i < 20; i++) {
      const ms = backoffMs(i);
      expect(ms).toBeGreaterThanOrEqual(prev);
      prev = ms;
    }
  });
});

describe("sourceUnavailable", () => {
  it("одна невдача — ще не недоступність", () => {
    expect(sourceUnavailable(1)).toBe(false);
  });

  it("кілька поспіль — уже так", () => {
    expect(sourceUnavailable(UNAVAILABLE_AFTER)).toBe(true);
    expect(sourceUnavailable(UNAVAILABLE_AFTER + 5)).toBe(true);
  });
});
