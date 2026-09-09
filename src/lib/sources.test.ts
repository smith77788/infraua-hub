import { describe, expect, it } from "bun:test";

import { ageOf } from "./freshness";
import { statusOf, worstState, type SourceInput } from "./sources";

const NOW = new Date("2026-09-09T12:00:00.000Z").getTime();
const fresh = ageOf(new Date(NOW - 60_000).toISOString(), 60, 1440, NOW);
const old = ageOf(new Date(NOW - 3000 * 60_000).toISOString(), 60, 1440, NOW);

function input(over: Partial<SourceInput> = {}): SourceInput {
  return { id: "s", label: "Джерело", count: 10, age: fresh, ...over };
}

describe("statusOf", () => {
  it("живе джерело показує свій вік", () => {
    expect(statusOf(input())).toMatchObject({ state: "live", detail: "1 хв тому" });
  });

  it("мовчання важливіше за неповне покриття", () => {
    // Покриття зростатиме саме, мовчазне джерело — ні; порядок серйозності
    // саме тому такий.
    const s = statusOf(input({ down: true, coverage: { loaded: 3, total: 50 } }));
    expect(s.state).toBe("down");
  });

  it("резервний перелік — не живі дані", () => {
    expect(statusOf(input({ degraded: true })).state).toBe("degraded");
  });

  it("застарілі дані видно окремо від відсутніх", () => {
    expect(statusOf(input({ age: old })).state).toBe("stale");
    expect(statusOf(input({ count: 0 })).state).toBe("empty");
  });

  it("неповне покриття показує прогрес", () => {
    expect(statusOf(input({ coverage: { loaded: 7, total: 50 } }))).toMatchObject({
      state: "loading",
      detail: "7 з 50 ділянок",
    });
  });

  it("повне покриття вже не вважається завантаженням", () => {
    expect(statusOf(input({ coverage: { loaded: 50, total: 50 } })).state).toBe("live");
  });

  it("обрізаний стелею набір позначається неповним", () => {
    expect(statusOf(input({ truncated: true })).state).toBe("degraded");
  });

  it("невідомий вік не видається за свіжість", () => {
    const unknown = ageOf(null, 60, 1440, NOW);
    // Нічого не відомо — але записи є, тож джерело живе, а деталь чесна.
    expect(statusOf(input({ age: unknown }))).toMatchObject({
      state: "live",
      detail: "час невідомий",
    });
  });
});

describe("worstState", () => {
  it("повертає найсерйозніший стан", () => {
    expect(
      worstState([
        statusOf(input()),
        statusOf(input({ coverage: { loaded: 1, total: 5 } })),
        statusOf(input({ down: true })),
      ]),
    ).toBe("down");
  });

  it("усе живе — значить живе", () => {
    expect(worstState([statusOf(input()), statusOf(input())])).toBe("live");
  });

  it("порожній список не ламається", () => {
    expect(worstState([])).toBe("live");
  });
});
