import { describe, expect, it } from "bun:test";

import {
  ALERT_CHANCE_THRESHOLD,
  chanceWords,
  closestApproach,
  erf,
  etaPhraseFrom,
  normalCdf,
  passChance,
} from "./approach";
import { estimateMotion, type Fix } from "./track-filter";

/** Рівний політ на північ уздовж меридіана 30°. */
function northbound(speedKmh = 180, count = 6): Fix[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: 48 + (speedKmh * ((i * 120_000) / 3_600_000)) / 111.32,
    lon: 30,
    ts: i * 120_000,
  }));
}
const state = () => estimateMotion(northbound(), 600_000, { type: "shahed" })!;

describe("математика", () => {
  it("erf збігається з табличними значеннями", () => {
    expect(erf(0)).toBeCloseTo(0, 6);
    expect(erf(0.5)).toBeCloseTo(0.5204999, 5);
    expect(erf(1)).toBeCloseTo(0.8427008, 5);
    expect(erf(2)).toBeCloseTo(0.9953223, 5);
    expect(erf(-1)).toBeCloseTo(-0.8427008, 5);
  });

  it("normalCdf дає класичні 68 / 95 відсотків", () => {
    expect(normalCdf(1) - normalCdf(-1)).toBeCloseTo(0.6827, 3);
    expect(normalCdf(2) - normalCdf(-2)).toBeCloseTo(0.9545, 3);
  });

  it("нульова похибка вироджується в порогову функцію, а не ділиться на нуль", () => {
    expect(normalCdf(5, 0, 0)).toBe(1);
    expect(normalCdf(-5, 0, 0)).toBe(0);
  });
});

describe("closestApproach", () => {
  it("ціль просто по курсу: промах нульовий, час = відстань / швидкість", () => {
    const s = state();
    const ahead = { lat: s.lat + 60 / 111.32, lon: 30 };
    const a = closestApproach(s, ahead);
    expect(a.approaching).toBe(true);
    expect(a.missKm).toBeLessThan(1);
    expect(a.etaMin!).toBeCloseTo(20, 0);
  });

  it("ціль, що вже пройшла повз, не вважається вхідною", () => {
    const s = state();
    const behind = { lat: s.lat - 40 / 111.32, lon: 30 };
    const a = closestApproach(s, behind);
    expect(a.approaching).toBe(false);
    expect(a.etaMin).toBeNull();
  });

  it("промах рахується, а не округлюється до «в секторі»", () => {
    // Саме це й ламало старий підхід: ціль у секторі ±60° вважалась вхідною,
    // хоч промине за десятки кілометрів.
    const s = state();
    const offside = { lat: s.lat + 60 / 111.32, lon: 30 + 30 / 74 };
    const a = closestApproach(s, offside);
    expect(a.missKm).toBeGreaterThan(25);
    expect(a.missKm).toBeLessThan(35);
  });

  it("віяло на траверзі ширше для далекої цілі, ніж для близької", () => {
    const s = state();
    const near = closestApproach(s, { lat: s.lat + 10 / 111.32, lon: 30 });
    const far = closestApproach(s, { lat: s.lat + 120 / 111.32, lon: 30 });
    expect(far.crossSigmaKm).toBeGreaterThan(near.crossSigmaKm);
  });
});

describe("passChance", () => {
  it("лоб у лоб — високий шанс", () => {
    const s = state();
    expect(passChance(s, { lat: s.lat + 50 / 111.32, lon: 30 }, 10)).toBeGreaterThan(0.8);
  });

  it("далеко вбік — низький, попри те що ціль наближається", () => {
    const s = state();
    const aside = { lat: s.lat + 50 / 111.32, lon: 30 + 60 / 74 };
    expect(passChance(s, aside, 10)).toBeLessThan(ALERT_CHANCE_THRESHOLD);
  });

  it("ціль віддаляється — нуль, без обчислень «про всяк випадок»", () => {
    const s = state();
    expect(passChance(s, { lat: s.lat - 30 / 111.32, lon: 30 }, 25)).toBe(0);
  });

  it("за горизонтом — нуль: це вже не оцінка руху, а ворожіння", () => {
    const s = state();
    const veryFar = { lat: s.lat + 400 / 111.32, lon: 30 };
    expect(passChance(s, veryFar, 25, 45)).toBe(0);
  });

  it("без курсу вести нема чого — нуль, а не половина", () => {
    const blind = estimateMotion([{ lat: 48, lon: 30, ts: 0 }], 60_000, { type: "shahed" })!;
    expect(passChance(blind, { lat: 49, lon: 30 }, 25)).toBe(0);
  });

  it("ширший радіус ніколи не зменшує шанс", () => {
    const s = state();
    const p = { lat: s.lat + 50 / 111.32, lon: 30 + 20 / 74 };
    expect(passChance(s, p, 25)).toBeGreaterThanOrEqual(passChance(s, p, 10));
  });
});

describe("слова замість фальшивої точності", () => {
  it("час подається діапазоном, бо швидкість відома з похибкою", () => {
    const s = state();
    const phrase = etaPhraseFrom(closestApproach(s, { lat: s.lat + 60 / 111.32, lon: 30 }))!;
    expect(phrase).toMatch(/^(~\d+ хв|\d+–\d+ хв)$/);
  });

  it("за годиною число не називається взагалі", () => {
    const s = state();
    const far = closestApproach(s, { lat: s.lat + 400 / 111.32, lon: 30 });
    expect(etaPhraseFrom(far)).toBe("понад годину");
  });

  it("ціль, що віддаляється, часу не має", () => {
    const s = state();
    expect(etaPhraseFrom(closestApproach(s, { lat: s.lat - 30 / 111.32, lon: 30 }))).toBeNull();
  });

  it("шанс словами, без третьої значущої цифри", () => {
    expect(chanceWords(0.9)).toContain("дуже ймовірно");
    expect(chanceWords(0.5)).toContain("імовірно");
    expect(chanceWords(0.25)).toContain("може");
    expect(chanceWords(0.05)).toContain("промине");
  });
});
