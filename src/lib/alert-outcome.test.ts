import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { AlertOutcomes, OUTCOME_WINDOW_MS } from "./alert-outcome";

const KYIV = { lat: 50.45, lon: 30.52 };
const T0 = Date.parse("2026-10-20T01:00:00Z");

function fix(lat: number, lon: number, atMs: number): Threat {
  const iso = new Date(atMs).toISOString();
  return {
    id: `t-${lat}-${atMs}`,
    name: "Пункт",
    lat,
    lon,
    source: "neptun.in.ua",
    count: 1,
    since: iso,
    expires: "",
    lastSeen: iso,
  };
}

function ledger() {
  const l = new AlertOutcomes();
  l.record({ chatId: 1, ...KYIV, radiusKm: 15, at: T0 });
  return l;
}

describe("AlertOutcomes — чи справдилось попередження", () => {
  it("ціль пролетіла в радіусі тривоги — підтверджено, з часом до наближення", () => {
    const l = ledger();
    l.resolve([fix(50.5, 30.55, T0 + 8 * 60_000)], T0 + 8 * 60_000); // ~6 км
    const s = l.summary();
    expect(s.confirmed).toBe(1);
    expect(s.open).toBe(0);
    expect(s.medianMinToNear).toBe(8);
  });

  it("поки вікно не минуло й поруч нікого — вироку ще немає", () => {
    const l = ledger();
    l.resolve([fix(51.5, 31.5, T0 + 10 * 60_000)], T0 + 10 * 60_000); // ~140 км
    expect(l.summary()).toMatchObject({ open: 1, closed: 0, confirmedShare: null });
  });

  it("вікно минуло без наближення — «не підтвердилось», а не «хибна»", () => {
    const l = ledger();
    l.resolve([], T0 + OUTCOME_WINDOW_MS + 1);
    expect(l.summary()).toMatchObject({ unconfirmed: 1, confirmed: 0, confirmedShare: 0 });
  });

  it("давня фіксація поруч не підтверджує нове попередження", () => {
    const l = ledger();
    l.resolve([fix(50.45, 30.52, T0 - 30 * 60_000)], T0 + 60_000);
    expect(l.summary().open).toBe(1);
  });

  it("частка підтверджених рахується серед тих, що мають вирок", () => {
    const l = new AlertOutcomes();
    l.record({ chatId: 1, ...KYIV, radiusKm: 15, at: T0 });
    l.record({ chatId: 2, lat: 49.84, lon: 24.03, radiusKm: 15, at: T0 }); // Львів
    l.resolve([fix(50.46, 30.5, T0 + 60_000)], T0 + 60_000);
    l.resolve([], T0 + OUTCOME_WINDOW_MS + 1);
    expect(l.summary()).toMatchObject({ confirmed: 1, unconfirmed: 1, confirmedShare: 0.5 });
  });

  it("зіпсований запис не відкривається — вирок не можна винести тому, чого немає", () => {
    const l = new AlertOutcomes();
    l.record({ chatId: 1, lat: Number.NaN, lon: 30, radiusKm: 15, at: T0 });
    l.record({ chatId: 1, ...KYIV, radiusKm: 0, at: T0 });
    expect(l.summary().open).toBe(0);
  });
});
