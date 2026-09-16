import { describe, expect, it } from "bun:test";

import {
  angularDiff,
  bearingDeg,
  citiesOnCourse,
  projectThreats,
  SPEED_KMH,
  SPEED_RANGE_KMH,
} from "./threat-eta";
import type { CategoryId, Facility } from "./infra-types";
import type { Threat, ThreatType } from "./air";

function fac(id: string, category: CategoryId, lat: number, lon: number): Facility {
  return { id, name: id, category, lat, lon, source: "test" };
}

function threat(id: string, lat: number, lon: number, extra: Partial<Threat> = {}): Threat {
  return { id, name: id, lat, lon, source: "@ch", count: 1, since: "", expires: "", ...extra };
}

describe("bearingDeg", () => {
  it("вказує на північ для точки прямо вище", () => {
    expect(bearingDeg({ lat: 50, lon: 30 }, { lat: 51, lon: 30 })).toBeCloseTo(0, 0);
  });
  it("вказує на схід для точки праворуч", () => {
    expect(bearingDeg({ lat: 50, lon: 30 }, { lat: 50, lon: 31 })).toBeCloseTo(90, 0);
  });
});

describe("angularDiff", () => {
  it("бере найкоротший бік кола", () => {
    expect(angularDiff(350, 10)).toBe(20);
    expect(angularDiff(10, 350)).toBe(20);
    expect(angularDiff(0, 180)).toBe(180);
  });
});

describe("projectThreats", () => {
  const kyiv = fac("f1", "power_plant", 50.45, 30.52);

  it("ловить ціль, що йде курсом на критичний обʼєкт", () => {
    // Ціль на південь від обʼєкта, курс 0° (на північ) — прямо на нього.
    const t = threat("t1", 49.55, 30.52, { heading: 0, type: "cruise" });
    const out = projectThreats([t], [kyiv]);
    expect(out).toHaveLength(1);
    expect(out[0]!.facility.id).toBe("f1");
    expect(out[0]!.etaMin).toBeGreaterThan(0);
    expect(out[0]!.offAxisDeg).toBeLessThanOrEqual(22);
  });

  it("відкидає ціль, що летить геть від обʼєкта", () => {
    const t = threat("t2", 49.55, 30.52, { heading: 180, type: "cruise" }); // на південь
    expect(projectThreats([t], [kyiv])).toHaveLength(0);
  });

  it("ігнорує цілі без курсу", () => {
    const t = threat("t3", 49.55, 30.52, { type: "cruise" });
    expect(projectThreats([t], [kyiv])).toHaveLength(0);
  });

  it("швидший тип дає менший ETA на тій самій дистанції", () => {
    const slow = threat("s", 49.55, 30.52, { heading: 0, type: "shahed" });
    const fast = threat("f", 49.55, 30.52, { heading: 0, type: "ballistic" });
    const es = projectThreats([slow], [kyiv])[0]!.etaMin;
    const ef = projectThreats([fast], [kyiv])[0]!.etaMin;
    expect(ef).toBeLessThan(es);
  });

  it("залишає один обʼєкт лише з найтерміновішою ціллю", () => {
    const near = threat("near", 50.2, 30.52, { heading: 0, type: "cruise" });
    const far = threat("far", 49.4, 30.52, { heading: 0, type: "cruise" });
    const out = projectThreats([far, near], [kyiv]);
    expect(out).toHaveLength(1);
    expect(out[0]!.threat.id).toBe("near");
  });

  it("за замовчуванням бере лише критичні категорії", () => {
    const shop = fac("shop", "other" as CategoryId, 50.45, 30.52);
    const t = threat("t", 49.55, 30.52, { heading: 0, type: "cruise" });
    expect(projectThreats([t], [shop])).toHaveLength(0);
    expect(projectThreats([t], [shop], { criticalOnly: false })).toHaveLength(1);
  });
});

