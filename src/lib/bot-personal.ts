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

function threatLine(n: PersonalThreat): string {
  const type = n.threat.type ?? "unknown";
  const dir = compass(n.bearingToThreat);
  const eta = n.etaMin != null ? `, ~${n.etaMin} хв до вас` : "";
  return `${TYPE_EMOJI[type]} ${TYPE_NAME[type]} — ${n.distanceKm} км на ${dir}${n.inbound ? `, <b>іде на вас</b>${eta}` : ""}`;
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
    lines.push(
      `На вашу точку йде: <b>${assess.inboundCount}</b>` +
        (assess.minutesToNearest != null
          ? ` · найближча ~<b>${assess.minutesToNearest} хв</b>`
          : ""),
    );
    lines.push("");
  }

  const near = assess.nearest.slice(0, 5);
  if (near.length === 0) {
    lines.push(`У радіусі ${radiusKm} км нічого не бачимо.`);
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
  lines.push(
    `<i>оцінка за даними OSINT, не радар · ${escapeHtml(danger.caveat.split(".")[0]!)}</i>`,
  );
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
    lines.push(
      `${TYPE_EMOJI[type]} ${TYPE_NAME[type]}: ${lead.distanceKm} км на ${compass(lead.bearingToThreat)}` +
        (lead.etaMin != null ? ` · <b>~${lead.etaMin} хв</b>` : ""),
    );
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

/** Точки ще немає — просимо її одним дотиком, а не інструкцією на абзац. */
export function renderAskPoint(): string {
  return [
    "🎯 <b>Персональний радар</b>",
    "",
    "Скажіть, де ви, — і бот рахуватиме не «цілі над країною», а те, що йде саме на вашу точку: напрямок, відстань, хвилини.",
    "",
    "Кнопка нижче надішле координати одним дотиком. Або просто надішліть геолокацію вкладенням — чи напишіть <code>/my Харків</code>.",
    "",
    "<i>Координати зберігаються лише для розрахунку відстані. Адреси ми не знаємо й не питаємо.</i>",
  ].join("\n");
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
  soundPrefix: "snd:",
  imOk: "ok",
  tierPrefix: "t:",
  nightPrefix: "n:",
  radiusPrefix: "km:",
  mute: "mu:1",
  unmute: "mu:0",
} as const;

export interface PersonalButton {
  text: string;
  callback_data: string;
}

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
  | { kind: "sound"; value: SoundKind }
  | { kind: "imOk" }
  | { kind: "tier"; value: AlertTier }
  | { kind: "night"; value: NightMode }
  | { kind: "radius"; value: number }
  | { kind: "mute"; value: boolean }
  | null {
  if (data === PERSONAL_ACTIONS.refresh) return { kind: "refresh" };
  if (data === PERSONAL_ACTIONS.settings) return { kind: "settings" };
  if (data === PERSONAL_ACTIONS.soundMenu) return { kind: "soundMenu" };
  if (data === PERSONAL_ACTIONS.imOk) return { kind: "imOk" };
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
    [
      { text: "👂 Чую", callback_data: PERSONAL_ACTIONS.soundMenu },
      { text: "🔄 Оновити", callback_data: PERSONAL_ACTIONS.refresh },
      { text: "⚙️", callback_data: PERSONAL_ACTIONS.settings },
    ],
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
