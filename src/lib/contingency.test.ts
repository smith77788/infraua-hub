import { describe, expect, it } from "bun:test";

import {
  planRestoration,
  rankAreaContingencies,
  rankContingencies,
  rankSecondFailures,
  simulateAreaOutage,
  simulateOutage,
} from "./contingency";
import type { CategoryId, Facility, GraphEdge } from "./infra-types";

function node(id: string, category: CategoryId = "substation"): Facility {
  return { id, name: id, category, lat: 50, lon: 30, source: "test" };
}

/** Обʼєкт із власними координатами — для перевірок, де відстань має значення. */
function f(
  id: string,
  category: CategoryId,
  lat: number,
  lon: number,
  extra: Partial<Facility> = {},
): Facility {
  return { id, name: id, category, lat, lon, source: "test", ...extra };
}

function observed(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    km: 10,
    kind: "supply",
    provenance: { kind: "observed", source: "OpenStreetMap", retrievedAt: "2026-09-09" },
  };
}

function inferred(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    km: 10,
    kind: "supply",
    provenance: {
      kind: "inferred",
      method: "найближча підстанція",
      params: { radiusKm: 120 },
      confidence: 0.25,
      caveat: "тест",
    },
  };
}

describe("simulateOutage", () => {
  it("не рахує втраченим вузол, у якого лишився інший шлях до генерації", () => {
    // Саме та помилка, заради якої писався модуль: підстанція живиться від
    // двох станцій, і відмова однієї її не гасить.
    const facilities = [
      node("plant-a", "power_plant"),
      node("plant-b", "power_plant"),
      node("sub", "substation"),
      node("hospital", "hospital"),
    ];
    const edges = [
      observed("plant-a", "sub"),
      observed("plant-b", "sub"),
      observed("sub", "hospital"),
    ];

    // Попередня реалізація (`downstreamOf`, прибрана) відповідала на це
    // питання транзитивним замиканням і оголошувала знеструмленими і `sub`, і
    // `hospital`.
    const result = simulateOutage(facilities, edges, "plant-a");
    expect(result.lost.size).toBe(0);
    expect(result.suppliedBefore).toBe(4);
  });

  it("гасить усе, що трималося на єдиному шляху", () => {
    const facilities = [
      node("plant", "power_plant"),
      node("sub", "substation"),
      node("hospital", "hospital"),
    ];
    const edges = [observed("plant", "sub"), observed("sub", "hospital")];
    const result = simulateOutage(facilities, edges, "sub");
    expect([...result.lost].sort()).toEqual(["hospital"]);
  });

  it("не рахує втраченим того, хто й до відмови не мав живлення", () => {
    const facilities = [
      node("plant", "power_plant"),
      node("sub", "substation"),
      node("island", "hospital"),
    ];
    const result = simulateOutage(facilities, [observed("plant", "sub")], "plant");
    expect(result.lost.has("island")).toBe(false);
    expect(result.suppliedBefore).toBe(2);
  });

  it("веде живлення в обидва боки по спостереженій лінії", () => {
    // Лінія фізично двостороння: `to → from` теж працює. Тут генерація
    // приходить у `sub` через ребро, записане в інший бік.
    const facilities = [node("plant", "power_plant"), node("sub", "substation")];
    const result = simulateOutage(facilities, [observed("sub", "plant")], "sub");
    expect(result.suppliedBefore).toBe(2);
    expect(result.lost.size).toBe(0);
  });

  it("не робить двостороннім виведене ребро", () => {
    // Здогадка «plant живить sub» не означає, що sub живить plant.
    const facilities = [
      node("plant", "power_plant"),
      node("sub", "substation"),
      node("other", "substation"),
    ];
    const result = simulateOutage(
      facilities,
      [inferred("plant", "sub"), inferred("other", "sub")],
      "plant",
    );
    expect(result.lost.has("sub")).toBe(true);
    expect(result.lost.has("other")).toBe(false);
  });

  it("відділяє наслідок, доведений спостереженнями, від наслідку з припущень", () => {
    const facilities = [
      node("plant", "power_plant"),
      node("sub", "substation"),
      node("real", "hospital"),
      node("guessed", "hospital"),
    ];
    const edges = [observed("plant", "sub"), observed("sub", "real"), inferred("sub", "guessed")];
    const result = simulateOutage(facilities, edges, "sub");
    expect([...result.lost].sort()).toEqual(["guessed", "real"]);
    // `guessed` висить на здогадці — довести його втрату ми не можемо.
    expect([...result.grounded]).toEqual(["real"]);
  });

  it("повідомляє, що джерел генерації в наборі немає", () => {
    const facilities = [node("a"), node("b")];
    const result = simulateOutage(facilities, [observed("a", "b")], "a");
    expect(result.hasSources).toBe(false);
    expect(result.lost.size).toBe(0);
  });

  it("повертає порожній результат на невідомому вузлі", () => {
    expect(simulateOutage([node("a")], [], "нема").lost.size).toBe(0);
  });
});

