import { describe, expect, it } from "bun:test";
import { frontlineKind } from "./air";

/*
 * Стрічка DeepState — робоча мапа редакції, а не карта окупації. У ній поруч
 * лежать окупована територія, звільнене у 2022-му, стрілки напрямків ударів,
 * позначки підрозділів і сатиричні полігони на чужі регіони — усе однаковими
 * полігонами з однаковим червонуватим `stroke`.
 *
 * Заміряно на живій відповіді: 124 полігони, з них 52 «Звільнено»,
 * 31 «Статус невідомий», 35 «окуповано» і 6 інших. Карта, що малює всі,
 * показує червону пляму, у якій лінії фронту не видно.
 */
describe("що означає полігон DeepState", () => {
  it("окупована територія — те єдине, що ми показуємо", () => {
    expect(frontlineKind("Окуповано")).toBe("occupied");
    expect(frontlineKind("Окупований Крим")).toBe("occupied");
    expect(frontlineKind("ОРДЛО")).toBe("occupied");
    expect(frontlineKind("Окупована Абхазія.")).toBe("occupied");
  });

  it("звільнене у 2022-му — не лінія фронту", () => {
    expect(frontlineKind("Звільнено")).toBe("liberated");
    // Дати в назві не мають ламати класифікацію: їх там десятки різних форм.
    expect(frontlineKind("Звільнено 25.03")).toBe("liberated");
    expect(frontlineKind("Звільнено 27-31.03")).toBe("liberated");
    expect(frontlineKind("Звільнено 04.09")).toBe("liberated");
  });

  it("стрілки ударів і невідомий статус — не межа контролю", () => {
    expect(frontlineKind("Напрямок удару")).toBe("direction");
    expect(frontlineKind("Статус невідомий")).toBe("unknown");
  });

  it("позначки підрозділів не є територією", () => {
    expect(frontlineKind('шойгісти "шторм-z"')).toBe("other");
    expect(frontlineKind("138-ма окрема мотострілецька бригада")).toBe("other");
  });

  it("нерозривний пробіл у назві не ламає розбір", () => {
    // Джерело ставить nbsp у назвах; без нормалізації «Звільнено» з ним
    // прочиталося б як «інше» і поїхало б на карту.
    expect(frontlineKind("Звільнено\u00a025.03")).toBe("liberated");
    expect(frontlineKind("\u00a0Окуповано")).toBe("occupied");
  });

  it("порожня назва — не привід вважати територію окупованою", () => {
    expect(frontlineKind("")).toBe("unknown");
    expect(frontlineKind("   ")).toBe("unknown");
  });
});
