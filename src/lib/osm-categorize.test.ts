import { describe, expect, it } from "bun:test";

import { categorize } from "./osm-categorize";

describe("categorize", () => {
  it("розкладає обʼєкти по категоріях за тегами", () => {
    expect(categorize({ power: "plant" })).toBe("power_plant");
    expect(categorize({ amenity: "hospital" })).toBe("hospital");
    expect(categorize({ amenity: "fire_station" })).toBe("fire_station");
    expect(categorize({ railway: "station" })).toBe("rail");
    expect(categorize({ man_made: "communications_tower" })).toBe("telecom");
    expect(categorize({ office: "government", name: "Міськрада" })).toBe("government");
    expect(categorize({ waterway: "dam", name: "ГЕС" })).toBe("dam");
    expect(categorize({ aeroway: "aerodrome", iata: "IEV" })).toBe("airport");
  });

  it("підстанція лише від 110 кВ", () => {
    expect(categorize({ power: "substation", voltage: "330000" })).toBe("substation");
    expect(categorize({ power: "substation", voltage: "35000" })).toBeNull();
    expect(categorize({ power: "substation", voltage: "10000;110000" })).toBe("substation");
  });

  it("не плутає близькі теги і повертає null для невідомого", () => {
    expect(categorize({ railway: "station", train: "no" })).toBeNull();
    expect(categorize({ office: "government" })).toBeNull(); // без name
    expect(categorize({ landuse: "industrial", name: "Завод" })).toBeNull(); // без operator
    expect(categorize({ amenity: "cafe" })).toBeNull();
  });

  it("пріоритет як у QUERIES: електростанція раніша за інше", () => {
    expect(categorize({ power: "plant", landuse: "industrial", name: "X", operator: "Y" })).toBe(
      "power_plant",
    );
  });
});
