/**
 * Персональний радар у боті: як він виглядає в чаті.
 *
 * Тексти й кнопки зібрані тут окремо від мережі — з тієї самої причини, що й
 * усе інше в цьому проєкті: відповідь, яку людина читає о третій ночі, має
 * бути перевірена тестом, а не «поклацана в чаті».
 *
 * Тон. Сповіщення пише не диспетчер і не жартівник: це кілька рядків, які
 * мають прочитатись за секунду з екрана блокування. Тому спершу — що робити,
 * далі — звідки й куди, і лише потім службові подробиці.
 */

import {
  compass,
  type DangerIndex,
  type PersonalAssessment,
  type PersonalThreat,
} from "./advisory";
import type { ThreatType } from "./air";
import { escapeHtml } from "./telegram";
import { preAlertFooter, preAlertHeader } from "./pre-alert";
import type { SoundKind } from "./acoustic";
import { type AlertTier, type NightMode, type Subscriber, DEFAULT_RADIUS_KM } from "./subscribers";
import { EMPTY_QUALITY, qualityLine } from "./threat-quality";
import { KIND_EMOJI, KIND_NOTE, type NearbyShelter } from "./shelters";

const TYPE_NAME: Record<ThreatType, string> = {
  shahed: "шахед",
  reactive: "реактивний шахед",
  cruise: "крилата ракета",
  missile: "ракета",
  ballistic: "балістика",
  kab: "КАБ",
  recon: "розвідник",
  aircraft: "борт",
  unknown: "ціль",
};

const TYPE_EMOJI: Record<ThreatType, string> = {
  shahed: "🛸",
  reactive: "🛸",
  cruise: "🚀",
  missile: "🚀",
  ballistic: "🎯",
  kab: "💥",
  recon: "👁",
  aircraft: "✈️",
  unknown: "❔",
};

const LEVEL_BADGE = {
  shelter: "🔴 <b>В УКРИТТЯ</b>",
  attention: "🟠 <b>Будьте напоготові</b>",
  watch: "🟡 <b>Пильнуйте</b>",
  calm: "🟢 <b>Спокійно</b>",
} as const;

/**
 * Час підльоту словами — і межа, за якою число перестає бути числом.
 *
 * ETA рахується по прямій за курсом, який джерело оновлює рідко. На двадцятій
 * хвилині це корисна оцінка; на двохсотій — вигадка з виглядом заміряного:
 * ціль до того часу кілька разів змінить курс, або її зіб'ють. «~240 хв до
 * вас» виглядає точніше, ніж будь-що, що ми насправді знаємо.
 *
 * Тому за годиною число не показуємо взагалі — лише те, що воно далеко.
 */
const ETA_HONEST_LIMIT_MIN = 60;

export function etaPhrase(etaMin: number | null): string {
  if (etaMin === null) return "";
  if (etaMin > ETA_HONEST_LIMIT_MIN) return ", далеко — понад годину";
  return `, ~${etaMin} хв до вас`;
}

/**
 * Час у рядку цілі — вилкою, коли вона широка.
 *
 * Те саме правило, що й у самому сповіщенні: одне число там, де насправді
 * інтервал, читається як вимір, хоч ним не є.
 */
function etaPart(n: PersonalThreat): string {
  const r = n.etaRangeMin;
  if (r && r[1] > ETA_HONEST_LIMIT_MIN) return ", далеко — понад годину";
  if (r && r[1] - r[0] >= 3) return `, ${r[0]}–${r[1]} хв до вас`;
  return etaPhrase(n.etaMin);
}

/**
 * Один рядок про ціль.
 *
 * Найважливіше тут — слово ПРОМИНЕ. Досі рядок знав лише два стани: «іде на
 * вас» або мовчання, і перший стояв біля всього, що потрапило в сектор ±60° —
 * зокрема біля цілі, яка пройде за тридцять кілометрів. Тепер, коли рух цілі
 * видно з її власних фіксів, промах рахується — і людина бачить різницю між
 * «на вас» і «повз вас», яка досі була стерта.
 */
function threatLine(n: PersonalThreat): string {
  const type = n.threat.type ?? "unknown";
  const dir = compass(n.bearingToThreat);
  const head = `${TYPE_EMOJI[type]} ${TYPE_NAME[type]} — ${n.distanceKm} км на ${dir}`;
  if (n.inbound) return `${head}, <b>іде на вас</b>${etaPart(n)}`;
  // Проліт повз показуємо лише тоді, коли ціль справді наближається: для тієї,
  // що вже віддаляється, «промине за 20 км» — не інформація, а шум.
  if (n.missKm !== undefined && n.etaMin !== null && n.missKm >= 3) {
    return `${head} · промине за ~${n.missKm} км`;
  }
  return head;
}

