import { describe, expect, it } from "bun:test";

import {
  assessCriticality,
  betweenness,
  betweennessDetailed,
  bridges,
  components,
  downstreamCounts,
} from "./infra-criticality";
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

describe("betweenness — вибірка опорних вузлів", () => {
  /** Ланцюжок з n вузлів: посередництво зростає до середини. */
  function chain(n: number) {
    const nodes = Array.from({ length: n }, (_, i) => node(`n${i}`));
    const edges = Array.from({ length: n - 1 }, (_, i) => edge(`n${i}`, `n${i + 1}`));
    return { nodes, edges };
  }

  it("позначає точний розрахунок як точний, а вибірку — як оцінку", () => {
    const { nodes, edges } = chain(40);
    expect(betweennessDetailed(nodes, edges).exact).toBe(true);
    const sampled = betweennessDetailed(nodes, edges, { sources: 10 });
    expect(sampled.exact).toBe(false);
    expect(sampled.sourcesUsed).toBe(10);
  });

  it("дає той самий результат на тих самих даних", () => {
    // Випадкова вибірка змушувала б рейтинг сіпатися між перерахунками.
    const { nodes, edges } = chain(60);
    const a = betweennessDetailed(nodes, edges, { sources: 15 }).entries;
    const b = betweennessDetailed(nodes, edges, { sources: 15 }).entries;
    expect(a).toEqual(b);
  });

  it("за вибіркою відділяє середину ланцюжка від країв, але не називає точного лідера", () => {
    // Межа методу, заміряна, а не припущена: на ланцюжку профіль посередництва
    // — пологá парабола, сусідні вузли відрізняються на відсотки, тож вибірка
    // з 12 джерел ставить першим n14 замість справжнього n20. Оцінка годиться,
    // щоб відділити посередника від периферії, і не годиться, щоб обирати
    // єдиний найважливіший вузол.
    const { nodes, edges } = chain(41);
    const entries = betweennessDetailed(nodes, edges, { sources: 12 }).entries;
    const top = Number(entries[0]!.id.slice(1));
    expect(top).toBeGreaterThanOrEqual(13);
    expect(top).toBeLessThanOrEqual(27);

    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get("n20")!.raw).toBeGreaterThan(byId.get("n2")!.raw * 5);
  });

  it("не просить більше джерел, ніж є вузлів", () => {
    const { nodes, edges } = chain(5);
    const r = betweennessDetailed(nodes, edges, { sources: 999 });
    expect(r.sourcesUsed).toBe(5);
    expect(r.exact).toBe(true);
  });
});

describe("паралельні ребра", () => {
  it("рахуються як один звʼязок, а не подвоюють шляхи", () => {
    // Дві лінії між тією ж парою — це один звʼязок у топології; інакше
    // подвоїлася б кількість найкоротших шляхів і поїхало б посередництво.
    const nodes = ["a", "b", "c"].map(node);
    const single = betweenness(nodes, [edge("a", "b"), edge("b", "c")]);
    const doubled = betweenness(nodes, [
      edge("a", "b"),
      edge("b", "a"),
      edge("b", "c"),
      edge("c", "b"),
    ]);
    expect(doubled).toEqual(single);
    expect(bridges(nodes, [edge("a", "b"), edge("b", "a")])).toHaveLength(1);
  });
});

describe("сигнал проти припущень", () => {
  function inferredEdge(from: string, to: string): GraphEdge {
    return {
      from,
      to,
      km: 1,
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

  const empty = {
    dependents: new Map<string, number>(),
    atRisk: new Set<string>(),
    underAlarm: new Set<string>(),
  };

  it("позначає структурний сигнал, який існує лише завдяки виведеним ребрам", () => {
    // Спостережений трикутник a—b—c, у якому мостів немає за побудовою, плюс
    // одна здогадка c—d. У змішаному графі c стає кінцем мосту — але це
    // властивість нашого припущення, а не мережі.
    const nodes = ["a", "b", "c", "d"].map(node);
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a"), inferredEdge("c", "d")];
    const result = assessCriticality({ facilities: nodes, edges, ...empty });

    const bridgeSignal = result.get("c")!.signals.find((s) => s.id === "bridge");
    expect(bridgeSignal).toBeDefined();
    expect(bridgeSignal!.grounded).toBe(false);

    // А в самому трикутнику ніхто мостом не став — перевірка, що ми не
    // позначаємо як необґрунтоване те, чого взагалі немає.
    expect(result.get("a")!.signals.some((s) => s.id === "bridge")).toBe(false);
  });

  it("не чіпляє попередження до сигналу, що тримається і без припущень", () => {
    // Той самий міст існує в спостереженому графі, тож здогадки поруч нічого
    // не змінюють.
    const nodes = ["a", "b", "c", "d", "e"].map(node);
    const edges = [edge("a", "b"), edge("b", "c"), inferredEdge("c", "d"), inferredEdge("d", "e")];
    const result = assessCriticality({ facilities: nodes, edges, ...empty });

    const bridgeSignal = result.get("b")!.signals.find((s) => s.id === "bridge")!;
    expect(bridgeSignal.grounded).toBe(true);
  });

  it("вважає структуру необґрунтованою, коли спостережених ребер немає взагалі", () => {
    const nodes = ["a", "b", "c"].map(node);
    const edges = [inferredEdge("a", "b"), inferredEdge("b", "c")];
    const result = assessCriticality({ facilities: nodes, edges, ...empty });
    for (const s of result.get("b")!.signals) {
      if (s.id === "bridge" || s.id === "brokerage") expect(s.grounded).toBe(false);
    }
  });

  it("вважає структуру обґрунтованою, коли всі ребра спостережені", () => {
    const nodes = ["a", "b", "c"].map(node);
    const result = assessCriticality({
      facilities: nodes,
      edges: [edge("a", "b"), edge("b", "c")],
      ...empty,
    });
    for (const s of result.get("b")!.signals) expect(s.grounded).toBe(true);
  });

  it("сигнали не з графа обґрунтовані завжди", () => {
    // Сектор, подія і тривога приходять із джерел напряму — граф їх не
    // стосується, тож і попереджати нема про що.
    const nodes = ["a", "b"].map(node);
    const result = assessCriticality({
      facilities: nodes,
      edges: [inferredEdge("a", "b")],
      dependents: new Map(),
      atRisk: new Set(["a"]),
      underAlarm: new Set(["a"]),
    });
    for (const s of result.get("a")!.signals) {
      if (["sector", "event_nearby", "alarm"].includes(s.id)) expect(s.grounded).toBe(true);
    }
  });
});

describe("downstreamCounts", () => {
  it("рахує всіх нижче за течією, не лише прямих сусідів", () => {
    const counts = downstreamCounts([edge("a", "b"), edge("b", "c"), edge("c", "d")]);
    expect(counts.get("a")).toBe(3);
    expect(counts.get("b")).toBe(2);
    expect(counts.get("c")).toBe(1);
  });

  it("не зациклюється на кільці", () => {
    const counts = downstreamCounts([edge("a", "b"), edge("b", "c"), edge("c", "a")]);
    expect(counts.get("a")).toBe(3);
  });
});
