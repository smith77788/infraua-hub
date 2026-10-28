import { classifyThreatType, moreSevereType, type Threat, type ThreatType } from "./air";
import { type Gazetteer, type GeoPlace, normName } from "./gazetteer";
import { distanceKm } from "./infra-types";
import type { ChannelMessage } from "./jet-sightings";
import { isRegionName, oblastAdminIn, oblastDirectionIn } from "./oblast";
import { bearingDeg } from "./threat-eta";

/**
 * Трек цілі з дописів каналів — коли спостерігач веде її по селах.
 *
 * ## Що бачили і чого не ловили
 *
 * RADAR.RIVNE (2026-10-21, живий зріз): «Даничів» → «Великі Межиричі» →
 * «Самостріли/Бокшин» → «Гоща» → «Далі Бабин» → «Відвернув на Бугрин» →
 * «Підліски» → «Мʼятин/Глинки» — точка щохвилини, з точним часом. Система
 * брала позицію лише з Нептуна, який веде позначку по населених пунктах і
 * рухає її рідше (findings #116: 36 із 37 цілей не зрушили за 6,5 хв). А в
 * розборі удару по Рівному 19.10 (#108) Нептун не мав цілі зовсім, хоча той
 * самий канал вів її 16 хвилин поіменно.
 *
 * ## Що розуміємо
 *
 *  - ПОЗИЦІЯ: допис лише з назв («Гоща», «Самостріли/Бокшин»), «Далі X»,
 *    «повз X», «біля X», «над X», «в районі X», «у передмісті X»;
 *  - КУРС: «Відвернув/повернув на X», «маневр на X», «курсом на X», «в
 *    напрямку X», «в бік X», «→ X». Курс НЕ рухає позначку — лише каже, куди.
 *
 * Допис, де поряд із назвою є інші слова без такої підказки («Скинув висоту,
 * Корець Гоща уважно»), позиції не дає: це попередження районам, а не точка.
 *
 * ## Неоднозначність — за близькістю, інакше мовчимо
 *
 * «Федорівок» в Україні 63. Обираємо збіг, найближчий до опори: поточних
 * цілей і попередньої точки того ж каналу; далі `MAX_ANCHOR_KM` — не беремо.
 * Без опори назва має бути єдиною в довіднику. Чого немає в довіднику
 * («Баранів») — того не вгадуємо.
 */

export interface ChannelFix {
  channel: string;
  at: number;
  /** `end` — канал сказав, що ціль зникла / збита: трек закрито. */
  kind: "position" | "course" | "end";
  place: GeoPlace;
  /** Назва так, як її написав канал. */
  said: string;
  type: ThreatType;
  /** Рядок допису — щоб курс із того ж рядка йшов до своєї цілі. */
  line?: number;
}

/** Скільки свіжою має бути точка: далі — це вже історія, а не де ціль. */
export const FIX_WINDOW_MS = 20 * 60_000;
/** Найдальша опора, від якої ще можна вибрати один із однойменних пунктів. */
export const MAX_ANCHOR_KM = 80;
/** Дві точки одного каналу — одна ціль, якщо між ними правдоподібний політ. */
const MAX_LINK_GAP_MS = 15 * 60_000;
const MAX_LINK_KMH = 900;
/** Точку каналу приписуємо цілі Нептуна, якщо вона не далі за це. */
export const MATCH_TARGET_KM = 45;

/*
 * «Пройшов Городню», «після Ріпок», «минув X» — теж місце: ціль уже там.
 * Заміряно 23.10 на UkraineRadar_24_7: «Реактивний на Чернігівщині пройшов
 * Городню, далі курсом на Ріпки» → «після Ріпок змінив курс, тепер на
 * Славутич» — реактивний, якого не мали ні Нептун, ні ми, бо обидві точки
 * трималися на цих словах.
 */
