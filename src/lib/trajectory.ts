/**
 * Прогноз траєкторії за СПОСТЕРЕЖЕНИМ рухом — куди насправді йде ціль.
 *
 * ## Чим це відрізняється від усього, що вже є
 *
 * `swarm.ts` і `threat-eta.ts` проєктують за полем `heading` з OSINT — тим, що
 * хтось вписав у повідомлення. Тут ми його НЕ використовуємо взагалі: вектор
 * швидкості (і напрямок, І величину) рахується з послідовних реально бачених
 * фіксів методом найменших квадратів. Шахед крутить, розвертається, обходить
 * ППО — і саме зміщення між фіксами каже, куди він іде, чесніше за будь-який
 * задекларований курс.
 *
 * ## Чесність невизначеності
 *
 * Прогноз без похибки — брехня з виглядом точності. Кожна проєкція несе радіус
 * невизначеності, що росте з часом і падає з якістю підгонки (R², кількість
 * точок, тривалість спостереження). Мало даних або хаотичний рух → низька
 * впевненість, і показувати таке як маршрут не можна.
 *
 * ## Межа
 *
 * Далі це вже не покращити наявними даними: точніший трек потребує РАДАРНИХ
 * вимірів (Калман на реальних сенсорах, багатогіпотезне трекінг), а не OSINT-
 * позначок «десь над районом». Тому лінійна модель тут — не спрощення, а стеля
 * того, що чесно витиснути з наявного.
 */

const M_PER_DEG_LAT = 110_574;
const R_KM = 6371;

export interface TrackFix {
  lat: number;
  lon: number;
  /** Час фіксу (ms). */
  t: number;
}

/**
 * Перетворює трек цілі (trail від джерела: lat/lon + ISO-час) на фікси для
 * оцінки швидкості. Це КРАЩЕ джерело за клієнтський буфер: доступне одразу на
 * першому ж завантаженні й щільніше. Биті мітки часу відкидаємо, решту — за
 * часом.
 */
