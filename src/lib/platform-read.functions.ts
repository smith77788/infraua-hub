import { createServerFn } from "@tanstack/react-start";

import { isPlatformConfigured, platformFetch } from "./platform-client";

/**
 * Читання аналітики з платформи в консоль.
 *
 * Досі інтеграція була майже однобічною: консоль надсилала факти в платформу,
 * а назад читала лише справи. Уся аналітика графа — оцінка ризику з поясненням,
 * центральність, розвʼязання дублів, зміни в часі, конфлікти інтересів — жила
 * на платформі, але в консолі її не було видно. Ці серверні функції під'єднують
 * її: платформа рахує на своєму сховищі (том Railway), консоль лише показує.
 *
 * Ключ не потрапляє в браузер — виклики серверні (див. platform-client).
 * Незаданий звʼязок — штатний стан: `configured:false`, і розділ ховається.
 */

export interface RiskSignal {
  label: string;
  reason: string;
  contribution: number;
}
export interface RiskItem {
  id: string;
  label: string;
  type: string;
  score: number;
  band: "low" | "elevated" | "high" | "severe";
  signals: RiskSignal[];
}
export interface NamedScore {
  id: string;
  label: string;
  score: number;
}
export interface PlatformAnalytics {
  totals: {
    nodes: number;
    edges: number;
    components: number;
    largestComponent: number;
    isolated: number;
  };
  risk: RiskItem[];
  riskBands: { severe: number; high: number; elevated: number; low: number };
  centrality: NamedScore[];
  connectivity: NamedScore[];
  /** Скільки пар сутностей платформа вважає кандидатами на злиття (дублі). */
  duplicateCount: number;
}

export interface AnalyticsResult {
  configured: boolean;
  ok: boolean;
  error?: string;
  data?: PlatformAnalytics;
}

export const getPlatformAnalytics = createServerFn({ method: "GET" }).handler(
  async (): Promise<AnalyticsResult> => {
    if (!isPlatformConfigured()) return { configured: false, ok: false };
    const res = await platformFetch("/api/platform/analytics");
    if (!res.ok) return { configured: true, ok: false, ...(res.error ? { error: res.error } : {}) };
    const b = (res.body ?? {}) as Partial<PlatformAnalytics> & { duplicateCandidates?: unknown[] };
    return {
      configured: true,
      ok: true,
      data: {
        totals: b.totals ?? {
          nodes: 0,
          edges: 0,
          components: 0,
          largestComponent: 0,
          isolated: 0,
        },
        risk: Array.isArray(b.risk) ? b.risk : [],
        riskBands: b.riskBands ?? { severe: 0, high: 0, elevated: 0, low: 0 },
        centrality: Array.isArray(b.centrality) ? b.centrality : [],
        connectivity: Array.isArray(b.connectivity) ? b.connectivity : [],
        duplicateCount: Array.isArray(b.duplicateCandidates) ? b.duplicateCandidates.length : 0,
      },
    };
  },
);

export interface GraphChange {
  totals: { added: number; removed: number; changed: number };
}
export interface DiffResult {
  configured: boolean;
  ok: boolean;
  error?: string;
  data?: GraphChange;
}

/**
 * Зміни в графі між двома точками історії. `from` обовʼязковий — ISO-час або
 * номер ревізії. Це темпоральний зріз обстановки: що додалось/зникло/змінилось.
 */
export const getPlatformGraphDiff = createServerFn({ method: "GET" })
  .validator((input: unknown): { from: string; to?: string } => {
    const v = (input ?? {}) as { from?: unknown; to?: unknown };
    return {
      from: typeof v.from === "string" ? v.from : "",
      ...(typeof v.to === "string" ? { to: v.to } : {}),
    };
  })
  .handler(async ({ data }): Promise<DiffResult> => {
    if (!isPlatformConfigured()) return { configured: false, ok: false };
    if (!data.from) return { configured: true, ok: false, error: "Не вказано початок періоду." };
    const qs = new URLSearchParams({ from: data.from, ...(data.to ? { to: data.to } : {}) });
    const res = await platformFetch(`/api/platform/graph/diff?${qs.toString()}`);
    if (!res.ok) return { configured: true, ok: false, ...(res.error ? { error: res.error } : {}) };
    const b = (res.body ?? {}) as { totals?: GraphChange["totals"] };
    return {
      configured: true,
      ok: true,
      data: { totals: b.totals ?? { added: 0, removed: 0, changed: 0 } },
    };
  });

