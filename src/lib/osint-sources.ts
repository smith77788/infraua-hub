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
  // Додано на прохання користувача (t.me/radarrv2025). Роль `watch` — за
  // структурною ознакою, спільною з рештою `radar*`: назва прямо називає
  // радарне спостереження за повітряною обстановкою, а не переказ новин. Якщо
  // виявиться, що канал переказує чуже, роль знизити — як і для решти переліку.
  { channel: "radarrv2025", role: "watch" },
  /*
   * Рівненщина, другий канал. Додано на прохання користувача, але не за тим
   * посиланням, яке він дав: t.me/rivne_1283_chat — це ГРУПА обговорення
   * («Обговорення», 12 596 учасників), а не канал. Перевірено запитом:
   * t.me/s/rivne_1283_chat віддає 302 і нуль дописів, тобто наш збирач
   * (`t.me/s/<канал>` у fetchThreatTypesByPlace) не прочитав би з неї нічого
   * ніколи — джерело мовчало б, а в переліку виглядало б робочим. Тому додано
   * канал, при якому та група живе.
   *
   * Роль `watch` — не за назвою, а за вибіркою: у превʼю 30 дописів, і це
   * первинні спостереження з курсом і пунктом («Реактивні БпЛА на Житомирщині,
   * повз н.п. Олевськ курсом на Рівненщину → Сарни»; «Рівненщина: реактивний
   * БпЛА повз Дубровицю, курс західний»), а не переказ чужих повідомлень.
   * Трапляються й побутові дописи — якщо переказу стане більше за спостереження,
   * роль знизити до `regional`.
   */
  { channel: "rivne_1283", role: "watch" },
  /*
   * Джерела, на яких працює Нептун — перелік зі сторінки «Джерела даних»
   * neptun.in.ua (знімки користувача, 2026-10-21).
   *
   * Не переписано з фото, а ПЕРЕВІРЕНО запитом до публічного превʼю кожного
   * (2026-10-21): 81 із 82 відкрились і живі (найдавніший останній допис —
   * 32 год); `totalizrada` з фото не існує — правильно `totallzrada`.
   *
   * Роль — з категорії Нептуна й заміру, а не з назви навмання: офіційні й
   * агрегатори — `watch`; розвідка — `general` (як уже стоїть
   * Ukrainian_Intelligence); локальні — `watch`, якщо ≥ 40% дописів про
   * повітряні цілі АБО назва прямо про небо (радар / моніторинг / небо / ППО /
   * тривога / шахед), інакше `regional`. Друга умова — не поблажка: трекери на
   * кшталт RADAR.RIVNE пишуть самі назви сіл («Гоща»), і словниковий замір їх
   * недооцінює (kyiv_airdef — 10%, Radar_Dnipra — 15%).
   *
   * У коментарі кожного — частка повітряних дописів і давність останнього на
   * момент заміру, щоб роль можна було перевірити, а не прийняти на віру.
   */
  { channel: "rozvidkaneba", role: "general" }, // розвідка; повітря 100%, ост. 0 год
  { channel: "monikppy", role: "watch" }, // агрегатор; повітря 75%, ост. 0.2 год
  { channel: "monitor_ukr", role: "watch" }, // агрегатор; повітря 80%, ост. 0.4 год
  { channel: "newspn", role: "watch" }, // агрегатор; повітря 44%, ост. 0.2 год
  { channel: "povitryanatrivogaaa", role: "watch" }, // агрегатор; повітря 50%, ост. 0.1 год
  { channel: "radar_raketaa", role: "watch" }, // агрегатор; повітря 80%, ост. 0.1 год
  { channel: "raketa_trevoga", role: "watch" }, // агрегатор; повітря 100%, ост. 0.2 год
  { channel: "sectorv666", role: "watch" }, // агрегатор; повітря 95%, ост. 0.1 год
  { channel: "totallzrada", role: "watch" }, // агрегатор; повітря 10%, ост. 0.2 год
  { channel: "UkraineRadar_24_7", role: "watch" }, // агрегатор; повітря 25%, ост. 0.1 год
  { channel: "veselyy_pivden", role: "watch" }, // агрегатор; повітря 50%, ост. 2.6 год
  { channel: "vibuxaviasia", role: "watch" }, // агрегатор; повітря 75%, ост. 0.7 год
  { channel: "war_monitor", role: "watch" }, // агрегатор; повітря 82%, ост. 21.6 год
  { channel: "monitoring_zaxid", role: "watch" }, // агрегатор; повітря 45%, ост. 0 год
  { channel: "rocket_danger_lviv", role: "watch" }, // агрегатор; повітря 10%, ост. 0.1 год
  { channel: "zahidnimonitoring", role: "watch" }, // локальний «Західний Моніторинг📡»; повітря 16%, ост. 0.4 год
  { channel: "vin_info_ppo", role: "watch" }, // локальний «ППО🫡 у Вінницькій області»; повітря 26%, ост. 0 год
  { channel: "dnepr_nagladach", role: "watch" }, // локальний «Наглядач Днепра»; повітря 10%, ост. 0 год
  { channel: "dnipro_alerts", role: "watch" }, // локальний «Дніпро Alerts 🚀 🚨»; повітря 50%, ост. 0 год
  { channel: "nikalert", role: "watch" }, // локальний «ТРИВОГА Нікополь DNiPRO»; повітря 70%, ост. 0 год
  { channel: "Radar_Dnipra", role: "watch" }, // локальний «⚡️Радар Дніпра⚡️»; повітря 15%, ост. 0.1 год
  { channel: "shovnebi", role: "watch" }, // локальний «Шо там в небі»; повітря 26%, ост. 0 год
  { channel: "kramatorsk_radar", role: "watch" }, // локальний «КРАМ РАДАР 🚀🚨»; повітря 80%, ост. 0.1 год
  { channel: "operatyvnyi_donbas", role: "regional" }, // локальний «Донбас Оперативний»; повітря 6%, ост. 0.3 год
  { channel: "korostentoday", role: "regional" }, // локальний «КОРОСТЕНЬ today:»; повітря 15%, ост. 0.2 год
  { channel: "eyes_everywhere_ua", role: "regional" }, // локальний «▵ 👁Очі Всюди🇺🇦▵»; повітря 26%, ост. 0 год
  { channel: "gnilayachereha", role: "watch" }, // локальний «∆✙🍒Гнила черешня🇺🇦✙∆»; повітря 50%, ост. 0 год
  { channel: "info_zp", role: "regional" }, // локальний «ЗАПОРІЖЖЯ.ІНФО🍁»; повітря 18%, ост. 0 год
  { channel: "operatyvnohlep", role: "regional" }, // локальний «Оперативно → by HLEP»; повітря 25%, ост. 0 год
  { channel: "zaborzp", role: "watch" }, // локальний «ЗаБор Запоріжжя»; повітря 67%, ост. 0.5 год
  { channel: "Northern_Sich_ukr", role: "watch" }, // локальний «Північний Сич 🦉»; повітря 100%, ост. 0.1 год
  { channel: "kievinform_ua1", role: "watch" }, // локальний «Київ ІНФО - LIVE | радар»; повітря 70%, ост. 1 год
  { channel: "kyiv_nebo", role: "watch" }, // локальний «Київське небо 🌌»; повітря 10%, ост. 0.1 год
  { channel: "krop_vanek", role: "regional" }, // локальний «Кропивницький Ваньок»; повітря 28%, ост. 0 год
  { channel: "pivden_FPV", role: "watch" }, // локальний «Вартові Півдня Фпв/Молнія»; повітря 15%, ост. 1.1 год
  { channel: "korabely_media", role: "watch" }, // локальний «КОРАБЕЛИ»; повітря 78%, ост. 0.2 год
  { channel: "Shturval_media", role: "watch" }, // локальний «Штурвал ⚓️»; повітря 40%, ост. 0.1 год
  { channel: "odessa_knight", role: "watch" }, // локальний «Темный Рыцарь»; повітря 50%, ост. 0 год
  { channel: "odessaveter", role: "watch" }, // локальний «Одесский Ветер ⚓️🌪 | Одесса»; повітря 65%, ост. 0 год
  { channel: "ReniHub", role: "regional" }, // локальний «ReniHub | Одещина | інформацій»; повітря 22%, ост. 16.9 год
  { channel: "kremen_sv", role: "regional" }, // локальний «Кременчуцький Миколай»; повітря 10%, ост. 0.2 год
  { channel: "PoltavaRadar", role: "watch" }, // локальний «Полтава радар | Radar Poltava»; повітря 60%, ост. 0.4 год
  { channel: "PoltavaRanger", role: "watch" }, // локальний «Тривога Полтавщини»; повітря 31%, ост. 0.6 год
  { channel: "ppopoltavanightfighters", role: "watch" }, // локальний «ППО Полтава Нічні мисливці»; повітря 100%, ост. 0.4 год
  { channel: "pivden_varta", role: "watch" }, // локальний «Вартові Півдня 🔱»; повітря 70%, ост. 0 год
  { channel: "krolevetsnews", role: "watch" }, // локальний «△ Кролевець today»; повітря 45%, ост. 0.1 год
  { channel: "rdsprostir", role: "watch" }, // локальний «RDS-prostir»; повітря 80%, ост. 0.1 год
  { channel: "sumygo", role: "watch" }, // локальний «СУМИ / SUMY GO ∆»; повітря 40%, ост. 0.1 год
  { channel: "sumyregion", role: "watch" }, // локальний «Sumyregion △»; повітря 85%, ост. 0.1 год
  { channel: "svessainfo", role: "watch" }, // локальний «Свеса△INFО»; повітря 75%, ост. 0.2 год
  { channel: "cxidua", role: "watch" }, // локальний «CXID ♾️ Харків | СХІД | СХИД»; повітря 85%, ост. 0 год
  { channel: "Karkivw", role: "watch" }, // локальний «Харківський Простір Онлайн»; повітря 40%, ост. 0 год
  { channel: "kharkov_media", role: "watch" }, // локальний «Харьков INFO | 24/7 Свет | Гра»; повітря 75%, ост. 0 год
  { channel: "kuptg", role: "watch" }, // локальний «Куп'янськ Телеграм / Kupyansk »; повітря 60%, ост. 0.8 год
  { channel: "monitor1654", role: "watch" }, // локальний «monitor 1654 | Харків»; повітря 60%, ост. 0.3 год
  { channel: "Nablydatel_Dozor", role: "watch" }, // локальний «Наблюдатель🧐 Харьков»; повітря 83%, ост. 0.3 год
  { channel: "place_kharkiv", role: "regional" }, // локальний «Де у Харкові | Харків»; повітря 19%, ост. 0.9 год
  { channel: "tlknewsua", role: "regional" }, // локальний «TLk News»; повітря 15%, ост. 0.1 год
  { channel: "kherson_monitoring", role: "watch" }, // локальний «Херсонщина Моніторинг🇺🇦»; повітря 70%, ост. 0.7 год
  { channel: "kherson_non_drone", role: "watch" }, // локальний «ХЕРСОН: Воздух / БПЛА»; повітря 100%, ост. 0.2 год
  { channel: "cherkasy_nebbo", role: "watch" }, // локальний «Черкаське небо 🫡»; повітря 20%, ост. 1.4 год
  { channel: "horizon_of_war_Official", role: "watch" }, // локальний «🍁 • Горизонт Війни | Моніторин»; повітря 95%, ост. 0.1 год
  { channel: "my_safety_Chernigiv", role: "watch" }, // локальний «SafetyChe🍁⛈»; повітря 55%, ост. 0 год
  { channel: "PhantomChe", role: "watch" }, // локальний «Чернігівський Фантом»; повітря 80%, ост. 0.1 год
  { channel: "RadarChernihiv", role: "watch" }, // локальний «Чернігівський Моніторинг»; повітря 60%, ост. 1.1 год
  { channel: "ShahedChernihiv", role: "watch" }, // локальний «👁‍🗨 єШахед Чернігів | Чернігів»; повітря 61%, ост. 1.7 год
  { channel: "taktychna_rukavuchkaa", role: "watch" }, // локальний «Тактична Рукавичка/НІЖИН»; повітря 41%, ост. 0.3 год
  { channel: "kyiv_airdef", role: "watch" }, // локальний «Kyiv AirDefense 🌇»; повітря 10%, ост. 0 год
  { channel: "monitoring_kyiv", role: "watch" }, // локальний «Київ Моніторинг | Оперативно»; повітря 57%, ост. 4.6 год
  { channel: "shahedradar", role: "watch" }, // локальний «SkyOps Радар»; повітря 15%, ост. 0.9 год

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

