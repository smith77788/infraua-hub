/**
 * Спільний серверний клієнт до аналітичної платформи (Palanter на Railway).
 *
 * Раніше кожен модуль інтеграції (справи, надсилання) ніс власну копію
 * `config()` і `fetch`-обгортки. З появою читання назад (аналітика, граф,
 * lineage, шляхи) копій стало б забагато — тож логіка звʼязку зібрана тут.
 *
 * Виклики навмисно серверні: платформа автентифікує bearer-ключем, а ключ у
 * браузері — це ключ у кожного відвідувача. `PLATFORM_API_URL` і
 * `PLATFORM_API_KEY` читаються лише на сервері; клієнт бачить тільки результат.
 *
 * Незаданий звʼязок — штатний стан, а не збій: консоль самодостатня, і поки
 * змінні не задані, розділи платформи просто не показуються.
 */

export interface PlatformConfig {
  base: string;
  key: string;
}

export function platformConfig(): PlatformConfig | null {
  const base = process.env["PLATFORM_API_URL"];
  const key = process.env["PLATFORM_API_KEY"];
  if (!base || !key) return null;
  return { base: base.replace(/\/$/, ""), key };
}

export function isPlatformConfigured(): boolean {
  return Boolean(process.env["PLATFORM_API_URL"] && process.env["PLATFORM_API_KEY"]);
}

export interface PlatformResponse {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

export async function platformFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<PlatformResponse> {
  const cfg = platformConfig();
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
