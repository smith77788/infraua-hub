import { describe, expect, it } from "bun:test";

import type { Threat, ThreatType } from "./air";
import type { AirSnapshot } from "./channel-post";
import { oblastOf } from "./channel-post";
import {
  accrueDay,
  beginWave,
  emptyDay,
  forecastWave,
  markOfficialAlert,
  movePoint,
  newCriticalTypes,
  renderAllClear,
  renderDigest,
  renderForecast,
  renderQuietHold,
  updateWave,
  waveEnded,
} from "./channel-wave";

function threat(p: Partial<Threat>): Threat {
  return {
    id: Math.random().toString(36).slice(2),
    name: "Ціль",
    lat: 50,
    lon: 30,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    ...p,
  };
}

function snap(oblasts: Record<string, Partial<Record<ThreatType, number>>>): AirSnapshot {
  let targets = 0;
  for (const m of Object.values(oblasts)) for (const n of Object.values(m)) targets += n ?? 0;
  return { oblasts, targets };
}

describe("movePoint", () => {
  it("111 км на північ — приблизно градус широти", () => {
    const p = movePoint(50, 30, 0, 111);
    expect(p.lat).toBeCloseTo(51, 1);
    expect(p.lon).toBeCloseTo(30, 2);
  });
  it("на схід довгота росте, широта майже не змінюється", () => {
    const p = movePoint(50, 30, 90, 100);
    expect(p.lon).toBeGreaterThan(30);
    expect(Math.abs(p.lat - 50)).toBeLessThan(0.6);
  });
});

describe("forecastWave", () => {
  it("шахед із Сумщини курсом на південь потрапляє в прогноз по сусідній області", () => {
    // Суми (50.91, 34.80), курс 180 (на південь) — за пів години шахед
    // проходить ~90 км і виходить за межі області.
    const out = forecastWave([threat({ lat: 50.91, lon: 34.8, type: "shahed", heading: 180 })]);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.oblast).not.toBe(oblastOf(50.91, 34.8));
    expect(out[0]!.minutes).toBeGreaterThan(0);
    expect(out[0]!.minutes).toBeLessThanOrEqual(30);
  });

  it("ціль без курсу не прогнозується — вигадувати напрямок нема з чого", () => {
    expect(forecastWave([threat({ lat: 50.91, lon: 34.8, type: "shahed" })])).toEqual([]);
  });

  it("область, де цілі вже є, у прогноз не потрапляє", () => {
    const from = threat({ lat: 50.91, lon: 34.8, type: "shahed", heading: 180 });
    const ahead = forecastWave([from])[0]!;
    // Ставимо ціль просто в ту область — і прогноз про неї замовкає.
    const inThere = threat({ lat: 49.59, lon: 34.55, type: "shahed" });
    const withOccupied = forecastWave([from, inThere]);
    expect(
      withOccupied.some((e) => e.oblast === ahead.oblast && ahead.oblast === "Полтавщина"),
    ).toBe(false);
  });

  it("рядок прогнозу згортає зайве в «і ще N»", () => {
    const line = renderForecast(
      [
        { oblast: "А", minutes: 5, count: 1, types: ["shahed"] },
        { oblast: "Б", minutes: 9, count: 1, types: ["shahed"] },
        { oblast: "В", minutes: 12, count: 1, types: ["shahed"] },
        { oblast: "Г", minutes: 20, count: 1, types: ["shahed"] },
      ],
      3,
    );
    expect(line).toContain("А (~5 хв)");
    expect(line).toContain("і ще 1");
  });

  it("порожній прогноз — це null, а не порожній рядок у пості", () => {
    expect(renderForecast([])).toBeNull();
  });
});

describe("хвиля", () => {
  it("піки — це максимуми одночасних, а не суми за час", () => {
    let w = beginWave(0);
    w = updateWave(w, snap({ Сумщина: { shahed: 5 } }), 1000);
    w = updateWave(w, snap({ Сумщина: { shahed: 3 } }), 2000);
    expect(w.oblasts["Сумщина"]).toBe(5);
    expect(w.peakTargets).toBe(5);
  });

  it("відбій настає лише після справжньої тиші, а не після однієї порожньої вибірки", () => {
    const w = updateWave(beginWave(0), snap({ Сумщина: { shahed: 2 } }), 0);
    expect(waveEnded(w, 5 * 60 * 1000)).toBe(false);
    expect(waveEnded(w, 25 * 60 * 1000)).toBe(true);
  });

  it("зведення відбою називає тривалість, пік і області", () => {
    let w = beginWave(0);
    w = updateWave(w, snap({ Сумщина: { shahed: 7 }, Харківщина: { kab: 2 } }), 0);
    const text = renderAllClear(w, 3 * 60 * 60 * 1000 + 20 * 60 * 1000);
    expect(text).toContain("Відбій — офіційно");
    expect(text).toContain("3 год 20 хв");
    expect(text).toContain("Сумщина");
  });
});

