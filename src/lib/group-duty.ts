/**
 * Бот як черговий по чату: родина, під'їзд, офіс, зміна.
 *
 * ## Чому персональний радар не покриває цього
 *
 * Люди не сидять у боті — вони сидять у своїх чатах. Сімейний чат, чат ОСББ,
 * чат зміни на роботі: саме там пишуть «у нас тривога», «хто в укритті»,
 * «чути роботу ППО». Щоб радар був там, кожному учаснику треба окремо знайти
 * бота, налаштувати точку й не вимкнути сповіщення. Так не буває.
 *
 * Тут навпаки: бота додають у чат ОДИН раз, хтось один задає точку — і чат
 * отримує попередження цілком. Двадцять людей прикриті одним налаштуванням.
 *
 * ## Це не персональний радар у групі
 *
 * Модель інша, і плутати їх не можна. У групи немає нічної тиші (в чаті сплять
 * не всі), немає кола рідних (сам чат ним і є), немає «моїх місць» — точка
 * одна, спільна. Натомість у групи є те, чого немає в людини: **поріг
 * гучності**, бо повідомлення, що будить одного, будить усіх двадцятьох.
 *
 * Тому за замовчуванням група чує лише те, заради чого варто розбудити двадцять
 * людей: ціль, що йде на їхню точку, і офіційну тривогу. Не «рух у небі».
 */

export type GroupLevel = "critical" | "inbound" | "all";

export interface GroupDuty {
  chatId: number;
  title: string;
  lat: number;
  lon: number;
  label: string;
  radiusKm: number;
  level: GroupLevel;
  /** Хто ввімкнув — щоб було видно, з кого питати. */
  enabledBy: number;
  enabledAt: string;
  /** Останнє надіслане — дедуп такий самий, як у персонального. */
  lastAlertAt: number;
  lastAlertIds: string[];
}

export const GROUP_DEFAULT_RADIUS_KM = 25;

export function newGroupDuty(
  chatId: number,
  title: string,
  place: { lat: number; lon: number; label: string },
  by: number,
  at: string,
): GroupDuty {
  return {
    chatId,
    title,
    lat: place.lat,
    lon: place.lon,
    label: place.label,
    // Радіус для групи вужчий за персональний: у чаті двадцять людей, і
    // «щось за сімдесят кілометрів» тут коштує двадцяти перерваних справ.
    radiusKm: GROUP_DEFAULT_RADIUS_KM,
    level: "inbound",
    enabledBy: by,
    enabledAt: at,
    lastAlertAt: 0,
    lastAlertIds: [],
  };
}

const LEVEL_LABEL: Record<GroupLevel, string> = {
  critical: "лише ракети й балістика",
  inbound: "усе, що йде на нас",
  all: "будь-який рух поблизу",
};

/** Локальне екранування — модуль лишається без залежностей від бота. */
function escapeDuty(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderDuty(duty: GroupDuty): string {
  return [
    `🛡 <b>Черговий по чату: увімкнено</b>`,
    "",
    // Назва місця з нашого довідника, але правило одне: усе, що не наша
    // розмітка, — екрануємо. Розбирати щоразу, чий саме це рядок, дорожче за
    // сам виклик, а ціна помилки — Telegram відхиляє повідомлення цілком.
    `Точка: <b>${escapeDuty(duty.label)}</b> · радіус ${duty.radiusKm} км`,
    `Попереджати: <b>${LEVEL_LABEL[duty.level]}</b>`,
    "",
    "<code>/duty off</code> — вимкнути · <code>/duty радіус 40</code> · <code>/duty рівень все</code>",
    "",
    "<i>Бот пише в цей чат, коли ціль іде на вашу точку або оголошують тривогу. Персональні налаштування учасників на це не впливають — у групи вони свої.</i>",
  ].join("\n");
}

export function renderDutyHelp(): string {
  return [
    "🛡 <b>Черговий по чату</b>",
    "",
    "Бота додають у чат один раз, точку задає хтось один — і попередження отримує весь чат. Двадцять людей прикриті одним налаштуванням.",
    "",
    "<code>/duty Харків</code> — увімкнути для міста",
    "<code>/duty off</code> — вимкнути",
    "",
    "<i>Умикати може лише адміністратор чату: це спільне сповіщення, а не особисте.</i>",
  ].join("\n");
}

/** Розбір `/duty …`. `null` — показати довідку. */
export function parseDutyArgs(
  args: string,
):
  | { kind: "off" }
  | { kind: "radius"; km: number }
  | { kind: "level"; level: GroupLevel }
  | { kind: "place"; query: string }
  | null {
  const raw = args.trim();
  if (!raw) return null;
  const [head, ...rest] = raw.split(/\s+/);
  const word = head!.toLowerCase();
  const tail = rest.join(" ").trim();

  if (word === "off" || word === "вимк" || word === "стоп") return { kind: "off" };
  if (word === "радіус" || word === "radius") {
    const km = Number(tail);
    return Number.isFinite(km) ? { kind: "radius", km: Math.max(5, Math.min(100, km)) } : null;
  }
  if (word === "рівень" || word === "level") {
    const v = tail.toLowerCase();
    if (v === "все" || v === "all") return { kind: "level", level: "all" };
    if (v === "ракети" || v === "critical") return { kind: "level", level: "critical" };
    if (v === "на нас" || v === "inbound") return { kind: "level", level: "inbound" };
    return null;
  }
  return { kind: "place", query: raw };
}

/**
 * Чи варто турбувати чат.
 *
 * Поріг для групи навмисно вищий за персональний: ціна помилки множиться на
 * кількість учасників. Повідомлення, яке для однієї людини «зайве, але
 * пробачне», у чаті на двадцять осіб — це двадцять перерваних справ і
 * вимкнений бот наступного дня.
 */
export const GROUP_COOLDOWN_MS = 15 * 60 * 1000;

export function shouldNotifyGroup(
  duty: GroupDuty,
  incoming: readonly { id: string; critical: boolean }[],
  now: number,
): { send: boolean; ids: string[] } {
  const pool = duty.level === "critical" ? incoming.filter((t) => t.critical) : [...incoming];
  if (pool.length === 0) return { send: false, ids: [] };

  const ids = pool.map((t) => t.id).sort();
  const known = new Set(duty.lastAlertIds);
  const fresh = ids.filter((id) => !known.has(id));
  if (fresh.length === 0) return { send: false, ids };
  if (now - duty.lastAlertAt < GROUP_COOLDOWN_MS) return { send: false, ids };
  return { send: true, ids };
}
