import { describe, expect, it } from "bun:test";

import { renderFlightNight } from "./flight-night";
import { droneWeather } from "./drone-weather";
import { accrueRhythm, summarizeRhythm, type RhythmBuckets } from "./threat-rhythm";

describe("renderFlightNight", () => {
  const favorable = droneWeather({ windKmh: 6, precipMm: 0, cloudPct: 85 });
  const adverse = droneWeather({ windKmh: 50, precipMm: 4 });

  it("сприятлива погода — тривожний тон і порада тримати валізу", () => {
    const text = renderFlightNight({ weather: favorable, rhythm: null });
    expect(text).toContain("на боці дронів");
    expect(text).toContain("валізу");
    expect(text).toContain(favorable.caveat);
  });

  it("нельотна погода — заспокійливий тон", () => {
    const text = renderFlightNight({ weather: adverse, rhythm: null });
    expect(text).toContain("проти дронів");
  });

  it("додає історичний ритм, коли він упевнений", () => {
    let b: RhythmBuckets = {};
    for (const h of [2, 2, 2, 3, 3, 3]) b = accrueRhythm(b, "UA", h, 4);
    const rhythm = summarizeRhythm(b, "UA");
    const text = renderFlightNight({ weather: favorable, rhythm });
    expect(text).toContain("Історично гарячіше");
    expect(text).toContain("уночі");
  });

  it("невпевнений ритм не потрапляє в пост", () => {
    const rhythm = summarizeRhythm({}, "UA");
    const text = renderFlightNight({ weather: favorable, rhythm });
    expect(text).not.toContain("Історично гарячіше");
  });
});
