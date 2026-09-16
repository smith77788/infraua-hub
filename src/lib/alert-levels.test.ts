import { describe, expect, it } from "bun:test";

import {
  levelForOblast,
  oblastKey,
  parseAlertLevels,
  raionsOf,
  reasonsFor,
  type AlertLevels,
} from "./alert-levels";

// Форма — зі справжньої відповіді джерела, знятої на живих даних.
const RAW = {
  version: 1789596415,
  updatedAt: "2026-09-16T22:06:55Z",
  raions: [
    {
      key: "бахмутський",
      name: "Бахмутський район",
      oblast: "Донецька область",
      since: "2026-09-16T04:42:55Z",
      level: "red",
      reasons: ["Ракетна загроза (червоний рівень)"],
    },
    {
      key: "конотопський",
      name: "Конотопський район",
      oblast: "Сумська область",
      since: "2026-09-16T21:00:00Z",
      level: "yellow",
      reasons: ["Дронова загроза (жовтий рівень)"],
    },
  ],
  oblasts: [
    {
      key: "м. київ",
      name: "м. Київ",
      oblast: "м. Київ",
      since: "2026-09-16T21:30:00Z",
      level: "yellow",
      reasons: ["Дронова загроза (жовтий рівень)"],
    },
  ],
};

describe("parseAlertLevels", () => {
  it("читає рівні, райони й причини", () => {
    const l = parseAlertLevels(RAW)!;
    expect(l.raions).toHaveLength(2);
    expect(l.oblasts).toHaveLength(1);
    expect(l.raions[0]!.level).toBe("red");
    expect(l.raions[0]!.reasons[0]).toContain("Ракетна");
  });

  it("незнайомий рівень відкидається, а не зводиться до червоного", () => {
    /*
     * Вигаданий рівень гірший за його відсутність: на нього люди діятимуть як
     * на справжній.
     */
    const l = parseAlertLevels({ raions: [{ ...RAW.raions[0], level: "orange" }] })!;
    expect(l.raions).toHaveLength(0);
  });

  it("бита відповідь — це NULL, а не «тривог немає»", () => {
    /*
     * Порожній перелік фарбує карту в спокій, тобто СТВЕРДЖУЄ, що ніде не
     * тривожно. Таке твердження на битій відповіді — найгірше, що може
     * зробити монітор.
     */
    expect(parseAlertLevels(null)).toBeNull();
    expect(parseAlertLevels({ щось: 1 })).toBeNull();
    expect(parseAlertLevels("тривога")).toBeNull();
  });

  it("порожні переліки — це законна відповідь «ніде не оголошено»", () => {
    const l = parseAlertLevels({ raions: [], oblasts: [], updatedAt: "x" })!;
    expect(l.raions).toHaveLength(0);
    expect(l.updatedAt).toBe("x");
  });
});

describe("oblastKey", () => {
  it("зводить різні написання однієї області", () => {
    expect(oblastKey("Сумська область")).toBe(oblastKey("Сумська обл."));
    expect(oblastKey("м. Київ")).toBe("київ");
  });
});

describe("levelForOblast", () => {
  const l = parseAlertLevels(RAW) as AlertLevels;

  it("район із ракетною загрозою робить область червоною", () => {
    // Інакше той, хто дивиться на країну цілком, цього просто не побачить.
    expect(levelForOblast(l, "Донецька область")).toBe("red");
  });

  it("район із дроновою загрозою — жовтий", () => {
    expect(levelForOblast(l, "Сумська обл.")).toBe("yellow");
  });

  it("тривога на цілу область теж рахується", () => {
    expect(levelForOblast(l, "м. Київ")).toBe("yellow");
  });

  it("де нічого не оголошено — нічого й не кажемо", () => {
    expect(levelForOblast(l, "Львівська область")).toBeNull();
  });

  it("червоний переважає жовтий у тій самій області", () => {
    const mixed = parseAlertLevels({
      raions: [
        { ...RAW.raions[1], oblast: "Сумська область", level: "yellow" },
        { ...RAW.raions[0], oblast: "Сумська область", level: "red" },
      ],
    })!;
    expect(levelForOblast(mixed, "Сумська область")).toBe("red");
  });
});

describe("райони й причини", () => {
  const l = parseAlertLevels(RAW) as AlertLevels;

  it("називає райони поіменно", () => {
    expect(raionsOf(l, "Донецька область").map((a) => a.name)).toEqual(["Бахмутський район"]);
  });

  it("причина — словами джерела, без повторів", () => {
    // Саме причина каже, що робити: дрон лишає час дійти, ракета — ні.
    expect(reasonsFor(l, "Сумська область")).toEqual(["Дронова загроза (жовтий рівень)"]);
  });
});
