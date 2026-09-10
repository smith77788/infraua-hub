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
  // Загальні.
  { channel: "novyny_live", role: "general" },
  { channel: "truexanewsua", role: "general" },
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
