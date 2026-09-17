/**
 * Шар поради: від «що в небі» до «що це означає для конкретної точки».
 *
 * Консоль уже знає, де цілі, куди вони летять і чого варте кожне джерело
 * (threat-eta, source-credibility). Але черговий і пересічний користувач
 * ставлять різні питання. Черговому потрібна карта країни; людині вдома —
 * рівно три відповіді: чи летить це на мене, скільки в мене часу, і з якого
 * боку. Цей модуль відповідає саме на них, не заводячи другої копії геометрії:
 * азимут і кут беруться з threat-eta, довіра — з source-credibility.
 *
 * Чиста, безстанова логіка — рахується на клієнті покадрово, тестується без
 * мережі.
 */

import type { Threat } from "./air";
import { distanceKm } from "./infra-types";
import { ALERT_CHANCE_THRESHOLD, closestApproach, passChance } from "./approach";
import type { MotionState } from "./track-filter";
import {
  assessCredibility,
  type CredibilityAssessment,
  type SourceRole,
} from "./source-credibility";
import { angularDiff, bearingDeg, speedRangeFor, SPEED_KMH } from "./threat-eta";
import { displayRadiusKm, EMPTY_QUALITY } from "./threat-quality";
import { nowRadiusKm } from "./position-age";

// ── Румби (для напрямку й сторони вікон) ─────────────────────────────────
export const COMPASS_8 = ["Пн", "ПнСх", "Сх", "ПдСх", "Пд", "ПдЗх", "Зх", "ПнЗх"] as const;

