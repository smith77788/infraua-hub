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
 *
 * ## Шлях, а не крапка
 *
 * Усі монітори цієї ніші малюють позначку зі стрілкою — і читач добудовує
 * пряму лінію на своє місто. Насправді шахед крутить: заходить із півночі,
 * розвертається на схід, обходить ППО. Стрілка цього не показує, а
 * СПОСТЕРЕЖЕНИЙ трек показує, і саме він відповідає на питання «звідки воно
 * взялося й куди насправді йде».
 *
 * Трек малюється лише з того, що ми РЕАЛЬНО бачили (послідовні фікси), і
 * ніколи не добудовується вперед: продовження лінії за останню відому точку
 * було б вигаданим маршрутом із виглядом заміряного.
 */

import type { Threat, ThreatType } from "./air";
import { UA_OUTLINE } from "./ua-outline";
import { UA_OBLASTS } from "./ua-oblasts";
import { courseIsObserved, displayRadiusKm, EMPTY_QUALITY, radiusIsStated } from "./threat-quality";

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

type Proj = (lat: number, lon: number) => [number, number];

/** Пікселів на кілометр для оглядової проєкції (SCALE — px на градус широти). */
const PX_PER_KM = SCALE / 111.32;

function marker(t: Threat): string {
  return markerWith(t, project, PX_PER_KM);
}

/**
 * Позначка цілі на картинці, яку бачить канал.
 *
 * Тут виправлено дві речі, і саме тут вони важили найбільше: цю картинку
 * бачить найбільше людей з усього, що продукт робить, і бачить її швидко —
 * як факт, а не як оцінку.
 *
 * **Ореол став колом невизначеності.** Раніше це був декоративний кружок
 * сталого радіуса 11 px довкола кожної позначки. Тепер його радіус — той
 * самий, який називає джерело (від 4 до 45 км), переведений у пікселі. Тобто
 * розмите коло тепер буквально означає «ціль десь тут», і ціль із розкидом
 * 45 км більше не виглядає такою ж точною, як ціль із розкидом 4 км.
 *
 * **Припущений курс більше не малюється як спостережений.** Джерело позначає
 * частину курсів припущеними — у живій відповіді таких було вісім із
 * пʼятнадцяти, — а стрілка дрона малювалась однаково гострою для всіх. Тепер
 * припущений курс дає порожній контур замість залитого силуету: напрямок
 * видно, але видно й те, що це здогадка.
 */
