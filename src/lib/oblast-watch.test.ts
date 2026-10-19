import { describe, expect, it } from "bun:test";

import { parseAlertLevels } from "./alert-levels";

import {
  oblastTransitions,
  renderAlertCleared,
  renderAlertStarted,
  updateAlertStarts,
  levelEscalations,
  levelMapOf,
  renderEscalation,
} from "./oblast-watch";

describe("oblastTransitions", () => {
  it("перший знімок не дає переходів — інакше редеплой став би сиреною", () => {
    // Найважливіше твердження модуля: без нього кожен перезапуск процесу
    // розсилав би «оголошено тривогу» всім, у кого вона вже тривала годину.
    expect(oblastTransitions(null, ["Сумщина", "Харківщина"])).toEqual([]);
  });

  it("нова область — початок, зникла — відбій", () => {
    expect(oblastTransitions(["Сумщина"], ["Харківщина"])).toEqual([
      { oblast: "Сумщина", kind: "cleared" },
      { oblast: "Харківщина", kind: "started" },
    ]);
  });

  it("незмінний стан не породжує повідомлень", () => {
    expect(oblastTransitions(["Сумщина"], ["Сумщина"])).toEqual([]);
  });

  it("порожній попередній стан — це не «перший знімок»", () => {
    // Порожній масив означає «тривог не було»; null означає «ми не знаємо».
    expect(oblastTransitions([], ["Сумщина"])).toEqual([{ oblast: "Сумщина", kind: "started" }]);
  });
});

describe("updateAlertStarts", () => {
  it("вже почата тривога зберігає свій початок", () => {
    const starts = new Map([["Сумщина", 1000]]);
    const next = updateAlertStarts(starts, ["Сумщина", "Харківщина"], 5000);
    expect(next.get("Сумщина")).toBe(1000);
    expect(next.get("Харківщина")).toBe(5000);
  });

  it("знята тривога забувається — інакше наступна порахувала б чужу тривалість", () => {
    const next = updateAlertStarts(new Map([["Сумщина", 1000]]), [], 5000);
    expect(next.size).toBe(0);
  });
});

describe("тексти", () => {
  it("початок називає джерело в першому ж рядку", () => {
    const text = renderAlertStarted("Сумщина", ["дім"]);
    expect(text).toContain("Повітряна тривога — Сумщина");
    expect(text).toContain("офіційна тривога, а не наша оцінка");
  });

  it("кілька місць в області перелічені, одне — ні", () => {
    expect(renderAlertStarted("Сумщина", ["дім", "робота"])).toContain("дім, робота");
    expect(renderAlertStarted("Сумщина", ["дім"])).not.toContain("Ваші місця");
  });

  it("відбій тут — справді відбій, і сказано це без застережень", () => {
    // Єдине місце в системі, де слово вживається без «ми перестали бачити».
    const text = renderAlertCleared("Сумщина", "2 год 15 хв");
    expect(text).toContain("Відбій — Сумщина");
    expect(text).toContain("2 год 15 хв");
    expect(text).toContain("Відбій офіційний");
  });

  it("без відомої тривалості текст не вигадує число", () => {
    expect(renderAlertCleared("Сумщина", null)).toContain("Офіційну тривогу знято");
  });
});

describe("назви ззовні не ламають повідомлення", () => {
  /*
   * Назва області розібрана з відповіді джерела офіційних тривог — це чужий
   * рядок. Одна кутова дужка в ньому, і Telegram відхиляє повідомлення
   * ЦІЛКОМ: людина не дізнається про тривогу взагалі. Найгірший наслідок тут
   * не підроблений текст, а тиша.
   */
  it("тривога: назва області екранується", () => {
    const t = renderAlertStarted("<b>Київщина</b> & обл.", []);
    expect(t).toContain("&lt;b&gt;Київщина&lt;/b&gt;");
    expect(t).toContain("&amp;");
  });

  it("відбій: назва області екранується", () => {
    expect(renderAlertCleared("<i>Сумщина", null)).toContain("&lt;i&gt;Сумщина");
  });

  it("перелік місць екранується", () => {
    const t = renderAlertStarted("Сумщина", ["<b>дім", "дача"]);
    expect(t).toContain("&lt;b&gt;дім");
  });

  it("наша власна розмітка лишається цілою", () => {
    expect(renderAlertStarted("Сумщина", [])).toContain("<b>Повітряна тривога");
  });
});

