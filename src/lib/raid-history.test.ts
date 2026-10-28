import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import {
  DENSE_MS,
  framesFromPayload,
  RaidHistory,
  SAMPLE_EVERY_MS,
  SPARSE_EVERY_MS,
  WINDOW_MS,
} from "./raid-history";
import { mergeFrames, replaySpan } from "./raid-replay";

const T0 = Date.parse("2026-10-28T17:00:00Z");
const th = (id: string, lat: number, extra: Partial<Threat> = {}): Threat => ({
  id,
  name: `Пункт ${id}`,
  lat,
  lon: 30,
  source: "neptun.in.ua",
  count: 1,
  since: "",
  expires: "",
  type: "shahed",
  ...extra,
});

describe("RaidHistory — історія нальоту на сервері", () => {
  it("кадр не частіше за хвилину й лише коли картина змінилась", () => {
    const h = new RaidHistory();
    expect(h.sample([th("a", 50)], T0)).toBe(true);
    expect(h.sample([th("a", 50.5)], T0 + 10_000)).toBe(false); // ще не минула хвилина
    expect(h.sample([th("a", 50)], T0 + SAMPLE_EVERY_MS)).toBe(false); // не змінилась
    expect(h.sample([th("a", 50.2)], T0 + SAMPLE_EVERY_MS)).toBe(true);
  });

  it("з порожнього неба історію не починаємо, а кінець нальоту — пишемо", () => {
    const h = new RaidHistory();
    expect(h.sample([], T0)).toBe(false);
    h.sample([th("a", 50)], T0);
    expect(h.sample([], T0 + SAMPLE_EVERY_MS)).toBe(true);
    expect(framesFromPayload(h.payload(T0 + SAMPLE_EVERY_MS)).map((f) => f.threats.length)).toEqual(
      [1, 0],
    );
  });

  it("компактний формат туди й назад: тип, курс, назва — на місці", () => {
    const h = new RaidHistory();
    h.sample([th("a", 50.1234, { type: "reactive", heading: 247.6 })], T0);
    const [f] = framesFromPayload(JSON.parse(JSON.stringify(h.payload(T0))));
    expect(f!.threats[0]).toMatchObject({
      id: "a",
      name: "Пункт a",
      lat: 50.123,
      type: "reactive",
      heading: 248,
    });
  });

  it("старше доби — забуто; переживає перезапуск", () => {
    const h = new RaidHistory();
    h.sample([th("old", 49)], T0);
    h.sample([th("new", 50)], T0 + WINDOW_MS);
    const at = T0 + WINDOW_MS + 1;
    const back = RaidHistory.fromState(JSON.parse(JSON.stringify(h.toState(at))), at);
    expect(framesFromPayload(back.payload(at)).flatMap((f) => f.threats.map((t) => t.id))).toEqual([
      "new",
    ]);
  });

  it("свіжі 3 год — щохвилини; старше — не частіше за 5 хв; ?hours обмежує вибірку", () => {
    const h = new RaidHistory();
    // Дві години кадрів щохвилини, з рухом — кожен змінює картину.
    for (let i = 0; i <= 120; i++) h.sample([th("a", 50 + i / 100)], T0 + i * SAMPLE_EVERY_MS);
    // Через 4 год ті кадри вже старші за 3 год — проріджуються.
    const later = T0 + 120 * SAMPLE_EVERY_MS + DENSE_MS + 60_000;
    h.sample([th("b", 48)], later);
    const all = framesFromPayload(h.payload(later));
    const old = all.filter((f) => later - f.t > DENSE_MS);
    for (let i = 1; i < old.length; i++) {
      expect(old[i]!.t - old[i - 1]!.t).toBeGreaterThanOrEqual(SPARSE_EVERY_MS);
    }
    expect(old.length).toBeLessThan(30);
    // ?hours=3 — лише кадри за останні 3 год.
    expect(
      framesFromPayload(h.payload(later, 3 * 3_600_000)).every((f) => later - f.t <= 3 * 3_600_000),
    ).toBe(true);
  });

  it("зіпсований вхід — порожньо, а не виняток", () => {
    expect(framesFromPayload(null)).toEqual([]);
    expect(framesFromPayload({ ids: "x", frames: 1 })).toEqual([]);
  });
});

describe("mergeFrames — повтор має історію з першої секунди", () => {
  it("серверні кадри — до першого свого; далі — свої", () => {
    const server = [0, 1, 2, 3].map((i) => ({ t: T0 + i * 60_000, threats: [th("s", 50)] }));
    const local = [{ t: T0 + 2.5 * 60_000, threats: [th("l", 50)] }];
    const merged = mergeFrames(server, local);
    expect(merged.map((f) => f.t)).toEqual([T0, T0 + 60_000, T0 + 120_000, T0 + 150_000]);
    // Щойно відкрив сторінку (один свій кадр) — повтор уже є.
    expect(replaySpan(local)).toBeNull();
    expect(replaySpan(merged)).not.toBeNull();
  });
});