describe("newCriticalTypes", () => {
  it("поява балістики там, де були шахеди, — привід для НОВОГО поста", () => {
    const prev = snap({ Сумщина: { shahed: 3 } });
    const cur = snap({ Сумщина: { shahed: 3, ballistic: 1 } });
    expect(newCriticalTypes(prev, cur)).toEqual(["ballistic"]);
  });
  it("ті самі типи — приводу немає", () => {
    const s = snap({ Сумщина: { shahed: 3 } });
    expect(newCriticalTypes(s, s)).toEqual([]);
  });
});

describe("підсумок доби", () => {
  it("тиха доба не дає поста", () => {
    expect(renderDigest(emptyDay("2026-01-01"))).toBeNull();
  });

  it("гучний час накопичується лише тоді, коли в небі щось було", () => {
    let day = emptyDay("2026-01-01");
    day = accrueDay(day, snap({ Сумщина: { shahed: 4 } }), 5);
    day = accrueDay(day, snap({}), 5);
    expect(day.loudMinutes).toBe(5);
    expect(day.peakTargets).toBe(4);
  });

  it("підсумок називає пік саме як одночасний, а не як суму", () => {
    let day = emptyDay("2026-01-01");
    day = accrueDay(day, snap({ Сумщина: { shahed: 4 } }), 5);
    const text = renderDigest(day)!;
    expect(text).toContain("2026-01-01");
    expect(text).toContain("ОДНОЧАСНО");
  });
});

describe("відбій прив'язаний до офіційної тривоги", () => {
  it("прапорець вмикається, коли тривога є в області хвилі", () => {
    const w = updateWave(beginWave(0), snap({ Сумщина: { shahed: 3 } }), 0);
    expect(w.officialAlertSeen).toBe(false);
    expect(markOfficialAlert(w, ["Львівщина"]).officialAlertSeen).toBe(false);
    expect(markOfficialAlert(w, ["Сумщина"]).officialAlertSeen).toBe(true);
  });

  it("прапорець не гасне: оголошену тривогу треба закрити відбоєм", () => {
    // Інакше тривога, знята між двома тиками, лишила б хвилю без відбою.
    let w = updateWave(beginWave(0), snap({ Сумщина: { shahed: 3 } }), 0);
    w = markOfficialAlert(w, ["Сумщина"]);
    expect(markOfficialAlert(w, []).officialAlertSeen).toBe(true);
  });

  it("нова хвиля починається без прапорця", () => {
    expect(beginWave(0).officialAlertSeen).toBe(false);
    expect(beginWave(0).quietNoticeAt).toBeNull();
  });
});

describe("renderQuietHold", () => {
  it("прямо каже, що це НЕ відбій, і називає області, де тривога триває", () => {
    // Найнебезпечніший текст каналу: у читача на екрані пост із цілями, яких
    // уже немає, і спокуса прочитати тишу як дозвіл вийти.
    let w = beginWave(0);
    w = updateWave(w, snap({ Сумщина: { shahed: 6 } }), 0);
    const text = renderQuietHold(w, ["Сумщина", "Харківщина"], 30 * 60 * 1000);
    expect(text).toContain("Це не відбій");
    expect(text).toContain("не виходьте з укриття");
    expect(text).toContain("Сумщина, Харківщина");
    expect(text).toContain("30 хв");
  });
});

describe("renderAllClear після офіційного оголошення", () => {
  it("каже, що відбій саме офіційний, і не обіцяє, що більше не прилетить", () => {
    let w = beginWave(0);
    w = updateWave(w, snap({ Сумщина: { shahed: 4 } }), 0);
    const text = renderAllClear(w, 60 * 60 * 1000);
    expect(text).toContain("офіційно");
    expect(text).toContain("може повернутись");
  });
});
