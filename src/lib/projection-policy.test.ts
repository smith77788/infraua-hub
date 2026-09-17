/**
 * Правило «тягнути чи не тягнути позначку» — як арифметика, а не як смак.
 *
 * Тест живе окремо від компонента навмисно: саме правило не залежить ні від
 * React, ні від карти, а сперечатись про нього будуть ще не раз.
 */

import { describe, expect, it } from "bun:test";

/**
 * Помилка позиції при протягуванні під кутом θ до справжнього курсу,
 * у частках справжнього зміщення. Стояти на місці = 1.
 */
function errorFactor(thetaDeg: number): number {
  return 2 * Math.sin((thetaDeg * Math.PI) / 360);
}

describe("коли протягування позначки виправдане", () => {
  it("рівно до 60° похибки курсу — і це не довільний поріг", () => {
    // Стоїмо: помилка = d. Тягнемо під кутом θ: помилка = 2·d·sin(θ/2).
    // Друге менше за перше рівно при θ < 60°.
    expect(errorFactor(0)).toBeCloseTo(0, 3);
    expect(errorFactor(30)).toBeLessThan(1);
    expect(errorFactor(60)).toBeCloseTo(1, 3);
    expect(errorFactor(72)).toBeGreaterThan(1);
    expect(errorFactor(180)).toBeCloseTo(2, 3);
  });

  it("на заміряному розподілі припущений курс лежить ПОЗА цим порогом", () => {
    /*
     * Заміряно за 40 хвилин спостережень живого фіду neptun, зіставленням
     * курсу джерела з нашим власним треком тієї самої цілі:
     *   presumptiveCourse=false → медіана розходження 0°
     *   presumptiveCourse=true  → медіана 72°, 5 випадків із 9 понад 60°
     * Тобто тягнути за припущеним курсом у медіані ГІРШЕ, ніж не тягнути.
     */
    const MEASURED_MEDIAN_PRESUMED_DEG = 72;
    const MEASURED_MEDIAN_OBSERVED_DEG = 0;
    expect(errorFactor(MEASURED_MEDIAN_PRESUMED_DEG)).toBeGreaterThan(1);
    expect(errorFactor(MEASURED_MEDIAN_OBSERVED_DEG)).toBeLessThan(1);
  });

  it("аргумент «нерухома позначка теж бреше» діє лише всередині порога", () => {
    // Він правильний — але не безумовно, і саме тому потрібен поріг, а не віра.
    for (const theta of [10, 25, 45, 59]) expect(errorFactor(theta)).toBeLessThan(1);
    for (const theta of [61, 80, 110, 150]) expect(errorFactor(theta)).toBeGreaterThan(1);
  });
});
