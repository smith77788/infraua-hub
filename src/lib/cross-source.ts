/**
 * Перехресне підтвердження між двома незалежними агрегаторами.
 *
 * ## Навіщо
 *
 * У ніші два агрегатори OSINT, і вони незалежні: neptun.in.ua зводить
 * повідомлення у треки зі стабільними id, detoyshahed.in.ua віддає сирі
 * повідомлення з назвою каналу, який їх написав. Досі другий був лише
 * запасним — його брали, коли перший не відповів.
 *
 * Це втрата найціннішого, що є в OSINT: НЕЗАЛЕЖНОГО СВІДКА. Заміряно на живому
 * зрізі (29 цілей neptun проти 187 повідомлень detoyshahed від 10 каналів):
 *
 * — 21 ціль із 29 мала підтвердження в другого агрегатора;
 * — у середньому 2,8 різних каналів на підтверджену ціль;
 * — **8 цілей із 29 (28%) бачив лише один агрегатор**.
 *
 * Оце останнє число й є те, чого система не знала про себе. Ціль, яку бачать
 * два незалежні збирачі й пів десятка каналів, і ціль, про яку сказав один
 * збирач, — різні за вагою твердження, а на карті вони виглядали однаково.
 *
 * ## Як шукаємо
 *
 * Радіус пошуку — НЕ константа, а власне коло цілі («де вона може бути зараз»).
 * Для позначки з розкидом ±2 км вимагати повідомлення за 25 км безглуздо, а для
 * ±25 км вимагати за 5 — теж: у першому випадку ми зарахуємо чуже, у другому не
 * зарахуємо своє. Коло вже рахує і заявлений розкид, і застій, тож воно тут
 * єдина чесна міра «поруч».
 *
 * ## Чого це НЕ робить, і чому
 *
 * Не піднімає рівень небезпеки. Підтвердження — це знання про ДОСТОВІРНІСТЬ
 * позначки, а не про те, що загроза більша. Ціль, яку бачать пʼять каналів,
 * не летить швидше за ту, яку бачить один.
 *
 * Чесно про межу методу: звʼязок за близькістю може приписати цілі чуже
 * повідомлення — коли дві цілі поруч, їхні кола перетинаються. Тому рахуємо
 * лише РІЗНІ канали (а не кількість повідомлень) і ніколи не лічимо те саме
 * джерело двічі. Помилка в цей бік завищує довіру, а не тривогу, і має стелю
 * в кількості каналів, які взагалі існують.
 */

import type { Threat } from "./air";
import { distanceKm } from "./infra-types";
import { nowRadiusKm } from "./position-age";

/** Сире повідомлення другого агрегатора. */
export interface ChannelReport {
  lat: number;
  lon: number;
  /** Канал, який повідомив, — саме він і є «незалежний свідок». */
  channel: string;
  /** Коли повідомлено, мс. */
  at: number;
}

export interface Corroboration {
  /** Різні канали, що бачили ціль у її колі. Без повторів. */
  channels: string[];
  /** Найсвіжіше підтвердження, мс, або `null`. */
  latestAt: number | null;
  /** У якому радіусі шукали, км — щоб число можна було перевірити. */
  withinKm: number;
}

/** Найбільший радіус пошуку: далі «поруч» перестає щось означати. */
export const MAX_MATCH_KM = 25;
/** Найменший: позначка з нульовим розкидом не може вимагати ідеального збігу. */
export const MIN_MATCH_KM = 5;
/** Повідомлення, старші за це від часу оцінки, підтвердженням не вважаємо. */
export const MATCH_WINDOW_MS = 45 * 60 * 1000;

/**
 * Скільки незалежних каналів другого агрегатора бачили кожну ціль.
 *
 * Чиста функція: ні мережі, ні годинника, крім переданого часу.
 */
export function corroborate(
  threats: readonly Threat[],
  reports: readonly ChannelReport[],
  now: number,
): Map<string, Corroboration> {
  const out = new Map<string, Corroboration>();
  const fresh = reports.filter(
    (r) =>
      Number.isFinite(r.lat) &&
      Number.isFinite(r.lon) &&
      Number.isFinite(r.at) &&
      r.at <= now &&
      now - r.at <= MATCH_WINDOW_MS &&
      r.channel.length > 0,
  );
  for (const t of threats) {
    if (!Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue;
    const circle = nowRadiusKm(t, now).likelyKm;
    const withinKm = Math.min(MAX_MATCH_KM, Math.max(MIN_MATCH_KM, circle));
    const channels = new Set<string>();
    let latestAt: number | null = null;
    for (const r of fresh) {
      const d = distanceKm(t, r);
      if (!Number.isFinite(d) || d > withinKm) continue;
      channels.add(r.channel);
      if (latestAt === null || r.at > latestAt) latestAt = r.at;
    }
    if (channels.size === 0) continue;
    out.set(t.id, {
      // Сталий порядок: перелік іде в текст, і він не має смикатись між тиками.
      channels: [...channels].sort(),
      latestAt,
      withinKm: Math.round(withinKm * 10) / 10,
    });
  }
  return out;
}

/**
 * Домішує знайдені канали до `sources` цілі.
 *
 * Далі їх зважує наявна `verifyThreat`/`assessCredibility` — вона вже вміє
 * рахувати незалежність джерел і знає ролі каналів. Нової шкали довіри тут
 * навмисно не заводимо: друга шкала поруч із першою означала б два різні
 * числа про те саме, а це вже проходили.
 */
export function withCorroboration(
  threats: readonly Threat[],
  found: ReadonlyMap<string, Corroboration>,
): Threat[] {
  return threats.map((t) => {
    const c = found.get(t.id);
    if (!c) return t;
    const merged = new Set<string>([...(t.sources ?? []), ...(t.source ? [t.source] : [])]);
    for (const ch of c.channels) merged.add(ch);
    return { ...t, sources: [...merged] };
  });
}

/** Людський підпис для картки цілі. `null` — підтверджень немає. */
export function corroborationLine(c: Corroboration | undefined): string | null {
  if (!c || c.channels.length === 0) return null;
  const n = c.channels.length;
  const word = n === 1 ? "канал" : n < 5 ? "канали" : "каналів";
  return `${n} незалежн${n === 1 ? "ий" : "і"} ${word} другого агрегатора в радіусі ${c.withinKm} км`;
}
