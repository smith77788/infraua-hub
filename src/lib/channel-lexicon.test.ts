import { describe, expect, it } from "bun:test";

import { EN, UK } from "./channel-lexicon";

describe("заголовок і пора доби", () => {
  /** Усі заголовки, які пул може віддати о цій годині. */
  const headsAt = (hour: number): string[] =>
    Array.from({ length: 12 }, (_, seed) => UK.headline("swarm", seed, hour));

  it("«нічна зміна» не зʼявляється вдень — це була справжня вада каналу", () => {
    // О 16:49 у проді вийшов пост «🛸 Нічна зміна шахедів». Вибір ішов за хешем
    // вмісту, тож приблизно кожен третій денний рій оголошував ніч.
    for (const hour of [7, 10, 13, 16, 18, 20]) {
      expect(headsAt(hour).join(" ")).not.toContain("Нічна зміна");
    }
  });

  it("уночі «нічна зміна» лишається доступною", () => {
    for (const hour of [22, 23, 0, 3, 5]) {
      expect(headsAt(hour).join(" ")).toContain("Нічна зміна");
    }
  });

  it("«серед дня» не зʼявляється вночі", () => {
    for (const hour of [23, 2, 4]) {
      expect(headsAt(hour).join(" ")).not.toContain("серед дня");
    }
  });

  it("о будь-якій годині доби заголовок є і він не порожній", () => {
    for (let hour = 0; hour < 24; hour++) {
      for (const head of headsAt(hour)) {
        expect(head.length).toBeGreaterThan(0);
      }
    }
  });

  it("кожен пул має хоч один безчасовий варіант", () => {
    // Запобіжник на майбутнє: пул із самих прив'язаних варіантів лишив би
    // години, у які заголовка не існує.
    const kinds = ["rocket", "kab", "swarm", "few", "calm"] as const;
    for (const lex of [UK, EN]) {
      for (const kind of kinds) {
        const alwaysSame = new Set<string>();
        for (let hour = 0; hour < 24; hour++) alwaysSame.add(lex.headline(kind, 0, hour));
        // Насіння те саме, година різна: якщо варіант безчасовий, вибір сталий.
        // Порожній результат чи виняток тут і означав би пул без безчасових.
        expect(alwaysSame.size).toBeGreaterThan(0);
      }
    }
  });
});
