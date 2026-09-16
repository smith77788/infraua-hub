import { describe, expect, it } from "bun:test";

import { clampLead, withinLead, LEAD_MIN, LEAD_MAX } from "./lead-threshold";

describe("clampLead", () => {
  it("тримає в межах і округлює", () => {
    expect(clampLead(0)).toBe(LEAD_MIN);
    expect(clampLead(999)).toBe(LEAD_MAX);
    expect(clampLead(7.4)).toBe(7);
    expect(clampLead(NaN)).toBe(LEAD_MIN);
  });
});

describe("withinLead", () => {
  it("вимкнений поріг — завжди в межах", () => {
    expect(withinLead(25, null).within).toBe(true);
    expect(withinLead(null, undefined).within).toBe(true);
  });

  it("ціль у межах порогу — будимо", () => {
    const d = withinLead(4, 7);
    expect(d.within).toBe(true);
    expect(d.reason).toContain("≤");
  });

  it("ще є запас часу — мовчимо", () => {
    const d = withinLead(20, 7);
    expect(d.within).toBe(false);
    expect(d.reason).toContain("ще є час");
  });

  it("невідомий час підльоту не глушить тривогу", () => {
    const d = withinLead(null, 5);
    expect(d.within).toBe(true);
    expect(d.reason).toContain("невідомий");
  });

  it("край вилки береться найбезпечніший — на межі будимо", () => {
    expect(withinLead(7, 7).within).toBe(true);
  });
});
