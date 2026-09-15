/**
 * Реплей нальоту — таймлапс ЖИВОЇ повітряної картини, а не архіву подій.
 *
 * `TimelinePlayer` прокручує 30-денне вікно подій (пожежі, землетруси,
 * інфраструктура) із сервера. Це інше: поки вкладка відкрита, ми складаємо
 * знімки самих цілей і даємо оператору перемотати останні години нальоту —
 * побачити, звідки зайшов рій і як він розвертався. Жоден монітор цієї ніші
 * так не вміє: усі показують лише «зараз».
 *
 * Уся логіка тут — чисті функції над кільцевим буфером кадрів, тож її видно в
 * тестах. Буфер живе в памʼяті браузера: після перезавантаження він порожній —
 * це чесне обмеження (реплей «з моменту відкриття»), а не збій.
 */

import type { Threat } from "./air";

export interface RaidFrame {
  /** Час знімка (ms). */
  t: number;
  /** Знімок цілей на цей момент — незмінна копія масиву з фіду. */
  threats: readonly Threat[];
}

export interface RecordOpts {
  /** Скільки історії тримаємо (default 3 год). Старіші кадри відпадають. */
  windowMs?: number;
  /** Жорсткий стель на кількість кадрів (default 500). */
  maxFrames?: number;
}

const DEFAULT_WINDOW_MS = 3 * 3600_000;
const DEFAULT_MAX_FRAMES = 500;

/**
 * Відбиток картини: набір цілей із огрубленою до ~1 км позицією. Однаковий
 * відбиток означає «нічого суттєвого не змінилось» — такий кадр не пишемо, щоб
 * буфер не роздувався від тремтіння координат між опитуваннями фіду.
 */
export function fingerprint(threats: readonly Threat[]): string {
  return threats
    .map((t) => `${t.id}|${t.lat.toFixed(2)}|${t.lon.toFixed(2)}|${t.type ?? "?"}`)
    .sort()
    .join(";");
}

/**
 * Додає знімок до буфера, якщо картина змінилась відносно останнього кадру.
 * Повертає НОВИЙ буфер (не мутує вхідний) або той самий, якщо писати нічого.
 *
 * Порожнє небо після нальоту теж кадр (реплей має показати, як усе стихло), але
 * два порожні кадри поспіль не пишемо.
 */
export function recordFrame(
  buffer: readonly RaidFrame[],
  threats: readonly Threat[],
  now: number,
  opts: RecordOpts = {},
): readonly RaidFrame[] {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;

  const last = buffer[buffer.length - 1];
  const fp = fingerprint(threats);
  // Перший кадр — тільки якщо в небі щось є (порожнім реплеєм нічого показувати).
  if (!last) {
    if (threats.length === 0) return buffer;
    return [{ t: now, threats: [...threats] }];
  }
  // Незмінна картина — не дублюємо.
  if (fingerprint(last.threats) === fp) return buffer;

  const next = [...buffer, { t: now, threats: [...threats] }];
  // Прибираємо застаріле відносно найновішого кадру, потім тримаємо стель.
  const newestT = next[next.length - 1]!.t;
  const pruned = next.filter((f) => newestT - f.t <= windowMs);
  return pruned.length > maxFrames ? pruned.slice(pruned.length - maxFrames) : pruned;
}

/** Часовий проміжок буфера, або null якщо перемотувати нема що (<2 кадрів). */
export function replaySpan(buffer: readonly RaidFrame[]): { from: number; to: number } | null {
  if (buffer.length < 2) return null;
  return { from: buffer[0]!.t, to: buffer[buffer.length - 1]!.t };
}

/**
 * Кадр на момент курсора: останній знімок із t <= cursorMs. До першого кадру
 * показуємо найраніший наявний (щоб реплей не блимав порожнечею на старті).
 */
export function frameAt(buffer: readonly RaidFrame[], cursorMs: number): RaidFrame | null {
  if (buffer.length === 0) return null;
  let chosen: RaidFrame = buffer[0]!;
  for (const f of buffer) {
    if (f.t <= cursorMs) chosen = f;
    else break;
  }
  return chosen;
}

/** Спостережений трек однієї цілі: її позиції по кадрах до курсора включно. */
export interface ReplayTrack {
  id: string;
  type: Threat["type"];
  points: { lat: number; lon: number }[];
}

/**
 * Треки, зібрані з буфера до курсора: для кожної цілі — ланцюжок реально
 * бачених позицій. Це шлях, а не стрілка: показує, як ціль справді йшла, а не
 * куди її екстраполює здогадка. Одноточкові (щойно зʼявились) — не треки.
 */
export function tracksUpTo(buffer: readonly RaidFrame[], cursorMs: number): ReplayTrack[] {
  const byId = new Map<string, ReplayTrack>();
  for (const f of buffer) {
    if (f.t > cursorMs) break;
    for (const t of f.threats) {
      const prev = byId.get(t.id);
      const pt = { lat: t.lat, lon: t.lon };
      if (!prev) {
        byId.set(t.id, { id: t.id, type: t.type, points: [pt] });
      } else {
        const tail = prev.points[prev.points.length - 1]!;
        // Не повторюємо ту саму точку (ціль стояла між кадрами).
        if (tail.lat !== pt.lat || tail.lon !== pt.lon) prev.points.push(pt);
      }
    }
  }
  return [...byId.values()].filter((tr) => tr.points.length >= 2);
}

/** Точка треку з часовою міткою — для оцінки ШВИДКОСТІ, не лише форми. */
export interface TimedPoint {
  lat: number;
  lon: number;
  /** Час фіксу (ms) — час кадру, у якому ціль була в цій позиції. */
  t: number;
}

export interface TimedTrack {
  id: string;
  type: Threat["type"];
  points: TimedPoint[];
}

/**
 * Треки з часом кожного фіксу — щоб можна було рахувати вектор швидкості, а не
 * лише малювати лінію. Той самий принцип, що й tracksUpTo (лише реально бачене,
 * без повторів позиції), але з часом кадру при кожній точці.
 */
export function timedTracks(buffer: readonly RaidFrame[]): TimedTrack[] {
  const byId = new Map<string, TimedTrack>();
  for (const f of buffer) {
    for (const t of f.threats) {
      const prev = byId.get(t.id);
      const pt: TimedPoint = { lat: t.lat, lon: t.lon, t: f.t };
      if (!prev) {
        byId.set(t.id, { id: t.id, type: t.type, points: [pt] });
      } else {
        const tail = prev.points[prev.points.length - 1]!;
        if (tail.lat !== pt.lat || tail.lon !== pt.lon) prev.points.push(pt);
      }
    }
  }
  return [...byId.values()].filter((tr) => tr.points.length >= 2);
}
