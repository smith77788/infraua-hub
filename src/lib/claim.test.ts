import { describe, expect, it } from "bun:test";

import {
  combine,
  explain,
  fromAdmiralty,
  inferred,
  isFullyObserved,
  methodsOf,
  observed,
  sourcesOf,
} from "./claim";

describe("observed", () => {
  it("за замовчуванням має повну впевненість — це й означає «спостережено»", () => {
    const c = observed(42, "OpenStreetMap", { ref: "way/1" });
    expect(c.confidence).toBe(1);
    expect(c.lineage).toMatchObject({ kind: "observed", source: "OpenStreetMap", ref: "way/1" });
  });

  it("дозволяє сказати, що джерело ненадійне", () => {
    // Чесніше числом, ніж удавати, що факт є факт.
    expect(observed(1, "чутка", { confidence: 0.4 }).confidence).toBe(0.4);
  });
});

describe("inferred", () => {
  it("несе метод і його межу", () => {
    const c = inferred(7, "найближчий сусід", 0.35, {
      params: { radiusKm: 250 },
      caveat: "лінія може йти повз",
    });
    expect(c.confidence).toBe(0.35);
    expect(c.lineage).toMatchObject({ kind: "inferred", method: "найближчий сусід" });
  });

  it("затискає впевненість у межі 0..1", () => {
    expect(inferred(1, "м", 5).confidence).toBe(1);
    expect(inferred(1, "м", -3).confidence).toBe(0);
    expect(inferred(1, "м", Number.NaN).confidence).toBe(0);
  });
});

describe("combine", () => {
  const fact = observed("а", "OSM");
  const guess = inferred("б", "найближчий сусід", 0.35);

  it("бере найслабшу ланку, а не добуток", () => {
    // Ланцюг висновків не буває надійнішим за найслабший крок. Добуток
    // удавав би обчислення, якого ми не робимо.
    expect(combine([fact, guess], "перетин", "в").confidence).toBe(0.35);
  });

  it("не дає висновку бути надійнішим за свої входи", () => {
    const c = combine([guess], "метод", "г", { methodConfidence: 1 });
    expect(c.confidence).toBe(0.35);
  });

  it("дозволяє слабкому методу знизити впевненість", () => {
    expect(combine([fact], "слабкий метод", "д", { methodConfidence: 0.5 }).confidence).toBe(0.5);
  });

  it("зберігає походження всіх входів — ланцюг не обривається", () => {
    const c = combine([fact, guess], "перетин", "в");
    expect(sourcesOf(c.lineage)).toEqual(["OSM"]);
    expect(methodsOf(c.lineage)).toEqual(["перетин", "найближчий сусід"]);
  });

  it("без входів лишається на власній впевненості методу", () => {
    expect(combine([], "нізвідки", 1).confidence).toBe(1);
    expect(combine([], "нізвідки", 1, { methodConfidence: 0.2 }).confidence).toBe(0.2);
  });
});

describe("isFullyObserved", () => {
  it("істина лише коли жодного припущення в ланцюзі немає", () => {
    const a = observed(1, "OSM");
    const b = observed(2, "USGS");
    const guess = inferred(3, "метод", 0.5);
    expect(isFullyObserved(combine([a, b], "сума", 3).lineage)).toBe(true);
    expect(isFullyObserved(combine([a, guess], "сума", 4).lineage)).toBe(false);
  });

  it("бачить припущення на будь-якій глибині", () => {
    // Саме тут ховається неправда: висновок другого рівня виглядає чистим.
    const deep = combine([inferred(1, "здогадка", 0.3)], "крок1", 1);
    const deeper = combine([observed(2, "OSM"), deep], "крок2", 2);
    expect(isFullyObserved(deeper.lineage)).toBe(false);
  });
});

describe("explain", () => {
  it("пояснює спостережене з посиланням", () => {
    expect(explain(observed(1, "OSM", { ref: "way/9" }).lineage)).toBe("зафіксовано в OSM (way/9)");
  });

  it("пояснює виведене з методом і параметрами", () => {
    expect(explain(inferred(1, "найближчий", 0.3, { params: { radiusKm: 250 } }).lineage)).toBe(
      "виведено методом «найближчий» (radiusKm=250)",
    );
  });

  it("згортає довгий ланцюг — пояснення, яке не дочитують, не пояснює", () => {
    const many = Array.from({ length: 6 }, (_, i) => observed(i, `Дж${i}`));
    const text = explain(combine(many, "зведення", 0).lineage);
    expect(text).toContain("та ще 3");
  });
});

describe("fromAdmiralty", () => {
  it("зберігає порядок шкали", () => {
    expect(fromAdmiralty("B", 2)).toBeGreaterThan(fromAdmiralty("C", 3));
    expect(fromAdmiralty("C", 3)).toBeGreaterThan(fromAdmiralty("D", 5));
  });

  it("бере гіршу з двох осей", () => {
    // Надійне джерело, що передає чутку, не стає достовірним.
    expect(fromAdmiralty("B", 5)).toBe(fromAdmiralty("D", 5));
  });

  it("невідомий код не перетворює на вигадане число", () => {
    expect(fromAdmiralty("Z", 9)).toBe(0.3);
    expect(fromAdmiralty("F", 6)).toBe(0.3);
  });
});