const POSITION_CUE =
  /(?:^|[\s,.:;(])(?:далі|дали|повз|біля|возле|над|в районі|у районі|в районе|в передмісті|у передмісті|поблизу|через|пройшов|пролетів|минув|після|прошел|пролетел|после)\s+(.+)$/i;
/*
 * «Реактивний на Млинів», «2х БпЛА на Чернігів», «шахед на Гощу» — теж курс:
 * так пишуть списки агрегаторів (sectorv666, Ukrainian_Intelligence, 23.10).
 * Голе «на X» без назви апарата перед ним курсом не вважаємо: «на Полтавщині»,
 * «на місто», «на удар».
 */
const COURSE_CUE =
  /(?:^|[\s,.:;(])(?:відвернув на|повернув на|розвернувся на|маневр на|курсом на|курс на|в напрямку|у напрямку|в направлении|в бік|у бік|в сторону|(?:реактив|бпла|шахед|мопед|дрон|герань|бандерол|звичайн|ціл)[\p{L}]*\s+на|→|->)\s*(.+)$/iu;

/**
 * Кінець цілі: короткий допис «зникла», «мінус», «збито», «відбій». Лише
 * короткий — «мінус 2, ще 3 на Київ» продовжує розповідь, а не закриває її.
 * Заміряно на shovnebi, 22.10: «над Вільнянськом» → «зникла» о 17:39, а ціль
 * трималась на карті ще 17 хв і до неї причепився інший FPV за 25 км.
 */
const END_CUE =
  /^(?:зникл[аио]?|зник|пропал[аио]?|мінус|минус|збит[аоиі]й?|збили|знищен[аоиі]й?|уничтожен[аоы]?|сбит[аоы]?|ціль втрачена|втратили|відбій|отбой)(?=$|[\s!.,)])/i;

/** Допис закриває трек: коротка фраза-кінець, без назв і продовження. */
export function isEndOfTarget(text: string): boolean {
  const line = text
    .replace(/[^\p{L}\p{N}\s'’ʼ-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.split(" ").length <= 3 && END_CUE.test(line);
}

/**
 * Дорозвідка — перевірка неба, а не ціль.
 *
 * Канали пишуть «дорозвідка» про ПОВТОРНИЙ огляд після збиття чи падіння:
 * треба переконатися, що в небі справді нікого не лишилось. Тобто слово
 * означає рівно протилежне появі цілі.
 *
 * Заміряно на живому модулі: «Дорозвідка в районі Гощі» давало `position`
 * у Гощі — фантомну ціль саме там, де небо щойно перевіряли на чистоту.
 * `STATUS_WORDS` цього не ловлять: вони прив'язані до цілого рядка, а тут
 * після слова йде пункт, і спрацьовує `POSITION_CUE` («в районі»).
 *
 * Межа навмисно вузька: глушимо рядок ЛИШЕ коли в ньому не названо апарат.
 * «Дорозвідка: БпЛА над Гощею» означає, що перевірка когось ЗНАЙШЛА, і таку
 * ціль ховати не можна. Помилка тут має бути в бік показу загрози.
 */
const SKY_CHECK = /дорозвід/i;

/**
 * Рядок — лише рубрика списку: назва краю й нічого більше.
 *
 * Агрегатори пишуть списками за областями:
 *
 *     🛵 Буковина
 *      - 2 на керованих Новодністровськ
 *
 * «Буковина» тут — заголовок, а не місце цілі. Але в довіднику є однойменне
 * СЕЛО, і рядок «лише з назв» ставив туди позицію. Заміряно 25.10 на 4453
 * рядках свіжих дописів 111 каналів: так сталося 12 разів, і з П'ЯТИ різних
 * каналів (radar_top_ua, kudy_letyt, eRadarrua, rozvidkaneba,
 * povitryanatrivogaaa). Ціль падала в село за сотні кілометрів від справжньої.
 *
 * Гірше, що однакова помилка кількох каналів виглядала як ПІДТВЕРДЖЕННЯ:
 * `corroborated` створює ціль, коли одну точку назвали два канали, — і фантом
 * ставав упевненою ціллю. Звідси на карті «3 шахеди — Буковина».
 *
 * Міста з назвою, співзвучною області («Житомир», «Херсон», «Суми»), сюди не
 * потрапляють: `oblastAdminIn` впізнає лише основи «-щина»/«-ська»/«Буковина»,
 * а не назву обласного центру.
 */
/**
 * Назва пункту в дописі пишеться з великої літери — звичайне слово з малої.
 *
 * У довіднику (GeoNames) повно сіл, названих звичайними словами: Атаки, Село,
 * Південне, Сильне, Площі. І «після вечірньої атаки» з новинного допису
 * ставало ціллю в селі Атаки на Буковині — за сотні кілометрів від Дніпра, про
 * який ішлося.
 *
 * Заміряно 25.10 на 450 остаточних точках 111 каналів: з малої літери — 6.
 * П'ять — сміття («площі», «селом», «села», «атаки», «південь»), один —
 * справжній («Шахед на черноморск», неформальний російськомовний допис). Ціна
 * правила — оцей один, і поруч із Чорноморськом зазвичай уже стоїть ціль
 * джерела. Ціна його відсутності — фантоми будь-де в країні.
 */
function startsCapitalized(said: string): boolean {
  const first = said.match(/\p{L}/u)?.[0];
  return first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase();
}

/**
 * Довгий допис, у якому рядок не називає апарата, — новина, а не зведення.
 *
 * «…російського контролю над Києвом» (804 символи), «режим тиші в районі
 * Олешків» (359) — сигнальні слова «над», «в районі» тут ті самі, що й у
 * зведенні, і кожна новина ставила ціль у названому місті. «Олешків» до того ж
 * знаходився не в Херсонській, а в Івано-Франківській області.
 *
 * Межа — 250 символів, заміряна: з 53 точок із дописів від 250 символів усі
 * справжні — це списки агрегатора, де КОЖЕН рядок називає апарат («Реактивний
 * БпЛА курсом на …»). Короткі ж справжні дописи апарата часто не називають
 * («Тупо транзит над Києвом», 54 символи) — їх правило не зачіпає.
 */
const NEWS_MIN_CHARS = 250;

function isRegionHeadingOnly(line: string): boolean {
  const bare = normName(line.replace(/^[^\p{L}]+/u, ""))
    .replace(/[^\p{L}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (bare.length === 1) return true;
  return bare.length === 2 && /^обл/.test(bare[1]!);
}

/** Рядок — стан області, а не назва пункту («чисто», «тихо», «відбій»). */
const STATUS_WORDS =
  /^(?:поки |все |вже |наразі )?(?:чисто|тихо|спокиино|спокоино|пусто|видбии|отбои|увага|уважно|загроза|без загроз|чисте небо)[\s.!]*$/u;

/** Службові слова, що не заважають «допису лише з назв». */
const FILLER = new Set([
  "і",
  "й",
  "та",
  "и",
  "далі",
  "дали",
  "ще",
  "1",
  "2",
  "3",
  "бпла",
  "шахед",
  "мопед",
]);

/** Слова фрази: як написано (для показу) і нормалізовані (для пошуку). */
function words(s: string): { orig: string[]; norm: string[] } {
  const orig = s
    .replace(/[^\p{L}\p{N}'’ʼ\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
  return { orig, norm: orig.map(normName) };
}

/** Найдовша назва (до 3 слів) з початку фрази: «Великі Межиричі» перед «Великі». */
function leadingPlace(
  w: { orig: string[]; norm: string[] },
  gaz: Gazetteer,
): { places: GeoPlace[]; said: string; used: number } | null {
  for (let n = Math.min(3, w.norm.length); n >= 1; n--) {
    const key = w.norm.slice(0, n).join(" ");
    if (key.length < 3) continue;
    const places = gaz.find(key);
    if (places.length) return { places, said: w.orig.slice(0, n).join(" "), used: n };
  }
  return null;
}

interface Mention {
  kind: "position" | "course";
  places: GeoPlace[];
  said: string;
  /** Номер рядка допису: рядок — одна ціль у списках агрегаторів. */
  line: number;
  /** Тип, названий у самому рядку («звичайний біля Ружина»), або `unknown`. */
  lineType: ThreatType;
  /** Курс на область, а не на пункт: важливіший за «на X» у тому ж рядку. */
  region?: boolean;
}

/**
 * Тип рядка. «Звичайний» у каналах спостереження — це протиставлення
 * реактивному: «Житомирщина: звичайний біля Ружина» під рядками про
 * реактивні — поршневий шахед.
 */
function typeOfLine(line: string): ThreatType {
  if (/(?<![а-яіїєґ])звичайн/i.test(line)) return "shahed";
  return classifyThreatType(line);
}

/**
 * Що каже допис: позиції й курси з кандидатами-пунктами (ще без вибору).
 *
 * Якщо в рядку чи в заголовку над ним названо область («Житомирщина: …»,
 * «на Полтавщині»), кандидатів звужено до неї — коли там хоч один є.
 */
export function mentionsOf(text: string, gaz: Gazetteer): Mention[] {
  const out: Mention[] = [];
  /*
   * Довгий допис, що ЖОДНОГО апарата не називає, — новина чи репортаж, а не
   * зведення. Заміряно 25.10: «Краматорськ / 25 жовтня 2026 року / Внаслідок
   * постійних обстрілів місто…» (eRadarrua, 259 символів) — рядок-дата ставав
   * ціллю в Краматорську. Зведення того ж розміру завжди називає апарат хоч
   * десь: «Реактивні:», «🛵», «БпЛА курсом на…».
   */
  if (text.length >= NEWS_MIN_CHARS && classifyThreatType(text) === "unknown") return out;
  let header: string | null = null;
  text.split(/\n|•|;/).forEach((raw, lineNo) => {
    const line = raw.trim();
    if (!line) return;
    // Хештег — тег, а не зведення: «#Дніпровський_район» з оголошення тривоги.
    if (line.startsWith("#")) return;
    // «Чернігівщина: Городня», «Рівненщина - Клевань»: заголовок відрізаємо,
    // інакше рядок «лише з назв» не впізнається через назву області.
    const head = raw.trim().match(/^((?:[^\s:–—-]+)(?:\s+област[ьи])?)\s*[:–—-]\s*(.+)$/u);
    const own = oblastAdminIn(line, gaz);
    const body = head && oblastAdminIn(head[1]!, gaz) ? head[2]!.trim() : line;
    // Заголовок діє на наступні рядки, поки не прийде інший.
    if (own) header = own;
    // Сама назва краю — рубрика списку, а не пункт (див. isRegionHeadingOnly).
    if (own && isRegionHeadingOnly(line)) return;
    const admin = own ?? header;
    const lineType = typeOfLine(line);
    // Перевірка неба без названого апарата — не ціль (див. SKY_CHECK).
    if (lineType === "unknown" && SKY_CHECK.test(line)) return;
    const push = (
      kind: Mention["kind"],
      p: { places: GeoPlace[]; said: string },
      viaCue: boolean,
    ) => {
      // Звичайне слово, назва області, новина — не пункт цілі (див. вище).
      if (!startsCapitalized(p.said)) return;
      if (isRegionName(p.said)) return;
      /*
       * Район чи громада — територія, а не точка цілі. Офіційний канал тривог
       * перелічує їх списком, і «🟢 Відбій тривоги в: • Кальміуський район»
       * ставив ціль у кожному районі ВІДБОЮ — повідомлення про те, що небезпека
       * минула, ставало ціллю (air_alert_ua, 25.10).
       */
      if (/\s(?:раион|громад)\S*$/.test(normName(p.said))) return;
      if (viaCue && lineType === "unknown" && text.length >= NEWS_MIN_CHARS) return;
      const inRegion = admin ? p.places.filter((x) => x.admin === admin) : [];
      out.push({
        kind,
        places: inRegion.length ? inRegion : p.places,
        said: p.said,
        line: lineNo,
        lineType,
      });
    };
    const course = firstPlaceAfter(body, COURSE_CUE, gaz);
    if (course) push("course", course, true);
    // «повз Овруч у Рівненську область» — курс на область (див. oblastDirectionIn).
    const toRegion = oblastDirectionIn(body);
    if (toRegion) {
      out.push({
        kind: "course",
        places: [{ name: "область", lat: toRegion.lat, lon: toRegion.lon, admin: "" }],
        said: "область",
        line: lineNo,
        lineType,
        region: true,
      });
    }
    const pos = firstPlaceAfter(body, POSITION_CUE, gaz);
    if (pos) {
      push("position", pos, true);
      if (pos.partner) push("position", pos.partner, true);
      return;
    }
    if (course || COURSE_CUE.test(body)) return;
    // Стан, а не місце: «Чернігівщина - чисто» давало село Чисте й хибну ціль
    // (sectorv666, 23.10).
    if (STATUS_WORDS.test(normName(body))) return;
    // Допис лише з назв: «Гоща», «Самостріли/Бокшин», «Мʼятин/Глинки».
    const parts = body.split("/").map((x) => {
      const w = words(x);
      const keep = w.norm.map((n) => !FILLER.has(n));
      return { orig: w.orig.filter((_, i) => keep[i]), norm: w.norm.filter((_, i) => keep[i]) };
    });
    if (parts.every((w) => w.norm.length > 0 && w.norm.length <= 3)) {
      const found = parts.map((w) => {
        const p = leadingPlace(w, gaz);
        return p && p.used === w.norm.length ? p : null;
      });
      if (found.every((f) => f !== null)) for (const f of found) push("position", f!, false);
    }
  });
  return out;
}

/**
 * Перший пункт після сигнального слова — шукаючи далі, якщо перше збігання
 * пункту не дало: у «Реактивний на Чернігівщині пройшов Городню, далі курсом
 * на Ріпки» найлівіше «на» — перед областю, а курс — у кінці.
 */
function firstPlaceAfter(
  text: string,
  cue: RegExp,
  gaz: Gazetteer,
): {
  places: GeoPlace[];
  said: string;
  partner: { places: GeoPlace[]; said: string } | null;
} | null {
  let rest = text;
  for (let i = 0; i < 6; i++) {
    const m = rest.match(cue);
    if (!m) return null;
    const p = leadingPlace(words(m[1]!), gaz);
    if (p) {
      /*
       * «в районі Ріпки/Олешня» — друга назва того самого місця. Ріпок в
       * Україні п'ять, Олешень три, і лише одна пара лежить поруч (17 км, на
       * Чернігівщині): без другої назви точка губилась (PhantomChe, 27.10).
       */
      const tail = m[1]!.slice(m[1]!.indexOf(p.said) + p.said.length);
      const after = tail.match(/^\s*\/\s*(.+)$/u);
      const partner = after ? leadingPlace(words(after[1]!), gaz) : null;
      return { places: p.places, said: p.said, partner };
    }
    rest = m[1]!;
  }
  return null;
}

function nearestTo(places: GeoPlace[], anchors: { lat: number; lon: number }[]): GeoPlace | null {
  let best: GeoPlace | null = null;
  let bestKm = Number.POSITIVE_INFINITY;
  for (const p of places) {
    for (const a of anchors) {
      const d = distanceKm(p, a);
      if (d < bestKm) {
        bestKm = d;
        best = p;
      }
    }
  }
  if (best && bestKm <= MAX_ANCHOR_KM) return best;
  // Без близької опори — лише однозначна назва.
  return places.length === 1 ? places[0]! : null;
}

/**
 * Точки з дописів каналів за останні `FIX_WINDOW_MS`, з вибраними пунктами.
 * Опори для вибору — поточні цілі й попередні точки того ж каналу.
 */
export function channelFixes(
  messages: readonly ChannelMessage[],
  gaz: Gazetteer,
  threats: readonly Threat[],
  now: number,
): ChannelFix[] {
  const fresh = messages
    .filter((m) => m.channel && m.at <= now && now - m.at <= FIX_WINDOW_MS)
    .sort((a, b) => a.at - b.at);
  // Свіжі точки каналу — опори для вибору однойменних. Не одна остання:
  // агрегатор веде кілька цілей одночасно, у різних областях.
  const recent = new Map<string, ChannelFix[]>();
  const out: ChannelFix[] = [];
  for (const m of fresh) {
    const mine = (recent.get(m.channel!) ?? []).filter((f) => m.at - f.at <= MAX_LINK_GAP_MS);
    recent.set(m.channel!, mine);
    const last = mine[mine.length - 1];
    if (last && isEndOfTarget(m.text)) {
      out.push({ ...last, at: m.at, kind: "end", said: m.text.trim() });
      // Наступна ціль каналу може бути будь-де — точки закритої вже не опора.
      // Чистимо всі, а не останню: інакше опорою лишається її попередня
      // точка, і «далі Петропавлівка» знову бере запорізьку (тест нижче).
      mine.length = 0;
      continue;
    }
    const ms = mentionsOf(m.text, gaz);
    if (!ms.length) continue;
    const msgType = classifyThreatType(m.text);
    const lines = [...new Set(ms.map((x) => x.line))];
    for (const lineNo of lines) {
      const lm = ms.filter((x) => x.line === lineNo);
      // Тип — з рядка; з усього допису — лише коли рядок один: у списку
      // «реактивний на Млинів / звичайний біля Ружина» тип допису змішаний.
      const named = lm[0]!.lineType;
      const type = named !== "unknown" ? named : lines.length === 1 ? msgType : "unknown";
      // «Самостріли/Бокшин» — дві назви одного місця: точка — між ними.
      const positions: { place: GeoPlace; said: string }[] = [];
      for (const x of lm) {
        // Однозначний пункт із того ж рядка теж опора: «пройшов Городню, далі
        // курсом на Ріпки» — Городень на Чернігівщині дві, за 130 км, а Ріпки
        // там одні, і Городня поруч із ними — саме та.
        // Неоднозначні теж — усіма кандидатами: з пари «Ріпки/Олешня»
        // лишиться та, де обидві назви поруч.
        // Курс на область — не опора: центр області не каже, який із
        // однойменних пунктів мається на увазі.
        const sameLine = lm.filter((o) => o !== x && !o.region).flatMap((o) => o.places);
        const anchors = [
          ...mine.map((f) => f.place),
          ...positions.map((p) => p.place),
          ...sameLine,
          ...threats,
        ];
        const place = nearestTo(x.places, anchors);
        if (!place) continue;
        if (x.kind === "position") positions.push({ place, said: x.said });
        else
          out.push({
            channel: m.channel!,
            at: m.at,
            kind: "course",
            place,
            said: x.said,
            type,
            line: lineNo,
          });
      }
      if (!positions.length) continue;
      const near = positions.filter((p) => distanceKm(p.place, positions[0]!.place) <= 25);
      const lat = near.reduce((s, p) => s + p.place.lat, 0) / near.length;
      const lon = near.reduce((s, p) => s + p.place.lon, 0) / near.length;
      const fix: ChannelFix = {
        channel: m.channel!,
        at: m.at,
        kind: "position",
        place: {
          name: near.map((p) => shownName(p, gaz)).join("/"),
          lat,
          lon,
          admin: near[0]!.place.admin,
        },
        said: near.map((p) => p.said).join("/"),
        type,
        line: lineNo,
      };
      out.push(fix);
      mine.push(fix);
    }
  }
  return out;
}

/**
 * Назва для позначки. Як у дописі — коли це точна форма цього пункту в
 * довіднику, тобто вже називний відмінок: GeoNames місцями пише назви
 * криво («Мятин» без апострофа, «Дубровіца» замість «Дубровиця»), а канал —
 * так, як кажуть. Інакше — з довідника: «над Вільнянськом» → «Вільнянськ».
 */
function shownName(p: { place: GeoPlace; said: string }, gaz: Gazetteer): string {
  return gaz.named(normName(p.said)).includes(p.place) ? p.said : p.place.name;
}

export interface ChannelTrack {
  channel: string;
  fixes: ChannelFix[];
  /** Останній названий курс, якщо був після останньої позиції. */
  course: ChannelFix | null;
  type: ThreatType;
  /** Канал сказав «зникла» / «збито»: на карті трек уже не веде нічого. */
  ended: boolean;
}

/**
 * Точки одного каналу, зшиті в треки за правдоподібністю польоту між ними.
 *
 * Відкритих треків у каналу може бути кілька: агрегатор веде цілі в різних
 * областях одним дописом («Рівненщина: реактивний на Млинів / Чернігівщина:
 * реактивний на Славутич»). З одним треком на канал кожна така точка рвала
 * трек сусідньої цілі. Точка йде до найближчого треку, до якого політ
 * правдоподібний; немає такого — новий трек.
 */
export function buildTracks(fixes: readonly ChannelFix[]): ChannelTrack[] {
  const tracks: ChannelTrack[] = [];
  const open = new Map<string, ChannelTrack[]>();
  const lastAt = (t: ChannelTrack) => t.fixes[t.fixes.length - 1]!.at;
  // Позиції раніше за курси того самого допису: курс іде до своєї цілі.
  const order = (f: ChannelFix) => (f.kind === "position" ? 0 : f.kind === "course" ? 1 : 2);
  const sorted = [...fixes].sort((a, b) => a.at - b.at || order(a) - order(b));
  const byLine = new Map<string, ChannelTrack>();
  for (const f of sorted) {
    const mine = (open.get(f.channel) ?? []).filter((t) => f.at - lastAt(t) <= MAX_LINK_GAP_MS);
    open.set(f.channel, mine);
    if (f.kind === "end") {
      // «Зникла» — про ту ціль, про яку канал писав останньою.
      const t = mine.reduce<ChannelTrack | null>(
        (x, y) => (!x || lastAt(y) > lastAt(x) ? y : x),
        null,
      );
      if (t) {
        t.ended = true;
        mine.splice(mine.indexOf(t), 1);
      }
      continue;
    }
    if (f.kind === "course") {
      const own = byLine.get(`${f.channel}:${f.at}:${f.line ?? -1}`);
      const t =
        own ??
        mine
          .filter((x) => distanceKm(x.fixes[x.fixes.length - 1]!.place, f.place) <= 200)
          .reduce<ChannelTrack | null>((x, y) => (!x || lastAt(y) > lastAt(x) ? y : x), null);
      if (t) t.course = f;
      continue;
    }
    let best: ChannelTrack | null = null;
    let bestKm = Number.POSITIVE_INFINITY;
    for (const t of mine) {
      const last = t.fixes[t.fixes.length - 1]!;
      const km = distanceKm(last.place, f.place);
      const hours = Math.max((f.at - last.at) / 3_600_000, 1 / 60);
      if (km / hours <= MAX_LINK_KMH && km < bestKm) {
        best = t;
        bestKm = km;
      }
    }
    if (best) {
      best.fixes.push(f);
      best.course = null;
      if (best.type === "unknown") best.type = f.type;
    } else {
      best = { channel: f.channel, fixes: [f], course: null, type: f.type, ended: false };
      tracks.push(best);
      mine.push(best);
    }
    byLine.set(`${f.channel}:${f.at}:${f.line ?? -1}`, best);
  }
  return tracks;
}

/**
 * Трек з каналу → оновлення цілей.
 *
 *  - Є ціль Нептуна в `MATCH_TARGET_KM` від останньої точки, давніша за неї —
 *    позначка переїжджає в точку каналу, курс — із двох останніх точок (це
 *    спостережений рух, а не здогадка), трек — точки каналу.
 *  - Цілі поруч немає, а точок ≥ 2 — нова ціль із каналу (випадок #108: Нептун
 *    мовчав, канал вів ціль поіменно). Одна точка нової цілі не створює:
 *    одиночна згадка могла бути про будь-що.
 *  - Названий після позиції курс («Відвернув на Бугрин») — лише напрямок,
 *    позначений як припущений.
 */
export interface SoloRule {
  /** Чи можна вірити одиночній точці цього каналу (канали спостереження). */
  trusted: (channel: string) => boolean;
  now: number;
}

export function applyChannelTracks(
  threats: readonly Threat[],
  tracks: readonly ChannelTrack[],
  solo?: SoloRule,
): Threat[] {
  const out = threats.map((t) => ({ ...t }));
  const singles: ChannelTrack[] = [];
  const DRONES = new Set<ThreatType>(["shahed", "reactive", "banderol", "unknown", "recon"]);
  for (const tr of tracks) {
    if (tr.ended) continue;
    const last = tr.fixes[tr.fixes.length - 1]!;
    // Курс — від найближчої попередньої точки, що вже за ≥ 3 км: сусідні дописи
    // часто називають села за кілометр одне від одного («Мʼятин» → «Глинки»),
    // і курс між ними — шум, а не рух.
    const prev =
      [...tr.fixes.slice(0, -1)].reverse().find((f) => distanceKm(f.place, last.place) >= 3) ??
      null;
    const lastIso = new Date(last.at).toISOString();
    let heading: number | null = null;
    let observed = false;
    if (prev && distanceKm(prev.place, last.place) >= 3) {
      heading = bearingDeg(prev.place, last.place);
      observed = true;
    }
    /*
     * Курс у ту саму точку, де ціль уже є («Реактивний на Овруч» + «повз
     * Овруч»), напрямку не має: з нульової відстані виходить 0°, і значок
     * дивився на північ (знімок користувача, 28.10). Такий курс не чіпає
     * курсу з треку.
     */
    if (tr.course && tr.course.at >= last.at && distanceKm(last.place, tr.course.place) >= 3) {
      heading = bearingDeg(last.place, tr.course.place);
      observed = false;
    }
    const trail = tr.fixes.map((f) => ({
      lat: f.place.lat,
      lon: f.place.lon,
      t: new Date(f.at).toISOString(),
    }));

    let best: Threat | null = null;
    let bestKm = Number.POSITIVE_INFINITY;
    for (const t of out) {
      if (!DRONES.has(t.type ?? "unknown")) continue;
      const d = distanceKm(t, last.place);
      if (d < bestKm) {
        bestKm = d;
        best = t;
      }
    }
    const sinceMs = best ? Date.parse(best.since || best.lastSeen || "") : Number.NaN;
    if (best && bestKm <= MATCH_TARGET_KM) {
      if (Number.isFinite(sinceMs) && sinceMs > last.at) continue; // джерело свіжіше
      best.lat = last.place.lat;
      best.lon = last.place.lon;
      best.name = last.place.name;
      best.since = lastIso;
      best.lastSeen = lastIso;
      if (heading !== null) best.heading = heading;
      best.quality = {
        ...(best.quality ?? {
          uncertaintyKm: null,
          position: null,
          lifecycle: null,
          presumptiveCourse: true,
          speedKmh: null,
        }),
        uncertaintyKm: 5,
        position: "approx",
        presumptiveCourse: heading === null ? (best.quality?.presumptiveCourse ?? true) : !observed,
      };
      if (trail.length >= 2) best.trail = trail;
      best.sources = [...new Set([...(best.sources ?? []), best.source, tr.channel])];
      continue;
    }
    if (tr.fixes.length < 2) {
      singles.push(tr);
      continue;
    }
    /*
     * Канал не назвав апарат, а поруч уже є ціль БУДЬ-ЯКОГО типу — це та сама
     * подія, а не нова ціль.
     *
     * Зливаємо вище лише з дронами (позицію FPV чи КАБа точкою села з допису
     * погіршувати не можна), і доти все, що не злилося, ставало ОКРЕМОЮ ціллю —
     * навіть за кілометр від цілі джерела. Заміряно 25.10, 50 хв, 25 зрізів
     * конвеєра консолі проти живого Нептуна: «Шахтарське — 0 км від цілі
     * Нептуна», «Зарічне — 5 км» — одна подія, дві позначки.
     *
     * Правило те саме, що в `corroborated` для одиночних точок: поруч із будь-
     * якою ціллю нової не створюємо. Межа — лише для НЕназваного апарата:
     * «шахед» поруч із FPV біля фронту — цілком можливо два різні об'єкти, і
     * ховати названий тип ми не маємо підстав.
     */
    if (tr.type === "unknown" && out.some((t) => distanceKm(t, last.place) <= MATCH_TARGET_KM)) {
      continue;
    }
    out.push({
      id: `ch:${tr.channel}:${tr.fixes[0]!.at}`,
      name: last.place.name,
      lat: last.place.lat,
      lon: last.place.lon,
      source: tr.channel,
      sources: [tr.channel],
      count: 1,
      since: lastIso,
      expires: "",
      lastSeen: lastIso,
      // Тип — лише якщо канал його назвав; «невідомий» чесніший за вгаданий «шахед».
      type: tr.type,
      ...(heading !== null ? { heading } : {}),
      quality: {
        uncertaintyKm: 5,
        position: "approx",
        lifecycle: "tracking",
        presumptiveCourse: !observed,
        speedKmh: null,
      },
      trail,
    });
  }
  out.push(...corroborated(singles, out, solo));
  return out;
}

/** Одна точка від різних каналів — одна ціль, якщо вони так близько в часі й просторі. */
const CORROBORATE_KM = 20;
const CORROBORATE_MS = 10 * 60_000;

/**
 * Одна точка каналу цілі не створює — але одна й та сама точка від ДВОХ
 * різних каналів уже створює. Саме так рахує підтвердження й Нептун
 * («Підтверджень: 3»).
 *
 * Заміряно 23.10: «🏍 Реактивний БпЛА на Полтавщині, повз Полтаву курс
 * західний» (kpszsu) і «Реактивний на Полтавщині тепер …» (UkraineRadar_24_7)
 * — реактивний, якого на карті не було ні в Нептуна, ні в нас: кожен канал
 * дав по одній точці, а одиночну точку ми свідомо відкидаємо.
 *
 * Копії одного агрегатора в різних каналах тут теж рахуються як окремі —
 * відрізнити їх за текстом надійно не вдається. Тому поріг — два канали, а не
 * один, і лише для місць, де жодної цілі поруч немає.
 */
/** Наскільки свіжою має бути одиночна точка, щоб стати ціллю (див. `SoloRule`). */
export const SOLO_FRESH_MS = 10 * 60_000;

/**
 * Одиночна точка одного каналу — теж ціль, але лише суворо: канал
 * спостереження (`watch`), тип апарата названо, точці ≤ 10 хв, поруч жодної
 * цілі. І позначена як непідтверджена — одне джерело.
 *
 * Чому взагалі: 27.10 о 23:40 UTC Нептун віддавав 0 цілей, а PhantomChe
 * писав «Новий реактивний від Брянської… під кордоном повз Славутич на
 * Київщину» — і на карті не було нічого. Порожня карта, коли спостерігач веде
 * реактивний, — гірша помилка за позначку з підписом «одне джерело».
 */
function corroborated(
  singles: readonly ChannelTrack[],
  existing: readonly Threat[],
  solo?: SoloRule,
): Threat[] {
  const out: Threat[] = [];
  const used = new Set<ChannelTrack>();
  const sorted = [...singles].sort((a, b) => b.fixes[0]!.at - a.fixes[0]!.at);
  for (const s of sorted) {
    if (used.has(s)) continue;
    const f = s.fixes[0]!;
    const group = sorted.filter(
      (o) =>
        !used.has(o) &&
        Math.abs(o.fixes[0]!.at - f.at) <= CORROBORATE_MS &&
        distanceKm(o.fixes[0]!.place, f.place) <= CORROBORATE_KM,
    );
    const channels = [...new Set(group.map((g) => g.channel))];
    const alone =
      channels.length < 2 &&
      !(
        solo &&
        solo.trusted(channels[0]!) &&
        s.type !== "unknown" &&
        solo.now - f.at <= SOLO_FRESH_MS
      );
    if (alone) continue;
    if ([...existing, ...out].some((t) => distanceKm(t, f.place) <= MATCH_TARGET_KM)) continue;
    for (const g of group) used.add(g);
    const latest = group.reduce((a, b) => (b.fixes[0]!.at > a.fixes[0]!.at ? b : a)).fixes[0]!;
    const first = Math.min(...group.map((g) => g.fixes[0]!.at));
    const iso = new Date(latest.at).toISOString();
    out.push({
      id: `cc:${latest.place.lat.toFixed(2)}:${latest.place.lon.toFixed(2)}:${first}`,
      name: latest.place.name,
      lat: latest.place.lat,
      lon: latest.place.lon,
      source: channels[0]!,
      sources: channels,
      count: 1,
      since: iso,
      expires: "",
      lastSeen: iso,
      type: group.map((g) => g.type).reduce(moreSevereType),
      quality: {
        // Одне джерело — ширший розкид: його ніхто не перевірив.
        uncertaintyKm: channels.length < 2 ? 15 : 10,
        position: "approx",
        lifecycle: "uncertain",
        presumptiveCourse: true,
        speedKmh: null,
      },
    });
  }
  return out;
}