describe("citiesOnCourse", () => {
  const cities = [
    { name: "Полтава", lat: 49.59, lon: 34.55 },
    { name: "Суми", lat: 50.9, lon: 34.8 },
    { name: "Львів", lat: 49.84, lon: 24.03 },
  ];

  it("місто по курсу — з ETA за швидкістю типу", () => {
    // Шахед південніше Полтави, курс 0° (на північ) → Полтава на курсі.
    const r = citiesOnCourse(threat("s", 49.0, 34.55, { type: "shahed", heading: 0 }), cities);
    expect(r[0]?.name).toBe("Полтава");
    expect(r[0]?.etaMin).toBeGreaterThan(0);
  });

  it("без курсу — порожньо (не вигадуємо напрямок)", () => {
    expect(citiesOnCourse(threat("s", 49.0, 34.55, { type: "shahed" }), cities)).toHaveLength(0);
  });

  it("місто збоку від курсу не потрапляє", () => {
    // Курс на північ, а Львів далеко на захід — не на курсі.
    const r = citiesOnCourse(threat("s", 49.0, 34.55, { type: "shahed", heading: 0 }), cities);
    expect(r.some((c) => c.name === "Львів")).toBe(false);
  });
});

/*
 * Те, що джерело каже про власну точність, має доходити до часу підльоту.
 * Заміри з живої відповіді neptun: радіус невизначеності 4..45 км, а для
 * цілі із заміряною швидкістю 99 км/год таблиця типових дала б 180 — тобто
 * майже вдвічі оптимістичніший час.
 */
describe("projectThreats — невизначеність доходить до часу", () => {
  const target: Facility[] = [
    { id: "pp", name: "ТЕЦ", category: "power_plant", lat: 51, lon: 30, source: "test" },
  ];

  it("вилка часу ширшає разом із заявленою невизначеністю", () => {
    const tight = projectThreats(
      [
        threat("a", 50, 30, {
          heading: 0,
          type: "shahed",
          quality: {
            uncertaintyKm: 4,
            position: "confirmed",
            lifecycle: "tracking",
            presumptiveCourse: false,
            speedKmh: null,
          },
        }),
      ],
      target,
    );
    const loose = projectThreats(
      [
        threat("b", 50, 30, {
          heading: 0,
          type: "shahed",
          quality: {
            uncertaintyKm: 45,
            position: "approx",
            lifecycle: "uncertain",
            presumptiveCourse: false,
            speedKmh: null,
          },
        }),
      ],
      target,
    );
    expect(tight).toHaveLength(1);
    expect(loose).toHaveLength(1);
    const width = (p: (typeof tight)[number]) => p.etaRangeMin[1] - p.etaRangeMin[0];
    expect(width(loose[0]!)).toBeGreaterThan(width(tight[0]!));
    // Середня оцінка при цьому та сама — ширшає саме невпевненість.
    expect(loose[0]!.etaMin).toBe(tight[0]!.etaMin);
  });

  it("середня оцінка лежить усередині вилки", () => {
    const [p] = projectThreats(
      [
        threat("a", 50, 30, {
          heading: 0,
          type: "shahed",
          quality: {
            uncertaintyKm: 10,
            position: "approx",
            lifecycle: "tracking",
            presumptiveCourse: false,
            speedKmh: null,
          },
        }),
      ],
      target,
    );
    expect(p!.etaRangeMin[0]).toBeLessThanOrEqual(p!.etaMin);
    expect(p!.etaRangeMin[1]).toBeGreaterThanOrEqual(p!.etaMin);
  });

  it("заміряна швидкість б'є таблицю типових", () => {
    const measured = projectThreats(
      [
        threat("a", 50, 30, {
          heading: 0,
          type: "shahed",
          quality: {
            uncertaintyKm: 4,
            position: "confirmed",
            lifecycle: "tracking",
            presumptiveCourse: false,
            speedKmh: 99.4,
          },
        }),
      ],
      target,
    );
    const typical = projectThreats([threat("b", 50, 30, { heading: 0, type: "shahed" })], target);
    expect(measured[0]!.speedMeasured).toBe(true);
    expect(typical[0]!.speedMeasured).toBe(false);
    // 99 км/год проти типових 180 — ціль іде повільніше, отже часу більше.
    expect(measured[0]!.etaMin).toBeGreaterThan(typical[0]!.etaMin);
  });

  it("припущений курс позначається, а не видається за спостережений", () => {
    const [p] = projectThreats(
      [
        threat("a", 50, 30, {
          heading: 0,
          type: "shahed",
          quality: {
            uncertaintyKm: 25,
            position: "approx",
            lifecycle: "uncertain",
            presumptiveCourse: true,
            speedKmh: null,
          },
        }),
      ],
      target,
    );
    expect(p!.courseObserved).toBe(false);
  });

  it("без заяв джерела вилка все одно не нульова", () => {
    const [p] = projectThreats([threat("a", 50, 30, { heading: 0, type: "shahed" })], target);
    expect(p!.courseObserved).toBe(true);
    expect(p!.etaRangeMin[1]).toBeGreaterThan(p!.etaRangeMin[0]);
  });
});

