import type { SourceRole } from "./source-credibility";

/**
 * OSINT-канали з їхньою роллю в цьому переліку.
 *
 * Роль — структурний факт про наш список, а не оцінка видання: канал доданий
 * сюди як такий, що веде спостереження за повітряною обстановкою, як
 * регіональний або як загальний новинний. Раніше це саме розділення стояло
 * коментарями, тобто було відоме людині й недоступне коду, і всі канали
 * важили однаково — позначка з одного загальноновинного каналу давала той
 * самий рівень, що й позначка від трьох каналів спостереження при активній
 * тривозі (див. `src/lib/source-credibility.ts`).
 */
const TG_SOURCES: { channel: string; role: SourceRole }[] = [
  // Спостереження за повітряною обстановкою — первинні повідомлення.
  { channel: "kpszsu", role: "watch" },
  { channel: "radar_top_ua", role: "watch" },
  { channel: "kudy_letyt", role: "watch" },
  { channel: "eRadarrua", role: "watch" },
  { channel: "kyivradar", role: "watch" },
  { channel: "air_alert_ua", role: "watch" },
  { channel: "raketna_neb", role: "watch" },
  { channel: "radarkherson", role: "watch" },
  { channel: "RadarDnepr", role: "watch" },
  { channel: "radar_zp", role: "watch" },
  { channel: "tro545fd", role: "watch" },
  // Регіональні.
  { channel: "real_kyiv", role: "regional" },
  { channel: "kyiv_operativ", role: "regional" },
  { channel: "kyiv_n", role: "regional" },
  { channel: "kievinfo", role: "regional" },
  { channel: "dnepr_operativ", role: "regional" },
  { channel: "truexazaporozie", role: "regional" },
  { channel: "kharkivlife", role: "regional" },
  { channel: "truexakharkiv", role: "regional" },
  { channel: "kharkivtypical", role: "regional" },
  { channel: "kharkiv_1654", role: "regional" },
  { channel: "lvivtruexa", role: "regional" },
  { channel: "truexalviv", role: "regional" },
  { channel: "lviv24x7", role: "regional" },
  { channel: "lvivmedia", role: "regional" },
  { channel: "volynnews", role: "regional" },
  { channel: "odessa_inform", role: "regional" },
  { channel: "our_odessa", role: "regional" },
  { channel: "odessa_infonews", role: "regional" },
  { channel: "inform_odesa", role: "regional" },
  { channel: "temporis_odesa", role: "regional" },
  { channel: "vanek_nikolaev", role: "regional" },
  /*
   * Канали, знайдені ЗАМІРОМ, а не з памʼяті.
   *
   * Прочесано живу видачу другого агрегатора (detoyshahed, 2026-09-17, 222
   * повідомлення): з десяти каналів, що реально наповнюють стрічку повітряних
   * подій, у переліку були лише пʼять. **176 повідомлень із 222 — 79% —
   * приходили від каналів, яких цей файл не знав.** Найактивніший із них,
   * `chyste_nebo`, дав 80 повідомлень: більше за всі відомі нам канали разом.
   *
   * Ціна цього була не косметична. Невідома роль дає `reliability: "F"`
   * («надійність невідома»), а в `verifyThreat` вимикає `knownSource`, через
   * що одиночне повідомлення спеціалізованого каналу спостереження ставало
   * «непідтвердженим». Тобто ми самі знецінювали дані, на яких працюємо, — і
   * перехресне підтвердження, додане напередодні, підставляло в `sources` саме
   * ці незнайомі імена.
   *
   * Роль призначено з того, що можна перевірити: ці канали публікують ПЕРВИННІ
   * повідомлення про повітряні цілі — інакше вони не потрапили б у стрічку
   * повітряних подій, — а їхні назви прямо називають призначення. Це
   * структурний факт про наш перелік, а не оцінка видання: якщо виявиться, що
   * канал переказує чуже, роль треба знизити, і замір вище лишається тут саме
   * для того, щоб таке рішення можна було перевірити, а не прийняти на віру.
   */
  { channel: "chyste_nebo", role: "watch" },
  { channel: "chyste_nebochernigv", role: "watch" },
  { channel: "UkraineAlarmSignal", role: "watch" },
  // Назва приходить із пробілом і емодзі — `roleOfSource` зіставляє за
  // обрізаним нижнім регістром, тож пишемо її рівно так, як віддає джерело.
  { channel: "Kyiv AirDefense 🌇", role: "watch" },
  // Загальні.
  { channel: "novyny_live", role: "general" },
  { channel: "truexanewsua", role: "general" },
  /*
   * Ширший розвідувальний канал, а не монітор неба: у стрічці зʼявляється, але
   * призначення в нього загальніше. Ставимо нижчу роль свідомо — завищити
   * надійність гірше, ніж недооцінити.
   */
  { channel: "Ukrainian_Intelligence", role: "general" },
];

export const TG_CHANNELS = TG_SOURCES.map((entry) => entry.channel);

const ROLE_BY_CHANNEL = new Map(
  TG_SOURCES.map((entry) => [entry.channel.toLowerCase(), entry.role]),
);

/**
 * Роль каналу. Невідомий канал лишається `unknown`, а не прирівнюється до
 * найгіршого: це різні речі, і плутати їх означало б глушити все, що приходить
 * із-поза цього переліку.
 */
export function roleOfSource(source: string): SourceRole {
  return ROLE_BY_CHANNEL.get(source.trim().toLowerCase()) ?? "unknown";
}
