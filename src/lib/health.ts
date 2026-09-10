/**
 * Стан служби — те, що можна спитати ззовні.
 *
 * Потрібне трьом різним споживачам, і саме тому це окремий модуль, а не рядок
 * у компоненті:
 *
 * - Railway перевіряє живість контейнера й перезапускає його, коли служба не
 *   відповідає;
 * - майбутній Telegram-бот має віддавати зведення, не завантажуючи консоль у
 *   браузері;
 * - людина, яка питає «воно взагалі працює», має отримати відповідь без
 *   відкривання інтерфейсу.
 *
 * Перевірка джерел навмисно не робиться на кожен виклик: healthcheck, який
 * ходить у зовнішній сервіс, перетворює чужу недоступність на власну і
 * викликає перезапуск справної служби. Тому проба вмикається явно
 * (`?probe=1`) і має власний кеш.
 */

export interface SourceProbe {
  source: string;
  ok: boolean;
  /** Мілісекунди до відповіді; `null`, якщо не відповіло. */
  ms: number | null;
  detail: string;
  /**
   * Початок відповіді.
   *
   * Кількість байтів каже, що щось прийшло, і не каже що саме. Для коротких
   * службових відповідей — а `out count` в Overpass саме така — корисніше
   * побачити зміст: проба тоді відповідає не лише «джерело живе», а й на
   * питання, заради якого запит узагалі складений.
   */
  sample?: string;
}

export interface HealthReport {
  status: "ok";
  service: string;
  /** Скільки секунд служба працює. */
  uptimeSeconds: number;
  now: string;
  /** Результати проби зовнішніх джерел — лише коли її просили. */
  probes?: SourceProbe[];
}

const startedAt = Date.now();

export function baseReport(service = "infraua-console"): HealthReport {
  return {
    status: "ok",
    service,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    now: new Date().toISOString(),
  };
}

/** Проба одного джерела: чи відповідає воно і як швидко. */
export async function probe(
  name: string,
  url: string,
  init?: RequestInit,
  timeoutMs = 15_000,
): Promise<SourceProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const ms = Date.now() - started;
    // Тіло читаємо, щоб зафіксувати саме відповідь, а не факт зʼєднання:
    // Overpass під навантаженням віддає HTML зі статусом 200.
    const text = await response.text();
    const looksJson = text.trimStart().startsWith("{") || text.trimStart().startsWith("[");
    return {
      source: name,
      ok: response.ok && looksJson,
      ms,
      detail: response.ok
        ? looksJson
          ? `${text.length} байт JSON`
          : `HTTP ${response.status}, але не JSON — джерело перевантажене`
        : `HTTP ${response.status}`,
      // Обрізаємо: проба має діагностувати, а не переносити дані.
      ...(looksJson && text.length <= 600 ? { sample: text.slice(0, 600) } : {}),
    };
  } catch (err) {
    return {
      source: name,
      ok: false,
      ms: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
