import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import {
  driftKm,
  fixAgeLabel,
  fixAgeMs,
  fixedAtMs,
  MAX_DRIFT_MIN,
  nowRadiusKm,
  speedBelief,
} from "./position-age";

const NOW = Date.parse("2026-09-16T21:07:58Z");
const ago = (sec: number): string => new Date(NOW - sec * 1000).toISOString();

function threat(p: Partial<Threat> = {}): Threat {
  return {
    id: "t",
    name: "Ціль",
    lat: 50,
    lon: 30,
    source: "neptun.in.ua",
    count: 1,
    since: ago(600),
    expires: "",
    type: "shahed",
    ...p,
  };
}

describe("fixedAtMs — час ПОЗИЦІЇ, а не час запису", () => {
  it("бере останню точку треку, а не updatedAt", () => {
    // Заміряно на живому фіді: updatedAt буває на сім хвилин оптимістичніший
    // за час, коли позицію справді бачили.
    const t = threat({
      lastSeen: ago(120),
      trail: [
        { lat: 51, lon: 31, t: ago(900) },
        { lat: 51.4, lon: 31.2, t: ago(600) },
      ],
    });
    expect(fixAgeMs(t, NOW)).toBe(600_000);
  });

  it("без треку падає на lastSeen", () => {
    expect(fixAgeMs(threat({ lastSeen: ago(120), trail: [] }), NOW)).toBe(120_000);
  });

  it("без нічого — null, а не нуль", () => {
    // Нуль тут означав би «щойно», тобто твердження про свіжість, якого немає.
    const t = threat({ since: "", lastSeen: "" });
    expect(fixedAtMs(t)).toBe(null);
    expect(fixAgeMs(t, NOW)).toBe(null);
  });

  it("час із майбутнього не стає відʼємним віком", () => {
    expect(fixAgeMs(threat({ lastSeen: new Date(NOW + 90_000).toISOString() }), NOW)).toBe(0);
  });

  it("сміття в полі часу не проходить за час", () => {
    expect(fixedAtMs(threat({ since: "не дата", lastSeen: "" }))).toBe(null);
  });
});

describe("driftKm — скільки ціль пройшла, поки дані йшли", () => {
  it("медіанний заміряний застій шахеда — близько десяти кілометрів", () => {
    // 205 с × 185 км/год = 10,5 км. Заявлений розкид у тому ж зрізі — 4 км.
    const d = driftKm("shahed", 205_000);
    expect(d.likelyKm).toBeCloseTo(10.5, 1);
  });

  it("швидкий край класу дає значно більше — і саме він іде в тривогу", () => {
    const d = driftKm("shahed", 205_000);
    expect(d.maxKm).toBeGreaterThan(d.likelyKm * 3); // 600 проти 185 км/год
  });

  it("заміряна швидкість бʼє таблицю класу", () => {
    const d = driftKm("shahed", 3_600_000, 99);
    expect(d.likelyKm).toBeCloseTo(99 * (MAX_DRIFT_MIN / 60), 1);
    expect(d.maxKm).toBeCloseTo(d.likelyKm, 1); // заміряна — без вилки
  });

  it("вік упирається в стелю, а не росте вічно", () => {
    const capped = driftKm("shahed", 3 * 3_600_000);
    expect(capped.capped).toBe(true);
    expect(capped.likelyKm).toBeCloseTo(185 * (MAX_DRIFT_MIN / 60), 1);
  });

  it("невідомий вік не вигадує зсуву", () => {
    expect(driftKm("shahed", null)).toEqual({
      ageSec: null,
      likelyKm: 0,
      maxKm: 0,
      capped: false,
    });
  });

  it("балістика за ту саму хвилину проходить незрівнянно більше", () => {
    const b = driftKm("ballistic", 60_000).likelyKm;
    const s = driftKm("shahed", 60_000).likelyKm;
    expect(b).toBeGreaterThan(s * 10);
  });
});

describe("nowRadiusKm — коло «де вона може бути зараз»", () => {
  it("більше за заявлене джерелом, бо застій додається", () => {
    const t = threat({
      lastSeen: ago(205),
      quality: {
        uncertaintyKm: 4,
        position: "confirmed",
        presumptiveCourse: false,
        speedKmh: null,
        lifecycle: "confirmed",
      },
    });
    const r = nowRadiusKm(t, NOW);
    expect(r.statedKm).toBe(4);
    expect(r.likelyKm).toBeGreaterThan(r.statedKm * 2);
    expect(r.maxKm).toBeGreaterThan(r.likelyKm);
  });

  it("свіжий фікс майже не додає нічого — коло лишається заявленим", () => {
    const t = threat({ lastSeen: ago(5), trail: [] });
    const r = nowRadiusKm(t, NOW);
    expect(r.likelyKm - r.statedKm).toBeLessThan(0.5);
  });

  it("без часу коло лишається рівно заявленим, без домислів", () => {
    const r = nowRadiusKm(threat({ since: "", lastSeen: "" }), NOW);
    expect(r.likelyKm).toBe(r.statedKm);
    expect(r.ageSec).toBe(null);
  });
});

describe("fixAgeLabel", () => {
  it("свіже називає свіжим, а не нулем секунд", () => {
    expect(fixAgeLabel(10)).toBe("щойно");
  });
  it("хвилини", () => {
    expect(fixAgeLabel(205)).toBe("3 хв тому");
  });
  it("години", () => {
    expect(fixAgeLabel(3 * 3600 + 25 * 60)).toBe("3 год 25 хв тому");
  });
  it("невідоме лишається невідомим", () => {
    expect(fixAgeLabel(null)).toBe(null);
  });
});

describe("speedBelief — заміряне бʼє припущене", () => {
  it("власний вимір руху сильніший за все інше", () => {
    const b = speedBelief("shahed", 300, { speedKmh: 140, speedSigma: 20 });
    expect(b.likelyKmh).toBe(140);
    expect(b.fastKmh).toBe(160);
  });

  it("швидкість від джерела сильніша за таблицю класу", () => {
    const b = speedBelief("shahed", 99, null);
    expect(b.likelyKmh).toBe(99);
    expect(b.fastKmh).toBe(99); // назване число — без вилки
  });

  it("без нічого — таблиця класу, і вона навмисно широка", () => {
    const b = speedBelief("shahed", null, null);
    expect(b.likelyKmh).toBe(185);
    expect(b.fastKmh).toBe(600);
  });

  it("вимір звужує коло застою в рази — саме заради цього все й робилось", () => {
    // Без виміру трихвилинний застій дає класовий верх 600 км/год, тобто 30 км
    // у будь-який бік, і КОЖНА ціль читається як «може бути вже поруч».
    const guess = driftKm("shahed", 180_000).maxKm;
    const known = driftKm("shahed", 180_000, null, { speedKmh: 150, speedSigma: 25 }).maxKm;
    expect(guess).toBeGreaterThan(known * 3);
  });

  it("відʼємна сигма не звужує вилку нижче за сам вимір", () => {
    const b = speedBelief("shahed", null, { speedKmh: 150, speedSigma: -40 });
    expect(b.fastKmh).toBe(150);
  });
});
