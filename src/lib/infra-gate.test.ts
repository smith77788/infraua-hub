import { afterEach, describe, expect, it } from "bun:test";
import { INFRA_LAYERS_FLAG, infraLayersOff, infraLayersPermitted } from "./infra-gate";

afterEach(() => {
  delete process.env[INFRA_LAYERS_FLAG];
});

describe("вимикач шарів критичної інфраструктури", () => {
  it("вимкнений, поки розгортання не сказало інакше", () => {
    // Головна властивість: розгортання, яке про вимикач не знає, нічого не
    // віддає. Протилежне усталене значення означало б, що шари публікує той,
    // хто про них не думав.
    expect(infraLayersPermitted()).toBe(false);
  });

  it("вмикається рівно одним значенням, а не будь-чим правдоподібним", () => {
    for (const value of ["yes", "true", "1", "ON", "on ", ""]) {
      process.env[INFRA_LAYERS_FLAG] = value;
      expect(infraLayersPermitted()).toBe(false);
    }
    process.env[INFRA_LAYERS_FLAG] = "on";
    expect(infraLayersPermitted()).toBe(true);
  });
});

describe("як консоль читає стан із відповіді", () => {
  it("вважає вимкненим, поки відповіді немає", () => {
    // Сторінка збирається на сервері раніше, ніж запит відповість. Якби
    // невідоме значення читалося як «увімкнено», був би кадр із намальованою
    // обстановкою шарів.
    expect(infraLayersOff(undefined)).toBe(true);
    expect(infraLayersOff({})).toBe(true);
  });

  it("вмикається назад лише на явне `false`", () => {
    // Це те, що ламалося: увімкнений шлях лишав поле порожнім, тож був
    // невідрізненний від «ще не відповіли», і вимикач не вмикався назад.
    expect(infraLayersOff({ disabled: false })).toBe(false);
    expect(infraLayersOff({ disabled: true })).toBe(true);
  });
});
