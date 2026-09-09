import { describe, expect, it } from "bun:test";

import { assessCriticality, betweenness, bridges, components } from "./infra-criticality";
import type { Facility, GraphEdge } from "./infra-types";

function node(id: string): Facility {
  return { id, name: id, category: "substation", lat: 50, lon: 30, source: "test" };
}

function edge(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    km: 1,
    kind: "supply",
    provenance: { kind: "observed", source: "test", retrievedAt: "2026-09-09" },
  };
}

describe("betweenness", () => {
  it("ставить посередника на ланцюжку вище за його кінці", () => {
    // a — b — c: усі найкоротші шляхи між a і c ідуть через b.
    const nodes = ["a", "b", "c"].map(node);
    const result = betweenness(nodes, [edge("a", "b"), edge("b", "c")]);
    const byId = new Map(result.map((r) => [r.id, r]));

    expect(byId.get("b")!.raw).toBe(1);
    expect(byId.get("a")!.raw).toBe(0);
    expect(result[0]!.id).toBe("b");
  });

  it("знаходить вузол, який пропускає підрахунок споживачів", () => {
    // Два трикутники, зʼєднані лише через `broker`. У нього ступінь 2, у
    // членів кластерів — 3. Саме цей випадок і мотивував метрику: за
    // кількістю споживачів посередник виглядає другорядним.
    const ids = ["x1", "x2", "x3", "broker", "y1", "y2", "y3"];
    const nodes = ids.map(node);
    const edges = [
      edge("x1", "x2"),
      edge("x2", "x3"),
      edge("x3", "x1"),
      edge("x1", "broker"),
      edge("broker", "y1"),
      edge("y1", "y2"),
      edge("y2", "y3"),
      edge("y3", "y1"),
    ];

    const top = betweenness(nodes, edges)[0]!;
    expect(top.id).toBe("broker");
    expect(top.score).toBe(1);
  });

  it("дає нуль усім у повному графі, де ніхто нічого не посередничає", () => {
    const nodes = ["a", "b", "c"].map(node);
    const edges = [edge("a", "b"), edge("b", "c"), edge("a", "c")];
    for (const entry of betweenness(nodes, edges)) expect(entry.raw).toBe(0);
  });

  it("ділить внесок між двома однаково короткими маршрутами", () => {
    const nodes = ["a", "b", "c", "d"].map(node);
    const edges = [edge("a", "b"), edge("b", "d"), edge("a", "c"), edge("c", "d")];
    const byId = new Map(betweenness(nodes, edges).map((r) => [r.id, r]));
    expect(byId.get("b")!.raw).toBeCloseTo(0.5, 5);
    expect(byId.get("c")!.raw).toBeCloseTo(0.5, 5);
  });

  it("не рахує недосяжні пари в розʼєднаному графі", () => {
    const nodes = ["a", "b", "c", "d"].map(node);
    for (const entry of betweenness(nodes, [edge("a", "b"), edge("c", "d")])) {
      expect(entry.raw).toBe(0);
    }
  });

  it("не падає на порожньому графі", () => {
    expect(betweenness([], [])).toEqual([]);
  });

  it("ігнорує ребро до вузла поза набором", () => {
    // Клірингова властивість: ребро до невидимого обʼєкта не має впливати
    // на метрики видимих.
    const nodes = ["a", "b"].map(node);
    const withGhost = betweenness(nodes, [edge("a", "b"), edge("a", "ghost")]);
    const without = betweenness(nodes, [edge("a", "b")]);
    expect(withGhost).toEqual(without);
  });
});

describe("bridges", () => {
  it("знаходить єдине ребро, що тримає два кластери разом", () => {
    const ids = ["x1", "x2", "x3", "y1", "y2", "y3"];
    const edges = [
      edge("x1", "x2"),
      edge("x2", "x3"),
      edge("x3", "x1"),
      edge("x1", "y1"),
      edge("y1", "y2"),
      edge("y2", "y3"),
      edge("y3", "y1"),
    ];
    const found = bridges(ids.map(node), edges);
    expect(found).toHaveLength(1);
    expect([found[0]!.from, found[0]!.to].sort()).toEqual(["x1", "y1"]);
  });

  it("не бачить мостів у циклі, де в кожного ребра є обхід", () => {
    const nodes = ["a", "b", "c"].map(node);
    expect(bridges(nodes, [edge("a", "b"), edge("b", "c"), edge("c", "a")])).toHaveLength(0);
  });

  it("вважає мостом кожне ребро дерева", () => {
    const nodes = ["a", "b", "c"].map(node);
    expect(bridges(nodes, [edge("a", "b"), edge("b", "c")])).toHaveLength(2);
  });
});

