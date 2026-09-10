import { describe, expect, it } from "bun:test";

import {
  assessCredibility,
  describeCode,
  warrantsEscalation,
  type SourceRole,
} from "./source-credibility";

const roles: Record<string, SourceRole> = {
  radar_a: "watch",
  radar_b: "watch",
  kyiv_local: "regional",
  news_wire: "general",
};
const roleOf = (source: string): SourceRole => roles[source] ?? "unknown";

describe("надійність джерела", () => {
  it("бере найкращу роль серед джерел, бо переказ не псує первинного", () => {
    // Якщо серед джерел є канал спостереження, повідомлення прийшло від нього,
    // а решта могла його переказати.
    expect(assessCredibility({ sources: ["news_wire", "radar_a"], roleOf }).reliability).toBe("C");
  });

  it("відрізняє невідому роль від поганої", () => {
    // Інакше кожне джерело поза нашим переліком мовчки прирівнювалося б до
    // найгіршого.
    expect(assessCredibility({ sources: ["хтось"], roleOf }).reliability).toBe("F");
    expect(assessCredibility({ sources: ["news_wire"], roleOf }).reliability).toBe("D");
  });

  it("ставить офіційне джерело вище за будь-який канал", () => {
    const official = assessCredibility({ sources: ["дснс"], roleOf: () => "official" });
    expect(official.reliability).toBe("B");
  });
});

describe("достовірність за підтвердженням", () => {
  it("рахує незалежні джерела, а не повідомлення", () => {
    // Десять повідомлень від одного джерела — це одне джерело.
    const one = assessCredibility({ sources: ["radar_a"], roleOf, reports: 10 });
    expect(one.independentSources).toBe(1);
    expect(one.credibility).toBe(3);
    expect(one.reasons.join(" ")).toContain("це одне джерело");
  });

  it("рахує офіційну тривогу окремим джерелом, бо вона й є окреме джерело", () => {
    const withAlarm = assessCredibility({
      sources: ["radar_a"],
      roleOf,
      officialCorroboration: true,
    });
    expect(withAlarm.independentSources).toBe(2);
    expect(withAlarm.credibility).toBe(2);
  });

  it("піднімає до підтвердженого на трьох незалежних", () => {
    const many = assessCredibility({ sources: ["radar_a", "radar_b", "kyiv_local"], roleOf });
    expect(many.credibility).toBe(1);
    expect(many.code).toBe("C1");
  });

  it("не має чим оцінювати, коли джерел немає взагалі", () => {
    const none = assessCredibility({ sources: [], roleOf });
    expect(none.code).toBe("F6");
  });
});

describe("чи піднімати рівень", () => {
  it("знижує лише за наявності підстав, а не за їх відсутності", () => {
    // Напрямок відмови тут протилежний до контролю доступу: пропущений удар
    // коштує більше, ніж зайва тривога.
    expect(warrantsEscalation(assessCredibility({ sources: ["хтось"], roleOf }))).toBe(true);
    expect(warrantsEscalation(assessCredibility({ sources: [], roleOf }))).toBe(true);
  });

  it("глушить одне непідтверджене повідомлення від каналу, що переказує", () => {
    expect(warrantsEscalation(assessCredibility({ sources: ["news_wire"], roleOf }))).toBe(false);
  });

  it("не глушить його ж, щойно зʼявляється підтвердження", () => {
    expect(
      warrantsEscalation(
        assessCredibility({ sources: ["news_wire"], roleOf, officialCorroboration: true }),
      ),
    ).toBe(true);
    expect(
      warrantsEscalation(assessCredibility({ sources: ["news_wire", "kyiv_local"], roleOf })),
    ).toBe(true);
  });

  it("не глушить канал спостереження навіть наодинці", () => {
    expect(warrantsEscalation(assessCredibility({ sources: ["radar_a"], roleOf }))).toBe(true);
  });
});

describe("підпис для людини", () => {
  it("розкриває код словами, а не лишає його загадкою", () => {
    const text = describeCode(assessCredibility({ sources: ["radar_a", "radar_b"], roleOf }));
    expect(text).toContain("C2");
    expect(text).toContain("досить надійне");
    expect(text).toContain("ймовірно правдиве");
  });
});
