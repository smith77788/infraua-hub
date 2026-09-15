/**
 * Збирає загальнонаціональний перелік укриттів з Overpass в один файл.
 *
 * Навіщо це окремим кроком, а не запитом під час роботи: заміряно на живому
 * Overpass під час звичайного дня — той самий запит по місту віддавав
 * відповідь то за 10 секунд, то за 45, то не віддавав зовсім. Залежність, яка
 * гальмує саме тоді, коли на неї спирається кнопка «куди сховатися», для
 * аварійної функції не годиться.
 *
 * Дані статичні: станції метро й обладнані сховища не зʼявляються щогодини.
 * Тож вони збираються заздалегідь, лягають у репозиторій і віддаються миттєво.
 *
 * Запуск: node scripts/build-shelters.mjs
 */
import { writeFileSync } from "node:fs";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
];
const UA = "InfraUA-Console/1.0 (critical infrastructure situational awareness)";

/** Запити подрібнені за видом: дрібніший запит має більше шансів пройти. */
/*
 * Прямокутник країни, а НЕ `area["ISO3166-1"="UA"]`.
 *
 * Пошук площі країни змушує Overpass спершу зібрати весь кордон, і на
 * навантаженому сервері це не повертається взагалі: перша спроба цього
 * скрипта провисіла понад пів години без жодного рядка. Прямокутник дешевий,
 * а зайве за кордоном відсіюється нижче — межі України ми й так знаємо.
 */
const UA_BBOX = "44.2,22.0,52.4,40.3";

const PARTS = [
  [
    "shelter",
    `nwr["shelter_type"~"^(bomb_shelter|bomb|air_raid|civil_defense)$"](${UA_BBOX});nwr["emergency"="shelter"](${UA_BBOX});`,
  ],
  ["metro", `nwr["station"="subway"](${UA_BBOX});`],
  ["metro_entrance", `node["railway"="subway_entrance"](${UA_BBOX});`],
  ["invincibility", `nwr["name"~"[Пп]ункт.?[Нн]езламност",i](${UA_BBOX});`],
  ["underground", `nwr["amenity"="parking"]["parking"="underground"](${UA_BBOX});`],
];

async function run(body) {
  let last = null;
  for (const url of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 180_000);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": UA,
            Accept: "application/json",
          },
          body: `data=${encodeURIComponent(body)}`,
          signal: ctl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        return json.elements ?? [];
      } catch (err) {
        last = err;
        console.error(`  ${url} спроба ${attempt}: ${err.message ?? err}`);
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
  }
  throw last;
}

const out = [];
const seen = new Set();
for (const [kind, filters] of PARTS) {
  console.log(`${kind}…`);
  const elements = await run(`[out:json][timeout:170];(${filters});out center;`);
  let kept = 0;
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    const tags = el.tags ?? {};
    // Закрите для входу укриття не рятує — не возимо його з собою.
    if (tags.access === "no" || tags.access === "private") continue;
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = tags["name:uk"] ?? tags.name ?? null;
    const capacity = Number.parseInt(tags.capacity ?? "", 10);
    out.push({
      i: id,
      k: kind,
      // Координати до пʼятого знака — це близько метра; більше не має сенсу
      // й лише роздуває файл.
      a: Math.round(lat * 1e5) / 1e5,
      o: Math.round(lon * 1e5) / 1e5,
      ...(name ? { n: name } : {}),
      ...(Number.isFinite(capacity) && capacity > 0 ? { c: capacity } : {}),
    });
    kept++;
  }
  console.log(`${kept} з ${elements.length}`);
}

out.sort((x, y) => x.a - y.a || x.o - y.o);
const path = new URL("../src/data/shelters.json", import.meta.url).pathname;
writeFileSync(path, JSON.stringify(out));
console.log(`\nУсього ${out.length} точок → ${path}`);
