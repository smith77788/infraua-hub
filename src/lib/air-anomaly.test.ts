import { describe, expect, it } from "bun:test";

import { addObservation, bucketStart, detectSurge, BUCKET_MS } from "./air-anomaly";

const T0 = 1_700_000_000_000; // фіксований момент для детермінованих відер

/** Історія рівних відер по `count` через кожні BUCKET_MS, що закінчується у `endMs`. */
function flat(count: number, n: number, endMs: number) {
  let hist: { t: number; count: number }[] = [];
  for (let i = n - 1; i >= 0; i--) hist = addObservation(hist, count, endMs - i * BUCKET_MS);
  return hist;
}

describe("bucketStart", () => {
  it("вирівнює момент до початку відра", () => {
    expect(bucketStart(T0 + 123)).toBe(bucketStart(T0));
    expect(bucketStart(T0 + BUCKET_MS) - bucketStart(T0)).toBe(BUCKET_MS);
  });
});

describe("addObservation", () => {
  it("у межах одного відра лишає пік, а не суму", () => {
    let h = addObservation([], 10, T0);
    h = addObservation(h, 25, T0 + 1000);
    h = addObservation(h, 7, T0 + 2000);
    expect(h).toHaveLength(1);
    expect(h[0]!.count).toBe(25);
  });

  it("відкидає застарілі відра за межею maxAge", () => {
    let h = addObservation([], 5, T0);
    h = addObservation(h, 5, T0 + 10 * 24 * 60 * 60 * 1000); // +10 діб
    expect(h).toHaveLength(1);
  });

  it("тримає відра відсортованими за часом", () => {
    let h = addObservation([], 1, T0 + 3 * BUCKET_MS);
    h = addObservation(h, 1, T0);
    h = addObservation(h, 1, T0 + BUCKET_MS);
    expect(h.map((b) => b.t)).toEqual([...h.map((b) => b.t)].sort((a, b) => a - b));
  });
});

describe("detectSurge", () => {
  it("рівна активність — норма", () => {
    const now = T0 + 20 * BUCKET_MS;
    const h = flat(10, 12, now);
    expect(detectSurge(h, now).level).toBe("normal");
  });

  it("різкий ріст над базовою лінією — сплеск", () => {
    const now = T0 + 20 * BUCKET_MS;
    let h = flat(10, 12, now - BUCKET_MS); // 12 відер по 10
    h = addObservation(h, 40, now); // поточне відро: 40 проти норми 10
    const r = detectSurge(h, now);
    expect(r.level).toBe("surge");
    expect(r.baseline).toBe(10);
    expect(r.ratio).toBeGreaterThanOrEqual(3);
  });

  it("помірний ріст — підвищено, не сплеск", () => {
    const now = T0 + 20 * BUCKET_MS;
    let h = flat(10, 12, now - BUCKET_MS);
    h = addObservation(h, 20, now); // ×2 — між elevated(1.8) і surge(3)
    expect(detectSurge(h, now).level).toBe("elevated");
  });

  it("замало історії — норма навіть за високого поточного", () => {
    const now = T0 + 3 * BUCKET_MS;
    let h = flat(10, 2, now - BUCKET_MS); // лише 2 відра базової лінії
    h = addObservation(h, 50, now);
    expect(detectSurge(h, now).level).toBe("normal");
  });

  it("нижче порогу шуму сплеск не оголошується", () => {
    const now = T0 + 20 * BUCKET_MS;
    let h = flat(1, 12, now - BUCKET_MS); // норма 1
    h = addObservation(h, 4, now); // ×4, але 4 < floor(6)
    expect(detectSurge(h, now).level).toBe("normal");
  });

  it("застаріле поточне відро дає current 0", () => {
    const stale = T0;
    const h = flat(30, 12, stale);
    const now = stale + 60 * BUCKET_MS; // давно без свіжих даних
    expect(detectSurge(h, now).current).toBe(0);
  });
});