describe("рівень небезпеки: підвищення під час тривоги", () => {
  const lvl = (pairs: [string, "red" | "yellow"][]) => new Map(pairs);

  it("жовтий → червоний будить: часу стало менше", () => {
    /*
     * Та сама подія, яку бот не вмів помічати взагалі: тривога вже триває,
     * людина вже отримала «оголошено офіційно», і тут дронова загроза стає
     * ракетною. До дрона можна дійти до укриття, до балістики — ні.
     */
    expect(levelEscalations(lvl([["сумська", "yellow"]]), lvl([["сумська", "red"]]))).toEqual([
      "сумська",
    ]);
  });

  it("поява червоного там, де нічого не було, теж підвищення", () => {
    expect(levelEscalations(lvl([]), lvl([["харківська", "red"]]))).toEqual(["харківська"]);
  });

  it("червоний, що триває, не повторюється", () => {
    expect(levelEscalations(lvl([["сумська", "red"]]), lvl([["сумська", "red"]]))).toEqual([]);
  });

  it("зниження рівня НЕ будить", () => {
    // Помилитись у бік спокою не можна, але й поспішати з ним нікуди:
    // відбій прийде окремо й офіційно.
    expect(levelEscalations(lvl([["сумська", "red"]]), lvl([["сумська", "yellow"]]))).toEqual([]);
  });

  it("жовтий сам по собі не будить", () => {
    expect(levelEscalations(lvl([]), lvl([["сумська", "yellow"]]))).toEqual([]);
  });

  it("перший знімок не дає підвищень", () => {
    /*
     * Без цього кожен редеплой розсилав би «рівень підвищено» всім, у кого
     * червоний уже тривав годину.
     */
    expect(levelEscalations(null, lvl([["сумська", "red"]]))).toEqual([]);
  });
});

describe("levelMapOf", () => {
  const levels = parseAlertLevels({
    raions: [
      { key: "a", name: "A", oblast: "Сумська область", level: "yellow", since: "", reasons: [] },
      { key: "b", name: "B", oblast: "Сумська область", level: "red", since: "", reasons: [] },
    ],
    oblasts: [],
  })!;

  it("область бере НАЙГОСТРІШИЙ рівень серед своїх районів", () => {
    // Інакше ракетна загроза в одному районі загубилась би за жовтими сусідами.
    expect(levelMapOf(levels).get("сумська")).toBe("red");
  });

  it("без рівнів — порожньо, а не вигадані значення", () => {
    expect(levelMapOf(null).size).toBe(0);
  });
});

describe("renderEscalation", () => {
  it("каже, що тривога триває, і називає причину словами джерела", () => {
    const t = renderEscalation("Сумщина", {
      level: "red",
      reasons: ["Ракетна загроза (червоний рівень)"],
      blindTo: null,
    });
    expect(t).toContain("Рівень підвищено");
    expect(t).toContain("Тривога триває");
    expect(t).toContain("Ракетна загроза");
  });

  it("несе застереження про нашу сліпоту, коли воно є", () => {
    const t = renderEscalation("Сумщина", {
      level: "red",
      reasons: ["Ракетна загроза (червоний рівень)"],
      blindTo: "Ракети й КАБи наш радар не відстежує.",
    });
    expect(t).toContain("не відстежує");
  });

  it("чужий текст у причині не ламає повідомлення", () => {
    // Інакше Telegram відхилить його цілком — і про підвищення ніхто не дізнається.
    const t = renderEscalation("Сумщина", { level: "red", reasons: ["<b>x</b>"], blindTo: null });
    expect(t).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("renderAlertStarted із рівнем", () => {
  it("початок тривоги одразу несе причину", () => {
    const t = renderAlertStarted("Сумщина", [], {
      level: "red",
      reasons: ["Ракетна загроза (червоний рівень)"],
      blindTo: "Порожня карта НЕ означає, що тихо.",
    });
    expect(t).toContain("Ракетна загроза");
    expect(t).toContain("НЕ означає, що тихо");
  });

  it("без рівня лишається таким, як був", () => {
    expect(renderAlertStarted("Сумщина", [])).toContain("Повітряна тривога");
  });
});

describe("підвищення без названої причини", () => {
  it("не обіцяє пояснити те, чого джерело не сказало", () => {
    /*
     * Заміряно на живих даних: для частини областей `reasons` порожній.
     * Рядок «загроза змінилась:» із порожнечею після двокрапки — обіцянка без
     * змісту, а в повідомленні, яке будить уночі, це гірше за її відсутність.
     */
    const t = renderEscalation("Крим", { level: "red", reasons: [], blindTo: null });
    expect(t).not.toContain("змінилась:");
    expect(t).toContain("підвищено до червоного");
  });

  it("з причиною — пояснює", () => {
    const t = renderEscalation("Сумщина", {
      level: "red",
      reasons: ["Ракетна загроза (червоний рівень)"],
      blindTo: null,
    });
    expect(t).toContain("змінилась:");
    expect(t).toContain("Ракетна загроза");
  });
});
