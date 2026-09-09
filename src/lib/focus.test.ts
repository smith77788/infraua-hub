import { describe, expect, it } from "bun:test";

import { applyFocus, focusLabel, sameFocus, type Focus } from "./focus";
import type { CategoryId, Facility } from "./infra-types";

function f(id: string, category: CategoryId): Facility {
  return { id, name: id, category, lat: 50, lon: 30, source: "" };
}

const facilities = [
  f("plant", "power_plant"),
  f("hosp", "hospital"),
  f("water", "water"),
  f("rail", "rail"),
];
const ctx = {
  riskIds: new Set(["plant", "hosp"]),
  alarmIds: new Set(["rail"]),
};

describe("applyFocus", () => {
  it("без фокуса нічого не змінює", () => {
    expect(applyFocus(facilities, null, ctx)).toEqual(facilities);
  });

  it("звужує до обʼєктів під загрозою", () => {
    expect(applyFocus(facilities, { kind: "risk" }, ctx).map((x) => x.id)).toEqual([
      "plant",
      "hosp",
    ]);
  });

  it("перетинає загрозу з життєзабезпеченням, а не підміняє одне одним", () => {
    // Станція під загрозою — не життєзабезпечення; лікарня — і те, й те.
    expect(applyFocus(facilities, { kind: "life-risk" }, ctx).map((x) => x.id)).toEqual(["hosp"]);
  });

  it("звужує до зони тривоги", () => {
    expect(applyFocus(facilities, { kind: "alarm" }, ctx).map((x) => x.id)).toEqual(["rail"]);
  });

  it("звужує до сектора", () => {
    expect(applyFocus(facilities, { kind: "tier", tier: "life" }, ctx).map((x) => x.id)).toEqual([
      "hosp",
      "water",
    ]);
  });

  it("порожній результат — це порожній результат, а не помилка", () => {
    expect(applyFocus(facilities, { kind: "tier", tier: "comms" }, ctx)).toEqual([]);
  });
});

describe("focusLabel", () => {
  it("називає кожен фокус словами", () => {
    const all: Focus[] = [
      { kind: "risk" },
      { kind: "life-risk" },
      { kind: "alarm" },
      { kind: "tier", tier: "energy" },
    ];
    for (const focus of all) expect(focusLabel(focus).length).toBeGreaterThan(0);
    expect(focusLabel(null)).toBe("");
  });
});

describe("sameFocus", () => {
  it("розпізнає той самий фокус, щоб повторне натискання його знімало", () => {
    expect(sameFocus({ kind: "risk" }, { kind: "risk" })).toBe(true);
    expect(sameFocus({ kind: "risk" }, { kind: "alarm" })).toBe(false);
    expect(sameFocus(null, null)).toBe(true);
    expect(sameFocus(null, { kind: "risk" })).toBe(false);
  });

  it("розрізняє сектори між собою", () => {
    expect(sameFocus({ kind: "tier", tier: "life" }, { kind: "tier", tier: "life" })).toBe(true);
    expect(sameFocus({ kind: "tier", tier: "life" }, { kind: "tier", tier: "energy" })).toBe(false);
  });
});

describe("фокус по області", () => {
  const regionOf = new Map([
    ["plant", "UA-32"],
    ["hosp", "UA-32"],
    ["rail", "UA-12"],
  ]);

  it("звужує до обʼєктів області", () => {
    const out = applyFocus(
      facilities,
      { kind: "region", code: "UA-32", name: "Київщина" },
      {
        ...ctx,
        regionOf,
      },
    );
    expect(out.map((x) => x.id)).toEqual(["plant", "hosp"]);
  });

  it("без привʼязки не показує нікого, а не всіх", () => {
    // Порожній результат чесніший за випадковий набір, зібраний за
    // відсутнім критерієм.
    const out = applyFocus(facilities, { kind: "region", code: "UA-32", name: "Київщина" }, ctx);
    expect(out).toEqual([]);
  });

  it("розрізняє області між собою", () => {
    expect(
      sameFocus(
        { kind: "region", code: "UA-32", name: "Київщина" },
        { kind: "region", code: "UA-12", name: "Дніпропетровщина" },
      ),
    ).toBe(false);
  });
});
