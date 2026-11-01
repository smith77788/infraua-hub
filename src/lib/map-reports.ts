/**
 * «Тут неправильно» — скарга на конкретну ціль прямо з карти.
 *
 * ## Навіщо
 *
 * Досі помилку на карті можна було показати лише скриншотом у чат — і з нього
 * не видно, яка саме ціль, з якого джерела, з яким типом і курсом вона була в
 * ту хвилину. Користувач (опитувальник 01.11) обрав «кнопку „тут неправильно“
 * на цілі». Скарга несе знімок цілі — те, що треба, щоб знайти причину.
 *
 * Скарга — дані від будь-кого, хто відкрив карту: тому лише перелічені
 * причини, обрізані рядки й обмеження частоти. Особистих даних не збираємо.
 */

export const REPORT_REASONS = {
  type: "неправильний тип",
  duplicate: "дубль",
  ghost: "цілі тут немає",
  course: "неправильний курс",
  place: "неправильне місце",
  missing: "тут є ціль, якої нема на карті",
  other: "інше",
} as const;

export type ReportReason = keyof typeof REPORT_REASONS;

export interface MapReport {
  at: number;
  reason: ReportReason;
  /** Вільний коментар, до `MAX_NOTE` символів. */
  note: string;
  /** Знімок цілі в момент скарги (або точки на карті для `missing`). */
  target: {
    id: string;
    name: string;
    type: string;
    lat: number;
    lon: number;
    heading: number | null;
    source: string;
    sources: string[];
    lastSeen: string;
    typeFromChannels: boolean;
  };
}

const MAX_NOTE = 300;
const MAX_STR = 120;
export const MAX_REPORTS = 500;

const str = (v: unknown, max = MAX_STR): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Розбір тіла запиту. `null` — не скарга (причина невідома чи нема координат). */
export function parseReport(raw: unknown, now: number): MapReport | null {
  const d = raw as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return null;
  const reason = d["reason"];
  if (typeof reason !== "string" || !(reason in REPORT_REASONS)) return null;
  const t = (d["target"] ?? {}) as Record<string, unknown>;
  const lat = num(t["lat"]);
  const lon = num(t["lon"]);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    at: now,
    reason: reason as ReportReason,
    note: str(d["note"], MAX_NOTE),
    target: {
      id: str(t["id"]),
      name: str(t["name"]),
      type: str(t["type"], 20),
      lat,
      lon,
      heading: num(t["heading"]),
      source: str(t["source"]),
      sources: Array.isArray(t["sources"]) ? t["sources"].slice(0, 10).map((s) => str(s, 60)) : [],
      lastSeen: str(t["lastSeen"], 40),
      typeFromChannels: t["typeFromChannels"] === true,
    },
  };
}

/** Не більше `limit` скарг за годину з однієї адреси — щоб журнал не засмітили. */
export class ReportLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly limit = 20) {}
  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

/** Додати до журналу, тримаючи останні `MAX_REPORTS`. */
export function appendReport(log: readonly MapReport[], r: MapReport): MapReport[] {
  return [...log, r].slice(-MAX_REPORTS);
}

/** Короткий текст для власника в Telegram. */
export function renderReportForOwner(r: MapReport): string {
  const t = r.target;
  const lines = [
    `🚩 <b>Скарга з карти: ${REPORT_REASONS[r.reason]}</b>`,
    t.name
      ? `Ціль: ${escape(t.name)} (${escape(t.type || "—")})`
      : `Точка: ${t.lat.toFixed(3)}, ${t.lon.toFixed(3)}`,
    `Координати: ${t.lat.toFixed(3)}, ${t.lon.toFixed(3)}${t.heading !== null ? ` · курс ${Math.round(t.heading)}°` : ""}`,
    t.source
      ? `Джерело: ${escape([t.source, ...t.sources.filter((s) => s !== t.source)].join(", "))}`
      : "",
    t.typeFromChannels ? "Тип — зі слів каналу" : "",
    r.note ? `Коментар: ${escape(r.note)}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