function markerWith(t: Threat, proj: Proj, pxPerKm: number): string {
  const type: ThreatType = t.type ?? "unknown";
  const [x, y] = proj(t.lat, t.lon);
  const color = COLOR[type];
  const q = t.quality ?? EMPTY_QUALITY;
  const hasCourse = typeof t.heading === "number" && Number.isFinite(t.heading);
  const observed = courseIsObserved(q);

  /*
   * Радіус ореолу — заявлена невизначеність у пікселях, але не менший за саму
   * позначку: коло, менше за дрон, який у ньому стоїть, не читається як коло
   * й виглядає як брудна обводка.
   */
  const rKm = displayRadiusKm(q);
  const r = Math.max(11, Math.round(rKm * pxPerKm));
  const halo =
    `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="0.16"/>` +
    // Заявлений джерелом радіус — тонкий контур; наше припущення, коли
    // джерело промовчало, лишається без нього.
    (radiusIsStated(q)
      ? `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${color}" stroke-width="0.8" opacity="0.4"/>`
      : "");

  // Дрон зі СТРІЛКОЮ — лише коли курс відомий. Інакше не вигадуємо напрямок
  // (це й була причина «курс неправильний»): малюємо нейтральну крапку.
  if ((type === "shahed" || type === "reactive") && hasCourse) {
    const fill = observed ? color : "none";
    const width = observed ? 1.4 : 1.6;
    const stroke = observed ? "#0a0e14" : color;
    return (
      halo +
      `<g transform="translate(${x} ${y}) rotate(${Math.round(t.heading as number)}) scale(0.95)">` +
      `<path d="${DRONE}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round"/></g>`
    );
  }
  if (type === "shahed" || type === "reactive") {
    return (
      halo +
      `<circle cx="${x}" cy="${y}" r="5.5" fill="${color}" stroke="#0a0e14" stroke-width="1.4"/>`
    );
  }
  // Ракети/КАБ/інше — компактна позначка-ромб, щоб не плутати з дроном.
  return (
    halo +
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

/** Спостережений трек однієї цілі: послідовні фікси в часовому порядку. */
export interface TrackLine {
  type: ThreatType;
  points: readonly { lat: number; lon: number }[];
}

/**
 * Лінія треку: старіші ділянки бліднуть, тож напрямок руху видно без стрілки —
 * хвіст тьмяний, голова яскрава. Коротші за два фікси не малюємо: одна точка
 * це не шлях.
 */
function trackPath(track: TrackLine): string {
  if (track.points.length < 2) return "";
  const color = COLOR[track.type];
  const d = track.points
    .map((p, i) => {
      const [x, y] = project(p.lat, p.lon);
      return `${i === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
  return (
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" ` +
    `stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>`
  );
}

/**
 * Легенда просто в картинці.
 *
 * Картинку з каналу пересилають, і підпис при цьому лишається позаду: далі
 * вона живе сама по собі, у чатах, де ніхто не читав нашого тексту. Тому те,
 * без чого її можна прочитати неправильно, має бути на ній самій.
 *
 * Пояснюємо рівно дві речі, і обидві — про те, чого НЕ видно з вигляду:
 * розмите коло це розкид позиції, а порожня стрілка — курс, якого ніхто не
 * спостерігав. Решта (колір за типом) зрозуміла з підпису або неважлива.
 */
function legend(showPresumed: boolean): string {
  const x = PAD + 4;
  const y = H - PAD - 34;
  const rows = [
    `<circle cx="${x + 8}" cy="${y + 4}" r="9" fill="#ffd23f" opacity="0.16"/>` +
      `<circle cx="${x + 8}" cy="${y + 4}" r="9" fill="none" stroke="#ffd23f" stroke-width="0.8" opacity="0.4"/>` +
      `<circle cx="${x + 8}" cy="${y + 4}" r="3" fill="#ffd23f"/>` +
      `<text x="${x + 24}" y="${y + 8}" fill="#8fa3b5" font-family="sans-serif" font-size="12">` +
      `коло — розкид позиції, як його називає джерело</text>`,
  ];
  if (showPresumed) {
    rows.push(
      `<g transform="translate(${x + 8} ${y + 26}) scale(0.62)">` +
        `<path d="${DRONE}" fill="none" stroke="#ffd23f" stroke-width="1.6" stroke-linejoin="round"/></g>` +
        `<text x="${x + 24}" y="${y + 30}" fill="#8fa3b5" font-family="sans-serif" font-size="12">` +
        `порожня стрілка — курс припущений, не спостережений</text>`,
    );
  }
  return rows.join("");
}

export function situationSvg(
  threats: readonly Threat[],
  tracks: readonly TrackLine[] = [],
): string {
  const outline = UA_OUTLINE.map(([lat, lon], i) => {
    const [x, y] = project(lat, lon);
    return `${i === 0 ? "M" : "L"}${x},${y}`;
  }).join(" ");
  const oblastBorders = UA_OBLASTS.map(ringPath).join(" ");

  // Треки — ПІД позначками: свіжа позиція має лишатись найпомітнішою.
  const lines = tracks.map(trackPath).join("");
  const markers = threats.map(marker).join("");
  // Пояснення про припущений курс показуємо лише тоді, коли такі цілі справді
  // є: легенда про те, чого на картинці немає, — це шум.
  const anyPresumed = threats.some(
    (t) =>
      typeof t.heading === "number" &&
      Number.isFinite(t.heading) &&
      !courseIsObserved(t.quality ?? EMPTY_QUALITY),
  );

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#0b0f16"/>` +
    // Заливка країни, потім тонкі межі областей, потім чіткий контур зверху.
    `<path d="${outline} Z" fill="#0f1a24" stroke="none"/>` +
    `<path d="${oblastBorders}" fill="none" stroke="#2f4d5e" stroke-width="1" stroke-linejoin="round" opacity="0.9"/>` +
    `<path d="${outline} Z" fill="none" stroke="#22d3ee" stroke-width="2" stroke-linejoin="round" opacity="0.95"/>` +
    lines +
    markers +
    // Легенда лише тоді, коли є що пояснювати: підпис до значків, яких на
    // картинці немає, — це шум, а порожнє небо має читатися як порожнє.
    (threats.length ? legend(anyPresumed) : "") +
    `</svg>`
  );
}

/**
 * Растеризує обстановку в PNG. Повертає `null` за будь-якої похибки (немає
 * бінарника, збій рендера) — тоді канал шле текст без картинки, а не падає.
 */
export async function renderSituationPng(
  threats: readonly Threat[],
  tracks: readonly TrackLine[] = [],
): Promise<Buffer | null> {
  try {
    // Змінний специфікатор + @vite-ignore: бандлер (rolldown/nitro, ціль
    // Cloudflare) НЕ намагається затягнути нативний .node у збірку — інакше
    // збірка падає на бінарнику. У рантаймі це живий Node-процес (той самий,
    // де працює таймер каналу), тож require із node_modules резолвиться.
    const mod = "@resvg/resvg-js";
    const { Resvg } = (await import(/* @vite-ignore */ mod)) as typeof import("@resvg/resvg-js");
    const png = new Resvg(situationSvg(threats, tracks), {
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

/**
 * Зумована локальна карта навколо міста — для поста «ціль підходить до X».
 *
 * Власна проєкція на квадрат радіусом radiusKm довкола центра; ті самі позначки
 * цілей (лише ті, що у в'юпорті), межі областей і приціл на самому місті. Чиста
 * функція, як і situationSvg.
 */
/** Екранування тексту для SVG: назва в розмітці не має права її зламати. */
function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ZW = 800;
/**
 * Кільця відстані від центра — щоб «~10 км» у підписі було ВИДНО, а не лише
 * заявлено.
 *
 * Без них зумована карта не має метричного сенсу взагалі: людина бачить точку
 * й пляму й не може сказати, це вісім кілометрів чи вісімдесят. Радіуси
 * беремо з драбини круглих чисел, щоб підпис кільця читався з одного погляду.
 */
const RING_LADDER = [5, 10, 25, 50, 100, 200];

function distanceRings(cx: number, cy: number, pxPerKm: number, radiusKm: number): string {
  const rings = RING_LADDER.filter((km) => km < radiusKm * 0.95).slice(-3);
  return rings
    .map((km) => {
      const r = km * pxPerKm;
      return (
        `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="#3b5a6e" ` +
        `stroke-width="0.8" stroke-dasharray="3 5" opacity="0.7"/>` +
        `<text x="${cx + 3}" y="${(cy - r + 12).toFixed(1)}" fill="#6b8496" ` +
        `font-family="sans-serif" font-size="11">${km} км</text>`
      );
    })
    .join("");
}

/** Масштабна лінійка: без неї зображення не можна ні перевірити, ні переказати. */
function scaleBar(x: number, y: number, pxPerKm: number, radiusKm: number): string {
  const km = RING_LADDER.filter((k) => k <= radiusKm / 2).pop() ?? 10;
  const len = km * pxPerKm;
  return (
    `<line x1="${x}" y1="${y}" x2="${(x + len).toFixed(1)}" y2="${y}" stroke="#8fa3b5" stroke-width="2"/>` +
    `<line x1="${x}" y1="${y - 4}" x2="${x}" y2="${y + 4}" stroke="#8fa3b5" stroke-width="2"/>` +
    `<line x1="${(x + len).toFixed(1)}" y1="${y - 4}" x2="${(x + len).toFixed(1)}" y2="${y + 4}" ` +
    `stroke="#8fa3b5" stroke-width="2"/>` +
    `<text x="${x}" y="${y - 9}" fill="#8fa3b5" font-family="sans-serif" font-size="12">${km} км</text>`
  );
}

/** Північ. Дешева позначка, без якої напрямок на карті доводиться вгадувати. */
function northMark(x: number, y: number): string {
  return (
    `<path d="M${x},${y - 12} L${x + 5},${y + 4} L${x},${y} L${x - 5},${y + 4} Z" ` +
    `fill="#8fa3b5" opacity="0.85"/>` +
    `<text x="${x - 4}" y="${y + 18}" fill="#8fa3b5" font-family="sans-serif" font-size="11">Пн</text>`
  );
}

export function situationSvgZoom(
  threats: readonly Threat[],
  center: { lat: number; lon: number },
  radiusKm = 70,
  opts: {
    /** Підпис центра — назва міста. Без нього карта не каже, де це взагалі. */
    label?: string | undefined;
  } = {},
): string {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos((center.lat * Math.PI) / 180));
  const latMin = center.lat - dLat;
  const latMax = center.lat + dLat;
  const lonMin = center.lon - dLon;
  const kk = Math.cos((center.lat * Math.PI) / 180);
  const worldW = 2 * dLon * kk;
  const scale = ZW / worldW;
  const zh = Math.round(2 * dLat * scale);
  const pr: Proj = (lat, lon) => [
    Math.round((lon - lonMin) * kk * scale * 10) / 10,
    Math.round((latMax - lat) * scale * 10) / 10,
  ];
  const inView = (lat: number, lon: number) =>
    lat >= latMin - 0.3 &&
    lat <= latMax + 0.3 &&
    lon >= lonMin - 0.4 &&
    lon <= lonMin + 2 * dLon + 0.4;

  const borders = UA_OBLASTS.map((ring) => {
    return (
      ring
        .map(([lat, lon], i) => {
          const [x, y] = pr(lat, lon);
          return `${i === 0 ? "M" : "L"}${x},${y}`;
        })
        .join(" ") + " Z"
    );
  }).join(" ");

  const markers = threats
    .filter((t) => inView(t.lat, t.lon))
    .map((t) => markerWith(t, pr, scale / 111.32))
    .join("");

  const [cx, cy] = pr(center.lat, center.lon);
  const pxPerKm = scale / 111.32;
  const crosshair =
    `<circle cx="${cx}" cy="${cy}" r="9" fill="none" stroke="#67e8f9" stroke-width="1.6"/>` +
    `<line x1="${cx - 13}" y1="${cy}" x2="${cx + 13}" y2="${cy}" stroke="#67e8f9" stroke-width="1.2"/>` +
    `<line x1="${cx}" y1="${cy - 13}" x2="${cx}" y2="${cy + 13}" stroke="#67e8f9" stroke-width="1.2"/>`;

  /*
   * Підпис міста. Без нього карта не каже головного — ДЕ це. Перехрестя посеред
   * чорного поля з ледь помітною межею області не впізнає навіть той, хто в
   * цьому місті живе.
   */
  const title = opts.label
    ? `<text x="${cx + 16}" y="${cy + 5}" fill="#e6f2f8" font-family="sans-serif" ` +
      `font-size="17" font-weight="bold">${escapeXml(opts.label)}</text>`
    : "";

  /*
   * Пояснення ореолу. На знімку з проду коричнева пляма була найбільшим
   * обʼєктом кадру й не значила для читача нічого — а вона означає рівно те,
   * наскільки ми НЕ знаємо, де ціль.
   */
  const note =
    `<text x="14" y="${zh - 14}" fill="#8fa3b5" font-family="sans-serif" font-size="12">` +
    `коло довкола цілі — наскільки невідома її позиція</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ZW}" height="${zh}" viewBox="0 0 ${ZW} ${zh}">` +
    `<rect width="${ZW}" height="${zh}" fill="#0b0f16"/>` +
    `<path d="${borders}" fill="none" stroke="#2f4d5e" stroke-width="1" stroke-linejoin="round" opacity="0.9"/>` +
    distanceRings(cx, cy, pxPerKm, radiusKm) +
    crosshair +
    title +
    markers +
    scaleBar(14, zh - 34, pxPerKm, radiusKm) +
    northMark(ZW - 26, 24) +
    note +
    `</svg>`
  );
}

/** Растеризує зумовану карту в PNG; null за будь-якої похибки (як renderSituationPng). */
export async function renderZoomPng(
  threats: readonly Threat[],
  center: { lat: number; lon: number },
  radiusKm = 70,
  opts: { label?: string | undefined } = {},
): Promise<Buffer | null> {
  try {
    const mod = "@resvg/resvg-js";
    const { Resvg } = (await import(/* @vite-ignore */ mod)) as typeof import("@resvg/resvg-js");
    return new Resvg(situationSvgZoom(threats, center, radiusKm, opts), {
      background: "#0b0f16",
      fitTo: { mode: "width", value: ZW },
    })
      .render()
      .asPng();
  } catch (err) {
    console.error("zoom image failed", err);
    return null;
  }
}
