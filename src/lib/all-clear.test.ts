import { describe, expect, it } from "bun:test";

import { decideAllClear, renderPersonalAllClear } from "./all-clear";

const NOW = 1_700_000_000_000;
const HOUR_AGO = NOW - 60 * 60 * 1000;

/*
 * Поспішити з ПОПЕРЕДЖЕННЯМ безпечно: найгірше — людина дарма зайде в коридор.
 * Поспішити з ВІДБОЄМ смертельно: вона вийде, коли ще летить. Ці тести тримають
 * саме цю асиметрію.
 */
describe("decideAllClear — відбій не виводиться з нашої картини неба", () => {
  it("поки офіційна тривога триває — мовчимо", () => {
    const d = decideAllClear({
      officialActive: true,
      alarmSince: HOUR_AGO,
      wasAlerted: true,
      now: NOW,
    });
    expect(d.send).toBe(false);
    expect(d.reason).toContain("триває");
  });

  it("офіційний відбій — кажемо, і з тривалістю", () => {
    const d = decideAllClear({
      officialActive: false,
      alarmSince: HOUR_AGO,
      wasAlerted: true,
      now: NOW,
    });
    expect(d.send).toBe(true);
    expect(d.durationMin).toBe(60);
  });

  it("кого не турбували — тому не кажемо", () => {
    // Дізнатися про тривогу з відбою — гірше за мовчання.
    const d = decideAllClear({
      officialActive: false,
      alarmSince: HOUR_AGO,
      wasAlerted: false,
      now: NOW,
    });
    expect(d.send).toBe(false);
  });

  it("тривоги не було — відбою теж немає", () => {
    const d = decideAllClear({
      officialActive: false,
      alarmSince: null,
      wasAlerted: true,
      now: NOW,
    });
    expect(d.send).toBe(false);
    expect(d.durationMin).toBe(0);
  });
});

describe("renderAllClear", () => {
  it("перший рядок — рішення, а не передмова", () => {
    // Людина в коридорі читає одне слово й приймає рішення.
    expect(renderPersonalAllClear(45).split("\n")[0]).toContain("Відбій");
  });

  it("називає тривалість словами", () => {
    expect(renderPersonalAllClear(45)).toContain("45 хв");
    expect(renderPersonalAllClear(135)).toContain("2 год 15 хв");
    expect(renderPersonalAllClear(120)).toContain("2 год");
    expect(renderPersonalAllClear(0)).toContain("менше хвилини");
  });

  it("називає джерело прямо — це не наш висновок", () => {
    const t = renderPersonalAllClear(30);
    expect(t).toContain("Повітряні Сили");
    expect(t).toContain("не даємо відбою за власною картиною");
  });

  it("найдовшу тривогу місяця відзначає лише для довгих", () => {
    expect(renderPersonalAllClear(180, { longestThisMonth: true })).toContain("найдовша");
    // Для пʼятихвилинної це було б смішно.
    expect(renderPersonalAllClear(5, { longestThisMonth: true })).not.toContain("найдовша");
  });
});
