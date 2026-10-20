import { describe, expect, it } from "bun:test";

import { advance } from "./dead-reckoning";
import { DriftAccuracy, sampleFromFix } from "./drift-accuracy";
import { mapNeptunThreat, type NeptunThreat } from "./neptun-map";

// Живий запис Нептуна (2026-10-20): БпЛА з припущеним курсом 254°.
const RAW: NeptunThreat = {
  id: "trk_00283043",
  type: "uav",
  title: "БпЛА",
  locality: "Олевськ",
  lat: 51.32267229631553,
  lon: 28.205612970422237,
  heading: 254.432,
  updatedAt: "2026-10-20T01:46:40Z",
  confirmedAt: "2026-10-20T01:46:40Z",
  explanationShort: "БпЛА курсом на Олевськ.",
  status: "active",
  presumptiveCourse: true,
};
const prev = mapNeptunThreat(RAW)!;

function fixAfter(minutes: number, bearing: number, km: number) {
  const p = advance(prev.lat, prev.lon, bearing, km);
  const at = new Date(Date.parse(RAW.confirmedAt!) + minutes * 60_000).toISOString();
  return { ...prev, lat: p.lat, lon: p.lon, since: at, lastSeen: at };
}

describe("sampleFromFix — замір моделі руху на новій фіксації", () => {
  it("ціль пішла заявленим курсом — рух ближчий до правди, ніж стояти", () => {
    // 6 хв, курс як заявлено, 18 км (реальні ~185 км/год).
    const s = sampleFromFix(prev, fixAfter(6, 254.432, 18))!;
    expect(s.basis).toBe("presumed");
    expect(s.stillErrKm).toBeCloseTo(18, 0);
    expect(s.driftErrKm).toBeCloseTo(13, 0); // протягнуто на 5 км із 18
    expect(s.driftErrKm).toBeLessThan(s.stillErrKm);
  });

  it("ціль розвернулась — замір чесно показує, що рух програв", () => {
    const s = sampleFromFix(prev, fixAfter(6, 74.432, 18))!;
    expect(s.driftErrKm).toBeGreaterThan(s.stillErrKm);
  });

  it("не нова фіксація (той самий час чи <30 с) — не вимір", () => {
    expect(sampleFromFix(prev, { ...prev })).toBeNull();
    expect(sampleFromFix(prev, fixAfter(0.2, 254, 1))).toBeNull();
  });

  it("ціль, яку модель не рухала, — не вимір: обидва кандидати та сама точка", () => {
    const { heading: _drop, ...still } = prev;
    expect(sampleFromFix(still, fixAfter(6, 254, 18))).toBeNull();
  });

  it("розрив понад 20 хв — не вимір: модель давно на стелі", () => {
    expect(sampleFromFix(prev, fixAfter(25, 254, 60))).toBeNull();
  });
});

describe("DriftAccuracy — зведення", () => {
  it("рахує медіани й частку перемог руху за типом курсу", () => {
    const acc = new DriftAccuracy();
    acc.observe(prev, fixAfter(6, 254.432, 18)); // рух виграв
    acc.observe(prev, fixAfter(6, 260, 15)); // рух виграв
    acc.observe(prev, fixAfter(6, 74.432, 18)); // рух програв
    const s = acc.summary().presumed!;
    expect(s.n).toBe(3);
    expect(s.driftWins).toBeCloseTo(0.67, 2);
    expect(s.medianStillKm).toBeCloseTo(18, 0);
  });

  it("підтвердження на тому ж місці не йде у вибірку, але рахується окремо", () => {
    const acc = new DriftAccuracy();
    const at = new Date(Date.parse(RAW.confirmedAt!) + 6 * 60_000).toISOString();
    acc.observe(prev, { ...prev, since: at, lastSeen: at });
    const s = acc.summary().presumed!;
    expect(s.n).toBe(0);
    expect(s.samePlace).toBe(1);
  });

  it("порожній замір — порожнє зведення, а не нулі, що читаються як «ідеально»", () => {
    expect(new DriftAccuracy().summary()).toEqual({});
  });

  it("без вибірки — null, а не нулі, що читаються як «ідеальна точність»", () => {
    const acc = new DriftAccuracy();
    const at = new Date(Date.parse(RAW.confirmedAt!) + 6 * 60_000).toISOString();
    acc.observe(prev, { ...prev, since: at, lastSeen: at });
    expect(acc.summary().presumed).toMatchObject({
      n: 0,
      medianDriftKm: null,
      medianStillKm: null,
      driftWins: null,
    });
  });

  it("стан переживає перезапуск", () => {
    const acc = new DriftAccuracy();
    acc.observe(prev, fixAfter(6, 254.432, 18));
    const back = new DriftAccuracy();
    back.restore(JSON.parse(JSON.stringify(acc.toState())));
    expect(back.summary()).toEqual(acc.summary());
    back.restore({ v: 9, samples: [{ basis: "presumed" }] });
    expect(back.summary().presumed!.n).toBe(1);
  });
});
