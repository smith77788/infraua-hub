import { describe, expect, it } from "bun:test";

import {
  MAX_PLACES,
  PLACE_COOLDOWN_MS,
  addPlace,
  alertSubject,
  canAddPlace,
  decidePlaceAlert,
  markPlaceAlerted,
  parsePlaceTail,
  placeRadiusKm,
  placesFromLegacy,
  primaryPlace,
  removePlace,
  renderPlaceAlert,
  renderPlaces,
  type MyPlace,
  validatePlaceName,
} from "./places-mine";

const p = (title: string, addedAt = 1, lat = 50, lon = 30): MyPlace => ({
  title,
  lat,
  lon,
  label: title,
  addedAt,
});

describe("validatePlaceName", () => {
  it("порожня назва відхиляється", () => {
    // «Ціль на » читається як поламане, а о третій ночі розбиратися ніколи.
    expect(validatePlaceName("   ").ok).toBe(false);
  });

  it("зайві пробіли стискаються", () => {
    expect(validatePlaceName("  школа   Соні ").value).toBe("школа Соні");
  });

  it("надто довга відхиляється", () => {
    expect(validatePlaceName("я".repeat(30)).ok).toBe(false);
  });
});

describe("addPlace", () => {
  it("однакова назва замінює, а не дублює", () => {
    /*
     * Людина, яка пише «дім» удруге, виправляє координату, а не заводить
     * другий дім. Мовчазний дубль дав би два сповіщення про одне місце.
     */
    const start = [p("дім", 100, 50, 30)];
    const r = addPlace(start, { title: "дім", lat: 51, lon: 31, label: "дім" }, 200);
    expect(r.places).toHaveLength(1);
    expect(r.replaced).toBe(true);
    expect(r.places[0]!.lat).toBe(51);
    // Час додавання зберігається — головне місце не має стрибати від правки.
    expect(r.places[0]!.addedAt).toBe(100);
  });

  it("регістр назви не створює другого місця", () => {
    const r = addPlace([p("Дім", 1)], { title: "дім", lat: 51, lon: 31, label: "дім" }, 2);
    expect(r.places).toHaveLength(1);
  });

  it("більше межі не додається, і причина називається", () => {
    const full = Array.from({ length: MAX_PLACES }, (_, i) => p(`м${i}`, i));
    expect(canAddPlace(full)).toBe(false);
    const r = addPlace(full, { title: "ще", lat: 50, lon: 30, label: "ще" }, 9);
    expect(r.places).toHaveLength(MAX_PLACES);
    expect(r.error).toContain("прибрати");
  });

  it("додає нове місце в межах ліміту", () => {
    const r = addPlace([p("дім", 1)], { title: "мама", lat: 49, lon: 36, label: "Харків" }, 5);
    expect(r.places).toHaveLength(2);
    expect(r.replaced).toBe(false);
  });
});

describe("removePlace", () => {
  it("прибирає за назвою без огляду на регістр", () => {
    const r = removePlace([p("дім", 1), p("мама", 2)], "  МАМА ");
    expect(r.places.map((x) => x.title)).toEqual(["дім"]);
    expect(r.removed?.title).toBe("мама");
  });

  it("чого немає — те не прибирається, і це не помилка", () => {
    const r = removePlace([p("дім", 1)], "офіс");
    expect(r.places).toHaveLength(1);
    expect(r.removed).toBeNull();
  });
});

describe("primaryPlace", () => {
  it("головне — найраніше додане, а не перше в масиві", () => {
    // Порядок у сховищі може змінитися після відновлення з копії.
    const shuffled = [p("мама", 200), p("дім", 100), p("робота", 300)];
    expect(primaryPlace(shuffled)?.title).toBe("дім");
  });

  it("порожньо — немає головного", () => {
    expect(primaryPlace([])).toBeNull();
  });
});

describe("placesFromLegacy — стара точка не губиться", () => {
  it("одна точка стає місцем", () => {
    const out = placesFromLegacy({ lat: 50, lon: 30, label: "Київ" }, undefined, 7);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("Моя точка");
    expect(out[0]!.lat).toBe(50);
  });

  it("наявні місця мають перевагу над старою точкою", () => {
    const out = placesFromLegacy({ lat: 50, lon: 30, label: "Київ" }, [p("дім", 1)], 9);
    expect(out.map((x) => x.title)).toEqual(["дім"]);
  });

  it("немає нічого — порожньо, і це не помилка", () => {
    expect(placesFromLegacy(null, undefined, 1)).toEqual([]);
  });
});