/*
 * «Шахед» у каналах — це два різні апарати: поршнева «Герань» понад 185 км/год
 * і реактивна до 600. Канал пише про обидві однаково. Таблиця з одним числом
 * 180 казала «пів години» там, де лишалося девʼять хвилин.
 */
describe("швидкість діапазоном — тип цілі теж невідомий", () => {
  const target: Facility[] = [
    { id: "pp", name: "ТЕЦ", category: "power_plant", lat: 51, lon: 30, source: "test" },
  ];
  const at = (type: ThreatType) =>
    projectThreats([threat("a", 50, 30, { heading: 0, type })], target)[0]!;

  it("невідомий різновид шахеда дає вилку в рази, а не відсотки", () => {
    const p = at("shahed");
    // Верхня межа діапазону 600 проти нижньої 185 — понад утричі.
    expect(p.etaRangeMin[1] / Math.max(1, p.etaRangeMin[0])).toBeGreaterThan(2.5);
  });

  it("найраніший приліт рахується з БИСТРОГО краю", () => {
    const shahed = at("shahed");
    const reactive = at("reactive");
    // Обидва можуть іти 600 км/год, тож найраніший приліт співмірний —
    // саме це й рятує від «у вас пів години» на реактивному.
    expect(shahed.etaRangeMin[0]).toBeLessThanOrEqual(reactive.etaRangeMin[0] * 1.3);
  });

  it("прямо названий реактивний не отримує поршневого хвоста", () => {
    expect(at("reactive").etaRangeMin[1]).toBeLessThan(at("shahed").etaRangeMin[1]);
  });

  it("нерозпізнана позначка не тягне балістичний край", () => {
    // Інакше кожна нерозпізнана ціль світилася б як найтерміновіша, а коли
    // терміновим позначено все — не позначено нічого.
    expect(at("unknown").etaRangeMin[0]).toBeGreaterThan(at("ballistic").etaRangeMin[0]);
  });

  it("заміряна швидкість схлопує діапазон у точку", () => {
    const [p] = projectThreats(
      [
        threat("m", 50, 30, {
          heading: 0,
          type: "shahed",
          quality: {
            uncertaintyKm: 0.001,
            position: "confirmed",
            lifecycle: "tracking",
            presumptiveCourse: false,
            speedKmh: 99.4,
          },
        }),
      ],
      target,
    );
    expect(p!.etaRangeMin[1] - p!.etaRangeMin[0]).toBeLessThanOrEqual(1);
    expect(p!.speedMeasured).toBe(true);
  });

  it("балістику більше не занижено вдвічі", () => {
    // Іскандер-М: 2100–2600 м/с. Попереднє одне число 3000 км/год було
    // заниженим більш ніж удвічі проти нижнього краю.
    expect(SPEED_RANGE_KMH.ballistic[0]).toBeGreaterThanOrEqual(3000);
    expect(SPEED_RANGE_KMH.ballistic[1]).toBeGreaterThan(7000);
  });

  it("середня оцінка лежить усередині свого діапазону", () => {
    for (const [type, [slow, fast]] of Object.entries(SPEED_RANGE_KMH)) {
      const typical = SPEED_KMH[type as keyof typeof SPEED_KMH];
      expect(typical).toBeGreaterThanOrEqual(slow);
      expect(typical).toBeLessThanOrEqual(fast);
    }
  });
});

