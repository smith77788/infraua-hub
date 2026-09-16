import { describe, expect, it } from "bun:test";

import {
  accrueNight,
  emptyJournal,
  journalHadThreat,
  renderNightSummary,
  type JournalTick,
  type NightJournal,
} from "./personal-journal";

const tick = (o: Partial<JournalTick>): JournalTick => ({
  level: "calm",
  inboundCount: 0,
  nearestInboundKm: null,
  minutesElapsed: 1.5,
  date: "2026-09-16",
  ...o,
});

describe("accrueNight", () => {
  it("рахує хвилини під загрозою лише на рівні attention+", () => {
    let j = emptyJournal("2026-09-16");
    j = accrueNight(j, tick({ level: "watch", minutesElapsed: 10 }));
    expect(j.minutesUnderThreat).toBe(0);
    j = accrueNight(j, tick({ level: "attention", minutesElapsed: 10 }));
    j = accrueNight(j, tick({ level: "shelter", minutesElapsed: 5 }));
    expect(j.minutesUnderThreat).toBe(15);
    expect(j.minutesInShelter).toBe(5);
  });

  it("ловить окремі заходи (спокій → тривога)", () => {
    let j = emptyJournal("2026-09-16");
    j = accrueNight(j, tick({ level: "attention" })); // захід 1
    j = accrueNight(j, tick({ level: "shelter" })); // той самий захід
    j = accrueNight(j, tick({ level: "calm" })); // стихло
    j = accrueNight(j, tick({ level: "attention" })); // захід 2
    expect(j.episodes).toBe(2);
  });

  it("тримає найближче зближення й пік вхідних", () => {
    let j = emptyJournal("2026-09-16");
    j = accrueNight(j, tick({ level: "attention", inboundCount: 2, nearestInboundKm: 40 }));
    j = accrueNight(j, tick({ level: "shelter", inboundCount: 5, nearestInboundKm: 12 }));
    j = accrueNight(j, tick({ level: "attention", inboundCount: 1, nearestInboundKm: 25 }));
    expect(j.closestKm).toBe(12);
    expect(j.peakInbound).toBe(5);
    expect(j.peakLevel).toBe("shelter");
  });

  it("зміна доби скидає журнал на свіжий", () => {
    let j = emptyJournal("2026-09-15");
    j = accrueNight(j, tick({ level: "shelter", date: "2026-09-15", minutesElapsed: 30 }));
    expect(j.episodes).toBe(1);
    const rolled = accrueNight(j, tick({ level: "calm", date: "2026-09-16", minutesElapsed: 5 }));
    expect(rolled.date).toBe("2026-09-16");
    expect(rolled.minutesUnderThreat).toBe(0);
    expect(rolled.episodes).toBe(0);
  });
});

describe("renderNightSummary", () => {
  it("тиха ніч — коротке заспокійливе", () => {
    const j = emptyJournal("2026-09-16");
    expect(journalHadThreat(j)).toBe(false);
    expect(renderNightSummary(j, "Харків")).toContain("спокійно");
  });

  it("тривожна ніч — час, заходи, найближче", () => {
    let j: NightJournal = emptyJournal("2026-09-16");
    j = accrueNight(
      j,
      tick({ level: "attention", inboundCount: 3, nearestInboundKm: 8, minutesElapsed: 40 }),
    );
    j = accrueNight(j, tick({ level: "calm" }));
    j = accrueNight(
      j,
      tick({ level: "shelter", inboundCount: 2, nearestInboundKm: 8, minutesElapsed: 20 }),
    );
    const text = renderNightSummary(j, "Суми");
    expect(text).toContain("Під загрозою");
    expect(text).toContain("8 км");
    expect(text).toContain("Окремих заходів");
  });
});
