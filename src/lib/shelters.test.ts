import { describe, expect, it } from "bun:test";

import {
  classifyShelter,
  nearestShelters,
  shelterQuery,
  toShelter,
  type Shelter,
} from "./shelters";

/*
 * Ці тести тримають межу, на якій функція ледь не стала шкідливою. Зразки —
 * із живих відповідей Overpass по Україні, а не вигадані: саме там виявилось,
 * що `amenity=shelter` — це альтанки, а `building=bunker` — руїни ДОТів.
 */
describe("classifyShelter — що НЕ є укриттям", () => {
  it("альтанка не укриття", () => {
    expect(classifyShelter({ amenity: "shelter", shelter_type: "gazebo" })).toBeNull();
  });

  it("накриття для пікніка не укриття", () => {
    expect(classifyShelter({ amenity: "shelter", shelter_type: "picnic_shelter" })).toBeNull();
  });

  it("зупинка транспорту не укриття", () => {
    expect(classifyShelter({ amenity: "shelter", shelter_type: "public_transport" })).toBeNull();
  });

  it("ДОТ Другої світової не укриття", () => {
    expect(
      classifyShelter({
        building: "bunker",
        military: "bunker",
        historic: "ruins",
        name: "ДОТ №35 СОР",
      }),
    ).toBeNull();
  });

  it("площа з назвою «Незламності» не укриття", () => {
    expect(classifyShelter({ name: "площа Незламності", place: "square" })).toBeNull();
  });
});

describe("classifyShelter — що є укриттям", () => {
  it("обладнане укриття", () => {
    expect(classifyShelter({ shelter_type: "bomb_shelter" })).toBe("shelter");
    expect(classifyShelter({ emergency: "shelter" })).toBe("shelter");
  });

  it("станція метро", () => {
    expect(classifyShelter({ station: "subway", name: "Арсенальна" })).toBe("metro");
  });

  it("вхід у метро", () => {
    expect(classifyShelter({ railway: "subway_entrance" })).toBe("metro_entrance");
  });

  it("підземний паркінг", () => {
    expect(classifyShelter({ amenity: "parking", parking: "underground" })).toBe("underground");
  });

  it("наземний паркінг — ні", () => {
    expect(classifyShelter({ amenity: "parking", parking: "surface" })).toBeNull();
  });

  it("станція з тегом укриття лишається укриттям, а не входом", () => {
    expect(classifyShelter({ station: "subway", shelter_type: "bomb_shelter" })).toBe("shelter");
  });
});

describe("toShelter", () => {
  it("закрите для входу відкидається", () => {
    const el = {
      type: "way",
      id: 1,
      center: { lat: 50, lon: 30 },
      tags: { emergency: "shelter", access: "private" },
    };
    expect(toShelter(el)).toBeNull();
  });

  it("бере місткість і назву українською", () => {
    const s = toShelter({
      type: "way",
      id: 7,
      center: { lat: 50, lon: 30 },
      tags: { emergency: "shelter", capacity: "245", "name:uk": "Сховище №3", name: "Shelter 3" },
    });
    expect(s!.capacity).toBe(245);
    expect(s!.name).toBe("Сховище №3");
    expect(s!.id).toBe("way/7");
  });

  it("без координат нічого не повертає", () => {
    expect(toShelter({ type: "way", id: 2, tags: { emergency: "shelter" } })).toBeNull();
  });
});

describe("shelterQuery", () => {
  const q = shelterQuery({ south: 50, west: 30, north: 51, east: 31 });

  it("не тягне альтанки й ДОТи", () => {
    expect(q).not.toContain('"building"="bunker"');
    expect(q).not.toMatch(/"amenity"="shelter"(?!\])/);
  });

  it("тягне метро й обладнані укриття", () => {
    expect(q).toContain('"station"="subway"');
    expect(q).toContain('"emergency"="shelter"');
  });
});

describe("nearestShelters", () => {
  const point = { lat: 50, lon: 30 };
  const at = (id: string, kind: Shelter["kind"], kmNorth: number): Shelter => ({
    id,
    kind,
    name: id,
    lat: point.lat + kmNorth / 111,
    lon: point.lon,
  });

  it("у межах одного кроку дальності виграє кращий захист", () => {
    const list = nearestShelters(point, [at("m", "metro_entrance", 0.3), at("s", "shelter", 0.4)]);
    expect(list[0]!.id).toBe("s");
  });

  it("але далеке укриття не витісняє близьке метро", () => {
    const list = nearestShelters(point, [at("far", "shelter", 4), at("near", "metro", 0.2)]);
    expect(list[0]!.id).toBe("near");
  });

  it("вхід і станція поруч не дублюються", () => {
    const list = nearestShelters(point, [at("st", "metro", 0.5), at("en", "metro_entrance", 0.55)]);
    expect(list).toHaveLength(1);
  });

  it("далі за межу не показуємо", () => {
    expect(nearestShelters(point, [at("x", "shelter", 40)])).toHaveLength(0);
  });

  it("рахує пішу дорогу, а не політ", () => {
    const [s] = nearestShelters(point, [at("a", "metro", 1)]);
    // 1 км пішки при 5 км/год — близько 12 хвилин.
    expect(s!.walkMin).toBeGreaterThanOrEqual(10);
    expect(s!.walkMin).toBeLessThanOrEqual(14);
  });

  it("порожній список — це порожній список, а не помилка", () => {
    expect(nearestShelters(point, [])).toEqual([]);
  });
});
