import { describe, expect, it } from "bun:test";

import {
  buildCalmProfile,
  calmestWindow,
  MIN_OBSERVED_DAYS,
  renderCalmHours,
  type ActivityBucket,
} from "./calm-hours";

/** Відрізки за `days` діб: уночі тихо, удень шумно. */
function synthetic(days: number, quietHours: number[] = [1, 2, 3, 4, 5, 6]): ActivityBucket[] {
  const out: ActivityBucket[] = [];
  const start = Date.UTC(2026, 8, 1, 0, 0, 0);
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      for (let k = 0; k < 6; k++) {
        const at = start + d * 86_400_000 + h * 3_600_000 + k * 600_000;
        // Київ улітку = UTC+3, тож година в даних зсунута — беремо це як є:
        // функція сама рахує київську годину.
        out.push({ at, targets: quietHours.includes((h + 3) % 24) ? 0 : 5 });
      }
    }
  }
  return out;
}

describe("buildCalmProfile", () => {
  it("мала вибірка позначається ненадійною", () => {
    // Профіль за два дні — це не розклад, а два дні.
    const p = buildCalmProfile(synthetic(2));
    expect(p.reliable).toBe(false);
    expect(p.observedDays).toBeLessThan(MIN_OBSERVED_DAYS);
  });

  it("достатня вибірка дає профіль на всі 24 години", () => {
    const p = buildCalmProfile(synthetic(10));
    expect(p.reliable).toBe(true);
    expect(p.hours).toHaveLength(24);
  });

  it("рахує і масштаб, і ймовірність спокою окремо", () => {
    /*
     * Одна ніч із сорока цілями псує середнє, але не робить годину загалом
     * неспокійною — людині, яка обирає час для сну, потрібна саме частка.
     */
    const p = buildCalmProfile(synthetic(10));
    const quiet = p.hours.find((h) => h.quietShare === 1);
    const loud = p.hours.find((h) => h.quietShare === 0);
    expect(quiet).toBeDefined();
    expect(quiet!.avgTargets).toBe(0);
    expect(loud!.avgTargets).toBeGreaterThan(0);
  });

  it("порожній вхід не ламає", () => {
    const p = buildCalmProfile([]);
    expect(p.hours).toEqual([]);
    expect(p.reliable).toBe(false);
  });
});

describe("calmestWindow — суцільний проміжок, не окремі години", () => {
  it("знаходить тихе вікно", () => {
    // «Тихо о 3-й і о 7-й» не допомагає тому, хто хоче поспати шість годин.
    const w = calmestWindow(buildCalmProfile(synthetic(10)), 6);
    expect(w).not.toBeNull();
    expect(w!.quietShare).toBeGreaterThan(0.9);
  });

  it("вікно може переходити через північ", () => {
    // Саме там воно найчастіше й буває.
    const w = calmestWindow(buildCalmProfile(synthetic(10, [22, 23, 0, 1, 2, 3])), 6);
    expect(w).not.toBeNull();
    expect(w!.quietShare).toBeGreaterThan(0.9);
  });

  it("ненадійний профіль вікна не дає", () => {
    expect(calmestWindow(buildCalmProfile(synthetic(2)), 6)).toBeNull();
  });
});

describe("renderCalmHours — прогноз, а не обіцянка", () => {
  it("мала вибірка: кажемо прямо, скільки зібрано", () => {
    const t = renderCalmHours(buildCalmProfile(synthetic(2)));
    expect(t).toContain("замало");
    expect(t).toContain("не розклад");
  });

  it("надійний профіль показує вікно й найгучнішу годину", () => {
    const t = renderCalmHours(buildCalmProfile(synthetic(10)));
    expect(t).toMatch(/\d{2}:00–\d{2}:00/);
    expect(t).toContain("Найгучніша година");
  });

  it("застереження їде разом із рядком, а не лишається в довідці", () => {
    // Рядок пересилають скріншотом.
    const t = renderCalmHours(buildCalmProfile(synthetic(10)));
    expect(t).toContain("не прогноз погоди");
    expect(t).toContain("вимикати не варто");
  });

  it("ніде не пропонує вимкнути сповіщення", () => {
    const t = renderCalmHours(buildCalmProfile(synthetic(10)));
    expect(t).not.toMatch(/можете вимкнути|радимо вимкнути/);
  });
});
