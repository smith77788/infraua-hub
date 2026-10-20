import { describe, expect, it } from "bun:test";

import { driftSector, OBSERVED_SPREAD_DEG, PRESUMED_SPREAD_DEG, spreadFor } from "./drift-sector";

const ZP = { lat: 47.84, lon: 35.14 };

/** Км від точки (схід, північ) у локальній площині. */
function km(p: [number, number]): [number, number] {
  const kx = 111.32 * Math.cos((ZP.lat * Math.PI) / 180);
  return [(p[1] - ZP.lon) * kx, (p[0] - ZP.lat) * 111.32];
}

describe("driftSector — «крапля» вперед по курсу", () => {
  // Курс на захід (270°), зсув 20 км, розкид джерела 5 км.
  const poly = driftSector({
    ...ZP,
    courseDeg: 270,
    spreadDeg: OBSERVED_SPREAD_DEG,
    driftKm: 20,
    statedKm: 5,
  })!.map(km);

  it("уперед по курсу сягає зсув + розкид", () => {
    const west = Math.min(...poly.map(([x]) => x));
    expect(west).toBeCloseTo(-25, 0);
  });

  it("позаду — лише розкид джерела: назад ціль не летить", () => {
    const east = Math.max(...poly.map(([x]) => x));
    expect(east).toBeLessThanOrEqual(5.01);
    expect(east).toBeGreaterThan(4.5);
  });

  it("поперек курсу — вузько для спостереженого курсу", () => {
    const north = Math.max(...poly.map(([, y]) => y));
    // 20 км · sin 20° + 5 км ≈ 11,8 км — далеко менше за коло в 25 км.
    expect(north).toBeLessThan(12.5);
    expect(north).toBeGreaterThan(11);
  });

  it("припущений курс — передня півплощина: ширше, але назад так само не сягає", () => {
    const wide = driftSector({
      ...ZP,
      courseDeg: 270,
      spreadDeg: PRESUMED_SPREAD_DEG,
      driftKm: 20,
      statedKm: 5,
    })!.map(km);
    expect(Math.max(...wide.map(([, y]) => y))).toBeCloseTo(25, 0);
    expect(Math.max(...wide.map(([x]) => x))).toBeLessThanOrEqual(5.01);
  });

  it("півкут обрізається до 90°: ширший сектор неопуклий і вже не «крапля»", () => {
    const a = driftSector({ ...ZP, courseDeg: 0, spreadDeg: 170, driftKm: 10, statedKm: 2 });
    const b = driftSector({ ...ZP, courseDeg: 0, spreadDeg: 90, driftKm: 10, statedKm: 2 });
    expect(a).toEqual(b);
  });

  it("зіпсований вхід — null, а не NaN-багатокутник, що мовчки зникне з карти", () => {
    expect(
      driftSector({ ...ZP, courseDeg: Number.NaN, spreadDeg: 20, driftKm: 5, statedKm: 1 }),
    ).toBeNull();
    expect(
      driftSector({ ...ZP, courseDeg: 0, spreadDeg: 20, driftKm: -1, statedKm: 1 }),
    ).toBeNull();
  });

  it("ширина — від того, наскільки курс відомий", () => {
    expect(spreadFor(true)).toBe(OBSERVED_SPREAD_DEG);
    expect(spreadFor(false)).toBe(PRESUMED_SPREAD_DEG);
  });
});