/** Румб азимута (0=Пн), напр. 95° → «Сх». */
export function compass(deg: number | null | undefined): string {
  if (deg == null) return "—";
  return COMPASS_8[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
}

// ── 1. Верифікація (анти-фейк): рівень словами, а не лише код ────────────
export type VerificationLevel = "official" | "corroborated" | "single" | "unverified";

const VERIFICATION_LABEL: Record<VerificationLevel, string> = {
  official: "підтверджено офіційним джерелом",
  corroborated: "підтверджено незалежними джерелами",
  single: "одне джерело, без підтвердження",
  unverified: "надійність джерела невідома",
};

export interface Verification {
  level: VerificationLevel;
  label: string;
  /** Код Адміралтейства (напр. «C2») — для тих, хто читає його прямо. */
  code: string;
  independentSources: number;
  reasons: string[];
}

/**
 * Рівень верифікації позначки для показу поруч із ціллю: підтверджене
 * незалежними джерелами не має виглядати як одиночна непідтверджена чутка.
 *
 * Важливо: основне джерело консолі — агрегатор (neptun), який САМ зводить
 * багато Telegram-каналів в одну позначку й віддає це числом `reports`
 * (скільки каналів) та власним рівнем `confidence`. Тому не можна судити лише
 * за роллю рядка-джерела «neptun.in.ua» (вона невідома) — інакше КОЖНА ціль
 * виглядала б непідтвердженою. Підтвердження тут несуть `reports` і
 * `confidence`, а роль джерела лишається окремим, сильнішим сигналом (офіційний
 * канал), коли він є.
 */
export function verifyThreat(
  threat: Pick<Threat, "sources" | "source" | "reports" | "confidence">,
  roleOf: (source: string) => SourceRole,
  officialCorroboration = false,
): Verification {
  const sources =
    threat.sources && threat.sources.length ? threat.sources : threat.source ? [threat.source] : [];
  const a: CredibilityAssessment = assessCredibility({
    sources,
    roleOf,
    officialCorroboration,
    ...(threat.reports != null ? { reports: threat.reports } : {}),
  });
  const roles = sources.map(roleOf);
  const reports = threat.reports ?? 0;
  const conf = (threat.confidence ?? "").toLowerCase();
  const knownSource = roles.some((r) => r !== "unknown");

  const reasons: string[] = [];
  let level: VerificationLevel;
  if (roles.includes("official")) {
    level = "official";
    reasons.push("серед джерел є офіційний канал");
  } else if (a.independentSources >= 2 || reports >= 3 || conf === "high") {
    level = "corroborated";
    if (a.independentSources >= 2) reasons.push(`${a.independentSources} незалежних джерела`);
    if (reports >= 3) reasons.push(`зведено з ${reports} повідомлень каналів`);
    if (conf === "high") reasons.push("джерело оцінює як високу впевненість");
  } else if (reports >= 2 || conf === "medium" || knownSource) {
    level = "single";
    if (reports >= 2) reasons.push(`${reports} повідомлення`);
    else reasons.push("одне джерело, без незалежного підтвердження");
    if (conf === "medium") reasons.push("середня впевненість джерела");
  } else {
    level = "unverified";
    reasons.push("непідтверджене одиночне повідомлення");
  }
  return {
    level,
    label: VERIFICATION_LABEL[level],
    code: a.code,
    independentSources: a.independentSources,
    reasons,
  };
}

// ── 2. Розумний відбій: чи є цілі навколо точки ─────────────────────────
export interface SkyState {
  radiusKm: number;
  clear: boolean;
  targets: number;
  nearestKm: number | null;
  nearestType: string | null;
  verdict: string;
  /**
   * Межа, яку не можна прибирати: відсутність цілей у видачі — НЕ доказ
   * відсутності загрози. Ми маємо покриття OSINT-повідомленнями, а не радар,
   * і офіційний відбій дають Повітряні Сили. Поле обовʼязкове саме тому.
   */
  caveat: string;
}

const SKY_CAVEAT =
  "Це покриття OSINT-повідомленнями, а не радар. Відсутність цілей у видачі не є " +
  "доказом відсутності загрози; офіційний відбій дають Повітряні Сили.";

export function skyState(
  threats: readonly Threat[],
  point: { lat: number; lon: number },
  radiusKm = 150,
): SkyState {
  const inside = threats
    .map((t) => ({ t, d: distanceKm(point, t) }))
    .filter((x) => x.d <= radiusKm)
    .sort((a, b) => a.d - b.d);
  const nearest = inside[0] ?? null;
  return {
    radiusKm,
    clear: inside.length === 0,
    targets: inside.length,
    nearestKm: nearest ? Math.round(nearest.d) : null,
    nearestType: nearest ? (nearest.t.type ?? "unknown") : null,
    verdict: inside.length
      ? `У радіусі ${radiusKm} км — ${inside.length}, найближча за ${Math.round(nearest!.d)} км`
      : `У радіусі ${radiusKm} км активних цілей немає`,
    caveat: SKY_CAVEAT,
  };
}

// ── 3. Радар вікон: чи йде загроза з боку ваших вікон ────────────────────
export type WindowSide = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

const SIDE_BEARING: Record<WindowSide, number> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};
const SIDE_LABEL: Record<WindowSide, string> = {
  N: "північ",
  NE: "північний схід",
  E: "схід",
  SE: "південний схід",
  S: "південь",
  SW: "південний захід",
  W: "захід",
  NW: "північний захід",
};

export interface WindowExposure {
  side: WindowSide;
  sideLabel: string;
  /** Азимут загрози відносно точки (звідки вона підходить). */
  threatBearing: number;
  /** Відхилення напрямку загрози від сторони вікон, градуси. */
  offDeg: number;
  exposed: boolean;
  advice: string;
}

export function windowExposure(
  threatBearing: number,
  side: WindowSide,
  halfSectorDeg = 55,
): WindowExposure {
  const off = angularDiff(threatBearing, SIDE_BEARING[side]);
  const exposed = off <= halfSectorDeg;
  return {
    side,
    sideLabel: SIDE_LABEL[side],
    threatBearing: Math.round(threatBearing),
    offDeg: Math.round(off),
    exposed,
    advice: exposed
      ? `Загроза з боку ваших вікон (${SIDE_LABEL[side]}) — відійдіть від них, дві стіни між вами і вікном`
      : `Загроза не з боку ваших вікон (вони на ${SIDE_LABEL[side]}, загроза за ${Math.round(off)}° від них)`,
  };
}

