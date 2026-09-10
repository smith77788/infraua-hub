import { createServerFn } from "@tanstack/react-start";

import {
  isPinnable,
  PIN_MAX,
  platformEntityId,
  validateNote,
  validateTitle,
  type AnalystCase,
  type PinnableFacility,
} from "./cases";

/**
 * Справи через платформу.
 *
 * Самі справи там і живуть: рівні доступу, відсіки «need-to-know», журнал
 * аудиту. Консоль лише показує їх і додає записи — і робить це серверними
 * функціями, бо платформа автентифікує bearer-ключем, а ключ у браузері
 * означає ключ у кожного відвідувача.
 *
 * Незаданий звʼязок — штатний стан: консоль самодостатня, і тоді розділ справ
 * просто не показується.
 */

interface PlatformConfig {
  base: string;
  key: string;
}

function config(): PlatformConfig | null {
  const base = process.env["PLATFORM_API_URL"];
  const key = process.env["PLATFORM_API_KEY"];
  if (!base || !key) return null;
  return { base: base.replace(/\/$/, ""), key };
}

export interface CasesResult {
  /** false — звʼязок із платформою не налаштований, і це не помилка. */
  configured: boolean;
  ok: boolean;
  cases?: AnalystCase[];
  case?: AnalystCase;
  error?: string;
}

async function platformFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const cfg = config();
  if (!cfg) return { ok: false, status: 0, body: null, error: "not configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  try {
    const response = await fetch(`${cfg.base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.key}`,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    // Тіло може бути HTML від проксі, а не JSON платформи.
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
      ...(response.ok ? {} : { error: `${response.status}: ${text.slice(0, 200)}` }),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export const listCases = createServerFn({ method: "GET" }).handler(
  async (): Promise<CasesResult> => {
    if (!config()) return { configured: false, ok: false };
    const res = await platformFetch("/api/platform/cases");
    if (!res.ok) return { configured: true, ok: false, ...(res.error ? { error: res.error } : {}) };
    const cases = (res.body as { cases?: AnalystCase[] } | null)?.cases ?? [];
    return { configured: true, ok: true, cases };
  },
);

export const createCase = createServerFn({ method: "POST" })
  .validator((input: unknown): { title: string } => {
    const title = (input as { title?: unknown } | undefined)?.title;
    return { title: typeof title === "string" ? title : "" };
  })
  .handler(async ({ data }): Promise<CasesResult> => {
    if (!config()) return { configured: false, ok: false };
    // Перевірка тут, а не лише у вигляді: серверна функція — це теж вхід, і
    // покладатися на те, що виклик прийшов саме з нашої форми, не можна.
    const title = validateTitle(data.title);
    if (!title.ok)
      return { configured: true, ok: false, ...(title.error ? { error: title.error } : {}) };

    const res = await platformFetch("/api/platform/cases", {
      method: "POST",
      body: JSON.stringify({ title: title.value }),
    });
    if (!res.ok) return { configured: true, ok: false, ...(res.error ? { error: res.error } : {}) };
    return { configured: true, ok: true, case: res.body as AnalystCase };
  });

export const addCaseNote = createServerFn({ method: "POST" })
  .validator((input: unknown): { id: string; text: string } => {
    const v = (input ?? {}) as { id?: unknown; text?: unknown };
    return {
      id: typeof v.id === "string" ? v.id : "",
      text: typeof v.text === "string" ? v.text : "",
    };
  })
  .handler(async ({ data }): Promise<CasesResult> => {
    if (!config()) return { configured: false, ok: false };
    if (!data.id) return { configured: true, ok: false, error: "Не вказано справу." };
    const note = validateNote(data.text);
    if (!note.ok)
      return { configured: true, ok: false, ...(note.error ? { error: note.error } : {}) };

    const res = await platformFetch(`/api/platform/cases/${encodeURIComponent(data.id)}/notes`, {
      method: "POST",
      body: JSON.stringify({ text: note.value }),
    });
    if (!res.ok) return { configured: true, ok: false, ...(res.error ? { error: res.error } : {}) };
    return { configured: true, ok: true, case: res.body as AnalystCase };
  });

/**
 * Приколоти обʼєкти консолі до справи.
 *
 * Платформа колить лише те, що вже є в її графі й видиме викликачеві — і це
 * правильно: інакше рівень доступу справи піднімався б за твердженням клієнта
 * про класифікацію того, чого він не бачить. Але обʼєкти консолі приходять з
 * OSM і в графі платформи їх зазвичай немає, тож голий `pin` за
 * ідентифікатором відповідав би 404 на кожен перший клік.
 *
 * Тому «приколоти» — це два кроки в одному: спершу обʼєкт потрапляє в
 * платформу штатним прийомом даних (`upsertNode`, тож повтор нічого не
 * дублює), потім колеться. Це не обхід перевірки: рівень доступу все одно
 * обмежений рівнем ключа консолі, а вузол після прийому справді існує й
 * справді видимий.
 */
export const pinToCase = createServerFn({ method: "POST" })
  .validator((input: unknown): { id: string; facilities: PinnableFacility[] } => {
    const v = (input ?? {}) as { id?: unknown; facilities?: unknown };
    const facilities = Array.isArray(v.facilities)
      ? v.facilities.filter(isPinnable).slice(0, PIN_MAX)
      : [];
    return { id: typeof v.id === "string" ? v.id : "", facilities };
  })
  .handler(async ({ data }): Promise<CasesResult> => {
    if (!config()) return { configured: false, ok: false };
    if (!data.id || data.facilities.length === 0) {
      return { configured: true, ok: false, error: "Немає що приколоти." };
    }

    const ingest = await platformFetch("/api/platform/ingest/infraua", {
      method: "POST",
      body: JSON.stringify({
        payload: { facilities: data.facilities, retrievedAt: new Date().toISOString() },
        source: "infraua-console",
        sector: "infrastructure",
      }),
    });
    if (!ingest.ok) {
      return {
        configured: true,
        ok: false,
        error: `Не вдалося передати обʼєкт у платформу — ${ingest.error ?? "невідома помилка"}`,
      };
    }

    const res = await platformFetch(`/api/platform/cases/${encodeURIComponent(data.id)}/pin`, {
      method: "POST",
      body: JSON.stringify({ entityIds: data.facilities.map((f) => platformEntityId(f.id)) }),
    });
    if (!res.ok) return { configured: true, ok: false, ...(res.error ? { error: res.error } : {}) };
    return { configured: true, ok: true, case: res.body as AnalystCase };
  });
