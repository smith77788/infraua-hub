import { describe, expect, it } from "bun:test";

import { adviceFor, renderAdvice, worstAdvice } from "./safety-advice";

describe("порада залежить від типу — бо дії справді різні", () => {
  it("балістика: не бігти далеко, бо часу немає", () => {
    const a = adviceFor("ballistic");
    expect(a.headline).toContain("не біжіть далеко");
    expect(a.timing).toContain("секунди");
  });

  it("шахед: час дійти до укриття є — і це сказано прямо", () => {
    // Порада «переждіть у коридорі» там, де встигаєш дійти до підвалу, —
    // це втрачені хвилини, які в людини насправді були.
    expect(adviceFor("shahed").headline).toContain("Час дійти до укриття є");
  });

  it("КАБ: головна небезпека названа першою — скло", () => {
    expect(adviceFor("kab").headline).toContain("скло");
  });

  it("невідомий тип не лишається без поради", () => {
    expect(adviceFor(undefined).steps.length).toBeGreaterThan(0);
    expect(adviceFor("unknown").headline).toContain("двох стін");
  });

  it("кроків не більше трьох: четвертий не прочитають", () => {
    for (const t of ["ballistic", "shahed", "kab", "cruise", "unknown"] as const) {
      expect(adviceFor(t).steps.length).toBeLessThanOrEqual(3);
    }
  });
});

describe("worstAdvice", () => {
  it("серед шахедів і балістики перемагає балістика", () => {
    // Порада про шахеди («час є») коштувала б людині тих хвилин, яких немає.
    expect(worstAdvice(["shahed", "ballistic"]).timing).toContain("секунди");
  });

  it("порядок у списку не впливає на вибір", () => {
    expect(worstAdvice(["ballistic", "shahed"])).toEqual(worstAdvice(["shahed", "ballistic"]));
  });

  it("порожній список дає загальну пораду, а не виняток", () => {
    expect(worstAdvice([]).steps.length).toBeGreaterThan(0);
  });

  it("невизначені типи не ламають вибір", () => {
    expect(worstAdvice([undefined, "kab"]).headline).toContain("скло");
  });
});

describe("renderAdvice", () => {
  it("компактно: заголовок, кроки, час", () => {
    const text = renderAdvice(adviceFor("shahed"));
    expect(text.split("\n").length).toBeLessThanOrEqual(5);
    expect(text).toContain("•");
  });
});