/**
 * Картка «що наді мною зараз» — відповідь на /my.
 *
 * Індекс небезпеки показується разом зі своїм застереженням, а не окремо:
 * число без межі, у якій воно чесне, читається як обіцянка, якої ніхто тут
 * дати не може (правило проєкту — похідне значення несе своє походження).
 */
export function renderPersonal(
  assess: PersonalAssessment,
  danger: DangerIndex,
  placeLabel: string,
  radiusKm: number,
  /**
   * Стан офіційної тривоги над точкою: `true` — діє, `false` — знято,
   * `null` — дізнатися не вдалося. Три стани, а не два, навмисно: збій
   * джерела, зведений до «діє», кричав би «тривога» щотихого дня і навчив би
   * не вірити, а зведений до «знято» — дав би фальшивий відбій. Обидва
   * спрощення шкідливі, тож невідоме лишається невідомим.
   */
  opts: {
    officialAlert?: boolean | null;
    /** Рядок «поруч чують» — готує acoustic.ts. */
    heard?: string | null;
    /** Чи їде точка за людиною (жива геолокація). */
    live?: boolean;
  } = {},
): string {
  // `??` тут був би помилкою: він зводить явний `null` («не знаємо») до
  // `false` («знято») — тобто рівно до того спрощення, якого ми уникаємо.
  const official: boolean | null = opts.officialAlert === undefined ? false : opts.officialAlert;
  // Офіційна тривога перекриває наш спокій, але не нашу тривогу.
  //
  // «Спокійно, можна спати» під чинною тривогою — це той самий фальшивий
  // відбій, тільки сказаний одній людині й тому ще переконливіший. Ми не
  // бачимо цілей поруч — це все, що можемо чесно стверджувати; відбій дає не
  // наш радіус, а офіційне оголошення.
  const quietUnderAlert = official === true && danger.level === "calm";
  const unknownAlert = official === null && danger.level === "calm";
  const lines: string[] = [
    quietUnderAlert
      ? `🔴 <b>Триває повітряна тривога</b> · ${escapeHtml(placeLabel)}`
      : `${LEVEL_BADGE[danger.level]} · ${escapeHtml(placeLabel)}`,
    quietUnderAlert
      ? "<i>Цілей поруч не бачимо — але відбою не було. Лишайтесь в укритті.</i>"
      : unknownAlert
        ? "<i>Цілей поруч не бачимо. Стан офіційної тривоги зараз невідомий — звіртесь з офіційними каналами.</i>"
        : `<i>${escapeHtml(danger.verdict)}</i>`,
    "",
  ];

  if (assess.inboundCount > 0) {
    const eta =
      assess.minutesToNearest != null && assess.minutesToNearest <= ETA_HONEST_LIMIT_MIN
        ? ` · найближча ~<b>${assess.minutesToNearest} хв</b>`
        : "";
    lines.push(`На вашу точку йде: <b>${assess.inboundCount}</b>${eta}`);
    lines.push("");
  }

  const near = assess.nearest.slice(0, 5);
  if (near.length === 0) {
    lines.push(`У радіусі ${radiusKm} км нічого не бачимо.`);
    // «У радіусі нічого» не те саме, що «в країні нічого». Один рядок
    // різниці — щоб спокій не читався як сліпота.
    if (assess.nearestBeyondKm != null) {
      lines.push(`<i>Найближча ціль — за ${assess.nearestBeyondKm} км, поза вашим радіусом.</i>`);
    }
  } else {
    for (const n of near) lines.push(threatLine(n));
  }

  // Що чують люди навколо. Стоїть ПІСЛЯ цілей і окремим блоком, бо це інший
  // клас знання: не спостереження джерел, а збіг свідчень сусідів.
  if (opts.heard) {
    lines.push("");
    lines.push(opts.heard);
  }

  lines.push("");
  if (opts.live) lines.push("<i>📍 точка їде за вами — жива геолокація увімкнена</i>");
  // Застереження одне. Раніше тут стояли два, і друге майже дослівно повторювало
  // перше — повтор читається як шаблон і тому не читається взагалі.
  lines.push("<i>оцінка обстановки за даними OSINT — не радар і не ймовірність влучання</i>");
  return lines.join("\n");
}

