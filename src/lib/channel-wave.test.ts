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
  renderRoute,
  updateWave,
  waveEnded,
  waveStateUsable,
  type WaveState,
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

  it("веде ціль найшвидшим можливим для типу, а не типовим", () => {
    /*
     * «Шахед» покриває і 185 км/год, і 600. Типова швидкість сказала б
     * області, що в неї пів години, там, де лишається десять хвилин — а
     * прогноз існує саме для того, щоб область устигла приготуватись.
     */
    const fast = forecastWave([threat({ lat: 50.91, lon: 34.8, type: "shahed", heading: 180 })]);
    const measured = forecastWave([
      threat({
        lat: 50.91,
        lon: 34.8,
        type: "shahed",
        heading: 180,
        quality: {
          uncertaintyKm: 4,
          position: "confirmed",
          lifecycle: "tracking",
          presumptiveCourse: false,
          speedKmh: 185,
        },
      }),
    ]);
    // Заміряні 185 км/год — це повільно; без заміру беремо верх діапазону,
    // тож ціль «доходить» помітно раніше.
    expect(fast[0]!.minutes).toBeLessThan(measured[0]!.minutes);
  });

  it("рахує, скільки цілей ідуть припущеним курсом", () => {
    const out = forecastWave([
      threat({
        lat: 50.91,
        lon: 34.8,
        type: "shahed",
        heading: 180,
        quality: {
          uncertaintyKm: 25,
          position: "approx",
          lifecycle: "uncertain",
          presumptiveCourse: true,
          speedKmh: null,
        },
      }),
    ]);
    expect(out[0]!.presumed).toBe(1);
    expect(out[0]!.count).toBe(1);
    // Рядок тоді так і каже — на відміну від адресного сигналу місту, тут
    // припущений курс не відкидається, а називається.
    expect(renderForecast(out)).toContain("курс припущений");
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
        { oblast: "А", minutes: 5, count: 1, types: ["shahed"], presumed: 0 },
        { oblast: "Б", minutes: 9, count: 1, types: ["shahed"], presumed: 0 },
        { oblast: "В", minutes: 12, count: 1, types: ["shahed"], presumed: 0 },
        { oblast: "Г", minutes: 20, count: 1, types: ["shahed"], presumed: 0 },
      ],
      3,
    );
    // Число — найраніше з можливого, і формулювання каже саме це: «може бути
    // вже за», а не «через», щоб рядок не читався як розклад.
    expect(line).toContain("А (може бути вже за 5 хв)");
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
  const NOW = 1_700_000_000_000;
  /** Хвиля, яка вже бачила задані типи. */
  const waveThatSaw = (snapshot: AirSnapshot): WaveState =>
    updateWave(beginWave(NOW), snapshot, NOW);

  it("поява балістики там, де були шахеди, — привід для НОВОГО поста", () => {
    const wave = waveThatSaw(snap({ Сумщина: { shahed: 3 } }));
    const cur = snap({ Сумщина: { shahed: 3, ballistic: 1 } });
    expect(newCriticalTypes(wave, cur)).toEqual(["ballistic"]);
  });

  it("ті самі типи — приводу немає", () => {
    const s = snap({ Сумщина: { shahed: 3 } });
    expect(newCriticalTypes(waveThatSaw(s), s)).toEqual([]);
  });

  it("перший пост нальоту — ескалація: там усе справді вперше", () => {
    expect(newCriticalTypes(undefined, snap({ Сумщина: { kab: 2 } }))).toEqual(["kab"]);
  });

  it("тип, що блимнув і повернувся, НЕ нова загроза", () => {
    /*
     * Головне виправлення. Порівняння йшло з попереднім тиком, а набір типів у
     * OSINT блимає: ціль зникає з видачі на одну вибірку й повертається.
     * Заміряно на сорока хвилинах живого фіду: `kab` «зʼявлявся вперше» тричі,
     * `missile` ще раз — разом чотири НОВІ пости за один безперервний наліт.
     *
     * «Зʼявився новий тип загрози» — подія рівня ХВИЛІ, а не тику.
     */
    let wave = beginWave(NOW);
    wave = updateWave(wave, snap({ Сумщина: { shahed: 3, kab: 1 } }), NOW);
    // Джерело загубило КАБ на один тик.
    const blinkedOut = snap({ Сумщина: { shahed: 3 } });
    wave = updateWave(wave, blinkedOut, NOW + 60_000);
    // І повернуло.
    const backAgain = snap({ Сумщина: { shahed: 3, kab: 1 } });
    expect(newCriticalTypes(wave, backAgain)).toEqual([]);
  });

  it("новий тип після блимання іншого все одно помічається", () => {
    // Захист від надмірного глушіння: справжня нова загроза має пройти.
    let wave = beginWave(NOW);
    wave = updateWave(wave, snap({ Сумщина: { shahed: 3, kab: 1 } }), NOW);
    wave = updateWave(wave, snap({ Сумщина: { shahed: 3 } }), NOW + 60_000);
    expect(newCriticalTypes(wave, snap({ Сумщина: { shahed: 3, ballistic: 1 } }))).toEqual([
      "ballistic",
    ]);
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

describe("маршрут хвилі", () => {
  it("області записуються в порядку першої появи", () => {
    let w = beginWave(0);
    w = updateWave(w, snap({ Чернігівщина: { shahed: 4 } }), 0);
    w = updateWave(w, snap({ Чернігівщина: { shahed: 4 }, Київщина: { shahed: 2 } }), 35 * 60e3);
    expect(w.route.map((r) => r.oblast)).toEqual(["Чернігівщина", "Київщина"]);
  });

  it("область, що з'явилась одного разу, не додається вдруге", () => {
    let w = beginWave(0);
    const s = snap({ Сумщина: { shahed: 3 } });
    w = updateWave(w, s, 0);
    w = updateWave(w, s, 60e3);
    expect(w.route).toHaveLength(1);
  });

  it("час подається від початку хвилі, а не годинником", () => {
    // «+35 хв» читається і через тиждень; «22:15» вимагає пам'ятати, коли все
    // почалось.
    let w = beginWave(0);
    w = updateWave(w, snap({ Чернігівщина: { shahed: 4 } }), 0);
    w = updateWave(w, snap({ Чернігівщина: { shahed: 4 }, Київщина: { shahed: 2 } }), 35 * 60e3);
    const route = renderRoute(w)!;
    expect(route).toContain("Чернігівщина");
    expect(route).toContain("+35 хв");
    expect(route).toContain("→");
  });

  it("одна область — маршруту немає: стрілка в нікуди гірша за її відсутність", () => {
    let w = beginWave(0);
    w = updateWave(w, snap({ Сумщина: { shahed: 3 } }), 0);
    expect(renderRoute(w)).toBeNull();
  });

  it("маршрут потрапляє у зведення відбою", () => {
    let w = beginWave(0);
    w = updateWave(w, snap({ Чернігівщина: { shahed: 4 } }), 0);
    w = updateWave(w, snap({ Київщина: { shahed: 2 } }), 30 * 60e3);
    expect(renderAllClear(w, 60 * 60e3)).toContain("🛣 Шлях:");
  });
});

describe("waveStateUsable — стан із минулої збірки", () => {
  const good = {
    startedAt: 1,
    lastActiveAt: 2,
    peakTargets: 3,
    oblasts: { Сумщина: 2 },
    types: {},
    messageId: null,
    edits: 0,
    officialAlertSeen: false,
  };

  it("повний стан придатний", () => {
    expect(waveStateUsable(good)).toBe(true);
  });

  it("бракує часу початку — непридатний", () => {
    /*
     * Саме цей випадок і виходив у канал рядком «Хвиля тривала NaN год NaN хв»:
     * старіша збірка записала стан без поля, новіша прочитала його без помилки.
     */
    const { startedAt: _drop, ...rest } = good;
    expect(waveStateUsable(rest)).toBe(false);
  });

  it("час є, але не число — непридатний", () => {
    expect(waveStateUsable({ ...good, lastActiveAt: "щойно" })).toBe(false);
    expect(waveStateUsable({ ...good, startedAt: null })).toBe(false);
  });

  it("порожнеча й не-обʼєкт — непридатні", () => {
    expect(waveStateUsable(null)).toBe(false);
    expect(waveStateUsable(undefined)).toBe(false);
    expect(waveStateUsable("wave")).toBe(false);
  });

  it("брак НОВОГО прапорця не робить стан непридатним", () => {
    // Інакше кожне нове поле скидало б живу хвилю при редеплої.
    const { officialAlertSeen: _drop, ...rest } = good;
    expect(waveStateUsable(rest)).toBe(true);
  });
});
