import { describe, expect, it } from "bun:test";
import { isInUkraine, parseReverseGeocode, reverseGeocodeUrl } from "./geo-country";

describe("розбір відповіді зворотного геокодування", () => {
  it("читає країну й регіон", () => {
    // Форма — з реальної відповіді Nominatim для Рені (заміряно 18.09).
    const raw = {
      display_name: "Одеська область, Україна",
      address: { state: "Одеська область", country: "Україна", country_code: "ua" },
    };
    expect(parseReverseGeocode(raw)).toEqual({ countryCode: "ua", state: "Одеська область" });
  });

  it("код країни зводиться до малих літер", () => {
    const raw = { address: { country_code: "PL", state: "podkarpackie" } };
    expect(parseReverseGeocode(raw)?.countryCode).toBe("pl");
  });

  it("без регіону бере країну як назву", () => {
    const raw = { address: { country_code: "ca", country: "Canada" } };
    expect(parseReverseGeocode(raw)).toEqual({ countryCode: "ca", state: "Canada" });
  });

  it("сміття дає null, а не здогад", () => {
    expect(parseReverseGeocode(null)).toBeNull();
    expect(parseReverseGeocode("ua")).toBeNull();
    expect(parseReverseGeocode({})).toBeNull();
    expect(parseReverseGeocode({ address: {} })).toBeNull();
    expect(parseReverseGeocode({ address: { country_code: 42 } })).toBeNull();
  });
});

describe("адреса запиту", () => {
  it("містить координати й рівень області", () => {
    const url = reverseGeocodeUrl(45.45, 28.28);
    expect(url).toContain("lat=45.45000");
    expect(url).toContain("lon=28.28000");
    expect(url).toContain("zoom=5");
  });

  it("не падає на неможливих числах", () => {
    expect(() => reverseGeocodeUrl(NaN, Infinity)).not.toThrow();
  });
});

describe("три відповіді, а не дві", () => {
  it("Україна", () => {
    expect(isInUkraine("ua")).toBe(true);
  });
  it("не Україна", () => {
    expect(isInUkraine("pl")).toBe(false);
    expect(isInUkraine("ca")).toBe(false);
  });
  it("НЕ ЗНАЄМО — окремо від «ні»", () => {
    // Стара підписка, задана до появи перевірки. Повестися з нею як із
    // закордонною означало б мовчки відібрати тривоги в людини вдома.
    expect(isInUkraine(undefined)).toBeNull();
    expect(isInUkraine(null)).toBeNull();
    expect(isInUkraine("")).toBeNull();
  });
});
