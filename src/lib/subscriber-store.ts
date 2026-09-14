/**
 * Сховище підписників — JSON-файл на диску процесу.
 *
 * Чому файл, а не база. Підписник — це вісім полів і один запис на людину;
 * навіть мільйон таких записів — це десятки мегабайтів, які читаються один раз
 * на старті. Ставити заради цього окрему базу означало б додати сервіс, який
 * може лежати окремо від бота — тобто ще одну причину, чому бот мовчить.
 *
 * Межа названа прямо: **без постійного тому підписки не переживуть редеплой.**
 * Шлях береться з `BOT_DATA_DIR`, далі `PLATFORM_DATA_DIR` (том Railway вже
 * налаштований під платформу), далі `./data`. Якщо тому немає, файл ляже в
 * ефемерну файлову систему контейнера — і це не тиха поведінка: `stats()`
 * повертає `durable:false`, а `/admin` це показує.
 *
 * Запис — атомарний (тимчасовий файл + rename) і відкладений на 2 с: сотня
 * змін за хвилину не має означати сотню повних перезаписів.
 */

import { newSubscriber, refCode, type Subscriber } from "./subscribers";

interface StoreFile {
  version: 1;
  subscribers: Subscriber[];
}

const MEMORY = new Map<number, Subscriber>();
let loaded = false;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastError: string | null = null;

function dataDir(): string {
  return (
    process.env["BOT_DATA_DIR"]?.trim() || process.env["PLATFORM_DATA_DIR"]?.trim() || "./data"
  );
}

function filePath(): string {
  return `${dataDir().replace(/\/$/, "")}/subscribers.json`;
}

/** Чи лежить сховище на явно заданому томі (а не в ефемерному контейнері). */
export function isDurable(): boolean {
  return Boolean(process.env["BOT_DATA_DIR"]?.trim() || process.env["PLATFORM_DATA_DIR"]?.trim());
}

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(filePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    for (const sub of parsed.subscribers ?? []) {
      if (typeof sub?.chatId === "number") MEMORY.set(sub.chatId, sub);
    }
  } catch (error) {
    // Файла ще немає — штатний перший запуск. Інша помилка варта логу, але не
    // падіння: бот без історії підписок працює, бот, що не стартує, — ні.
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      lastError = error instanceof Error ? error.message : String(error);
      console.error("subscriber store load failed", error);
    }
  }
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (!dirty) return;
  dirty = false;
  const body: StoreFile = { version: 1, subscribers: [...MEMORY.values()] };
  try {
    const { mkdir, rename, writeFile } = await import("node:fs/promises");
    const dir = dataDir().replace(/\/$/, "");
    await mkdir(dir, { recursive: true });
    const tmp = `${filePath()}.tmp`;
    await writeFile(tmp, JSON.stringify(body), "utf8");
    await rename(tmp, filePath());
    lastError = null;
  } catch (error) {
    dirty = true; // не втрачаємо намір записати
    lastError = error instanceof Error ? error.message : String(error);
    console.error("subscriber store flush failed", error);
  }
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    void flush();
  }, 2000);
  (flushTimer as unknown as { unref?: () => void }).unref?.();
}

export async function getSubscriber(chatId: number): Promise<Subscriber | undefined> {
  await load();
  return MEMORY.get(chatId);
}

/** Знаходить наявного або заводить нового — без другого запиту на запис. */
export async function ensureSubscriber(
  chatId: number,
  at: string,
  ref: string | null = null,
): Promise<{ sub: Subscriber; created: boolean }> {
  await load();
  const found = MEMORY.get(chatId);
  if (found) return { sub: found, created: false };
  const sub = newSubscriber(chatId, at, ref);
  MEMORY.set(chatId, sub);
  scheduleFlush();
  return { sub, created: true };
}

export async function putSubscriber(sub: Subscriber): Promise<void> {
  await load();
  MEMORY.set(sub.chatId, sub);
  scheduleFlush();
}

export async function allSubscribers(): Promise<Subscriber[]> {
  await load();
  return [...MEMORY.values()];
}

/** Погашення коду запрошення: лічильник зростає в того, чий це код. */
export async function creditInvite(code: string, invitee: number): Promise<boolean> {
  await load();
  if (!code || code === refCode(invitee)) return false;
  for (const sub of MEMORY.values()) {
    if (sub.code === code) {
      MEMORY.set(sub.chatId, { ...sub, invited: sub.invited + 1 });
      scheduleFlush();
      return true;
    }
  }
  return false;
}

export interface StoreStats {
  total: number;
  withPoint: number;
  active: number;
  durable: boolean;
  path: string;
  lastError: string | null;
}

export async function stats(): Promise<StoreStats> {
  await load();
  const list = [...MEMORY.values()];
  return {
    total: list.length,
    withPoint: list.filter((s) => s.point).length,
    active: list.filter((s) => s.point && !s.muted).length,
    durable: isDurable(),
    path: filePath(),
    lastError,
  };
}

/** Записати негайно, не чекаючи на відкладений запис (тести, коректне завершення). */
export async function flushNow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
}

/** Для тестів і адмінських перевірок: скинути памʼять процесу. */
export function resetStoreForTests(): void {
  MEMORY.clear();
  loaded = false;
  dirty = false;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  lastError = null;
}