/**
 * Саме сповіщення — те, що приходить без запиту.
 *
 * Коротше за картку навмисно: його читають із заблокованого екрана, і кожен
 * зайвий рядок зсуває головне — час — під обріз.
 */
export function renderAlert(
  assess: PersonalAssessment,
  danger: DangerIndex,
  placeLabel: string,
  opts: {
    /** Офіційної тривоги ще немає — ми попереджаємо раніше за сирену. */
    pre?: boolean;
    /** Наскільки цій цілі можна вірити (рядок готує advisory/verifyThreat). */
    trust?: string | null;
  } = {},
): string {
  const lead = assess.nearest.find((n) => n.inbound);
  const type = lead?.threat.type ?? "unknown";
  const head = opts.pre
    ? preAlertHeader()
    : danger.level === "shelter"
      ? "🔴 <b>В УКРИТТЯ</b>"
      : danger.level === "attention"
        ? "🟠 <b>Увага, ціль на вас</b>"
        : "🟡 <b>Рух у вашому напрямку</b>";

  const lines = [`${head} — ${escapeHtml(placeLabel)}`, ""];
  if (lead) {
    /*
     * Час подається вилкою, коли вона широка.
     *
     * Джерело саме каже, з якою точністю знає позицію — від 4 до 45 км. На
     * швидкості шахеда сорок пʼять кілометрів це чверть години, і «~7 хв» у
     * такому разі не оцінка, а випадкове число з інтервалу, подане людині як
     * вимір. Коли вилка вузька, показуємо одне число: зайва точність у тексті,
     * який читають о третій ночі, коштує дорожче за свою користь.
     */
    const r = lead.etaRangeMin;
    const timePart =
      r && r[1] - r[0] >= 3
        ? ` · <b>${r[0]}–${r[1]} хв</b>`
        : lead.etaMin != null
          ? ` · <b>~${lead.etaMin} хв</b>`
          : "";
    lines.push(
      `${TYPE_EMOJI[type]} ${TYPE_NAME[type]}: ${lead.distanceKm} км на ${compass(lead.bearingToThreat)}` +
        timePart,
    );
    /*
     * Чим підкріплений цей рядок — словами джерела, а не нашими.
     *
     * «Підтверджена, ±4 км» і «не підтверджена, ±45 км, курс припущений» — це
     * два різні рішення для людини, і досі вони виглядали однаково. Мовчання
     * джерела лишається мовчанням: порожній рядок не друкуємо.
     */
    const quality = qualityLine(lead.threat.quality ?? EMPTY_QUALITY);
    const speed = lead.speedMeasured ? "швидкість заміряна" : "";
    const detail = [quality, speed].filter(Boolean).join(" · ");
    if (detail) lines.push(`<i>${escapeHtml(detail)}</i>`);
  }
  if (assess.inboundCount > 1) lines.push(`Усього на вашу точку: ${assess.inboundCount}`);
  // Наскільки цьому вірити — у самому сповіщенні, а не в довідці. Людина, яку
  // підняли о третій ночі, має бачити підставу відразу: «три незалежні канали»
  // і «одне непідтверджене повідомлення» — це різні рішення.
  if (opts.trust) lines.push(`<i>${escapeHtml(opts.trust)}</i>`);
  lines.push("");
  lines.push(
    opts.pre ? preAlertFooter() : "<i>за даними OSINT · офіційний відбій дають Повітряні Сили</i>",
  );
  return lines.join("\n");
}

/**
 * Точки ще немає.
 *
 * Текст переписано після скарги «натиснув кнопку поділитись локацією — нічого
 * не сталося». Раніше він вів до ОДНОГО способу — кнопки `request_location`,
 * яка на компʼютері показується, але не робить нічого: джерела координат там
 * немає. Людина лишалась без жодного шляху вперед і без пояснення.
 *
 * Тепер першим іде спосіб, який працює скрізь і без дозволів (кнопки з
 * областями), а точніші — поруч, із чесною позначкою, де саме вони працюють.
 */
