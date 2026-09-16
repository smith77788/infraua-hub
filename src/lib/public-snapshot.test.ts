import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { publicAirSnapshot } from "./public-snapshot";

function threat(p: Partial<Threat>): Threat {
  return {
    id: "secret-id",
    name: "внутрішня назва",
    lat: 50.4501234,
    lon: 30.5234567,
    source: "neptun.in.ua",
    count: 17,
    since: "",
    expires: "",
    ...p,
  };
}

describe("publicAirSnapshot", () => {
  it("віддає лише публічні поля — без id, джерел і лічильників згадок", () => {
    const snap = publicAirSnapshot([threat({ type: "shahed", heading: 90 })], 1000);
    const t = snap.threats[0]!;
    expect(Object.keys(t).sort()).toEqual(["heading", "lat", "lon", "type"]);
    expect(JSON.stringify(snap)).not.toContain("secret-id");
    expect(JSON.stringify(snap)).not.toContain("neptun");
  });

  it("координати огрублені до ~100 м (3 знаки)", () => {
    const snap = publicAirSnapshot([threat({ type: "shahed" })]);
    expect(snap.threats[0]!.lat).toBe(50.45);
    expect(snap.threats[0]!.lon).toBe(30.523);
  });

  it("курс лише коли відомий; невідомий — поля немає, а не вигадане 0", () => {
    const withC = publicAirSnapshot([threat({ type: "shahed", heading: 45 })]);
    const noC = publicAirSnapshot([threat({ type: "shahed" })]);
    expect(withC.threats[0]!.heading).toBe(45);
    expect("heading" in noC.threats[0]!).toBe(false);
  });

  it("count дорівнює числу цілей, а не сумі згадок", () => {
    const snap = publicAirSnapshot([
      threat({ type: "shahed", count: 17 }),
      threat({ type: "missile", count: 3 }),
    ]);
    expect(snap.count).toBe(2);
    expect(snap.threats).toHaveLength(2);
  });

  it("тип за замовчуванням — unknown, не порожньо", () => {
    const snap = publicAirSnapshot([threat({})]);
    expect(snap.threats[0]!.type).toBe("unknown");
  });

  it("битих координат у видачі немає", () => {
    const snap = publicAirSnapshot([
      threat({ type: "shahed" }),
      threat({ type: "shahed", lat: NaN }),
    ]);
    expect(snap.count).toBe(1);
  });

  it("застереження їде разом із даними", () => {
    const snap = publicAirSnapshot([]);
    expect(snap.disclaimer).toContain("Повітряні Сили");
    expect(snap.source).toBe("OSINT");
  });
});

describe("observedAt у публічному знімку", () => {
  it("несе час спостереження окремо від часу формування", () => {
    /*
     * Той, хто вбудовує наші дані, за `at` бачить лише, що наш сервер
     * відповів. На збої джерела сервер віддає останню відому картину — і без
     * `observedAt` чужий віджет показував би застиглу картину як поточну.
     */
    const snap = publicAirSnapshot(
      [
        {
          id: "1",
          name: "x",
          lat: 50,
          lon: 30,
          source: "s",
          count: 1,
          since: "",
          expires: "",
          lastSeen: "2026-09-16T18:56:00Z",
        } as never,
      ],
      Date.UTC(2026, 8, 16, 19, 30, 0),
    );
    expect(snap.at).toBe(Date.UTC(2026, 8, 16, 19, 30, 0));
    expect(snap.observedAt).toBe(Date.parse("2026-09-16T18:56:00Z"));
  });

  it("порожнє небо — час спостереження невідомий, а не «зараз»", () => {
    expect(publicAirSnapshot([], 1).observedAt).toBeNull();
  });
});