export function trailToFixes(
  trail: readonly { lat: number; lon: number; t: string }[],
): TrackFix[] {
  const out: TrackFix[] = [];
  for (const p of trail) {
    const ms = Date.parse(p.t);
    if (Number.isFinite(ms)) out.push({ lat: p.lat, lon: p.lon, t: ms });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface Velocity {
  /** Курс руху, ° (0=Пн, 90=Сх) — з реального зміщення, не з поля heading. */
  bearingDeg: number;
  /** Швидкість, км/год. */
  speedKmh: number;
  /** Впевненість [0..1]: якість підгонки × кількість × тривалість. */
  confidence: number;
}

export interface Projection {
  lat: number;
  lon: number;
  /** Радіус невизначеності на цей момент, км. */
  uncertaintyKm: number;
  /** Скільки хвилин уперед від останнього фіксу. */
  minutes: number;
}

export interface TrajectoryOptions {
  /** Вікно спостереження: беремо фікси не старші за це від останнього (ms). */
  windowMs?: number;
  /** Мінімальна тривалість спостереження для довіри, с. */
  minSpanSec?: number;
}

const DEFAULT_WINDOW_MS = 15 * 60_000;
const DEFAULT_MIN_SPAN_SEC = 45;
// Правдоподібні швидкості повітряних цілей, км/год. Поза діапазоном — це шум
// позначок (стрибок між віддаленими фіксами), а не рух: прогноз не будуємо.
const MIN_SPEED_KMH = 20;
const MAX_SPEED_KMH = 1500;

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

/**
 * Оцінює вектор швидкості з треку. `null`, коли даних замало або рух
 * неправдоподібний (краще мовчати, ніж показати вигаданий маршрут).
 *
 * Метод: локальна рівнокутна проєкція навколо першого фіксу вікна (метри),
 * підгонка схід(t) і північ(t) прямими через початок (перший фікс = початок при
 * dt=0), швидкість — нахили цих прямих. R² по обох осях дає якість.
 */
export function estimateVelocity(
  fixes: readonly TrackFix[],
  opts: TrajectoryOptions = {},
): Velocity | null {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const minSpanSec = opts.minSpanSec ?? DEFAULT_MIN_SPAN_SEC;

  const sorted = [...fixes].sort((a, b) => a.t - b.t);
  const last = sorted[sorted.length - 1];
  if (!last) return null;
  const win = sorted.filter((f) => last.t - f.t <= windowMs);
  if (win.length < 2) return null;

  const p0 = win[0]!;
  const spanSec = (last.t - p0.t) / 1000;
  if (spanSec < minSpanSec) return null;

  // Метрів на градус довготи на цій широті (екватор ≈ 111 320 м, стискається cos).
  const kLon = Math.cos((p0.lat * Math.PI) / 180) * 111_320;
  let sTT = 0;
  let sTE = 0;
  let sTN = 0;
  const rows: { dt: number; e: number; n: number }[] = [];
  for (const f of win) {
    const dt = (f.t - p0.t) / 1000; // с
    const e = (f.lon - p0.lon) * kLon;
    const n = (f.lat - p0.lat) * M_PER_DEG_LAT;
    rows.push({ dt, e, n });
    sTT += dt * dt;
    sTE += dt * e;
    sTN += dt * n;
  }
  if (sTT === 0) return null;
  const vE = sTE / sTT; // м/с на схід
  const vN = sTN / sTT; // м/с на північ
  const speedMs = Math.hypot(vE, vN);
  const speedKmh = speedMs * 3.6;
  if (speedKmh < MIN_SPEED_KMH || speedKmh > MAX_SPEED_KMH) return null;

  // R²: наскільки прямолінійний рух пояснює спостережене зміщення.
  let ssRes = 0;
  let ssTot = 0;
  for (const r of rows) {
    const ep = vE * r.dt;
    const np = vN * r.dt;
    ssRes += (r.e - ep) ** 2 + (r.n - np) ** 2;
    ssTot += r.e ** 2 + r.n ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  const pointsFactor = Math.min(1, win.length / 4);
  const spanFactor = Math.min(1, spanSec / 180);
  const confidence = Math.max(0, Math.min(1, r2 * pointsFactor * spanFactor));

  let bearing = (Math.atan2(vE, vN) * 180) / Math.PI;
  if (bearing < 0) bearing += 360;

  return { bearingDeg: Math.round(bearing), speedKmh: Math.round(speedKmh), confidence };
}

export interface SwarmVector extends Velocity {
  /** Наскільки узгоджено цілі йдуть в один бік [0..1]. Низька — рій розсипаний. */
  coherence: number;
}

/**
 * Зводить вектори багатьох цілей в один — «куди йде рій». Курс — зважений
 * круговий середній (за впевненістю), тож дві цілі на схід і одна назад не дають
 * фальшивого «на північ». Довжина результанта — когерентність: близька до 1 —
 * летять разом; низька — розходяться, і про єдиний курс говорити чесно не можна.
 */
export function swarmVector(vs: readonly Velocity[]): SwarmVector | null {
  const use = vs.filter((v) => v.confidence > 0);
  if (use.length === 0) return null;
  let sSin = 0;
  let sCos = 0;
  let sSpeed = 0;
  let sW = 0;
  let sConf = 0;
  for (const v of use) {
    const w = v.confidence;
    const th = (v.bearingDeg * Math.PI) / 180;
    sSin += w * Math.sin(th);
    sCos += w * Math.cos(th);
    sSpeed += w * v.speedKmh;
    sW += w;
    sConf += v.confidence;
  }
  if (sW === 0) return null;
  let bearing = (Math.atan2(sSin, sCos) * 180) / Math.PI;
  if (bearing < 0) bearing += 360;
  return {
    bearingDeg: Math.round(bearing),
    speedKmh: Math.round(sSpeed / sW),
    confidence: Math.min(1, sConf / use.length),
    coherence: Math.hypot(sSin, sCos) / sW,
  };
}

/** Точка на відстані `km` за курсом `bearingDeg` від (lat,lon). */
function destPoint(lat: number, lon: number, bearingDeg: number, km: number): [number, number] {
  const th = (bearingDeg * Math.PI) / 180;
  const dLat = (km * Math.cos(th)) / 111.32;
  const dLon = (km * Math.sin(th)) / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lon + dLon];
}

/**
 * Проєктує ціль уперед на `minutes` за вектором. Радіус невизначеності росте з
 * часом і падає з упевненістю: за 2 хвилини при добрій підгонці — кілометри, за
 * 20 хвилин при слабкій — десятки. Це не оздоба: без нього крапка на мапі
 * читалась би як гарантія.
 */
export function projectForward(
  from: { lat: number; lon: number },
  v: Velocity,
  minutes: number,
): Projection {
  const distKm = (v.speedKmh * minutes) / 60;
  const [lat, lon] = destPoint(from.lat, from.lon, v.bearingDeg, distKm);
  // База 3 км (розмитість самої позначки) + розхід, що росте з часом і з
  // браком упевненості: піврозхил конуса від 0.05 рад (~3°) при повній
  // упевненості до 0.20 рад (~11°) при повній невпевненості.
  const spread = distKm * (0.05 + 0.15 * (1 - v.confidence));
  const uncertaintyKm = 3 + spread + minutes * 0.2 * (1 - v.confidence);
  return { lat, lon, uncertaintyKm: Math.round(uncertaintyKm * 10) / 10, minutes };
}

export interface ForecastCone {
  /** Центрлінія прогнозу: точки [lat, lon] від зараз до горизонту. */
  centerline: [number, number][];
  /** Замкнений контур коридору (конус невизначеності) для полігона. */
  ring: [number, number][];
  /** Вістря — найдальша спрогнозована точка (для мітки/ETA). */
  tip: { lat: number; lon: number };
}

/**
 * Коридор прогнозу як геометрія для карти: центрлінія + конус, що розширюється
 * з невизначеністю (та сама, що в projectForward). Не «стрілка курсу», а чесне
 * віяло: чим далі й чим менша впевненість — тим ширше.
 */
export function forecastCone(
  from: { lat: number; lon: number },
  v: Velocity,
  opts: { horizonMin?: number; stepMin?: number } = {},
): ForecastCone {
  const horizon = opts.horizonMin ?? 18;
  const step = opts.stepMin ?? 3;
  const centerline: [number, number][] = [[from.lat, from.lon]];
  const right: [number, number][] = [];
  const left: [number, number][] = [];
  let tip = { lat: from.lat, lon: from.lon };
  for (let m = step; m <= horizon; m += step) {
    const p = projectForward(from, v, m);
    centerline.push([p.lat, p.lon]);
    const [rLat, rLon] = destPoint(p.lat, p.lon, v.bearingDeg + 90, p.uncertaintyKm);
    const [lLat, lLon] = destPoint(p.lat, p.lon, v.bearingDeg - 90, p.uncertaintyKm);
    right.push([rLat, rLon]);
    left.push([lLat, lLon]);
    tip = { lat: p.lat, lon: p.lon };
  }
  // Контур: від носія праворуч уперед до вістря, потім ліворуч назад.
  const ring: [number, number][] = [[from.lat, from.lon], ...right, ...left.reverse()];
  return { centerline, ring, tip };
}

export interface ReachedPlace {
  name: string;
  etaMin: number;
  /** Наскільки близько центрлінія проходить від міста, км. */
  missKm: number;
}

/**
 * Які орієнтири траєкторія накриває за `horizonMin`. Для кожного місця шукаємо
 * момент НАЙБЛИЖЧОГО проходження (мінімум відстані центрлінії до міста), і якщо
 * тоді центрлінія лягає в коридор «конус невизначеності + радіус міста» — це «на
 * курсі», з ETA цього найближчого проходження. Раніший ETA сильніший.
 *
 * Саме найближче проходження, а не перший дотик зростаючого конуса: інакше
 * далеке місто «входить» у конус ще тоді, коли той величезний, і ETA виходить
 * оманливо ранній — небезпечно в панелі, яку читають як «встигну/не встигну».
 */
export function reachedPlaces(
  from: { lat: number; lon: number },
  v: Velocity,
  places: readonly { name: string; lat: number; lon: number }[],
  opts: { horizonMin?: number; stepMin?: number; cityRadiusKm?: number } = {},
): ReachedPlace[] {
  const horizon = opts.horizonMin ?? 30;
  const step = opts.stepMin ?? 2;
  const cityRadiusKm = opts.cityRadiusKm ?? 25;

  const out: ReachedPlace[] = [];
  for (const c of places) {
    let bestMiss = Infinity;
    let bestM = 0;
    let bestUnc = 0;
    for (let m = step; m <= horizon; m += step) {
      const p = projectForward(from, v, m);
      const miss = haversineKm(p.lat, p.lon, c.lat, c.lon);
      if (miss < bestMiss) {
        bestMiss = miss;
        bestM = m;
        bestUnc = p.uncertaintyKm;
      }
    }
    if (bestMiss <= bestUnc + cityRadiusKm) {
      out.push({ name: c.name, etaMin: bestM, missKm: Math.round(bestMiss) });
    }
  }
  return out.sort((a, b) => a.etaMin - b.etaMin);
}
