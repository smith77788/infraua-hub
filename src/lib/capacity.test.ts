import { describe, expect, it } from "bun:test";

import { audienceCeiling, capacityFor, renderCapacity, usefulWindowExplained } from "./capacity";

describe("стеля аудиторії", () => {
  it("на безкоштовних 30/с у корисні 10 хв вкладаються 18 000 людей", () => {
    // Це не оцінка коду, а арифметика документованого ліміту Telegram.
    expect(audienceCeiling()).toBe(18_000);
  });

  it("менша аудиторія — запасу вистачає", () => {
    const c = capacityFor(5_000);
    expect(c.sufficient).toBe(true);
    expect(c.unreachable).toBe(0);
  });

  it("сто тисяч — половина не встигає отримати попередження вчасно", () => {
    const c = capacityFor(100_000);
    expect(c.sufficient).toBe(false);
    expect(c.reachable).toBe(18_000);
    expect(c.unreachable).toBe(82_000);
  });

  it("платна стеля 1000/с міняє картину", () => {
    expect(capacityFor(100_000, { perSec: 1000 }).sufficient).toBe(true);
  });
});

describe("подання", () => {
  it("поки запасу вистачає — попередження не мозолить око", () => {
    // Попередження про межу, до якої ще далеко, перетворюється на фон і не
    // спрацює тоді, коли справді знадобиться.
    const lines = renderCapacity(capacityFor(1_000));
    expect(lines.join("\n")).toContain("Запасу вистачає");
    expect(lines.join("\n")).not.toContain("⚠️");
  });

  it("за межею — називає числа й обидва справжні варіанти", () => {
    const text = renderCapacity(capacityFor(100_000)).join("\n");
    expect(text).toContain("18000");
    expect(text).toContain("100000");
    expect(text).toContain("платні розсилки");
    expect(text).toContain("канал");
  });

  it("порожня аудиторія не отримує жодного рядка", () => {
    expect(renderCapacity(capacityFor(0))).toEqual([]);
  });

  it("корисне вікно пояснене фізикою, а не відчуттям", () => {
    expect(usefulWindowExplained(50)).toContain("16 хв");
  });
});