// ── 4. Компас уламків: знос вітром ──────────────────────────────────────
export interface DebrisDrift {
  /** Куди зносить (метеонапрямок вітру показує, ЗВІДКИ дме). */
  driftToDeg: number;
  driftToLabel: string;
  driftMeters: number;
  basis: string;
}

/**
 * Груба оцінка зносу уламків приземним вітром. Це ОЦІНКА ПОРЯДКУ, не
 * розрахунок падіння: висота підриву, маса й форма уламка невідомі. Число тут
 * вірне лише за порядком величини — і так підписане, щоб на нього не спиралися
 * як на точний прогноз.
 */
export function debrisDrift(windDirDeg: number, windKmh: number, fallSec = 30): DebrisDrift {
  const toDeg = (windDirDeg + 180) % 360;
  const windMs = windKmh / 3.6;
  return {
    driftToDeg: Math.round(toDeg),
    driftToLabel: SIDE_LABEL[bearingToSide(toDeg)],
    driftMeters: Math.round(windMs * fallSec),
    basis: `приземний вітер ${windMs.toFixed(1)} м/с, умовний час падіння ${fallSec} с — оцінка порядку, не розрахунок траєкторії`,
  };
}

function bearingToSide(deg: number): WindowSide {
  const sides: WindowSide[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return sides[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
}

// ── 5. Персональна загроза: що стосується саме моєї точки ────────────────
export interface PersonalThreat {
  threat: Threat;
  distanceKm: number;
  /** Азимут із моєї точки НА ціль (де вона зараз). */
  bearingToThreat: number;
  /**
   * Ціль іде в мій бік.
   *
   * Там, де рух оцінено з фіксів, це означає «шанс пройти ближче за радіус
   * тривоги вищий за поріг»; де руху ще не видно — стару перевірку сектора.
   */
  inbound: boolean;
  /** Оцінка часу підльоту до моєї точки, хв (лише для inbound). */
  etaMin: number | null;
  /**
   * Вилка часу підльоту, хв — від найранішого до найпізнішого.
   *
   * Джерело саме називає, з якою точністю знає позицію (від 4 до 45 км), і ця
   * невизначеність ріже В ОБИДВА боки: ціль може бути вже на сорок пʼять
   * кілометрів ближче, ніж показано. Саме тому вилка тут потрібна не заради
   * акуратності формулювань — її нижній край є найбезпечнішим прочитанням, і
   * рішення про рівень тривоги береться з нього.
   */
  etaRangeMin: [number, number] | null;
  /** Швидкість заміряна джерелом, а не взята з таблиці типових. */
  speedMeasured: boolean;
  /**
   * Шанс, що ОЦІНЕНА ТРАЄКТОРІЯ пройде ближче за радіус тривоги.
   *
   * Не ймовірність влучання, не прогноз роботи ППО — лише геометрія оцінки
   * руху, порахована на розкиді, заміряному з власних фіксів цілі. Є тільки
   * там, де рух узагалі видно.
   */
  chance?: number;
  /** На скільки ціль промине точку за середньою оцінкою, км. */
  missKm?: number;
}

export interface PersonalAssessment {
  point: { lat: number; lon: number };
  /**
   * Найближчі цілі **в межах радіуса**.
   *
   * Радіус тут не косметика. Без нього сюди потрапляли цілі за 600–700 км —
   * тобто над іншою країною — і кожна, чий курс випадково дивився в бік точки,
   * підписувалась «іде на вас, ~240 хв». Особистий радар, який о третій ночі
   * каже таке, не просто марний: він навчає не вірити, і справжнє сповіщення
   * потім теж прочитають як шум.
   */
  nearest: PersonalThreat[];
  inboundCount: number;
  minutesToNearest: number | null;
  /**
   * Найбезпечніше прочитання часу до найближчої вхідної цілі, хв.
   *
   * Нижній край вилки: ціль може бути ближчою, ніж її позначка. Рівень
   * тривоги рахується саме з цього числа — поспішити з попередженням безпечно,
   * запізнитися ні, і ця асиметрія тут та сама, що й у передтривозі.
   */
  minutesToNearestLow: number | null;
  /**
   * Відстань до найближчої цілі ПОЗА радіусом, км. `null` — поза радіусом
   * порожньо теж. Потрібне, щоб «у радіусі нічого» не читалось як «у країні
   * нічого»: різниця між тишею і далеким рухом варта одного рядка.
   */
  nearestBeyondKm: number | null;
  sky: SkyState;
}

/**
 * Оцінка обстановки для точки користувача: найближчі цілі з напрямком і
 * відстанню, скільки з них іде в мій бік, і хвилини до найближчої вхідної.
 * «Вхідна» — та, чий курс проходить у секторі inboundSectorDeg повз точку.
 */
export function personalAssessment(
  threats: readonly Threat[],
  point: { lat: number; lon: number },
  opts: {
    radiusKm?: number;
    limit?: number;
    inboundSectorDeg?: number;
    /**
     * Оцінений рух цілі за спостереженими фіксами (`track-filter`).
     *
     * Коли він є, «вхідна» перестає бути перевіркою сектора й стає задачею про
     * найближче зближення. Сектор ±60° зараховував як «іде на вас» ціль, що
     * промине за тридцять кілометрів, — звідси половина зайвих сповіщень.
     *
     * Коли руху ще не видно (перший фікс), лишається перевірка сектора: гірша
     * оцінка краща за відсутність оцінки.
     */
    motionOf?: (threat: Threat) => MotionState | null;
    /**
     * Наскільки близько — це вже близько, км.
     *
     * Окремо від `radiusKm`, і це не дрібниця. Радіус спостереження каже, що
     * людина хоче БАЧИТИ (50–100 км); радіус тривоги — на якій відстані проліт
     * її вже стосується. Злити їх означало б рахувати шанс «пройде ближче за
     * сто кілометрів», який справджується майже завжди й тому нічого не каже.
     */
    concernKm?: number;
    /**
     * Момент оцінки, мс.
     *
     * Потрібен не для показу, а для розрахунку: позначка джерела — це не «де
     * ціль», а «де її бачили N хвилин тому», і ці хвилини заміряні (медіана
     * 205 с у живому зрізі). Без них найраніший край часу підльоту рахується
     * від застарілої відстані — тобто обіцяє запас часу, якого вже немає.
     * Див. `position-age.ts`.
     */
    now?: number;
  } = {},
): PersonalAssessment {
  const radiusKm = opts.radiusKm ?? 150;
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 6;
  const sector = opts.inboundSectorDeg ?? 60;
  const concernKm = opts.concernKm ?? Math.min(radiusKm, 15);

  const scored: PersonalThreat[] = threats.map((threat) => {
    const d = distanceKm(point, threat);
    const toThreat = bearingDeg(point, threat);
    let inbound = false;
    let etaMin: number | null = null;
    let etaRangeMin: [number, number] | null = null;
    let chance: number | undefined;
    let missKm: number | undefined;
    const q = threat.quality ?? EMPTY_QUALITY;

    const motion = opts.motionOf?.(threat) ?? null;
    if (motion && motion.origin !== "none") {
      // Рух цілі видно з її власних фіксів — значить, питання стає точним:
      // не «чи в секторі», а «на скільки промине й коли буде на траверзі».
      const a = closestApproach(motion, point);
      chance = passChance(motion, point, concernKm);
      missKm = Math.round(a.missKm);
      if (a.approaching && a.etaMin !== null) {
        inbound = chance >= ALERT_CHANCE_THRESHOLD;
        etaMin = Math.round(a.etaMin);
        // Вилка ширшає з ТРЬОХ боків: похибка заміряної швидкості (звідси
        // a.etaLow/High), невпевненість у позиції (u) і те, що ціль могла
        // прискоритись. Найраніший приліт — ближче й швидше.
        // Не заявлений розкид, а коло «де ціль може бути ЗАРАЗ»: заявлений
        // плюс політ за час, поки дані йшли до нас. Швидкість беремо ЗАМІРЯНУ
        // — вона тут уже є, і брати замість неї класовий верх означало б
        // викинути власний вимір.
        const u = nowRadiusKm(threat, now, motion).maxKm;
        const lowSpeed = Math.max(1, motion.speedKmh - motion.speedSigma);
        const highSpeed = motion.speedKmh + motion.speedSigma;
        etaRangeMin = [
          Math.round((Math.max(0, a.alongKm - u) / highSpeed) * 60),
          Math.round(((a.alongKm + u) / lowSpeed) * 60),
        ];
      }
    } else if (threat.heading != null) {
      // Ціль іде в мій бік, якщо азимут ВІД неї НА мене близький до її курсу.
      const bearingThreatToMe = bearingDeg(threat, point);
      if (angularDiff(bearingThreatToMe, threat.heading) <= sector) {
        inbound = true;
        // Заміряна швидкість цієї цілі б'є таблицю типових для класу.
        const speed = q.speedKmh ?? SPEED_KMH[threat.type ?? "unknown"] ?? 250;
        etaMin = Math.round((d / speed) * 60);
        const u = nowRadiusKm(threat, now).maxKm;
        /*
         * Вилка ширшає з двох боків одночасно: ми не знаємо точно, ДЕ ціль, і
         * не знаємо точно, ЩО це. Позначка «шахед» покриває і поршневу
         * «Герань» (185 км/год), і реактивну (до 600) — канал пише про них
         * однаково. Найраніший приліт = ближче й швидше.
         */
        const [slow, fast] = speedRangeFor(threat.type, q.speedKmh);
        etaRangeMin = [
          Math.round((Math.max(0, d - u) / fast) * 60),
          Math.round(((d + u) / slow) * 60),
        ];
      }
    }
    return {
      threat,
      distanceKm: Math.round(d),
      bearingToThreat: Math.round(toThreat),
      inbound,
      etaMin,
      etaRangeMin,
      speedMeasured: q.speedKmh !== null,
      ...(chance !== undefined ? { chance } : {}),
      ...(missKm !== undefined ? { missKm } : {}),
    };
  });

  const inboundList = scored.filter((s) => s.inbound && s.distanceKm <= radiusKm);
  // Радіус застосовується й до переліку, а не лише до лічильника вхідних.
  // Раніше `nearest` бралося з УСІХ цілей країни, і картка показувала те, що
  // за сотні кілометрів, поруч із тим, що за двадцять.
  const inside = scored.filter((s) => s.distanceKm <= radiusKm);
  const nearest = [...inside]
    .sort((a, b) => {
      if (a.inbound !== b.inbound) return a.inbound ? -1 : 1;
      return a.distanceKm - b.distanceKm;
    })
    .slice(0, limit);
  const beyond = scored.filter((s) => s.distanceKm > radiusKm);
  const nearestBeyondKm = beyond.length ? Math.min(...beyond.map((s) => s.distanceKm)) : null;
  const minutesToNearest = inboundList.length
    ? Math.min(...inboundList.map((s) => s.etaMin ?? Infinity))
    : null;
  const minutesToNearestLow = inboundList.length
    ? Math.min(...inboundList.map((s) => s.etaRangeMin?.[0] ?? s.etaMin ?? Infinity))
    : null;

  return {
    point,
    nearest,
    inboundCount: inboundList.length,
    minutesToNearest: minutesToNearest === Infinity ? null : minutesToNearest,
    minutesToNearestLow: minutesToNearestLow === Infinity ? null : minutesToNearestLow,
    nearestBeyondKm,
    sky: skyState(threats, point, radiusKm),
  };
}

// ── 6. Індекс небезпеки: «спати чи в укриття» ───────────────────────────
export type DangerLevel = "calm" | "watch" | "attention" | "shelter";

export interface DangerIndex {
  /** 0..100 — НЕ ймовірність влучання, а зважена оцінка обстановки для точки. */
  percent: number;
  level: DangerLevel;
  verdict: string;
  /** Межа чесності: це оцінка за покриттям OSINT, не гарантія й не радар. */
  caveat: string;
}

const DANGER_CAVEAT =
  "Це оцінка обстановки за даними OSINT, а не ймовірність влучання й не радар. " +
  "Рішення про укриття лишається за вами; офіційний відбій дають Повітряні Сили.";

/**
 * Зводить оцінку точки в один індекс «спати чи в укриття».
 *
 * Навмисно НЕ називається «ймовірністю прилёта»: точних чисел про влучання в
 * конкретний квадрат ми не маємо, і вигадати їх означало б збрехати (правило
 * проекту: заміряне окремо від оціненого). Це зважена оцінка ситуації —
 * головне важить час до найближчої ВХІДНОЇ цілі, далі кількість вхідних і
 * близькість найближчої. Коли вхідних немає — небо навколо тихе, індекс малий,
 * і так і сказано: «можна спати».
 */
export function dangerIndex(a: PersonalAssessment): DangerIndex {
  let percent: number;

  if (a.inboundCount === 0) {
    // Ніщо не йде на точку. Лишається лише фон близькості найближчої цілі.
    const near = a.sky.nearestKm;
    percent = near == null ? 0 : near < 30 ? 22 : near < 60 ? 14 : near < 100 ? 8 : 3;
  } else {
    /*
     * Рівень береться з НАЙБЕЗПЕЧНІШОГО прочитання, а не з середнього.
     *
     * Позначка цілі відома з точністю, яку називає саме джерело, і ціль може
     * бути вже ближче. Рахувати рівень із середини вилки означає систематично
     * запізнюватися рівно на половину невизначеності — тобто на чверть години
     * там, де джерело заявило ±45 км.
     */
    const low = a.minutesToNearestLow;
    const likely = a.minutesToNearest ?? low ?? 30;
    /*
     * НАЙШВИДШИЙ край лишається — але як ОСОБЛИВИЙ ВИПАДОК, а не як основа.
     *
     * Чому не як основа. Заміряно: без заміряної швидкості нижній край вилки
     * для «шахеда» бере 600 км/год (реактивна «Герань»), і тоді рівень «в
     * укриття» має КОЖНА ціль у радіусі ста кілометрів. Шкала перестає
     * розрізняти саме в найчастішому випадку — а рівень, який завжди
     * найвищий, не означає нічого й швидко привчає його ігнорувати. Це та сама
     * порожня правда, що й «може бути вже поруч» під кожним сповіщенням.
     *
     * Чому лишається як особливий випадок. Коли найшвидше прочитання дає пʼять
     * хвилин чи менше, ціль справді може бути вже над головою, і тут
     * асиметрія «поспішити безпечно, запізнитися ні» важить більше за
     * розрізнювальну здатність шкали.
     *
     * Що лишається нерозвʼязаним і названо чесно: для дрона без заміряної
     * швидкості цей особливий випадок спрацьовує аж до ~60 км, тож нижче цієї
     * межі шкала все одно насичена. Прибрати це можна лише звузивши верхній
     * край класу 185..600, а на нього в мене поки 40 хвилин спостережень
     * (максимум 340 км/год) — замало, щоб переписувати клас.
     */
    const imminent = low !== null && low <= 5;
    const base = imminent
      ? 95
      : likely <= 5
        ? 95
        : likely <= 10
          ? 85
          : likely <= 20
            ? 65
            : likely <= 30
              ? 45
              : 32;
    // Кілька вхідних гірше за одну, але з швидким насиченням.
    percent = Math.min(100, base + Math.min(a.inboundCount - 1, 4) * 4);
  }
  percent = Math.max(0, Math.min(100, Math.round(percent)));

  const level: DangerLevel =
    percent >= 70 ? "shelter" : percent >= 40 ? "attention" : percent >= 15 ? "watch" : "calm";
  const verdict =
    level === "shelter"
      ? "В укриття зараз"
      : level === "attention"
        ? "Будьте напоготові, стежте"
        : level === "watch"
          ? "Тримайте зв'язок під рукою"
          : a.inboundCount === 0 && (a.sky.nearestKm == null || a.sky.nearestKm > 100)
            ? "Спокійно, можна спати"
            : "Спокійно, але поглядайте";

  return { percent, level, verdict, caveat: DANGER_CAVEAT };
}
