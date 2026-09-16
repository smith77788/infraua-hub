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
    etaRangeMin: [6, 11],
    distanceKm: 24,
    missKm: 2,
    uncertaintyKm: 8,
    uncertaintyStated: true,
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
  const cap = (patch: Partial<CityAlert> = {}): string =>
    cityAlertCaption({
      name: "Полтавщина",
      lat: 49.59,
      lon: 34.55,
      etaMin: 8,
      etaRangeMin: [7, 10],
      distanceKm: 24,
      missKm: 2,
      uncertaintyKm: 6,
      uncertaintyStated: true,
      count: 3,
      type: "shahed",
      ...patch,
    });

  it("містить місто, підліт і правильну множину типу", () => {
    const text = cap();
    expect(text).toContain("<b>Полтавщина</b>");
    expect(text).toContain("3 шахеди");
  });

  it("одна ціль — однина", () => {
    const text = cap({ name: "Сумщина", count: 1 });
    expect(text).toContain("1 шахед");
    expect(text).not.toContain("1 шахеди");
  });

  it("вузька вилка — одне число, як і було", () => {
    expect(cap({ etaMin: 8, etaRangeMin: [7, 9] })).toContain("~8 хв");
  });

  it("широка вилка — діапазон, а не середнє", () => {
    const text = cap({ etaMin: 8, etaRangeMin: [4, 14] });
    expect(text).toContain("4–14 хв");
    expect(text).not.toContain("~8 хв");
  });

  it("вилка від нуля до далеко — не число, а те, що з нього випливає", () => {
    // Саме випадок зі знімка проду: розкид позиції більший за відстань до
    // міста. «~3 хв» там було формально правдиве й порожнє водночас.
    const text = cap({ etaMin: 3, etaRangeMin: [1, 25] });
    expect(text).toContain("може бути вже поруч");
    expect(text).not.toContain("~3 хв");
  });

  it("називає розкид позиції й те, чиє це число", () => {
    expect(cap({ uncertaintyKm: 6, uncertaintyStated: true })).toContain("±6 км за даними джерела");
    const ours = cap({ uncertaintyKm: 15, uncertaintyStated: false });
    expect(ours).toContain("±15 км");
    expect(ours).toContain("розкиду не вказало");
  });
});

/*
 * Адресний сигнал каже конкретному місту «ціль іде саме на вас». Побудувати
 * таке на припущеному курсі — значить підняти місто навмання; загальна
 * картина, обласна тривога й персональний радар працюють для цієї людини
 * незалежно, тож ідеться про прибрану хибну точність, а не про прибране
 * попередження.
 */
describe("cityAlerts — адресний сигнал лише зі спостереженого курсу", () => {
  const presumed = {
    uncertaintyKm: 25,
    position: "approx" as const,
    lifecycle: "uncertain" as const,
    presumptiveCourse: true,
    speedKmh: null,
  };

  it("припущений курс не піднімає місто", () => {
    expect(cityAlerts([nearPoltava({ quality: presumed })])).toHaveLength(0);
  });

  it("спостережений курс піднімає", () => {
    expect(cityAlerts([nearPoltava()]).length).toBeGreaterThan(0);
  });

  it("серед змішаних лишаються тільки спостережені", () => {
    const alerts = cityAlerts([nearPoltava({ quality: presumed }), nearPoltava()]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.count).toBe(1);
  });
});

describe("сигнал розрізняє підліт і проліт повз", () => {
  const base = {
    name: "Полтавщина",
    lat: 49.59,
    lon: 34.55,
    etaMin: 8,
    etaRangeMin: [7, 10] as [number, number],
    distanceKm: 24,
    uncertaintyKm: 4,
    uncertaintyStated: true,
    count: 1,
    type: "shahed" as const,
  };

  it("ціль на місто — «на підльоті»", () => {
    const text = cityAlertCaption({ ...base, missKm: 2 });
    expect(text).toContain("на підльоті");
    expect(text).toContain("Підліт:");
  });

  it("ціль мине за двадцять кілометрів — не «на підльоті»", () => {
    // Найгучніший сигнал продукту не можна витрачати на проліт повз: місто,
    // яке двічі підняли даремно, на третій раз не повірить.
    const text = cityAlertCaption({ ...base, missKm: 20 });
    expect(text).not.toContain("на підльоті");
    expect(text).toContain("проходить поруч");
    expect(text).toContain("мине приблизно за 20 км");
  });

  it("межа міста не вважається пролетом повз", () => {
    // У межах приблизного радіуса міста курс уже не відрізняє центр від
    // околиці, і казати «мине за 6 км» означало б удавану точність.
    expect(cityAlertCaption({ ...base, missKm: 6 })).toContain("на підльоті");
  });
});
