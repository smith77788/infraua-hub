import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { mergeParallelDuplicates } from "./parallel-merge";

const T = "2026-11-01T02:30:00Z";
const at = (min: number) => new Date(Date.parse(T) + min * 60_000).toISOString();

function drone(
  id: string,
  lat: number,
  lon: number,
  heading: number,
  extra: Partial<Threat> = {},
): Threat {
  return {
    id,
    name: id,
    lat,
    lon,
    heading,
    source: "neptun.in.ua",
    type: "shahed",
    count: 1,
    since: at(0),
    lastSeen: at(0),
    expires: "",
    ...extra,
  };
}

describe("mergeParallelDuplicates — той самий дрон двома треками", () => {
  it("поруч, той самий курс, одночасно — одна ціль, свіжіша лишається", () => {
    const out = mergeParallelDuplicates([
      drone("a", 50.0, 30.0, 270, { lastSeen: at(0) }),
      drone("b", 50.03, 30.05, 280, { lastSeen: at(1) }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("b");
    expect(out[0]!.mergedIds).toEqual(["a"]);
  });

  it("тип — найнебезпечніший із пари", () => {
    const out = mergeParallelDuplicates([
      drone("a", 50.0, 30.0, 270, { type: "reactive", typeFromChannels: true }),
      drone("b", 50.02, 30.02, 265, { lastSeen: at(1) }),
    ]);
    expect(out[0]!.type).toBe("reactive");
    expect(out[0]!.typeFromChannels).toBe(true);
  });

  it("джерело каже «2х БпЛА» — не зливаємо", () => {
    expect(
      mergeParallelDuplicates([
        drone("a", 50, 30, 270, { count: 2 }),
        drone("b", 50.02, 30.02, 270),
      ]),
    ).toHaveLength(2);
  });

  it("розходяться курсом, далеко, без курсу, ракета чи старий звіт — окремо", () => {
    expect(
      mergeParallelDuplicates([drone("a", 50, 30, 270), drone("b", 50.02, 30.02, 200)]),
    ).toHaveLength(2);
    expect(
      mergeParallelDuplicates([drone("a", 50, 30, 270), drone("b", 50.2, 30.2, 270)]),
    ).toHaveLength(2);
    const noCourse = { ...drone("b", 50.02, 30.02, 0) };
    delete (noCourse as { heading?: number }).heading;
    expect(mergeParallelDuplicates([drone("a", 50, 30, 270), noCourse])).toHaveLength(2);
    expect(
      mergeParallelDuplicates([
        drone("a", 50, 30, 270),
        drone("b", 50.02, 30.02, 270, { type: "cruise" }),
      ]),
    ).toHaveLength(2);
    expect(
      mergeParallelDuplicates([
        drone("a", 50, 30, 270),
        drone("b", 50.02, 30.02, 270, { lastSeen: at(10) }),
      ]),
    ).toHaveLength(2);
  });

  it("рій не стягується в одну точку: кожна ціль зливається щонайбільше з однією", () => {
    const out = mergeParallelDuplicates([
      drone("a", 50.0, 30.0, 270),
      drone("b", 50.02, 30.0, 270),
      drone("c", 50.04, 30.0, 270),
      drone("d", 50.06, 30.0, 270),
    ]);
    expect(out).toHaveLength(2);
  });
});
