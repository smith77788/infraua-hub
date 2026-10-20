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

  it("ціль у радіусі тривоги, попередження було за вікно до того — «попереджено»", () => {
    const l = new AlertOutcomes();
    const now = T0 + 10 * 60_000;
    const v = l.approach(
      { chatId: 1, ...KYIV, radiusKm: 15, lastAlertAt: T0, quiet: false },
      [fix(50.46, 30.5, now - 60_000)],
      now,
    );
    expect(v).toBe("warned");
  });

  it("ціль поруч, а попередження не було — пропуск, і частка це показує", () => {
    const l = new AlertOutcomes();
    const now = T0 + 10 * 60_000;
    l.approach(
      { chatId: 1, ...KYIV, radiusKm: 15, lastAlertAt: null, quiet: false },
      [fix(50.46, 30.5, now)],
      now,
    );
    l.approach(
      { chatId: 2, ...KYIV, radiusKm: 15, lastAlertAt: now - 60_000, quiet: false },
      [fix(50.46, 30.5, now)],
      now,
    );
    expect(l.summary().approaches).toEqual({ warned: 1, unwarned: 1, quiet: 0, warnedShare: 0.5 });
  });

  it("людина сама попросила тиші — не пропуск системи, а окремий рядок", () => {
    const l = new AlertOutcomes();
    const now = T0;
    l.approach(
      { chatId: 1, ...KYIV, radiusKm: 15, lastAlertAt: null, quiet: true },
      [fix(50.46, 30.5, now)],
      now,
    );
    expect(l.summary().approaches).toMatchObject({ quiet: 1, unwarned: 0, warnedShare: null });
  });

  it("ціль, що кружляє поруч, — одне наближення на пів години, а не двадцять", () => {
    const l = new AlertOutcomes();
    for (let i = 0; i < 20; i++) {
      const now = T0 + i * 60_000;
      l.approach(
        { chatId: 1, ...KYIV, radiusKm: 15, lastAlertAt: null, quiet: false },
        [fix(50.46, 30.5, now)],
        now,
      );
    }
    expect(l.summary().approaches.unwarned).toBe(1);
  });

  it("давня позначка поруч — не наближення", () => {
    const l = new AlertOutcomes();
    const v = l.approach(
      { chatId: 1, ...KYIV, radiusKm: 15, lastAlertAt: null, quiet: false },
      [fix(50.46, 30.5, T0 - 30 * 60_000)],
      T0,
    );
    expect(v).toBeNull();
  });

  it("стан переживає перезапуск, а битий файл не змішується з вибіркою", () => {
    const l = ledger();
    l.resolve([fix(50.46, 30.5, T0 + 60_000)], T0 + 60_000);
    l.approach(
      { chatId: 3, ...KYIV, radiusKm: 15, lastAlertAt: null, quiet: false },
      [fix(50.46, 30.5, T0)],
      T0,
    );
    const back = AlertOutcomes.fromState(JSON.parse(JSON.stringify(l.toState())));
    expect(back.summary()).toEqual(l.summary());
    expect(AlertOutcomes.fromState({ v: 2, closed: [1, 2] }).summary().closed).toBe(0);
    expect(AlertOutcomes.fromState("сміття").summary().closed).toBe(0);
  });
});
