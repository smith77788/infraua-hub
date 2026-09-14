import { describe, expect, it } from "bun:test";

import {
  canReport,
  corroborate,
  pruneReports,
  renderClusters,
  renderReportAccepted,
  REPORT_COOLDOWN_MS,
  REPORT_TTL_MS,
  type SoundKind,
  type SoundReport,
} from "./acoustic";

const HOME = { lat: 50.45, lon: 30.52 };

function report(chatId: number, kind: SoundKind, at: number, kmNorth = 0): SoundReport {
  return { chatId, kind, at, lat: HOME.lat + kmNorth / 111.32, lon: HOME.lon };
}

describe("один доклад ніколи нічого не піднімає", () => {
  it("одна людина — підтвердження немає", () => {
    // Це не налаштування, а конструкція: зловмисник або злякана людина не може
    // створити подію в принципі, скільки б разів не тиснула.
    expect(corroborate([report(1, "drone", 1000)], HOME, 1000)).toEqual([]);
  });

  it("десять докладів ОДНІЄЇ людини — усе одно одна людина", () => {
    const many = Array.from({ length: 10 }, (_, i) => report(1, "drone", 1000 + i));
    expect(corroborate(many, HOME, 1100)).toEqual([]);
  });

  it("двоє різних поруч — підтверджено", () => {
    const out = corroborate([report(1, "drone", 1000), report(2, "drone", 1200)], HOME, 1500);
    expect(out).toHaveLength(1);
    expect(out[0]!.witnesses).toBe(2);
  });
});

describe("межі місця й часу", () => {
  it("доклад за 200 км не стосується цієї точки", () => {
    const far = [report(1, "drone", 1000, 200), report(2, "drone", 1000, 200)];
    expect(corroborate(far, HOME, 1000)).toEqual([]);
  });

  it("доклад пів години тому нічого не каже про зараз", () => {
    const old = 0;
    const now = 25 * 60 * 1000;
    expect(corroborate([report(1, "drone", old), report(2, "drone", old)], HOME, now)).toEqual([]);
  });

  it("застарілі доклади прибираються з буфера", () => {
    const kept = pruneReports(
      [report(1, "drone", 0), report(2, "drone", REPORT_TTL_MS)],
      REPORT_TTL_MS,
    );
    expect(kept).toHaveLength(1);
  });
});

describe("антиспам", () => {
  it("перший доклад можна завжди, другий — лише після паузи", () => {
    expect(canReport(undefined, 1000)).toBe(true);
    expect(canReport(1000, 1000 + 60_000)).toBe(false);
    expect(canReport(1000, 1000 + REPORT_COOLDOWN_MS)).toBe(true);
  });
});

describe("подання", () => {
  it("порожньо — мовчимо, а не пишемо «нічого не чути»", () => {
    expect(renderClusters([])).toBeNull();
  });

  it("рядок називає кількість людей і свіжість", () => {
    const line = renderClusters(
      corroborate(
        [report(1, "explosion", 0), report(2, "explosion", 0), report(3, "explosion", 0)],
        HOME,
        5 * 60 * 1000,
      ),
    )!;
    expect(line).toContain("вибухи");
    expect(line).toContain("3 людини");
    expect(line).toContain("5 хв тому");
  });

  it("самотньому доповідачу прямо кажуть, чому його ще не показують іншим", () => {
    const text = renderReportAccepted("drone", []);
    expect(text).toContain("одного доклада замало");
  });
});