describe("components", () => {
  it("групує досяжні вузли, найбільша компонента перша", () => {
    const nodes = ["a", "b", "c", "d", "e"].map(node);
    const result = components(nodes, [edge("a", "b"), edge("b", "c"), edge("d", "e")]);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(3);
  });

  it("рахує ізольований вузол окремою компонентою", () => {
    expect(components(["a", "b"].map(node), [])).toHaveLength(2);
  });
});

describe("assessCriticality", () => {
  const ids = ["x1", "x2", "x3", "broker", "y1", "y2", "y3"];
  const nodes = ids.map(node);
  const edges = [
    edge("x1", "x2"),
    edge("x2", "x3"),
    edge("x3", "x1"),
    edge("x1", "broker"),
    edge("broker", "y1"),
    edge("y1", "y2"),
    edge("y2", "y3"),
    edge("y3", "y1"),
  ];
  const empty = {
    dependents: new Map<string, number>(),
    atRisk: new Set<string>(),
    underAlarm: new Set<string>(),
  };

  it("розкладає кожну оцінку на названі сигнали з причиною і доказом", () => {
    const result = assessCriticality({ facilities: nodes, edges, ...empty });
    const broker = result.get("broker")!;

    expect(broker.signals.length).toBeGreaterThan(0);
    for (const signal of broker.signals) {
      // Оцінка без розбору — це число, з яким не можна не погодитись поіменно.
      expect(signal.reason.length).toBeGreaterThan(0);
      expect(signal.evidence.length).toBeGreaterThan(0);
      expect(signal.contribution).toBeGreaterThan(0);
    }
  });

  it("ставить посередника вище за периферійний вузол", () => {
    const result = assessCriticality({ facilities: nodes, edges, ...empty });
    expect(result.get("broker")!.score).toBeGreaterThan(result.get("y2")!.score);
  });

  it("оцінка нуль означає відсутність сигналів, і навпаки", () => {
    const result = assessCriticality({ facilities: nodes, edges, ...empty });
    for (const assessment of result.values()) {
      if (assessment.signals.length === 0) expect(assessment.score).toBe(0);
      else expect(assessment.score).toBeGreaterThan(0);
    }
  });

  it("активна подія поруч підіймає оцінку", () => {
    const base = assessCriticality({ facilities: nodes, edges, ...empty });
    const withEvent = assessCriticality({
      facilities: nodes,
      edges,
      dependents: new Map(),
      atRisk: new Set(["y2"]),
      underAlarm: new Set(),
    });
    expect(withEvent.get("y2")!.score).toBeGreaterThan(base.get("y2")!.score);
    expect(withEvent.get("y2")!.signals.some((s) => s.id === "event_nearby")).toBe(true);
  });

  it("обмежує оцінку сотнею, не ховаючи внески", () => {
    const loaded = assessCriticality({
      facilities: nodes,
      edges,
      dependents: new Map(nodes.map((n) => [n.id, 100])),
      atRisk: new Set(ids),
      underAlarm: new Set(ids),
    });
    for (const assessment of loaded.values()) {
      expect(assessment.score).toBeLessThanOrEqual(100);
    }
  });

  it("призначає смуги на задокументованих межах", () => {
    const result = assessCriticality({ facilities: nodes, edges, ...empty });
    for (const a of result.values()) {
      if (a.score >= 70) expect(a.band).toBe("severe");
      else if (a.score >= 45) expect(a.band).toBe("high");
      else if (a.score >= 20) expect(a.band).toBe("elevated");
      else expect(a.band).toBe("low");
    }
  });
});
