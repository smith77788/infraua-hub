import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { cityAlertCaption, cityAlerts, selectFreshCityAlerts, type CityAlert } from "./city-alert";

function threat(p: Partial<Threat>): Threat {
  return {
    id: Math.random().toString(36).slice(2),
    name: "",
    lat: 49,
    lon: 34.55,
    source: "n",
    count: 1,
    since: "",
    expires: "",
    ...p,
  };
}

// Полтава: 49.59, 34.55. Шахед (180 км/год = 3 км/хв): 30 км → ~10 хв.
const nearPoltava = (extra: Partial<Threat> = {}) =>
  threat({ lat: 49.32, lon: 34.55, type: "shahed", heading: 0, ...extra });

describe("cityAlerts", () => {
  it("ціль на підльоті до міста дає адресний сигнал", () => {
    const [a, ...rest] = cityAlerts([nearPoltava()]);
    expect(rest).toHaveLength(0);
    expect(a!.name).toBe("Полтавщина");
    expect(a!.etaMin).toBeLessThanOrEqual(12);
    expect(a!.count).toBe(1);
    expect(a!.type).toBe("shahed");
  });

  it("без курсу — сигналу немає (напрямок не вигадуємо)", () => {
    // Той самий близький шахед, але без heading — курс невідомий.
    expect(cityAlerts([threat({ lat: 49.32, lon: 34.55, type: "shahed" })])).toHaveLength(0);
  });

  it("далеко — ще не сигнал: підліт більший за поріг", () => {
    // 100 км південніше → ~33 хв, поза maxEtaMin=12
    expect(
      cityAlerts([threat({ lat: 48.69, lon: 34.55, type: "shahed", heading: 0 })]),
    ).toHaveLength(0);
  });

  it("курс повз місто — не сигнал", () => {
    // близько, але йде на південь (від Полтави), не на неї
    expect(cityAlerts([nearPoltava({ heading: 180 })])).toHaveLength(0);
  });

  it("кілька цілей на одне місто — рахуємо, підліт за найближчою", () => {
    const [a] = cityAlerts([
      nearPoltava(), // ~30 км
      threat({ lat: 49.41, lon: 34.55, type: "shahed", heading: 0 }), // ~20 км, ближче
    ]);
    expect(a!.count).toBe(2);
    expect(a!.etaMin).toBeLessThanOrEqual(7); // визначає ближча ціль
  });

  it("ліміт тримає сигнал рідкісним — одне місто за раз", () => {
    const many = cityAlerts(
      [nearPoltava(), threat({ lat: 50.64, lon: 34.8, type: "shahed", heading: 0 })], // біля Сум
      undefined,
      { limit: 1 },
    );
    expect(many).toHaveLength(1);
  });
});

describe("selectFreshCityAlerts (кулдаун)", () => {
  const alert: CityAlert = {
    name: "Полтавщина",
    lat: 49.59,
    lon: 34.55,
    etaMin: 8,
    distanceKm: 24,
    count: 2,
    type: "shahed",
  };

  it("перший сигнал проходить і фіксує час", () => {
    const r = selectFreshCityAlerts([alert], {}, 1000, 30 * 60_000);
    expect(r.fresh).toHaveLength(1);
    expect(r.lastAlertedAt["Полтавщина"]).toBe(1000);
  });

  it("повтор у межах кулдауна не проходить", () => {
    const r = selectFreshCityAlerts([alert], { Полтавщина: 1000 }, 1000 + 5 * 60_000, 30 * 60_000);
    expect(r.fresh).toHaveLength(0);
  });

  it("після кулдауна — знову можна", () => {
    const r = selectFreshCityAlerts([alert], { Полтавщина: 1000 }, 1000 + 31 * 60_000, 30 * 60_000);
    expect(r.fresh).toHaveLength(1);
  });
});

describe("cityAlertCaption", () => {
  it("містить місто, підліт і правильну множину типу", () => {
    const cap = cityAlertCaption({
      name: "Полтавщина",
      lat: 49.59,
      lon: 34.55,
      etaMin: 8,
      distanceKm: 24,
      count: 3,
      type: "shahed",
    });
    expect(cap).toContain("<b>Полтавщина</b>");
    expect(cap).toContain("~8 хв");
    expect(cap).toContain("3 шахеди");
  });

  it("одна ціль — однина", () => {
    const cap = cityAlertCaption({
      name: "Сумщина",
      lat: 50.91,
      lon: 34.8,
      etaMin: 5,
      distanceKm: 15,
      count: 1,
      type: "shahed",
    });
    expect(cap).toContain("1 шахед");
    expect(cap).not.toContain("1 шахеди");
  });
});
