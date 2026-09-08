import type {
  AnalystCase,
  AnalyticsResponse,
  AttachFindingResponse,
  AuditResponse,
  GraphSnapshot,
  HealthResponse,
  IngestResult,
  InvestigationResult,
  PathsResponse,
  SessionResponse,
  StructuredIngestResult,
  StructuredMapping,
} from "./types";

/**
 * Client for the Sovereign Analyst platform API.
 *
 * Two rules this file exists to enforce:
 *
 * 1. The API key is sent as `Authorization: Bearer <key>` and nothing else.
 *    The console never sends a `clearance` field on a read — the server
 *    resolves clearance from the key (core/security/ApiKeyAuth.ts). A UI that
 *    let the user pick their own clearance would recreate exactly the hole
 *    that mechanism closed.
 * 2. Every non-2xx response becomes an ApiError carrying the server's own
 *    message, so the UI can show the real reason (401 unknown key, 400 bad
 *    mapping, 403 guardrail) instead of a generic failure.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when the key is missing or not recognised by the server. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * Empty by default: the platform API serves this build from its own origin in
 * production, and Vite proxies /api/platform to it in development. Set
 * VITE_API_BASE_URL only when the console is deployed apart from the API.
 */
const BASE_URL = (import.meta.env["VITE_API_BASE_URL"] ?? "").replace(/\/$/, "");

const API_KEY_STORAGE = "palanter.apiKey";

export function getStoredApiKey(): string {
  // This module is imported during server-side rendering too, where there is
  // no localStorage at all — so the window check is load-bearing, not defensive
  // padding. Private windows and blocked site-data additionally throw on
  // access rather than returning null; an unusable store is the same as an
  // empty one here.
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(API_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function setStoredApiKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    if (key) window.localStorage.setItem(API_KEY_STORAGE, key);
    else window.localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // Non-fatal: the key still works for this page load, it just will not be
    // remembered on the next one.
  }
}

async function request<T>(
  path: string,
  apiKey: string,
  init?: Omit<RequestInit, "body"> & { body?: unknown },
): Promise<T> {
  const { body, ...rest } = init ?? {};
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...((rest.headers as Record<string, string> | undefined) ?? {}),
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...rest,
      headers,
      // Under exactOptionalPropertyTypes an explicit `undefined` is not the
      // same as an absent key, and RequestInit.body does not accept it — so
      // the property is spread in only when there is a body to send.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new ApiError(
      0,
      `Cannot reach the platform API${BASE_URL ? ` at ${BASE_URL}` : ""}. Is it running (npm run dev:platform)? ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 400) };
    }
  }

  if (!response.ok) {
    const message =
      (payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : "") || `${response.status} ${response.statusText}`;
    throw new ApiError(response.status, message);
  }

  return payload as T;
}

export const api = {
  /** Public — deliberately outside the API-key gate, for liveness checks. */
  health: () => request<HealthResponse>("/api/platform/health", ""),

  /** Resolves the caller's own clearance from their key, server-side. */
  session: (apiKey: string) => request<SessionResponse>("/api/platform/session", apiKey),

  graph: (apiKey: string) => request<GraphSnapshot>("/api/platform/graph", apiKey),

  audit: (apiKey: string) => request<AuditResponse>("/api/platform/audit", apiKey),

  /** Centrality, explainable risk and duplicate candidates over the caller's view. */
  analytics: (apiKey: string) => request<AnalyticsResponse>("/api/platform/analytics", apiKey),

  cases: (apiKey: string) => request<{ cases: AnalystCase[] }>("/api/platform/cases", apiKey),

  case: (apiKey: string, id: string) =>
    request<AnalystCase>(`/api/platform/cases/${encodeURIComponent(id)}`, apiKey),

  createCase: (apiKey: string, title: string) =>
    request<AnalystCase>("/api/platform/cases", apiKey, { method: "POST", body: { title } }),

  /**
   * Runs the investigation server-side and attaches it in one call, so the
   * finding stored on the case is exactly the one the audit log records.
   */
  attachFinding: (apiKey: string, id: string, query: string) =>
    request<AttachFindingResponse>(
      `/api/platform/cases/${encodeURIComponent(id)}/findings`,
      apiKey,
      {
        method: "POST",
        body: { query },
      },
    ),

  addCaseNote: (apiKey: string, id: string, text: string) =>
    request<AnalystCase>(`/api/platform/cases/${encodeURIComponent(id)}/notes`, apiKey, {
      method: "POST",
      body: { text },
    }),

  /** Every shortest route between two entities, not just one. */
  paths: (apiKey: string, from: string, to: string) =>
    request<PathsResponse>(
      `/api/platform/paths?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      apiKey,
    ),

  investigate: (apiKey: string, query: string) =>
    request<InvestigationResult>("/api/platform/investigate", apiKey, {
      method: "POST",
      body: { query },
    }),

  ingestText: (
    apiKey: string,
    input: { text: string; source: string; sector: string; clearance: string },
  ) =>
    request<IngestResult>("/api/platform/documents", apiKey, {
      method: "POST",
      body: input,
    }),

  ingestStructured: (
    apiKey: string,
    input: {
      csv?: string;
      records?: Record<string, string>[];
      mapping: StructuredMapping;
      source: string;
      sector: string;
      clearance: string;
    },
  ) =>
    request<StructuredIngestResult>("/api/platform/documents/structured", apiKey, {
      method: "POST",
      body: input,
    }),
};
