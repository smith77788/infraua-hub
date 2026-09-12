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
import {
  assessCredibility,
  type CredibilityAssessment,
  type SourceRole,
} from "./source-credibility";
import { angularDiff, bearingDeg, SPEED_KMH } from "./threat-eta";

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
 * Спирається на наявну оцінку Адміралтейства, лише зводячи її до рівня, який
 * можна показати кольором.
 */
export function verifyThreat(
  threat: Pick<Threat, "sources" | "source" | "reports">,
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
  let level: VerificationLevel;
  if (roles.includes("official")) level = "official";
  else if (a.independentSources >= 2) level = "corroborated";
  else if (a.reliability === "F") level = "unverified";
  else level = "single";
  return {
    level,
    label: VERIFICATION_LABEL[level],
    code: a.code,
    independentSources: a.independentSources,
    reasons: a.reasons,
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
  /** Ціль іде в мій бік (у межах inboundSectorDeg від свого курсу). */
  inbound: boolean;
  /** Оцінка часу підльоту до моєї точки, хв (лише для inbound). */
  etaMin: number | null;
}

export interface PersonalAssessment {
  point: { lat: number; lon: number };
  nearest: PersonalThreat[];
  inboundCount: number;
  minutesToNearest: number | null;
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
  opts: { radiusKm?: number; limit?: number; inboundSectorDeg?: number } = {},
): PersonalAssessment {
  const radiusKm = opts.radiusKm ?? 150;
  const limit = opts.limit ?? 6;
  const sector = opts.inboundSectorDeg ?? 60;

  const scored: PersonalThreat[] = threats.map((threat) => {
    const d = distanceKm(point, threat);
    const toThreat = bearingDeg(point, threat);
    let inbound = false;
    let etaMin: number | null = null;
    if (threat.heading != null) {
      // Ціль іде в мій бік, якщо азимут ВІД неї НА мене близький до її курсу.
      const bearingThreatToMe = bearingDeg(threat, point);
      if (angularDiff(bearingThreatToMe, threat.heading) <= sector) {
        inbound = true;
        const speed = SPEED_KMH[threat.type ?? "unknown"] || 250;
        etaMin = Math.round((d / speed) * 60);
      }
    }
    return {
      threat,
      distanceKm: Math.round(d),
      bearingToThreat: Math.round(toThreat),
      inbound,
      etaMin,
    };
  });

  const inboundList = scored.filter((s) => s.inbound && s.distanceKm <= radiusKm);
  const nearest = [...scored]
    .sort((a, b) => {
      if (a.inbound !== b.inbound) return a.inbound ? -1 : 1;
      return a.distanceKm - b.distanceKm;
    })
    .slice(0, limit);
  const minutesToNearest = inboundList.length
    ? Math.min(...inboundList.map((s) => s.etaMin ?? Infinity))
    : null;

  return {
    point,
    nearest,
    inboundCount: inboundList.length,
    minutesToNearest: minutesToNearest === Infinity ? null : minutesToNearest,
    sky: skyState(threats, point, radiusKm),
  };
}
