import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { oblastOf, renderChannelPost } from "./channel-post";

function threat(p: Partial<Threat>): Threat {
  return {
    id: Math.random().toString(36).slice(2),
    name: "Ціль",
    lat: 50,
    lon: 30,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    ...p,
  };
}

describe("oblastOf", () => {
  it("координата Києва → м. Київ", () => {
    expect(oblastOf(50.45, 30.52)).toBe("м. Київ");
  });
  it("координата Миколаєва → Миколаївщина", () => {
    expect(oblastOf(46.97, 32.0)).toBe("Миколаївщина");
  });
});

describe("renderChannelPost", () => {
  it("порожньо в небі — постити нічого", () => {
    expect(renderChannelPost([])).toBeNull();
  });

  it("рахує однотипні цілі однією фразою «ванёк»-регістру", () => {
    const post = renderChannelPost([
      threat({ lat: 51.0, lon: 34.5, type: "shahed" }),
      threat({ lat: 51.1, lon: 34.6, type: "shahed" }),
      threat({ lat: 51.2, lon: 34.7, type: "shahed" }),
    ])!;
    expect(post.text).toContain("3 мопеда");
    expect(post.targets).toBe(3);
  });

  it("додає курс, коли він відомий", () => {
    const post = renderChannelPost([threat({ lat: 49.0, lon: 33.0, type: "shahed", heading: 0 })])!;
    expect(post.text).toContain("курсом на север");
  });

  it("«может быть громко», коли ціль іде на місто поруч", () => {
    // ціль трохи південніше Полтави (49.59,34.55), курс 0° = на неї
    const post = renderChannelPost([
      threat({ lat: 49.3, lon: 34.55, type: "shahed", heading: 0 }),
    ])!;
    expect(post.text).toContain("может быть громко: Полтавщина");
  });

  it("шапка веде найгострішим: ракета важливіша за мопед", () => {
    const post = renderChannelPost([
      threat({ lat: 51, lon: 34.5, type: "shahed" }),
      threat({ lat: 50, lon: 30, type: "missile" }),
    ])!;
    expect(post.text.startsWith("🚀")).toBe(true);
    expect(post.text.toLowerCase()).toContain("ракет");
  });

  it("без ракет шапка про шахеди", () => {
    const post = renderChannelPost([threat({ lat: 51, lon: 34.5, type: "shahed" })])!;
    expect(post.text.startsWith("🛸")).toBe(true);
  });

  it("значок типу і загальний лік у пості", () => {
    const post = renderChannelPost([
      threat({ lat: 51, lon: 34.5, type: "shahed" }),
      threat({ lat: 51.1, lon: 34.6, type: "shahed" }),
    ])!;
    expect(post.text).toContain("🛸");
    expect(post.text).toContain("всего в небе: 2");
  });

  it("count (згадки в OSINT) НЕ роздуває кількість цілей", () => {
    // Одна ціль із 17 згадок — це ОДИН об'єкт, а не «17 мопедов». Саме так
    // канал розходився з картою й писав фейкові числа.
    const post = renderChannelPost([threat({ lat: 46.6, lon: 32.6, type: "shahed", count: 17 })])!;
    expect(post.text).toContain("1 мопед");
    expect(post.text).not.toContain("17");
    expect(post.targets).toBe(1);
  });

  it("масований наліт: тіло обмежене, підпис бачить усе", () => {
    const post = renderChannelPost(
      [
        threat({ lat: 51, lon: 34.5, type: "shahed" }),
        threat({ lat: 46.97, lon: 32.0, type: "shahed" }),
      ],
      { maxOblasts: 1 },
    )!;
    // Показано лише одну область у тілі, решта згорнута.
    expect(post.text).toContain("…и ещё 1 область");
    // Але дедуп-підпис усе одно містить обидві.
    expect(post.signature.split("|").length).toBe(2);
  });

  it("живе оновлення: веде зміну, а не повтор тієї самої картини", () => {
    const first = renderChannelPost([threat({ lat: 46.6, lon: 32.6, type: "shahed" })])!;
    // Та сама картина вдруге — несуттєво, постити не варто.
    const same = renderChannelPost([threat({ lat: 46.6, lon: 32.6, type: "shahed" })], {
      previous: first.snapshot,
    })!;
    expect(same.material).toBe(false);

    // З'явилась нова область — суттєво, і в тексті видно, що саме змінилось.
    const grown = renderChannelPost(
      [
        threat({ lat: 46.6, lon: 32.6, type: "shahed" }),
        threat({ lat: 49.9, lon: 36.2, type: "shahed" }),
      ],
      { previous: first.snapshot },
    )!;
    expect(grown.material).toBe(true);
    expect(grown.text).toContain("🆕");
  });

  it("ескалація до ракет — завжди суттєво", () => {
    const drones = renderChannelPost([threat({ lat: 46.6, lon: 32.6, type: "shahed" })])!;
    const rockets = renderChannelPost(
      [
        threat({ lat: 46.6, lon: 32.6, type: "shahed" }),
        threat({ lat: 47.8, lon: 35.1, type: "missile" }),
      ],
      { previous: drones.snapshot },
    )!;
    expect(rockets.material).toBe(true);
    expect(rockets.text).toContain("⚠️");
  });

  it("однакова картина дає однаковий підпис (дедуп)", () => {
    const a = renderChannelPost([threat({ lat: 51, lon: 34.5, type: "shahed" })])!;
    const b = renderChannelPost([threat({ lat: 51, lon: 34.5, type: "shahed" })])!;
    expect(a.signature).toBe(b.signature);
  });

  it("інша картина — інший підпис", () => {
    const a = renderChannelPost([threat({ lat: 51, lon: 34.5, type: "shahed" })])!;
    const b = renderChannelPost([
      threat({ lat: 51, lon: 34.5, type: "shahed" }),
      threat({ lat: 51, lon: 34.5, type: "missile" }),
    ])!;
    expect(a.signature).not.toBe(b.signature);
  });
});