export interface ConflictsResult {
  configured: boolean;
  ok: boolean;
  error?: string;
  data?: { confirmed: number; unconfirmed: number; commonOwnership: number };
}

/** Конфлікти інтересів у закупівлях/реєстрі — окремий, навмисний запит. */
export const getPlatformConflicts = createServerFn({ method: "GET" }).handler(
  async (): Promise<ConflictsResult> => {
    if (!isPlatformConfigured()) return { configured: false, ok: false };
    const res = await platformFetch("/api/platform/analytics/conflicts");
    if (!res.ok) return { configured: true, ok: false, ...(res.error ? { error: res.error } : {}) };
    const b = (res.body ?? {}) as { totals?: ConflictsResult["data"] };
    return {
      configured: true,
      ok: true,
      data: b.totals ?? { confirmed: 0, unconfirmed: 0, commonOwnership: 0 },
    };
  },
);

export interface RegionSurge {
  region: string;
  current: number;
  baseline: number;
  ratio: number;
  level: "normal" | "elevated" | "surge";
  samples: number;
  updatedAt: string | null;
}

export interface AirSurge {
  current: number;
  baseline: number;
  ratio: number;
  level: "normal" | "elevated" | "surge";
  samples: number;
  updatedAt: string | null;
  /** Області зі сплеском/підвищенням, найгостріші перші (порожньо — тиша). */
  regions?: RegionSurge[];
}

export interface AirSurgeResult {
  configured: boolean;
  ok: boolean;
  error?: string;
  data?: AirSurge;
}

/** Пара «область → кількість» для надсилання розбивки активності. */
export interface RegionCount {
  region: string;
  count: number;
}

/**
 * Записує поточну кількість активних повітряних цілей у платформу й повертає
 * оцінку сплеску відносно бази, що живе на постійному томі Railway.
 *
 * Кросдевайсний, багатоденний двійник клієнтського `useAirActivityHistory`:
 * той тримає історію на пристрої (localStorage), цей — на сервері, тож база
 * переживає перезавантаження й спільна для всіх, хто дивиться консоль. Коли
 * платформа не під'єднана — `configured:false`, і консоль лишається на
 * локальній історії.
 */
export const reportAirActivity = createServerFn({ method: "POST" })
  .validator((input: unknown): { count: number; regions: RegionCount[] } => {
    const v = (input ?? {}) as { count?: unknown; regions?: unknown };
    const c = Number(v.count);
    const regions = Array.isArray(v.regions)
      ? v.regions
          .map((r) => {
            const region = (r as { region?: unknown })?.region;
            const rc = Number((r as { count?: unknown })?.count);
            return typeof region === "string" && region && Number.isFinite(rc) && rc >= 0
              ? { region, count: Math.round(rc) }
              : null;
          })
          .filter((x): x is RegionCount => x !== null)
      : [];
    return { count: Number.isFinite(c) && c >= 0 ? Math.round(c) : 0, regions };
  })
  .handler(async ({ data }): Promise<AirSurgeResult> => {
    if (!isPlatformConfigured()) return { configured: false, ok: false };
    const res = await platformFetch("/api/platform/ingest/air", {
      method: "POST",
      body: JSON.stringify({ count: data.count, regions: data.regions }),
    });
    if (!res.ok) return { configured: true, ok: false, ...(res.error ? { error: res.error } : {}) };
    return { configured: true, ok: true, data: res.body as AirSurge };
  });
