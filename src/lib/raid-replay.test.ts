import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { fingerprint, frameAt, recordFrame, replaySpan, tracksUpTo } from "./raid-replay";

function threat(p: Partial<Threat>): Threat {
  return {
    id: "t",
    name: "",
    lat: 50,
    lon: 30,
    source: "n",
    count: 1,
    since: "",
    expires: "",
    ...p,
  };
}

describe("fingerprint", () => {
  it("тремтіння в межах ~1 км не змінює відбиток", () => {
    const a = fingerprint([threat({ id: "x", lat: 50.001, lon: 30.002 })]);
    const b = fingerprint([threat({ id: "x", lat: 50.004, lon: 30.001 })]);
    expect(a).toBe(b);
  });
  it("порядок цілей не впливає — набір, а не послідовність", () => {
    const a = fingerprint([threat({ id: "a" }), threat({ id: "b", lat: 49 })]);
    const b = fingerprint([threat({ id: "b", lat: 49 }), threat({ id: "a" })]);
    expect(a).toBe(b);
  });
});

describe("recordFrame", () => {
  it("порожнє небо на старті нічого не пише", () => {
    expect(recordFrame([], [], 1000)).toHaveLength(0);
  });

  it("перша ціль — перший кадр", () => {
    const buf = recordFrame([], [threat({ id: "a" })], 1000);
    expect(buf).toHaveLength(1);
    expect(buf[0]!.t).toBe(1000);
  });

  it("незмінна картина не дублює кадр", () => {
    const buf1 = recordFrame([], [threat({ id: "a" })], 1000);
    const buf2 = recordFrame(buf1, [threat({ id: "a" })], 2000);
    expect(buf2).toBe(buf1); // той самий буфер — нічого не додано
  });

  it("рух цілі > огрублення дає новий кадр", () => {
    const buf1 = recordFrame([], [threat({ id: "a", lat: 50 })], 1000);
    const buf2 = recordFrame(buf1, [threat({ id: "a", lat: 50.5 })], 2000);
    expect(buf2).toHaveLength(2);
  });

  it("зростання групи на місці — це теж кадр (реплей показує розвиток)", () => {
    const buf1 = recordFrame([], [threat({ id: "a", lat: 50, count: 3 })], 1000);
    const buf2 = recordFrame(buf1, [threat({ id: "a", lat: 50, count: 10 })], 2000);
    expect(buf2).toHaveLength(2);
  });

  it("небо стихло — це теж кадр (реплей показує завершення)", () => {
    const buf1 = recordFrame([], [threat({ id: "a" })], 1000);
    const buf2 = recordFrame(buf1, [], 2000);
    expect(buf2).toHaveLength(2);
    expect(buf2[1]!.threats).toHaveLength(0);
  });

  it("застарілі кадри відпадають за вікном", () => {
    let buf = recordFrame([], [threat({ id: "a", lat: 50 })], 0);
    buf = recordFrame(buf, [threat({ id: "a", lat: 51 })], 1000);
    buf = recordFrame(buf, [threat({ id: "a", lat: 52 })], 10_000, { windowMs: 5000 });
    // кадр t=0 старший за 5 с відносно найновішого (10000) — має відпасти
    expect(buf.map((f) => f.t)).toEqual([10_000]);
  });

  it("стеля кадрів тримає лише найновіші", () => {
    let buf: readonly { t: number; threats: readonly Threat[] }[] = [];
    for (let i = 0; i < 10; i++) {
      buf = recordFrame(buf, [threat({ id: "a", lat: 50 + i })], i * 1000, { maxFrames: 3 });
    }
    expect(buf).toHaveLength(3);
    expect(buf[buf.length - 1]!.t).toBe(9000);
  });
});

describe("replaySpan / frameAt", () => {
  const buf = [
    { t: 1000, threats: [threat({ id: "a", lat: 50 })] },
    { t: 2000, threats: [threat({ id: "a", lat: 51 })] },
    { t: 3000, threats: [threat({ id: "a", lat: 52 })] },
  ];

  it("менше двох кадрів — перемотувати нема що", () => {
    expect(replaySpan(buf.slice(0, 1))).toBeNull();
    expect(replaySpan([])).toBeNull();
  });

  it("проміжок — від першого до останнього кадру", () => {
    expect(replaySpan(buf)).toEqual({ from: 1000, to: 3000 });
  });

  it("кадр на момент курсора — останній із t <= cursor", () => {
    expect(frameAt(buf, 2500)!.t).toBe(2000);
    expect(frameAt(buf, 3000)!.t).toBe(3000);
  });

  it("до першого кадру показуємо найраніший, не порожнечу", () => {
    expect(frameAt(buf, 500)!.t).toBe(1000);
  });
});

describe("tracksUpTo", () => {
  const buf = [
    { t: 1000, threats: [threat({ id: "a", lat: 51.5, lon: 31.3, type: "shahed" })] },
    { t: 2000, threats: [threat({ id: "a", lat: 50.9, lon: 31.0, type: "shahed" })] },
    { t: 3000, threats: [threat({ id: "a", lat: 50.4, lon: 30.6, type: "shahed" })] },
  ];

  it("трек росте лише до курсора", () => {
    const tr = tracksUpTo(buf, 2000);
    expect(tr).toHaveLength(1);
    expect(tr[0]!.points).toHaveLength(2);
  });

  it("одна поява — ще не трек", () => {
    expect(tracksUpTo(buf, 1000)).toHaveLength(0);
  });

  it("ціль, що стояла на місці, не плодить точок", () => {
    const still = [
      { t: 1000, threats: [threat({ id: "a", lat: 50, lon: 30 })] },
      { t: 2000, threats: [threat({ id: "a", lat: 50, lon: 30 })] },
    ];
    // одна унікальна точка → не трек
    expect(tracksUpTo(still, 2000)).toHaveLength(0);
  });
});