export function renderAskPoint(): string {
  return [
    "🎯 <b>Персональний радар</b>",
    "",
    "Скажіть, де ви, — і бот рахуватиме не «цілі над країною», а те, що йде саме на вашу точку: напрямок, відстань, хвилини.",
    "",
    "<b>Оберіть область кнопками нижче</b> — це працює на будь-якому пристрої й не питає жодних дозволів.",
    "",
    "Точніше (і краще):",
    "📱 <b>телефон</b> — кнопка «📍 Точніше» нижче, один дотик;",
    "💻 <b>компʼютер</b> — 📎 → <b>Локація</b> → вибрати точку на карті;",
    "⌨️ будь-де — напишіть <code>/my Харків</code>.",
    "",
    "<i>Координати зберігаються лише для розрахунку відстані. Адреси ми не знаємо й не питаємо.</i>",
  ].join("\n");
}

/**
 * Підказка після вибору області.
 *
 * Центр області — орієнтир на десятки кілометрів. Мовчати про це означало б
 * дати людині радіус 50 км від точки, яка може бути за 120 км від неї, і не
 * сказати, що з цим робити.
 */
export function renderOblastPicked(name: string): string {
  return [
    `✅ Область: <b>${escapeHtml(name)}</b>`,
    "",
    "<i>Точка — центр області, це орієнтир на десятки кілометрів. Щоб рахувало саме для вас, надішліть геолокацію: на телефоні кнопкою «📍 Точніше», на компʼютері 📎 → Локація.</i>",
  ].join("\n");
}

export interface PersonalButton {
  text: string;
  callback_data: string;
}

/** Кнопка «точніше» під вибором області — веде до запиту геолокації. */
export function preciseButton(): PersonalButton {
  return { text: "📍 Точніше — моя геолокація", callback_data: PERSONAL_ACTIONS.wantGeo };
}