describe("alertSubject — за що саме прийшло сповіщення", () => {
  const places = [p("дім", 100), p("мама", 200)];

  it("головне місце — це «ви»", () => {
    expect(alertSubject(places[0]!, places)).toBe("вас");
  });

  it("решта називається своїм імʼям", () => {
    // Саме заради цієї різниці кілька місць і потрібні.
    expect(alertSubject(places[1]!, places)).toBe("мама");
  });
});

/*
 * Правило для чужого місця свідомо суворіше за правило для себе, і це не
 * економія повідомлень. Про власну точку людина може діяти на будь-якому
 * рівні. Про дім батьків за триста кілометрів вона не може зробити нічого,
 * крім як хвилюватись, — а сповіщення без дії вчать не читати жодних.
 */
describe("decidePlaceAlert — про чуже місце лише серйозне", () => {
  const place = p("мама", 1);

  it("підвищена готовність про чуже місце не турбує", () => {
    expect(decidePlaceAlert(place, "attention", {}, 1000).send).toBe(false);
    expect(decidePlaceAlert(place, "watch", {}, 1000).send).toBe(false);
  });

  it("серйозне — кажемо", () => {
    expect(decidePlaceAlert(place, "shelter", {}, 1000).send).toBe(true);
  });

  it("двічі поспіль про те саме місце не кажемо", () => {
    const state = markPlaceAlerted({}, place, 1000);
    expect(decidePlaceAlert(place, "shelter", state, 1000 + 60_000).send).toBe(false);
    expect(decidePlaceAlert(place, "shelter", state, 1000 + PLACE_COOLDOWN_MS + 1).send).toBe(true);
  });

  it("кулдаун одного місця не глушить інше", () => {
    const state = markPlaceAlerted({}, place, 1000);
    expect(decidePlaceAlert(p("школа", 2), "shelter", state, 1000).send).toBe(true);
  });
});

describe("renderPlaceAlert / renderPlaces", () => {
  it("текст про чуже місце з першого слова не про мене", () => {
    // Сплутати «в укриття» про себе з «у Харкові серйозно» — це або зайва
    // паніка, або пропущене власне попередження.
    const t = renderPlaceAlert(p("мама", 1), "деталі", "застереження");
    expect(t).toContain("мама");
    expect(t).not.toContain("В УКРИТТЯ");
  });

  it("назва місця екранується", () => {
    expect(renderPlaceAlert(p("<b>злам</b>", 1), "д", "з")).toContain("&lt;b&gt;");
  });

  it("порожній перелік пояснює, навіщо це", () => {
    const t = renderPlaces([]);
    expect(t).toContain("/place мама Харків");
  });

  it("перелік позначає головне місце", () => {
    const t = renderPlaces([p("дім", 100), p("мама", 200)]);
    expect(t).toContain("ваша точка");
    expect(t).toContain("мама");
  });
});

describe("власний радіус місця", () => {
  it("без свого радіуса діє радіус людини", () => {
    // Нове поле не має нічого міняти тим, хто про нього не знає.
    expect(placeRadiusKm(p("дім"), 50)).toBe(50);
  });

  it("свій радіус переважає", () => {
    // Навколо дачі поле, навколо дому — місто.
    expect(placeRadiusKm({ ...p("дача"), radiusKm: 30 }, 50)).toBe(30);
  });

  it("нуль не вважається радіусом", () => {
    expect(placeRadiusKm({ ...p("дім"), radiusKm: 0 }, 50)).toBe(50);
  });
});

describe("parsePlaceTail", () => {
  it("без числа — саме лише місто", () => {
    expect(parsePlaceTail("Кривий Ріг")).toEqual({ query: "Кривий Ріг" });
  });

  it("останнє число — радіус", () => {
    expect(parsePlaceTail("Ірпінь 30")).toEqual({ query: "Ірпінь", radiusKm: 30 });
  });

  it("число поза межами лишається частиною назви", () => {
    /*
     * «Слобожанське 5» не має перетворитись на «Слобожанське» з радіусом
     * пʼять кілометрів: таких радіусів наші дані все одно не розрізняють.
     */
    expect(parsePlaceTail("Слобожанське 5")).toEqual({ query: "Слобожанське 5" });
    expect(parsePlaceTail("Село 999")).toEqual({ query: "Село 999" });
  });
});
