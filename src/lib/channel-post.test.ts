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