/** Клавіатура з проханням геолокації — приймається лише в приватному чаті. */
export function locationKeyboard(chatType: string):
  | {
      keyboard: { text: string; request_location: boolean }[][];
      resize_keyboard: boolean;
      one_time_keyboard: boolean;
    }
  | undefined {
  if (chatType !== "private") return undefined;
  return {
    keyboard: [[{ text: "📍 Надіслати мою точку", request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

/* ─── Налаштування ──────────────────────────────────────────────────────── */

const TIER_LABEL: Record<AlertTier, string> = {
  critical: "лише ракети, балістика, КАБи",
  inbound: "усе, що йде на мене",
  all: "усе поблизу",
};

const NIGHT_LABEL: Record<NightMode, string> = {
  critical: "лише критичне",
  all: "усе, як удень",
  silent: "тиша",
};

export function renderSettings(sub: Subscriber): string {
  return [
    "⚙️ <b>Налаштування радара</b>",
    "",
    `Точка: ${sub.point ? `<b>${escapeHtml(sub.point.label)}</b>` : "<b>не задана</b>"}`,
    `Радіус: <b>${sub.radiusKm} км</b>`,
    `Поріг часу: <b>${sub.leadMin != null ? `будити за ≤${sub.leadMin} хв льоту` : "за радіусом"}</b>`,
    `Будити: <b>${TIER_LABEL[sub.tier]}</b>`,
    `Уночі (23:00–07:00): <b>${NIGHT_LABEL[sub.night]}</b>`,
    `Сповіщення: <b>${sub.muted ? "на паузі" : "увімкнені"}</b>`,
    "",
    "<i>Нічний режим лише звужує денний — він ніколи не розбудить вас тим, чого ви не просили вдень.</i>",
  ].join("\n");
}

export const PERSONAL_ACTIONS = {
  refresh: "pv",
  settings: "st",
  soundMenu: "snd",
  wantGeo: "geo",
  soundPrefix: "snd:",
  imOk: "ok",
  tierPrefix: "t:",
  nightPrefix: "n:",
  radiusPrefix: "km:",
  mute: "mu:1",
  unmute: "mu:0",
  shelter: "sh",
  share: "shr",
  leadPrefix: "ld:",
} as const;

/** Варіанти порогу «будити за N хв льоту». `off` — вимкнено (вирішує радіус). */
const LEAD_OPTIONS: (number | "off")[] = ["off", 5, 10, 15];

/** Кнопки налаштувань. Показують ДІЮ, а не поточний стан — як в адмінпанелі. */
export function settingsKeyboard(sub: Subscriber): { inline_keyboard: PersonalButton[][] } {
  const tiers: AlertTier[] = ["critical", "inbound", "all"];
  const nights: NightMode[] = ["silent", "critical", "all"];
  const radii = [25, 50, 100];
  return {
    inline_keyboard: [
      tiers.map((t) => ({
        text: `${sub.tier === t ? "✅ " : ""}${t === "critical" ? "Ракети" : t === "inbound" ? "На мене" : "Усе"}`,
        callback_data: `${PERSONAL_ACTIONS.tierPrefix}${t}`,
      })),
      nights.map((n) => ({
        text: `${sub.night === n ? "✅ " : ""}Ніч: ${n === "silent" ? "тиша" : n === "critical" ? "критичне" : "усе"}`,
        callback_data: `${PERSONAL_ACTIONS.nightPrefix}${n}`,
      })),
      radii.map((km) => ({
        text: `${sub.radiusKm === km ? "✅ " : ""}${km} км`,
        callback_data: `${PERSONAL_ACTIONS.radiusPrefix}${km}`,
      })),
      LEAD_OPTIONS.map((opt) => {
        const current = (sub.leadMin ?? null) === (opt === "off" ? null : opt);
        return {
          text: `${current ? "✅ " : ""}${opt === "off" ? "За радіусом" : `≤${opt} хв`}`,
          callback_data: `${PERSONAL_ACTIONS.leadPrefix}${opt}`,
        };
      }),
      [
        sub.muted
          ? { text: "🔔 Увімкнути сповіщення", callback_data: PERSONAL_ACTIONS.unmute }
          : { text: "🔕 Пауза", callback_data: PERSONAL_ACTIONS.mute },
        { text: "🔄 Оновити", callback_data: PERSONAL_ACTIONS.refresh },
      ],
    ],
  };
}

/** Розбір натискання. `null` — кнопка не наша (це нормально, їх кілька наборів). */
export function parsePersonalAction(
  data: string,
):
  | { kind: "refresh" }
  | { kind: "settings" }
  | { kind: "soundMenu" }
  | { kind: "wantGeo" }
  | { kind: "sound"; value: SoundKind }
  | { kind: "imOk" }
  | { kind: "tier"; value: AlertTier }
  | { kind: "night"; value: NightMode }
  | { kind: "radius"; value: number }
  | { kind: "mute"; value: boolean }
  | { kind: "shelter" }
  | { kind: "share" }
  | { kind: "lead"; value: number | null }
  | null {
  if (data === PERSONAL_ACTIONS.refresh) return { kind: "refresh" };
  if (data === PERSONAL_ACTIONS.settings) return { kind: "settings" };
  if (data === PERSONAL_ACTIONS.soundMenu) return { kind: "soundMenu" };
  if (data === PERSONAL_ACTIONS.wantGeo) return { kind: "wantGeo" };
  if (data === PERSONAL_ACTIONS.imOk) return { kind: "imOk" };
  if (data === PERSONAL_ACTIONS.shelter) return { kind: "shelter" };
  if (data === PERSONAL_ACTIONS.share) return { kind: "share" };
  if (data.startsWith(PERSONAL_ACTIONS.soundPrefix)) {
    const v = data.slice(PERSONAL_ACTIONS.soundPrefix.length);
    return v === "drone" || v === "explosion" || v === "air-defence"
      ? { kind: "sound", value: v }
      : null;
  }
  if (data === PERSONAL_ACTIONS.mute) return { kind: "mute", value: true };
  if (data === PERSONAL_ACTIONS.unmute) return { kind: "mute", value: false };
  if (data.startsWith(PERSONAL_ACTIONS.tierPrefix)) {
    const v = data.slice(PERSONAL_ACTIONS.tierPrefix.length);
    return v === "critical" || v === "inbound" || v === "all" ? { kind: "tier", value: v } : null;
  }
  if (data.startsWith(PERSONAL_ACTIONS.nightPrefix)) {
    const v = data.slice(PERSONAL_ACTIONS.nightPrefix.length);
    return v === "critical" || v === "all" || v === "silent" ? { kind: "night", value: v } : null;
  }
  if (data.startsWith(PERSONAL_ACTIONS.radiusPrefix)) {
    const n = Number(data.slice(PERSONAL_ACTIONS.radiusPrefix.length));
    return Number.isFinite(n) ? { kind: "radius", value: n } : null;
  }
  if (data.startsWith(PERSONAL_ACTIONS.leadPrefix)) {
    const v = data.slice(PERSONAL_ACTIONS.leadPrefix.length);
    if (v === "off") return { kind: "lead", value: null };
    const n = Number(v);
    return Number.isFinite(n) ? { kind: "lead", value: n } : null;
  }
  return null;
}

/** Підтвердження після збереження точки — і одразу перша картка. */
export function renderPointSaved(label: string, radiusKm = DEFAULT_RADIUS_KM): string {
  return [
    `✅ Точку збережено: <b>${escapeHtml(label)}</b>`,
    "",
    `Радіус спостереження — ${radiusKm} км. Тепер бот сам напише, коли на вас піде ціль.`,
    "",
    "/my — подивитись зараз · /settings — налаштувати · /stop — пауза",
  ].join("\n");
}

/**
 * Кнопки під карткою /my.
 *
 * «Чую» стоїть у першому ряду навмисно: доклад має коштувати один дотик у ту
 * саму секунду, коли людина щось почула. Кнопка, заради якої треба згадати
 * команду, не буде натиснута ніколи — а разом із нею не буде й даних.
 */
export function personalKeyboard(opts: { withOk?: boolean } = {}): {
  inline_keyboard: PersonalButton[][];
} {
  const rows: PersonalButton[][] = [
    /*
     * «Куди сховатися» стоїть першим рядком і окремо.
     *
     * Це єдина кнопка, яка відповідає на питання, з яким людина відкриває
     * бота під тривогою. Решта — про обстановку, і вони важливі потім.
     */
    [{ text: "🛡 Куди сховатися", callback_data: PERSONAL_ACTIONS.shelter }],
    [
      { text: "👂 Чую", callback_data: PERSONAL_ACTIONS.soundMenu },
      { text: "🔄 Оновити", callback_data: PERSONAL_ACTIONS.refresh },
      { text: "⚙️", callback_data: PERSONAL_ACTIONS.settings },
    ],
    // Окремим рядком: картку обстановки пересилають рідним, і разом із нею їде
    // посилання на бота — головний канал росту, не реклама.
    [{ text: "📤 Поділитися обстановкою", callback_data: PERSONAL_ACTIONS.share }],
  ];
  if (opts.withOk) {
    rows.unshift([{ text: "✅ Я в порядку", callback_data: PERSONAL_ACTIONS.imOk }]);
  }
  return { inline_keyboard: rows };
}

/** Що саме чути. Три варіанти — більше людина не читатиме під тривогою. */
export function soundKeyboard(): { inline_keyboard: PersonalButton[][] } {
  return {
    inline_keyboard: [
      [
        { text: "🛸 Дрон", callback_data: `${PERSONAL_ACTIONS.soundPrefix}drone` },
        { text: "💥 Вибухи", callback_data: `${PERSONAL_ACTIONS.soundPrefix}explosion` },
        { text: "🛡 ППО", callback_data: `${PERSONAL_ACTIONS.soundPrefix}air-defence` },
      ],
      [{ text: "← Назад", callback_data: PERSONAL_ACTIONS.refresh }],
    ],
  };
}

/**
 * Список укриттів для людини.
 *
 * Найближче — перше й окремим рядком, бо під тривогою читають один рядок.
 * Кожен вид названо чесно: метро це метро, паркінг це паркінг, і жодне з них
 * не видається за обладнане укриття, якщо воно ним не є.
 *
 * Координати даються посиланням на карту, а не текстом: людині треба дійти,
 * а не запамʼятати число.
 */
export function renderShelters(
  list: readonly NearbyShelter[],
  caveat: string,
  degraded = false,
): string {
  if (!list.length) {
    return [
      // «Не відповіло» і «нічого немає» — різні речення. Друге стверджує про
      // світ те, чого ми не знаємо, і людина може на цьому збудувати рішення.
      degraded ? "🛡 <b>Джерело не відповіло</b>" : "🛡 <b>Поруч нічого не знайдено</b>",
      "",
      escapeHtml(caveat),
      "",
      "<i>Найбезпечніше з доступного просто зараз — внутрішня кімната без вікон,",
      "коридор чи ванна: дві стіни між вами й вулицею.</i>",
    ].join("\n");
  }

  const lines = ["🛡 <b>Куди сховатися</b>", ""];
  for (const s of list) {
    const where = `<a href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}">на карті</a>`;
    lines.push(
      `${KIND_EMOJI[s.kind]} <b>${escapeHtml(s.name)}</b> — ${s.walkMin} хв пішки (${s.distanceKm} км) · ${where}`,
    );
    lines.push(`<i>${escapeHtml(KIND_NOTE[s.kind])}</i>`);
  }
  lines.push("");
  lines.push(`<i>${escapeHtml(caveat)}</i>`);
  return lines.join("\n");
}
