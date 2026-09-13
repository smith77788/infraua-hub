/**
 * Картинка повітряної обстановки для поста в канал — БЕЗ браузера.
 *
 * Малюємо власний SVG (контур України + позначки цілей) і растеризуємо його в
 * PNG через resvg (нативний, без headless-Chrome). Це надійно на Railway
 * (живий Node-процес, бінарник linux-x64-gnu) і дешево: жодного рендера
 * сторінки, лише геометрія.
 *
 * `situationSvg` — чиста функція (рядок SVG), тож її видно в тестах. Растер і
 * динамічний імпорт resvg — окремо, і будь-яка їх похибка не валить пост:
 * канал просто відправить текст без картинки.
 */

import type { Threat, ThreatType } from "./air";
import { UA_OUTLINE } from "./ua-outline";
import { UA_OBLASTS } from "./ua-oblasts";

const W = 1000;
const PAD = 24;

// Межі та проєкція — за контуром країни, щоб позначки лягали на ту саму карту.
const LATS = UA_OUTLINE.map((p) => p[0]);
const LONS = UA_OUTLINE.map((p) => p[1]);
const LAT_MIN = Math.min(...LATS);
const LAT_MAX = Math.max(...LATS);
const LON_MIN = Math.min(...LONS);
const LON_MAX = Math.max(...LONS);
const MID_LAT = (LAT_MIN + LAT_MAX) / 2;
const K = Math.cos((MID_LAT * Math.PI) / 180); // стиск довготи на цих широтах
const WORLD_W = (LON_MAX - LON_MIN) * K;
const WORLD_H = LAT_MAX - LAT_MIN;
const SCALE = (W - 2 * PAD) / WORLD_W;
const H = Math.round(WORLD_H * SCALE + 2 * PAD);

function project(lat: number, lon: number): [number, number] {
  const x = PAD + (lon - LON_MIN) * K * SCALE;
  const y = PAD + (LAT_MAX - lat) * SCALE;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

// Колір за типом — узгоджений із мапою (жовтий БпЛА, червоні ракети…).
const COLOR: Record<ThreatType, string> = {
  shahed: "#ffd23f",
  reactive: "#ff8c1a",
  cruise: "#ff6a2a",
  missile: "#ff4d4d",
  ballistic: "#ff2d2d",
  kab: "#ffb020",
  recon: "#22d3ee",
  aircraft: "#38bdf8",
  unknown: "#ffb020",
};

// Дельтакрилий силует дрона навколо початку координат, вістрям на північ.
const DRONE = "M0,-9 L8,7.5 L0,3.5 L-8,7.5 Z";

function marker(t: Threat): string {
  const type: ThreatType = t.type ?? "unknown";
  const [x, y] = project(t.lat, t.lon);
  const color = COLOR[type];
  const glow = `<circle cx="${x}" cy="${y}" r="11" fill="${color}" opacity="0.28"/>`;
  if (type === "shahed" || type === "reactive") {
    const rot = typeof t.heading === "number" && Number.isFinite(t.heading) ? t.heading : 0;
    return (
      glow +
      `<g transform="translate(${x} ${y}) rotate(${Math.round(rot)}) scale(0.95)">` +
      `<path d="${DRONE}" fill="${color}" stroke="#0a0e14" stroke-width="1.4" stroke-linejoin="round"/></g>`
    );
  }
  // Ракети/КАБ/інше — компактна позначка-ромб, щоб не плутати з дроном.
  return (
    glow +
    `<path d="M${x},${y - 8} L${x + 6},${y} L${x},${y + 8} L${x - 6},${y} Z" ` +
    `fill="${color}" stroke="#0a0e14" stroke-width="1.4" stroke-linejoin="round"/>`
  );
}

/** Рядок SVG обстановки. Чиста функція: та сама на вході — та сама на виході. */
function ringPath(ring: readonly [number, number][]): string {
  return (
    ring
      .map(([lat, lon], i) => {
        const [x, y] = project(lat, lon);
        return `${i === 0 ? "M" : "L"}${x},${y}`;
      })
      .join(" ") + " Z"
  );
}

export function situationSvg(threats: readonly Threat[]): string {
  const outline = UA_OUTLINE.map(([lat, lon], i) => {
    const [x, y] = project(lat, lon);
    return `${i === 0 ? "M" : "L"}${x},${y}`;
  }).join(" ");
  const oblastBorders = UA_OBLASTS.map(ringPath).join(" ");

  const markers = threats.map(marker).join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#0b0f16"/>` +
    // Заливка країни, потім тонкі межі областей, потім чіткий контур зверху.
    `<path d="${outline} Z" fill="#0f1a24" stroke="none"/>` +
    `<path d="${oblastBorders}" fill="none" stroke="#2f4d5e" stroke-width="1" stroke-linejoin="round" opacity="0.9"/>` +
    `<path d="${outline} Z" fill="none" stroke="#22d3ee" stroke-width="2" stroke-linejoin="round" opacity="0.95"/>` +
    markers +
    `</svg>`
  );
}

/**
 * Растеризує обстановку в PNG. Повертає `null` за будь-якої похибки (немає
 * бінарника, збій рендера) — тоді канал шле текст без картинки, а не падає.
 */
export async function renderSituationPng(threats: readonly Threat[]): Promise<Buffer | null> {
  try {
    // Змінний специфікатор + @vite-ignore: бандлер (rolldown/nitro, ціль
    // Cloudflare) НЕ намагається затягнути нативний .node у збірку — інакше
    // збірка падає на бінарнику. У рантаймі це живий Node-процес (той самий,
    // де працює таймер каналу), тож require із node_modules резолвиться.
    const mod = "@resvg/resvg-js";
    const { Resvg } = (await import(/* @vite-ignore */ mod)) as typeof import("@resvg/resvg-js");
    const png = new Resvg(situationSvg(threats), {
      background: "#0b0f16",
      fitTo: { mode: "width", value: W },
    })
      .render()
      .asPng();
    return png;
  } catch (err) {
    console.error("situation image failed", err);
    return null;
  }
}
