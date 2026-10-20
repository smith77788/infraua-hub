/**
 * Журнал запусків процесу — щоб перезапуск можна було відрізнити від деплою.
 *
 * ## Чому цього бракувало
 *
 * Запитали, чому контейнер перезапускається. Відповісти було нічим: `uptime`
 * показує лише вік ЦЬОГО процесу, а причини не несе. Заміряно двічі — 4915 с
 * 19.10 і 3817 с 20.10, — і обидва рази вік упирався в чийсь пуш у `main`.
 * Але це висновок за кореляцією: над репозиторієм працюють дві сесії, пушів за
 * день багато, і кожен редеплоїть Railway. Відрізнити «перезапустилось, бо
 * вийшла нова версія» від «процес упав і піднявся на тій самій версії» з
 * одного числа неможливо.
 *
 * ## Що це вирішує
 *
 * Запуск записує на том свій час і SHA збірки. Тоді відповідь читається прямо:
 *
 * - новий запуск із ІНШИМ SHA — це деплой, і так має бути;
 * - новий запуск із ТИМ САМИМ SHA — процес перезапустився сам: падіння, OOM
 *   або зупинка платформою. Саме це й треба було побачити.
 *
 * Журнал короткий і не росте: тримаємо останні `KEEP` запусків. Довша історія
 * тут нічого не додає — питання завжди про останні години.
 */

export interface Boot {
  /** Коли процес запустився, мс. */
  at: number;
  /** SHA збірки, якщо платформа його дала. Порожньо — не сказала. */
  sha: string;
}

/** Скільком останнім запускам лишаємо місце. */
export const KEEP = 12;

/**
 * Розбір журналу зі сховища.
 *
 * Пошкоджений або чужий вміст дає порожній журнал, а не виняток: втратити
 * історію запусків неприємно, впасти на старті через неї — гірше.
 */
export function parseBootLog(raw: string | null): Boot[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Boot[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const { at, sha } = item as { at?: unknown; sha?: unknown };
      if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) continue;
      out.push({ at, sha: typeof sha === "string" ? sha : "" });
    }
    return out.sort((a, b) => a.at - b.at).slice(-KEEP);
  } catch {
    return [];
  }
}

/** Журнал із дописаним поточним запуском. */
export function appendBoot(previous: readonly Boot[], boot: Boot): Boot[] {
  return [...previous, boot].sort((a, b) => a.at - b.at).slice(-KEEP);
}

export interface BootReport {
  /** Скільком запускам ми взагалі знаємо час. */
  known: number;
  /**
   * Запуски на ТІЙ САМІЙ збірці, що й попередній, — тобто не деплої.
   *
   * Це і є відповідь на питання «чому перезапускається»: нуль означає, що
   * кожен перезапуск був виходом нової версії.
   */
  sameBuildRestarts: number;
  /** Коли такий перезапуск стався останнього разу, мс. `null` — не ставалось. */
  lastSameBuildAt: number | null;
  /**
   * Скільки прожив попередній процес до перезапуску на тій самій збірці, с.
   *
   * Потрібне, щоб відрізнити падіння від зупинки платформою: цикл падінь дає
   * десятки секунд, зупинка за простоєм — години. `null` — такого випадку не
   * було.
   */
  lastSameBuildLifetimeSec: number | null;
}

/**
 * Що журнал каже про перезапуски.
 *
 * Порожній SHA не вважаємо збігом: якщо платформа версії не дала, ми НЕ знаємо,
 * чи збірка та сама, і стверджувати падіння за незнанням означало б вигадати
 * діагноз.
 */
export function bootReport(log: readonly Boot[]): BootReport {
  let sameBuildRestarts = 0;
  let lastSameBuildAt: number | null = null;
  let lastSameBuildLifetimeSec: number | null = null;
  for (let i = 1; i < log.length; i++) {
    const prev = log[i - 1]!;
    const cur = log[i]!;
    if (!prev.sha || !cur.sha || prev.sha !== cur.sha) continue;
    sameBuildRestarts++;
    lastSameBuildAt = cur.at;
    lastSameBuildLifetimeSec = Math.round((cur.at - prev.at) / 1000);
  }
  return {
    known: log.length,
    sameBuildRestarts,
    lastSameBuildAt,
    lastSameBuildLifetimeSec,
  };
}
