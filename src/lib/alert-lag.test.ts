import { describe, expect, it } from "bun:test";

import type { AlertLevels } from "./alert-levels";
import { LagLog, MAX_PLAUSIBLE_LAG_SEC, officialStartOf } from "./alert-lag";

const area = (oblast: string, since: string) => ({
  key: since,
  name: "Район",
  oblast,
  level: "yellow" as const,
  since,
  reasons: [],
});

describe("officialStartOf", () => {
  const levels: AlertLevels = {
    updatedAt: "",
    oblasts: [],
    raions: [
      area("Рівненська область", "2026-10-28T18:08:43Z"),
      area("Рівненська область", "2026-10-28T18:10:00Z"),
      area("Хмельницька область", "2026-10-28T18:05:00Z"),
    ],
  };

  it("бере НАЙРАНІШИЙ район області: сирена звучить відтоді, як її оголосили хоч десь", () => {
    expect(officialStartOf(levels, "Рівненська область")).toBe(Date.parse("2026-10-28T18:08:43Z"));
  });

  it("знаходить область і за народною назвою", () => {
    expect(officialStartOf(levels, "Рівненщина")).toBe(Date.parse("2026-10-28T18:08:43Z"));
  });

  it("немає даних — немає й заміру, а не нуль", () => {
    expect(officialStartOf(null, "Рівненщина")).toBeNull();
    expect(officialStartOf(levels, "Волинь")).toBeNull();
  });
});

describe("LagLog", () => {
  const T = Date.parse("2026-10-28T18:08:43Z");

  it("рахує затримку в секундах і підсумовує медіаною", () => {
    const log = new LagLog();
    log.record(T + 40_000, T);
    log.record(T + 90_000, T);
    log.record(T + 20_000, T);
    expect(log.summary()).toEqual({ n: 3, lastSec: 20, medianSec: 40, maxSec: 90 });
  });

  it("давня тривога, вперше побачена після перезапуску, — не затримка", () => {
    const log = new LagLog();
    expect(log.record(T + (MAX_PLAUSIBLE_LAG_SEC + 1) * 1000, T)).toBeNull();
    expect(log.summary().n).toBe(0);
  });

  it("розбіжність годинників зводиться до нуля, а не викидається", () => {
    const log = new LagLog();
    expect(log.record(T - 5_000, T)).toBe(0);
  });

  it("без офіційного часу нічого не записує", () => {
    const log = new LagLog();
    expect(log.record(T, null)).toBeNull();
    expect(log.summary()).toEqual({ n: 0, lastSec: null, medianSec: null, maxSec: null });
  });

  it("кільце не росте", () => {
    const log = new LagLog(3);
    for (let i = 0; i < 10; i++) log.record(T + i * 1000, T);
    expect(log.summary().n).toBe(3);
  });
});
