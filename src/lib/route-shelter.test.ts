import { describe, expect, it } from "bun:test";
import {
  renderRouteShelters,
  shelterNear,
  SHELTER_REACH_KM,
  type LegShelter,
} from "./route-shelter";
import type { Shelter } from "./shelters";

const s = (name: string, lat: number, lon: number): Shelter => ({
  id: name,
  kind: "shelter",
  name,
  lat,
  lon,
});

const P = { lat: 50.0, lon: 30.0 };
/** Зсув по широті в градусах, що дає приблизно `km` кілометрів. */
const north = (km: number) => km / 111;

describe("найближче укриття", () => {
  it("бере найближче з кількох", () => {
    const near = [s("далеке", 50 + north(20), 30), s("близьке", 50 + north(5), 30)];
    expect(shelterNear(P, () => near)?.name).toBe("близьке");
  });

  it("укриття за порогом не рахується — година їзди це не укриття", () => {
    const far = [s("за 60 км", 50 + north(60), 30)];
    expect(shelterNear(P, () => far)).toBeNull();
  });

  it("порожній набір дає null, а не найкраще з поганого", () => {
    expect(shelterNear(P, () => [])).toBeNull();
  });

  it("поріг можна звузити, але не обійти", () => {
    const one = [s("за 20 км", 50 + north(20), 30)];
    expect(shelterNear(P, () => one, SHELTER_REACH_KM)).not.toBeNull();
    expect(shelterNear(P, () => one, 10)).toBeNull();
  });

  it("биті координати не проходять як «нуль кілометрів»", () => {
    const broken = [{ ...s("битий", NaN, NaN) }];
    expect(shelterNear(P, () => broken)).toBeNull();
  });
});

describe("рядок для маршруту", () => {
  it("без небезпечних ділянок рядка немає взагалі", () => {
    expect(renderRouteShelters([])).toBeNull();
  });

  it("називає укриття там, де воно є", () => {
    const legs: LegShelter[] = [{ fromStartKm: 40, shelter: { name: "Холодна Гора", km: 8 } }];
    const out = renderRouteShelters(legs)!;
    expect(out).toContain("40 км — Холодна Гора (8 км убік)");
    // Усі ділянки закриті укриттям — поради про канаву тут не треба.
    expect(out).not.toContain("канаву");
  });

  it("де укриття немає — каже прямо й дає єдину правильну пораду", () => {
    const legs: LegShelter[] = [
      { fromStartKm: 120, shelter: null },
      { fromStartKm: 160, shelter: null },
    ];
    const out = renderRouteShelters(legs)!;
    expect(out).toContain("120 км — укриття поблизу немає");
    expect(out).toContain("канаву");
    expect(out).toContain("Машина — не");
  });

  it("змішаний випадок: і назви, і порада", () => {
    const legs: LegShelter[] = [
      { fromStartKm: 40, shelter: { name: "Метро", km: 3 } },
      { fromStartKm: 160, shelter: null },
    ];
    const out = renderRouteShelters(legs)!;
    expect(out).toContain("Метро (3 км убік)");
    expect(out).toContain("укриття поблизу немає");
    expect(out).toContain("канаву");
  });
});