/**
 * Російські канали — ЛИШЕ як джерело пусків (`launch-sightings`).
 *
 * ## Як знайдено й чому лише ці
 *
 * Не з памʼяті: кандидатів зібрано пошуком і з посилань перевірених каналів,
 * а КОЖЕН перевірено запитом до публічного превʼю t.me/s/<канал>
 * (2026-10-21): чи існує превʼю (групи його не мають), частка російськомовних
 * постів, давність останнього, частка постів про БПЛА / пуски / вибухи / ППО.
 * Відкинуто: без превʼю або неіснуючі (chp_eisk, Strategic_AviaControl,
 * novosti_yeisk та ін.), мертві понад 7 днів (TPK_ATV, millerovo_live,
 * podslushano_feodosia та ін.), пародійні («Настоящий Гладков»), загальні
 * федеральні (mod_russia, rybar, astrapress — про пуски по Україні не пишуть).
 *
 * ## Чого вони НЕ роблять
 *
 * Замір чесно показав: офіційні канали пишуть про НАШІ дрони над їхньою
 * територією («над Воронежем уничтожены 14 БПЛА»), місцеві — про побут; на
 * момент заміру жодного повідомлення про власні запуски. Тож вони не входять у
 * `TG_SOURCES`: не впливають ні на тип цілі, ні на підтвердження цілей в
 * Україні — російський канал не може «підтвердити» шахед над Києвом. Їх читає
 * тільки детектор пусків, із суворішими правилами (дієслово пуску зі зброєю
 * поряд; повідомлення про атаки ЗСУ відкидаються) і з позначкою «за
 * російським джерелом» у картці. Якщо жителі Ахтарів напишуть «опять
 * запуски» — це буде пуск із їхнього району; якщо ні — вони мовчать, а не
 * шумлять.
 *
 * `home` — район пусків, до якого канал «прив'язаний»: місцеві пишуть «опять
 * запуски», не називаючи власного міста. Без `home` пуск зараховується лише
 * тоді, коли район названо в тексті.
 */
