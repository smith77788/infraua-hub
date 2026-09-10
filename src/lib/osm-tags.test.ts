import { describe, expect, it } from "bun:test";

import { formatVoltage, highestVoltage, plantOutputMw, voltageClass } from "./osm-tags";

describe("highestVoltage", () => {
  it("бере найвищу напругу зі списку, а не першу", () => {
    // Саме тут була розбіжність: одне з трьох місць читало перше значення,
    // і підстанція 330 кВ показувалася як 110 кВ.
    expect(highestVoltage("110000;330000")).toBe(330000);
    expect(highestVoltage("330000;110000")).toBe(330000);
  });

  it("розбирає одиничне значення", () => {
    expect(highestVoltage("750000")).toBe(750000);
  });

  it("переживає биті частини тега", () => {
    expect(highestVoltage("110000;;330000")).toBe(330000);
    expect(highestVoltage("110 kV;330000")).toBe(330000);
  });

  it("не вигадує напругу там, де її немає", () => {
    expect(highestVoltage(undefined)).toBeUndefined();
    expect(highestVoltage("")).toBeUndefined();
    expect(highestVoltage("невідомо")).toBeUndefined();
    expect(highestVoltage("0")).toBeUndefined();
    expect(highestVoltage("-110000")).toBeUndefined();
  });
});

describe("voltageClass", () => {
  it("розкладає напругу по класах української мережі", () => {
    expect(voltageClass(750000)).toBe("backbone");
    expect(voltageClass(330000)).toBe("transmission");
    expect(voltageClass(220000)).toBe("sub_transmission");
    expect(voltageClass(150000)).toBe("sub_transmission");
    expect(voltageClass(110000)).toBe("distribution");
  });

  it("без напруги класу немає", () => {
    expect(voltageClass(undefined)).toBeUndefined();
  });
});

describe("formatVoltage", () => {
  it("пише кіловольти без хибної точності", () => {
    expect(formatVoltage(330000)).toBe("330 кВ");
    expect(formatVoltage(6600)).toBe("6.6 кВ");
  });

  it("порожньо, коли нічого не відомо", () => {
    expect(formatVoltage(undefined)).toBe("");
  });
});

describe("plantOutputMw", () => {
  it("розбирає звичні написання", () => {
    expect(plantOutputMw("1000 MW")).toBe(1000);
    expect(plantOutputMw("1 GW")).toBe(1000);
    expect(plantOutputMw("500 kW")).toBe(0.5);
    expect(plantOutputMw("2,5 MW")).toBe(2.5);
  });

  it("голе число трактує як мегавати", () => {
    expect(plantOutputMw("750")).toBe(750);
  });

  it("повертає undefined на тому, чого не впізнав", () => {
    // Вигадана потужність гірша за відсутню: на неї спираються.
    expect(plantOutputMw("багато")).toBeUndefined();
    expect(plantOutputMw("730` MW")).toBeUndefined();
    expect(plantOutputMw("")).toBeUndefined();
    expect(plantOutputMw(undefined)).toBeUndefined();
    expect(plantOutputMw("0 MW")).toBeUndefined();
  });
});
