/**
 * Памʼять обходу тривог між перезапусками.
 *
 * ## Навіщо
 *
 * Обхід порівнює ДВА зрізи: що було й що є. Перший знімок навмисно не дає
 * переходів — інакше кожен редеплой розсилав би «оголошено тривогу» всім, у
 * кого вона вже тривала годину.
 *
 * Але «що було» жило лише в памʼяті процесу. Заміряно на проді: `uptimeSeconds`
 * 709, тобто контейнер перезапускається. Після кожного перезапуску перший обхід
 * знову бачить «перший знімок» і МОВЧИТЬ. Якщо перезапуск стався незадовго до
 * початку тривоги, її не оголосить ніхто — і це не помилка в коді, а наслідок
 * того, що правильний запобіжник не мав памʼяті.
 *
 * Стан живого поста каналу переживає редеплой позначкою на томі ще з давніших
 * правок. Обхід тривог — ні. Ця несиметрія і є вада.
 *
 * ## Чому памʼять має строк придатності
 *
 * Відновити зріз годинної давності гірше, ніж почати з нуля: за цю годину
 * тривоги починались і закінчувались, і порівняння з давнім зрізом видало б
 * пачку «оголошено тривогу» про події, яких уже немає. Тому старша памʼять
 * відкидається, і обхід чесно починає як уперше — мовчки.
 */

export interface AlertMemory {
  /** Області з активною тривогою на момент запису. */
  alerts: string[];
  /** Область → рівень (`red`/`yellow`) на момент запису. */
  levels: Record<string, string>;
  /** Область → коли тривога почалась (мс), щоб відбій міг сказати тривалість. */
  starts: Record<string, number>;
  /** Коли записано, мс. */
  at: number;
}

/**
 * Скільки памʼять лишається придатною.
 *
 * Пʼять хвилин — трохи більше за кілька тактів обходу, тобто переживає
 * звичайний редеплой, але не переживає простою, за який картина встигає
 * змінитись до невпізнання.
 */
export const ALERT_MEMORY_MAX_AGE_MS = 5 * 60 * 1000;

export function packAlertMemory(
  alerts: readonly string[],
  levels: ReadonlyMap<string, string>,
  starts: ReadonlyMap<string, number>,
  at: number,
): string {
  const memory: AlertMemory = {
    alerts: [...alerts],
    levels: Object.fromEntries(levels),
    starts: Object.fromEntries(starts),
    at,
  };
  return JSON.stringify(memory);
}

export interface RestoredAlerts {
  alerts: string[];
  levels: Map<string, string>;
  starts: Map<string, number>;
}

/**
 * Відновити памʼять.
 *
 * `null` означає «починаємо як уперше» — і це НЕ відмова, а свідомий тихий
 * старт. Повертати тут порожній стан замість `null` було б гірше: порожнє «що
 * було» перетворює кожну активну тривогу на щойно оголошену.
 */
export function unpackAlertMemory(
  raw: string | null,
  now: number,
  maxAgeMs: number = ALERT_MEMORY_MAX_AGE_MS,
): RestoredAlerts | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Partial<AlertMemory>;
  if (!Array.isArray(m.alerts)) return null;
  if (!Number.isFinite(m.at)) return null;
  if (now - (m.at as number) > maxAgeMs) return null;
  // Запис із майбутнього — збитий годинник; довіряти йому не можна.
  if ((m.at as number) - now > 60_000) return null;

  const levels = new Map<string, string>();
  for (const [k, v] of Object.entries(m.levels ?? {})) {
    if (v === "red" || v === "yellow") levels.set(k, v);
  }
  const starts = new Map<string, number>();
  for (const [k, v] of Object.entries(m.starts ?? {})) {
    if (Number.isFinite(v)) starts.set(k, v as number);
  }
  return {
    alerts: m.alerts.filter((a): a is string => typeof a === "string"),
    levels,
    starts,
  };
}
