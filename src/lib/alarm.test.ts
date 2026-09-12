import { describe, expect, it } from "bun:test";

import { newInboundIds } from "./alarm";

describe("newInboundIds", () => {
  it("повертає лише цілі, що стали вхідними щойно", () => {
    expect(newInboundIds(["a"], ["a", "b"])).toEqual(["b"]);
  });

  it("нічого нового — порожній масив", () => {
    expect(newInboundIds(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("зникнення цілі не є приводом тривожити", () => {
    expect(newInboundIds(["a", "b"], ["a"])).toEqual([]);
  });

  it("перша поява з порожнього стану — тривога", () => {
    expect(newInboundIds([], ["x", "y"])).toEqual(["x", "y"]);
  });
});
