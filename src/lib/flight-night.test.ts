import { describe, expect, it } from "bun:test";

import { renderFlightNight } from "./flight-night";
import { droneWeather } from "./drone-weather";
import { accrueRhythm, summarizeRhythm, type RhythmBuckets } from "./threat-rhythm";

describe("renderFlightNight", () => {
  const favorable = droneWeather({ windKmh: 6, precipMm: 0, cloudPct: 85 });
  const adverse = droneWeather({ windKmh: 50, precipMm: 4 });

  it("сприятлива погода — тривожний тон і порада тримати валізу", () => {
    const text = renderFlightNight({ weather: favorable, rhythm: null, hourKyiv: 21 });
    expect(text).toContain("на боці дронів");
    expect(text).toContain("валізу");
    expect(text).toContain(favorable.caveat);
  });

  it("нельотна погода — заспокійливий тон", () => {
    const text = renderFlightNight({ weather: adverse, rhythm: null, hourKyiv: 21 });
    expect(text).toContain("проти дронів");
  });

  it("додає історичний ритм, коли він упевнений", () => {
    let b: RhythmBuckets = {};
    for (const h of [2, 2, 2, 3, 3, 3]) b = accrueRhythm(b, "UA", h, 4);
    const rhythm = summarizeRhythm(b, "UA");
    const text = renderFlightNight({ weather: favorable, rhythm, hourKyiv: 21 });
    expect(text).toContain("Історично гарячіше");
    expect(text).toContain("уночі");
  });

  it("невпевнений ритм не потрапляє в пост", () => {
    const rhythm = summarizeRhythm({}, "UA");
    const text = renderFlightNight({ weather: favorable, rhythm, hourKyiv: 21 });
    expect(text).not.toContain("Історично гарячіше");
  });
});

describe("індекс не вдає прогноз, коли читає поточну погоду", () => {
  const favorable = droneWeather({ windKmh: 6, precipMm: 0, cloudPct: 85 });

  it("вдень не називає себе вечірнім індексом на ніч", () => {
    // О десятій ранку «індекс на ніч» містить два твердження, яких у даних
    // немає: що зараз вечір і що ми знаємо погоду на ніч. Читаємо ми поточну.
    for (const hour of [7, 10, 13, 16]) {
      const text = renderFlightNight({ weather: favorable, rhythm: null, hourKyiv: hour });
      expect(text).not.toContain("Вечірній індекс");
      expect(text).not.toContain("на ніч</b>");
    }
  });

  it("вдень прямо каже, що це умови зараз, і коли питати про ніч", () => {
    const text = renderFlightNight({ weather: favorable, rhythm: null, hourKyiv: 10 });
    expect(text).toContain("умови просто зараз");
    expect(text).toContain("Ближче до вечора");
  });

  it("ввечері й уночі вечірній індекс лишається", () => {
    for (const hour of [17, 20, 23, 2, 5]) {
      const text = renderFlightNight({ weather: favorable, rhythm: null, hourKyiv: hour });
      expect(text).toContain("Вечірній індекс");
    }
  });

  it("ввечері застереження про «зараз» не додається — воно там зайве", () => {
    const text = renderFlightNight({ weather: favorable, rhythm: null, hourKyiv: 21 });
    expect(text).not.toContain("умови просто зараз");
  });

  it("оцінка погоди не називає пори доби — вона про погоду", () => {
    // «Льотна ніч» о полудні — те саме, що «нічна зміна» о четвертій дня.
    expect(favorable.label).not.toContain("ніч");
  });
});
