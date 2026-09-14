/**
 * Вухо як датчик: читачі перетворюються на мережу спостереження.
 *
 * У цієї ніші є сліпа пляма, якої не закриває жоден агрегатор: OSINT-канали
 * пишуть про ціль, коли її ХТОСЬ побачив і встиг написати. Але в ту саму
 * хвилину дрон чують сотні людей, і ця інформація просто зникає — вона є в
 * головах, а не в даних.
 *
 * Тут вона стає даними. Людина тисне кнопку «чую», і її доклад — з часом і
 * координатами — лягає поруч із докладами сусідів. Сто тисяч читачів
 * перетворюються на сто тисяч мікрофонів, і жодного обладнання для цього не
 * треба.
 *
 * ## Чому це не може бути наївним
 *
 * Натовп бреше, помиляється й панікує. Тому ЖОДЕН окремий доклад ніколи нічого
 * не піднімає: підтвердженням вважається лише збіг кількох НЕЗАЛЕЖНИХ людей у
 * тому самому місці й часі. Один зляканий (або зловмисник) не зможе створити
 * подію в принципі — не через модерацію, а тому, що конструкція цього не
 * передбачає.
 *
 * Тому ж тут рахуються різні `chatId`, а не кількість докладів: десять
 * натискань однієї людини — це одна людина.
 */

export type SoundKind = "drone" | "explosion" | "air-defence";

export interface SoundReport {
  chatId: number;
  lat: number;
  lon: number;
  kind: SoundKind;
  at: number;
}

export const SOUND_LABEL: Record<SoundKind, string> = {
  drone: "дрон",
  explosion: "вибухи",
  "air-defence": "працює ППО",
};

const SOUND_EMOJI: Record<SoundKind, string> = {
  drone: "🛸",
  explosion: "💥",
  "air-defence": "🛡",
};

/** Пауза між докладами однієї людини — щоб кнопка не стала лічильником паніки. */
export const REPORT_COOLDOWN_MS = 3 * 60 * 1000;
/** Скільки живе доклад: звук, почутий пів години тому, нічого не каже про зараз. */
export const REPORT_TTL_MS = 30 * 60 * 1000;
/** Мінімум РІЗНИХ людей для підтвердження. Одиниця тут неможлива за задумом. */
export const MIN_WITNESSES = 2;

export function canReport(lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || now - lastAt >= REPORT_COOLDOWN_MS;
}

export function pruneReports(reports: readonly SoundReport[], now: number): SoundReport[] {
  return reports.filter((r) => now - r.at < REPORT_TTL_MS);
}

export interface SoundCluster {
  kind: SoundKind;
  /** Скільки РІЗНИХ людей, а не скільки натискань. */
  witnesses: number;
  /** Наскільки свіжий найновіший доклад, хв. */
  freshMin: number;
  radiusKm: number;
}

function distanceKmFast(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (a.lat - b.lat) * 111.32;
  const dLon = (a.lon - b.lon) * 111.32 * Math.cos(((a.lat + b.lat) / 2 / 180) * Math.PI);
  return Math.hypot(dLat, dLon);
}

/**
 * Що чують навколо точки.
 *
 * Повертає лише те, що підтверджене кількома незалежними людьми. Порожній
 * масив — «нічого достовірного», і це найчастіший, нормальний результат.
 */
export function corroborate(
  reports: readonly SoundReport[],
  point: { lat: number; lon: number },
  now: number,
  opts: { radiusKm?: number; windowMs?: number; minWitnesses?: number } = {},
): SoundCluster[] {
  const radiusKm = opts.radiusKm ?? 15;
  const windowMs = opts.windowMs ?? 12 * 60 * 1000;
  const minWitnesses = opts.minWitnesses ?? MIN_WITNESSES;

  const near = reports.filter(
    (r) => now - r.at <= windowMs && distanceKmFast(point, r) <= radiusKm,
  );
  const byKind = new Map<SoundKind, SoundReport[]>();
  for (const r of near) {
    const list = byKind.get(r.kind);
    if (list) list.push(r);
    else byKind.set(r.kind, [r]);
  }

  const out: SoundCluster[] = [];
  for (const [kind, list] of byKind) {
    const witnesses = new Set(list.map((r) => r.chatId)).size;
    if (witnesses < minWitnesses) continue;
    const newest = Math.max(...list.map((r) => r.at));
    out.push({
      kind,
      witnesses,
      freshMin: Math.max(0, Math.round((now - newest) / 60_000)),
      radiusKm,
    });
  }
  return out.sort((a, b) => b.witnesses - a.witnesses);
}

function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

/** Рядок «що чують поруч». `null` — підтвердженого немає, і мовчимо. */
export function renderClusters(clusters: readonly SoundCluster[]): string | null {
  if (clusters.length === 0) return null;
  const parts = clusters.map(
    (c) =>
      `${SOUND_EMOJI[c.kind]} ${SOUND_LABEL[c.kind]} — ${c.witnesses} ` +
      `${plural(c.witnesses, "людина", "людини", "людей")}` +
      (c.freshMin > 0 ? `, ${c.freshMin} хв тому` : ", щойно"),
  );
  return `👂 <b>Поруч чують:</b> ${parts.join(" · ")}`;
}

/** Подяка за доклад. Коротка: людина тисне кнопку не заради читання. */
export function renderReportAccepted(kind: SoundKind, clusters: readonly SoundCluster[]): string {
  const confirmed = clusters.find((c) => c.kind === kind);
  return confirmed
    ? `✅ Записано. Те саме поруч чують ще ${confirmed.witnesses - 1}.`
    : "✅ Записано. Поки ви єдиний — одного доклада замало, щоб про це сказати іншим.";
}