export const RU_LAUNCH_SOURCES: readonly { channel: string; home?: string }[] = [
  // Офіційні (оперштаби / губернатори регіонів пусків і прикордоння).
  { channel: "opershtab23" }, // Оперштаб Краснодарського краю: Приморсько-Ахтарськ, Єйськ
  { channel: "gubernator_46", home: "kursk" }, // Оперштаб Курської області
  { channel: "gusev_36", home: "voronezh" }, // губернатор Воронезької області
  { channel: "razvozhaev", home: "crimea" }, // окупований Севастополь
  // Місцеві міст пусків.
  { channel: "AhtariLive", home: "primorsko" }, // Приморсько-Ахтарськ
  { channel: "pve_123", home: "yeysk" }, // «Подслушано в Ейске»
  { channel: "taganrogonline", home: "taganrog" },
  { channel: "barakholka57", home: "orel" }, // «Новости Орел»
  { channel: "Kursk_podslushal", home: "kursk" },
  { channel: "podslushano_kursk46_46", home: "kursk" },
  { channel: "kurskN1", home: "kursk" },
  { channel: "podslushano_feo", home: "crimea" }, // Феодосія — поруч мис Чауда
  { channel: "podsluhano_kerch", home: "crimea" },
  // Прикордоння без «домашнього» району пусків — лише коли район названо.
  { channel: "klintsyregion_32" }, // Клинці, Брянщина
  { channel: "valuykitg" }, // Валуйки, Бєлгородщина
];
