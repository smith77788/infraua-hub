/**
 * Резервна копія підписників у приватний чат власника.
 *
 * Навіщо, якщо є том. Тому що тому може не бути — і саме це зараз і є: підключити
 * його з телефона Railway не дає, а редеплой тим часом стирає всіх. Але навіть
 * із томом лишається клас відмов, від якого том не рятує: видалений сервіс,
 * помилковий `/purge`, том, змонтований не туди. Копія переводить будь-який із
 * цих випадків із «втрачено назавжди» в «відновлюється одним дотиком».
 *
 * Куди. В особистий чат ВЛАСНИКА з ботом — не в канал і не до стороннього
 * сервісу. Це та сама межа довіри, що й сам бот: дані вже в нього є, і нових
 * місць, де лежать чужі координати, не з'являється.
 *
 * Відновлення ЗЛИВАЄТЬСЯ, а не перезаписує. Людина, яка підписалась після
 * копії, не має зникнути через те, що власник відновив учорашній файл: живий
 * запис завжди сильніший за архівний.
 */

import type { Subscriber } from "./subscribers";
import type { Circle } from "./circle";

export interface BackupFile {
  version: 1;
  savedAt: string;
  subscribers: Subscriber[];
  circles: Circle[];
}

export function buildBackup(
  subscribers: readonly Subscriber[],
  circles: readonly Circle[],
  at: string,
): BackupFile {
  return {
    version: 1,
    savedAt: at,
    subscribers: [...subscribers],
    circles: [...circles],
  };
}

/**
 * Розбір копії. `null` — це не наш файл.
 *
 * Перевіряємо форму, а не довіряємо назві: власник може переслати боту що
 * завгодно, і мовчазне прийняття чужого JSON як бази підписників — це спосіб
 * втратити її замість відновити.
 */
export function parseBackup(raw: string): BackupFile | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const file = data as Partial<BackupFile>;
  if (!Array.isArray(file.subscribers)) return null;
  const subscribers = file.subscribers.filter(
    (s): s is Subscriber => typeof (s as Subscriber)?.chatId === "number",
  );
  const circles = Array.isArray(file.circles)
    ? file.circles.filter((c): c is Circle => typeof (c as Circle)?.code === "string")
    : [];
  return {
    version: 1,
    savedAt: typeof file.savedAt === "string" ? file.savedAt : "",
    subscribers,
    circles,
  };
}

export interface MergeResult<T> {
  merged: T[];
  added: number;
  kept: number;
}

/**
 * Злиття: архів заповнює прогалини, живий запис виграє конфлікт.
 *
 * Саме в цьому порядку, а не навпаки. Відновлення після втрати — це майже
 * завжди порожня памʼять і повний архів, там порядок не важить. Але якщо
 * власник відновить копію на робочій базі, зворотний порядок відкотив би
 * кожного, хто встиг щось змінити, — і зробив би з відновлення другу аварію.
 */
export function mergeSubscribers(
  live: readonly Subscriber[],
  archived: readonly Subscriber[],
): MergeResult<Subscriber> {
  const byId = new Map(live.map((s) => [s.chatId, s] as const));
  let added = 0;
  for (const s of archived) {
    if (byId.has(s.chatId)) continue;
    byId.set(s.chatId, s);
    added += 1;
  }
  return { merged: [...byId.values()], added, kept: live.length };
}

export function mergeCircles(
  live: readonly Circle[],
  archived: readonly Circle[],
): MergeResult<Circle> {
  const byCode = new Map(live.map((c) => [c.code, c] as const));
  let added = 0;
  for (const c of archived) {
    if (byCode.has(c.code)) continue;
    byCode.set(c.code, c);
    added += 1;
  }
  return { merged: [...byCode.values()], added, kept: live.length };
}

/** Підпис під файлом копії. Коротко: його читають раз на добу й не читають. */
export function renderBackupNote(file: BackupFile, ephemeral: boolean): string {
  const withPoint = file.subscribers.filter((s) => s.point).length;
  return [
    "💾 <b>Копія підписників</b>",
    `Записів: <b>${file.subscribers.length}</b> · з точкою: <b>${withPoint}</b> · кіл: <b>${file.circles.length}</b>`,
    ...(ephemeral
      ? [
          "",
          "⚠️ Сховище ефемерне — після редеплою поверніть цей файл боту, і підписники повернуться.",
        ]
      : []),
  ].join("\n");
}

export function renderRestoreResult(
  subs: MergeResult<Subscriber>,
  circles: MergeResult<Circle>,
): string {
  if (subs.added === 0 && circles.added === 0) {
    return "Файл прийнято, але нового в ньому немає — усі записи вже на місці.";
  }
  return [
    "✅ <b>Відновлено з копії</b>",
    "",
    `Додано підписників: <b>${subs.added}</b> (було ${subs.kept})`,
    ...(circles.added > 0 ? [`Додано кіл: <b>${circles.added}</b>`] : []),
    "",
    "<i>Живі записи не переписувались: архів лише заповнив прогалини.</i>",
  ].join("\n");
}
