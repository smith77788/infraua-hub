import { describe, expect, it } from "bun:test";

import {
  addPlace,
  MAX_PLACES,
  parsePlaceArgs,
  placeId,
  primaryPlace,
  removePlace,
  renderPlaces,
  type SavedPlace,
  setPrimary,
} from "./saved-places";

function place(label: string, lat = 50, lon = 30): SavedPlace {
  return { id: placeId(label), label, lat, lon, radiusKm: 50, primary: false };
}

describe("placeId", () => {
  it("однакова назва — однаковий ідентифікатор", () => {
    // Інакше «дім», доданий двічі, дав би двійника, про якого людина не знає.
    expect(placeId("Дім")).toBe(placeId("дім "));
  });
  it("назва з самих значків не дає порожнього ідентифікатора", () => {
    expect(placeId("🏠").length).toBeGreaterThan(0);
  });
});

describe("addPlace", () => {
  it("перше місце автоматично головне", () => {
    // Інакше людина додала б точку й не отримувала нічого, доки не здогадалась
    // її призначити.
    const { places } = addPlace([], place("дім"));
    expect(places[0]!.primary).toBe(true);
  });

  it("та сама назва оновлює місце, а не плодить двійника", () => {
    const first = addPlace([], place("дім")).places;
    const r = addPlace(first, place("дім", 49, 36));
    expect(r.outcome).toBe("replaced");
    expect(r.places).toHaveLength(1);
    expect(r.places[0]!.lat).toBe(49);
  });

  it("оновлення не скидає ознаку головного", () => {
    const first = addPlace([], place("дім")).places;
    expect(addPlace(first, place("дім", 49, 36)).places[0]!.primary).toBe(true);
  });

  it("більше за стелю не додається — і про це сказано", () => {
    let places: SavedPlace[] = [];
    for (let i = 0; i < MAX_PLACES; i++) places = addPlace(places, place(`м${i}`)).places;
    const r = addPlace(places, place("зайве"));
    expect(r.outcome).toBe("full");
    expect(r.places).toHaveLength(MAX_PLACES);
  });
});

describe("removePlace", () => {
  it("видалення головного передає звання наступному", () => {
    // Без цього /my перестав би працювати, хоч місця лишились.
    let places = addPlace([], place("дім")).places;
    places = addPlace(places, place("робота")).places;
    const left = removePlace(places, placeId("дім"));
    expect(left).toHaveLength(1);
    expect(left[0]!.primary).toBe(true);
  });

  it("видалення останнього лишає порожньо, без винятків", () => {
    const places = addPlace([], place("дім")).places;
    expect(removePlace(places, placeId("дім"))).toEqual([]);
  });
});

describe("setPrimary", () => {
  it("головне переїжджає й лишається одне", () => {
    let places = addPlace([], place("дім")).places;
    places = addPlace(places, place("робота")).places;
    const next = setPrimary(places, placeId("робота"));
    expect(next.filter((p) => p.primary)).toHaveLength(1);
    expect(primaryPlace(next)!.label).toBe("робота");
  });

  it("невідомий ідентифікатор нічого не ламає", () => {
    const places = addPlace([], place("дім")).places;
    expect(setPrimary(places, "немає")[0]!.primary).toBe(true);
  });
});

describe("parsePlaceArgs", () => {
  it("перше слово — назва, решта — місто", () => {
    // Назви міст бувають із двох слів; назви місць — ні.
    expect(parsePlaceArgs("мама Кривий Ріг")).toEqual({ label: "мама", query: "Кривий Ріг" });
  });
  it("одного слова замало", () => {
    expect(parsePlaceArgs("дім")).toBeNull();
    expect(parsePlaceArgs("")).toBeNull();
  });
});

describe("renderPlaces", () => {
  it("порожній перелік пояснює, чому одна точка — це мало", () => {
    expect(renderPlaces([])).toContain("мовчить непомітно");
  });
  it("головне місце позначене", () => {
    const places = addPlace([], place("дім")).places;
    expect(renderPlaces(places)).toContain("★ <b>дім</b>");
  });
});
