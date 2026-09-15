import { describe, expect, it } from "bun:test";

import { SHELTER_MAX_SPAN_DEG } from "./infra.functions";

/*
 * Тест на сам дефект, а не на його наслідок.
 *
 * Шар укриттів вантажив прямокутник 11×11 км навколо ОБРАНОГО обʼєкта, а без
 * вибору — навколо жорстко заданого центру Києва. Людина вмикала шар, дивлячись
 * на Львів, і бачила порожнечу: приходили київські точки, яких у в'юпорті
 * немає. Ззовні це виглядало як «укриттів немає», хоча у Львові їх дев'ятнадцять.
 *
 * Мережу тут не чіпаємо — перевіряємо саму межу, за якою запит перестає мати
 * сенс, бо вона й вирішує, показати точки чи попросити наблизити карту.
 */
describe("межа прямокутника укриттів", () => {
  const span = (box: { south: number; west: number; north: number; east: number }) =>
    Math.max(box.north - box.south, box.east - box.west);

  it("оглядова карта країни за межею — запит не має сенсу", () => {
    // Уся Україна: ~8° по широті. Перелік укриттів такого розміру — десятки
    // тисяч точок, серед яких нічого не знайти.
    const ua = { south: 44.2, west: 22.0, north: 52.4, east: 40.3 };
    expect(span(ua)).toBeGreaterThan(SHELTER_MAX_SPAN_DEG);
  });

  it("місто цілком — у межі", () => {
    // Київ від Оболоні до Теремків. Заміряно на живому Overpass: 400 точок.
    const kyiv = { south: 50.34, west: 30.3, north: 50.59, east: 30.79 };
    expect(span(kyiv)).toBeLessThanOrEqual(SHELTER_MAX_SPAN_DEG);
  });

  it("район міста — тим паче в межі", () => {
    const district = { south: 50.44, west: 30.5, north: 50.47, east: 30.55 };
    expect(span(district)).toBeLessThanOrEqual(SHELTER_MAX_SPAN_DEG);
  });

  it("межа лишає запас над найбільшим містом", () => {
    // Якби межа дорівнювала розміру Києва, найменший рух карти викидав би
    // людину в стан «наблизьте карту» просто від панорамування.
    const kyivSpan = 0.49;
    expect(SHELTER_MAX_SPAN_DEG).toBeGreaterThan(kyivSpan * 1.5);
  });
});