describe("rankContingencies", () => {
  it("ранжує відмови за втратами життєзабезпечення, потім за загальними", () => {
    const facilities = [
      node("plant", "power_plant"),
      node("hub", "substation"),
      node("side", "substation"),
      node("h1", "hospital"),
      node("h2", "hospital"),
      node("mill", "industry"),
    ];
    const edges = [
      observed("plant", "hub"),
      observed("hub", "h1"),
      observed("hub", "h2"),
      observed("plant", "side"),
      observed("side", "mill"),
    ];

    const ranked = rankContingencies(facilities, edges);

    // Єдина станція гасить усе — вона й є найгіршою одиничною відмовою.
    // Далі вузол, що тримає обидві лікарні, і аж потім гілка з млином.
    expect(ranked.map((r) => r.id)).toEqual(["plant", "hub", "side"]);
    expect(ranked[0]!.lost).toBe(5);
    expect(ranked[1]!.lifeLost).toBe(2);
    expect(ranked[1]!.lost).toBe(2);

    const side = ranked.find((r) => r.id === "side")!;
    expect(side.lost).toBe(1);
    expect(side.lifeLost).toBe(0);
  });

  it("не показує відмов, що нікого не знеструмлюють", () => {
    // Кільце: будь-який один вузол лишає решту зі шляхом до генерації.
    const facilities = [node("plant", "power_plant"), node("a"), node("b"), node("c")];
    const edges = [
      observed("plant", "a"),
      observed("a", "b"),
      observed("b", "c"),
      observed("c", "plant"),
    ];
    for (const entry of rankContingencies(facilities, edges)) {
      expect(entry.lost).toBeGreaterThan(0);
    }
  });

  it("повертає порожній список без джерел генерації", () => {
    expect(rankContingencies([node("a"), node("b")], [observed("a", "b")])).toEqual([]);
  });

  it("не падає на порожньому наборі", () => {
    expect(rankContingencies([], [])).toEqual([]);
  });
});

describe("відмова за площею", () => {
  /**
   * Ланцюжок: станція живить дві підстанції, кожна — свою лікарню. Друга
   * підстанція стоїть за два кілометри від першої, тобто в тому самому колі.
   */
  const facilities: Facility[] = [
    f("plant", "power_plant", 49.0, 35.0, { name: "Станція", capacityMw: 800 }),
    f("plant-2", "power_plant", 51.0, 30.0, { name: "Далека станція", capacityMw: 300 }),
    f("sub-a", "substation", 49.1, 35.1),
    f("sub-b", "substation", 49.11, 35.11),
    f("hosp-a", "hospital", 49.2, 35.2),
    f("hosp-b", "hospital", 49.3, 35.3),
  ];
  const edges: GraphEdge[] = [
    observed("plant", "sub-a"),
    observed("plant", "sub-b"),
    observed("sub-a", "hosp-a"),
    observed("sub-b", "hosp-b"),
  ];

  it("знімає все, що є в радіусі, а не один вузол", () => {
    // Приліт не вибирає один вузол зі списку: підстанція і резервна лінія за
    // два кілометри від неї — не дві незалежні відмови, а одна.
    const single = simulateOutage(facilities, edges, "sub-a");
    expect(single.lost).toEqual(new Set(["hosp-a"]));

    const area = simulateAreaOutage(facilities, edges, { lat: 49.105, lon: 35.105 }, 5);
    expect(new Set(area.destroyed)).toEqual(new Set(["sub-a", "sub-b"]));
    expect(new Set(area.lost)).toEqual(new Set(["hosp-a", "hosp-b"]));
  });

  it("називає поіменно те, що не можна замінити числом", () => {
    const area = simulateAreaOutage(facilities, edges, { lat: 49.105, lon: 35.105 }, 5);
    expect(area.lifeCritical.map((h) => h.id).sort()).toEqual(["hosp-a", "hosp-b"]);
    expect(area.byTier.life).toBe(2);
    expect(area.byTier.energy).toBe(2);
  });

  it("рахує втрачену генерацію лише там, де вона є в джерелі", () => {
    const withUnknown = [...facilities, f("plant-3", "power_plant", 49.02, 35.02)];
    const area = simulateAreaOutage(withUnknown, edges, { lat: 49.0, lon: 35.0 }, 10);
    expect(area.lostCapacityMw).toBe(800);
    expect(area.capacityKnownFor).toBe(1);
    // Число завжди занижене, і скільки саме — видно. Оцінити потужність за
    // типом станції означало б видати припущення за замір.
    expect(area.capacityUnknownFor).toBe(1);
  });

  it("не чіпає мережу поза колом", () => {
    const area = simulateAreaOutage(facilities, edges, { lat: 51.0, lon: 30.0 }, 5);
    expect(area.destroyed).toEqual(["plant-2"]);
    expect(area.lost).toEqual([]);
  });

  it("перебирає епіцентри, і кожен забирає все своє коло одразу", () => {
    const ranked = rankAreaContingencies(facilities, edges, 5, { limit: 5 });

    // Найдорожчий удар — по станції: без неї немає ні підстанцій, ні лікарень.
    expect(ranked[0]!.centerId).toBe("plant");
    expect(ranked[0]!.lifeLost).toBe(2);
    expect(ranked[0]!.lostCapacityMw).toBe(800);

    // А ось те, чого перебір вузлів не показує ніколи: удар по одній
    // підстанції знімає й другу, бо вона за два кілометри.
    const atSub = ranked.find((entry) => entry.centerId === "sub-a")!;
    expect(atSub.destroyed).toBe(2);
    expect(atSub.lifeLost).toBe(2);
  });
});

