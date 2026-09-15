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

import type { Circle } from "./circle";
import { newSubscriber, refCode, type Subscriber } from "./subscribers";

interface StoreFile {
  version: 1;
  subscribers: Subscriber[];
  circles?: Circle[];
}

const MEMORY = new Map<number, Subscriber>();
const CIRCLES = new Map<string, Circle>();
let loaded = false;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastError: string | null = null;

/** Звідки взявся шлях до сховища — це головне, що треба знати при діагностиці. */
export type DataDirSource =
  "BOT_DATA_DIR" | "RAILWAY_VOLUME_MOUNT_PATH" | "PLATFORM_DATA_DIR" | "default";

/**
 * Де лежать підписки.
 *
 * `RAILWAY_VOLUME_MOUNT_PATH` тут — головний додаток. Railway виставляє цю
 * змінну САМ, щойно до сервісу підключено том (перевірено в документації
 * Railway, розділ Volumes). Тобто власникові достатньо підключити том — і
 * нічого більше налаштовувати не треба. Раніше ми вимагали ще й вручну задати
 * `BOT_DATA_DIR`, і саме цей зайвий крок означав, що підписники зникали при
 * кожному редеплої: том міг бути, а змінна — ні.
 *
 * Явний `BOT_DATA_DIR` лишається першим: він перекриває автовизначення там, де
 * том мають ділити з чимось іще.
 */
export function dataDirSource(): DataDirSource {
  if (process.env["BOT_DATA_DIR"]?.trim()) return "BOT_DATA_DIR";
  if (process.env["RAILWAY_VOLUME_MOUNT_PATH"]?.trim()) return "RAILWAY_VOLUME_MOUNT_PATH";
  if (process.env["PLATFORM_DATA_DIR"]?.trim()) return "PLATFORM_DATA_DIR";
  return "default";
}

function dataDir(): string {
  const source = dataDirSource();
  if (source === "default") return "./data";
  return process.env[source]!.trim();
}

function filePath(): string {
  return `${dataDir().replace(/\/$/, "")}/subscribers.json`;
}

/**
 * Чи переживуть підписки редеплой.
 *
 * `default` — ні: файл ляже в ефемерну файлову систему контейнера. Решта
 * джерел вказує на том. Це висновок із конфігурації, а не замір: том можна
 * відмонтувати й не сказати нам. Тому поруч є `probeWritable`, який саме
 * МІРЯЄ, чи туди взагалі можна писати.
 */
export function isDurable(): boolean {
  return dataDirSource() !== "default";
}

/**
 * Реальна перевірка запису — пише й прибирає пробний файл.
 *
 * Потрібна тому, що всі попередні висновки про сховище були висновками з
 * НАЯВНОСТІ ЗМІННОЇ, а не з того, що на диск справді щось лягає. Том можна
 * підключити не в ту теку, змонтувати лише для читання або впертись у квоту —
 * і в кожному з цих випадків налаштування виглядає правильним, а підписники
 * все одно зникають.
 */
