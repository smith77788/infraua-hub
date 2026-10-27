import { describe, expect, it } from "bun:test";

import type { Threat, ThreatType } from "./air";
import { SpeedLedger, WINDOW_MS } from "./speed-ledger";
import { EMPTY_QUALITY } from "./threat-quality";

const NOW = Date.parse("2026-10-23T00:00:00Z");

function t(id: string, type: ThreatType, speedKmh: number | null): Threat {
  return {
    id,
    name: "x",
    lat: 50,
    lon: 30,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    type,
    quality: { ...EMPTY_QUALITY, speedKmh },
  };
}

describe("SpeedLedger — заміряна швидкість за нашим типом", () => {
  it("одна ціль — одна точка: висіла пів години чи пролетіла — важить однаково", () => {
    const l = new SpeedLedger();
    for (let i = 0; i < 60; i++) l.observe([t("a", "reactive", 400)], NOW + i * 30_000);
    l.observe([t("b", "reactive", 300)], NOW);
    expect(l.summary(NOW + 60 * 30_000).reactive).toMatchObject({ n: 2, medianKmh: 350 });
  });

  it("тип — останній відомий: канал назвав її реактивною — рахуємо в реактивні", () => {
    const l = new SpeedLedger();
    l.observe([t("a", "shahed", 420)], NOW);
    l.observe([t("a", "reactive", 430)], NOW + 60_000);
    const s = l.summary(NOW + 60_000);
    expect(s.shahed).toBeUndefined();
    expect(s.reactive).toMatchObject({ n: 1, medianKmh: 430, referenceKmh: 550 });
  });

  it("без заміру й викиди — не в вибірці; старше тижня — забуто", () => {
    const l = new SpeedLedger();
    l.observe([t("a", "shahed", null), t("b", "shahed", 5), t("c", "shahed", 5000)], NOW);
    expect(l.summary(NOW).shahed).toBeUndefined();
    l.observe([t("d", "shahed", 180)], NOW);
    expect(l.summary(NOW + WINDOW_MS + 1).shahed).toBeUndefined();
  });

  it("відкинута для руху швидкість (reportedSpeedKmh) у вибірці лишається", () => {
    const l = new SpeedLedger();
    const t0 = t("a", "reactive", null);
    l.observe([{ ...t0, quality: { ...t0.quality!, reportedSpeedKmh: 103 } }], NOW);
    expect(l.summary(NOW).reactive).toMatchObject({ n: 1, medianKmh: 103 });
  });

  it("переживає перезапуск: стан → JSON → стан", () => {
    const l = new SpeedLedger();
    l.observe([t("a", "banderol", 480), t("b", "reactive", 510)], NOW);
    const back = SpeedLedger.fromState(JSON.parse(JSON.stringify(l.toState())), NOW);
    expect(back.summary(NOW)).toEqual(l.summary(NOW));
    expect(SpeedLedger.fromState("битий", NOW).summary(NOW)).toEqual({});
  });
});