describe("друга відмова там, де перша вже сталася", () => {
  const facilities: Facility[] = [
    f("plant", "power_plant", 49.0, 35.0),
    f("sub-1", "substation", 49.1, 35.1),
    f("sub-2", "substation", 49.2, 35.2),
    f("hosp", "hospital", 49.3, 35.3),
  ];
  // Лікарня живиться з двох боків, тож у повній схемі жодна одна відмова її не
  // знімає.
  const edges: GraphEdge[] = [
    observed("plant", "sub-1"),
    observed("plant", "sub-2"),
    observed("sub-1", "hosp"),
    observed("sub-2", "hosp"),
  ];

  it("бачить запас там, де він є", () => {
    expect(simulateOutage(facilities, edges, "sub-1").lost.size).toBe(0);
  });

  it("і бачить, що після першої втрати його вже немає", () => {
    // Запас, порахований по повній схемі, у цьому стані вже витрачено.
    const ranked = rankSecondFailures(facilities, edges, ["sub-1"], 5);
    const second = ranked.find((entry) => entry.id === "sub-2");
    expect(second?.lifeLost).toBe(1);
  });

  it("не приписує кандидатові наслідків першої відмови", () => {
    const withDeadEnd: Facility[] = [...facilities, f("orphan", "water", 49.9, 35.9)];
    const withEdge: GraphEdge[] = [...edges, observed("sub-1", "orphan")];
    const ranked = rankSecondFailures(withDeadEnd, withEdge, ["sub-1"], 5);
    // orphan упав разом із sub-1 і не має зʼявлятися в рахунку sub-2.
    expect(ranked.find((entry) => entry.id === "sub-2")?.lost).toBe(1);
  });
});

describe("черговість відновлення", () => {
  const facilities: Facility[] = [
    f("plant", "power_plant", 49.0, 35.0),
    f("big", "substation", 49.1, 35.1),
    f("small", "substation", 49.5, 35.5),
    f("h1", "hospital", 49.11, 35.11),
    f("h2", "hospital", 49.12, 35.12),
    f("shop", "industry", 49.51, 35.51),
  ];
  const edges: GraphEdge[] = [
    observed("plant", "big"),
    observed("plant", "small"),
    observed("big", "h1"),
    observed("big", "h2"),
    observed("small", "shop"),
  ];

  it("ставить першим ремонт, що повертає найбільше життєзабезпечення", () => {
    const plan = planRestoration(facilities, edges, ["big", "small"], 5);
    expect(plan[0]!.id).toBe("big");
    expect(plan[0]!.restoresLife).toBe(2);
    expect(plan[1]!.id).toBe("small");
  });

  it("перераховує кроки після кожного вибору", () => {
    // Поки станція лежить, ремонт підстанції не повертає нікого: вона сама
    // лишається без живлення. Її цінність зʼявляється лише після першого
    // кроку — тому сума окремих ефектів двох ремонтів не є ефектом від обох.
    const plan = planRestoration(facilities, edges, ["plant", "big"], 5);
    expect(plan[0]!.id).toBe("plant");
    expect(plan[0]!.restoresLife).toBe(0);

    expect(plan[1]!.id).toBe("big");
    expect(plan[1]!.restoresLife).toBe(2);
    expect(plan[plan.length - 1]!.remaining).toBe(0);
  });

  it("повертає порожній план, коли ремонтувати нічого", () => {
    expect(planRestoration(facilities, edges, [], 5)).toEqual([]);
    expect(planRestoration(facilities, edges, ["не існує"], 5)).toEqual([]);
  });
});