describe("геометрія підльоту: вздовж курсу, а не по похилій", () => {
  const KYIV = { name: "Київ", lat: 50.45, lon: 30.52 };

  /** Ціль на півдні від Києва, курсом рівно на північ, за `km` кілометрів. */
  function southOf(km: number, heading: number): Threat {
    return {
      id: "t",
      name: "Ціль",
      lat: KYIV.lat - km / 111.32,
      lon: KYIV.lon,
      source: "neptun.in.ua",
      count: 1,
      since: "",
      expires: "",
      type: "shahed",
      heading,
      quality: {
        uncertaintyKm: 0,
        position: "confirmed",
        lifecycle: "confirmed",
        presumptiveCourse: false,
        speedKmh: 200,
      },
    };
  }

  it("ціль точно по курсу — час як і був", () => {
    const [hit] = citiesOnCourse(southOf(100, 0), [KYIV], { corridorDeg: 35, maxRangeKm: 200 });
    // 100 км на 200 км/год — тридцять хвилин.
    expect(hit!.etaMin).toBe(30);
    expect(hit!.missKm).toBe(0);
  });

  it("ціль під кутом — час МЕНШИЙ, бо рахується до траверзу", () => {
    /*
     * Похила відстань 100 км під кутом 30° означає шлях до траверзу 86,6 км,
     * тобто 26 хвилин, а не 30. Стара формула давала 30 — завищення на 15%, і
     * завжди в бік «у вас більше часу, ніж насправді».
     */
    const [hit] = citiesOnCourse(southOf(100, 30), [KYIV], {
      corridorDeg: 35,
      maxRangeKm: 200,
      // Стелю промаху тут піднімаємо навмисно: перевіряємо саме ЧАС, а
      // усталені 25 км відсікли б цю ціль раніше (промах 50 км) — що вони й
      // мають робити, і що перевірено окремим тестом нижче.
      maxMissKm: 100,
    });
    expect(hit!.etaMin).toBeLessThan(30);
    expect(hit!.etaMin).toBeGreaterThanOrEqual(25);
  });

  it("називає, наскільки ціль промине місто", () => {
    // 100 км під 30° — промах пів сотні кілометрів.
    const [hit] = citiesOnCourse(southOf(100, 30), [KYIV], {
      corridorDeg: 35,
      maxRangeKm: 200,
      maxMissKm: 100,
    });
    expect(hit!.missKm).toBeGreaterThan(45);
    expect(hit!.missKm).toBeLessThan(55);
  });

  it("стеля промаху відсікає те, чого кутовий коридор не відсікав", () => {
    // Той самий кут 30°: на 100 км це промах 50 км, на 20 км — лише 10.
    const far = citiesOnCourse(southOf(100, 30), [KYIV], {
      corridorDeg: 35,
      maxRangeKm: 200,
      maxMissKm: 25,
    });
    const near = citiesOnCourse(southOf(20, 30), [KYIV], {
      corridorDeg: 35,
      maxRangeKm: 200,
      maxMissKm: 25,
    });
    expect(far).toHaveLength(0);
    expect(near).toHaveLength(1);
  });

  it("час ніколи не буває більший за розрахунок по похилій", () => {
    // Властивість, а не окремий випадок: cos ≤ 1 на всьому коридорі.
    for (const off of [0, 5, 10, 15, 20, 25, 30, 35]) {
      const [hit] = citiesOnCourse(southOf(80, off), [KYIV], {
        corridorDeg: 35,
        maxRangeKm: 200,
        maxMissKm: 100,
      });
      expect(hit!.etaMin).toBeLessThanOrEqual(Math.round((80 / 200) * 60));
    }
  });
});