export async function probeWritable(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { mkdir, rm, writeFile } = await import("node:fs/promises");
    const dir = dataDir().replace(/\/$/, "");
    await mkdir(dir, { recursive: true });
    const probe = `${dir}/.write-probe`;
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  hookShutdown();
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(filePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    for (const sub of parsed.subscribers ?? []) {
      if (typeof sub?.chatId === "number") MEMORY.set(sub.chatId, sub);
    }
    for (const circle of parsed.circles ?? []) {
      if (typeof circle?.code === "string") CIRCLES.set(circle.code, circle);
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

/**
 * Записи не накладаються один на одний.
 *
 * Негайний запис зробив перекриття не теоретичним: два дотики поспіль
 * запускали два `flush` одночасно, обидва писали ОДИН тимчасовий файл, перший
 * перейменовував його — і другий падав на `rename` з ENOENT, залишаючи диск
 * без частини змін. Тому записи стоять у черзі, а тимчасове імʼя унікальне.
 */
let flushChain: Promise<void> = Promise.resolve();
let tmpCounter = 0;

async function writeSnapshot(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  const body: StoreFile = {
    version: 1,
    subscribers: [...MEMORY.values()],
    circles: [...CIRCLES.values()],
  };
  // Шлях беремо ОДИН раз на запис: інакше запис, початий до зміни оточення,
  // перейменовував би файл уже в іншу теку.
  const target = filePath();
  const dir = target.slice(0, target.lastIndexOf("/")) || ".";
  const tmp = `${target}.${++tmpCounter}.tmp`;
  try {
    const { mkdir, rename, writeFile } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(body), "utf8");
    await rename(tmp, target);
    lastError = null;
  } catch (error) {
    dirty = true; // не втрачаємо намір записати
    lastError = error instanceof Error ? error.message : String(error);
    console.error("subscriber store flush failed", error);
  }
}

function flush(): Promise<void> {
  flushTimer = null;
  flushChain = flushChain.then(writeSnapshot);
  return flushChain;
}

/**
 * Відкладений запис — і коли на нього не можна покладатись.
 *
 * Дві секунди затримки економлять сотні перезаписів файлу під час обходу
 * підписників. Але між дотиком людини й записом на диск утворюється вікно, і
 * редеплой у цьому вікні стирає рівно те, заради чого людина прийшла: щойно
 * задану точку. Тому зміни, які варто не втратити ніколи (поява підписника,
 * нова точка, вступ у коло), пишуться НЕГАЙНО, а решта — як і раніше.
 */
function scheduleFlush(urgent = false): Promise<void> {
  dirty = true;
  if (urgent) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    return flush();
  }
  // Таймер уже зведено — другий не потрібен, зміна поїде з ним.
  if (flushTimer) return Promise.resolve();
  flushTimer = setTimeout(() => {
    void flush();
  }, 2000);
  (flushTimer as unknown as { unref?: () => void }).unref?.();
  return Promise.resolve();
}

/**
 * Запис на зупинці процесу.
 *
 * Railway зупиняє контейнер сигналом, і все, що лежало в памʼяті, зникає разом
 * із ним. Без цього гачка кожен редеплой з'їдав останні секунди роботи — а
 * редеплой тут буває частіше, ніж хотілося б.
 */
let shutdownHooked = false;
function hookShutdown(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const proc = (globalThis as { process?: NodeJS.Process }).process;
  if (typeof proc?.on !== "function") return; // не Node — гачків немає, і це штатно
  const save = () => {
    void flush();
  };
  proc.on("SIGTERM", save);
  proc.on("SIGINT", save);
  proc.on("beforeExit", save);
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
  // Поява підписника — негайно: саме її найприкріше втратити. Чекаємо на
  // завершення запису, інакше «негайно» лишається обіцянкою.
  await scheduleFlush(true);
  return { sub, created: true };
}

/**
 * `urgent` — для змін, які втратити не можна: нова точка, вступ у коло.
 * Обхід сповіщень лишається відкладеним: там пишеться службовий стан, і сотня
 * повних перезаписів файлу за такт коштувала б дорожче за те, що вони бережуть.
 */
export async function putSubscriber(sub: Subscriber, urgent = false): Promise<void> {
  await load();
  MEMORY.set(sub.chatId, sub);
  await scheduleFlush(urgent);
}

export async function allSubscribers(): Promise<Subscriber[]> {
  await load();
  return [...MEMORY.values()];
}

export async function allCircles(): Promise<Circle[]> {
  await load();
  return [...CIRCLES.values()];
}

/**
 * Вставляє записи, яких ще немає. Повертає, скільки додалось.
 *
 * Саме вставка, а не заміна: відновлення з копії не має відкочувати того, хто
 * встиг щось змінити вже після неї.
 */
export async function insertMissing(
  subscribers: readonly Subscriber[],
  circles: readonly Circle[],
): Promise<{ subscribers: number; circles: number }> {
  await load();
  let subs = 0;
  for (const sub of subscribers) {
    if (MEMORY.has(sub.chatId)) continue;
    MEMORY.set(sub.chatId, sub);
    subs += 1;
  }
  let rings = 0;
  for (const circle of circles) {
    if (CIRCLES.has(circle.code)) continue;
    CIRCLES.set(circle.code, circle);
    rings += 1;
  }
  if (subs || rings) await scheduleFlush(true);
  return { subscribers: subs, circles: rings };
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

/* ─── Кола ──────────────────────────────────────────────────────────────── */

export async function getCircle(code: string): Promise<Circle | undefined> {
  await load();
  return CIRCLES.get(code);
}

export async function putCircle(circle: Circle): Promise<void> {
  await load();
  CIRCLES.set(circle.code, circle);
  scheduleFlush();
}

/**
 * Створює коло з кодом, якого ще немає.
 *
 * Колізія коду тут не дрібниця: другий власник того самого коду тихо потрапив
 * би в чуже коло рідних і бачив би їхні відмітки. Тому код не просто
 * генерується, а й перевіряється на зайнятість.
 */
export async function createCircle(
  name: string,
  ownerChatId: number,
  makeCode: (seed: number) => string,
): Promise<Circle> {
  await load();
  let code = makeCode(ownerChatId);
  for (let i = 1; CIRCLES.has(code) && i < 50; i++) code = makeCode(ownerChatId + i * 7919);
  const circle: Circle = {
    code,
    name,
    ownerChatId,
    members: [ownerChatId],
    createdAt: new Date().toISOString(),
  };
  CIRCLES.set(code, circle);
  scheduleFlush();
  return circle;
}

/**
 * Прибирає людину з кола.
 *
 * Потрібне рівно тоді, коли вона переходить в інше: без цього старе коло й далі
 * показувало б її серед своїх — з відміткою «у порядку», зробленою вже для
 * інших людей. Тобто рідні бачили б заспокійливий сигнал, якого їм ніхто не
 * надсилав.
 */
export async function leaveCircle(code: string, chatId: number): Promise<void> {
  await load();
  const circle = CIRCLES.get(code);
  if (!circle || !circle.members.includes(chatId)) return;
  const members = circle.members.filter((m) => m !== chatId);
  if (members.length === 0) CIRCLES.delete(code);
  else CIRCLES.set(code, { ...circle, members });
  scheduleFlush();
}

export async function joinCircle(code: string, chatId: number): Promise<Circle | null> {
  await load();
  const circle = CIRCLES.get(code);
  if (!circle) return null;
  if (!circle.members.includes(chatId)) {
    const updated = { ...circle, members: [...circle.members, chatId] };
    CIRCLES.set(code, updated);
    scheduleFlush();
    return updated;
  }
  return circle;
}

export interface StoreStats {
  total: number;
  withPoint: number;
  active: number;
  durable: boolean;
  /** Звідки взявся шлях — без цього «ефемерне» не підказує, що робити. */
  source: DataDirSource;
  path: string;
  /** Чи можна туди писати НАСПРАВДІ (замір, не висновок із конфігурації). */
  writable: boolean;
  writeError?: string;
  lastError: string | null;
  circles: number;
  /**
   * Де саме зараз працює процес.
   *
   * Без цього «сховище ефемерне» не розрізняє два зовсім різні випадки: тому
   * немає ніде — і том є, але підключений до СУСІДНЬОГО сервісу. Друге
   * трапилось насправді: у проєкті три сервіси з дуже схожими назвами, том
   * створили, побачили його в списку й вирішили, що готово.
   */
  railwayService: string | null;
  railwayProject: string | null;
}

export async function stats(): Promise<StoreStats> {
  await load();
  const list = [...MEMORY.values()];
  const probe = await probeWritable();
  return {
    total: list.length,
    withPoint: list.filter((s) => s.point).length,
    active: list.filter((s) => s.point && !s.muted).length,
    durable: isDurable(),
    source: dataDirSource(),
    path: filePath(),
    writable: probe.ok,
    ...(probe.error ? { writeError: probe.error } : {}),
    lastError,
    circles: CIRCLES.size,
    railwayService: process.env["RAILWAY_SERVICE_NAME"]?.trim() || null,
    railwayProject: process.env["RAILWAY_PROJECT_NAME"]?.trim() || null,
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

/** Для тестів: дочекатись, поки черга записів спорожніє. */
export async function drainFlushes(): Promise<void> {
  await flushChain;
}

/** Для тестів і адмінських перевірок: скинути памʼять процесу. */
export function resetStoreForTests(): void {
  MEMORY.clear();
  CIRCLES.clear();
  loaded = false;
  dirty = false;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  lastError = null;
}
