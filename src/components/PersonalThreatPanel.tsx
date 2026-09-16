import { Bell, BellOff, Crosshair, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Threat } from "@/lib/air";
import type { WeatherNow } from "@/lib/air";
import {
  compass,
  dangerIndex,
  debrisDrift,
  personalAssessment,
  windowExposure,
  type DangerLevel,
  type WindowSide,
} from "@/lib/advisory";
import { newInboundIds, notify, playBeep, vibrate } from "@/lib/alarm";
import { ALL_PLACES } from "@/lib/ua-cities";
import {
  locationErrorText,
  requestBrowserLocation,
  requestTelegramLocation,
  type LocationOutcome,
  type TelegramWebApp,
} from "@/lib/telegram-webapp";

/** Причина, з якої точку не вдалося дізнатись. */
type LocationFailure = Extract<LocationOutcome, { ok: false }>["reason"];

/*
 * «Я тут» — обстановка для точки користувача.
 *
 * Консоль показує країну; людині вдома потрібні три відповіді: чи летить це
 * на мене, скільки в мене часу, з якого боку. Панель бере точку з геолокації
 * (або зі списку міст, коли доступ закрито) і рахує це з тих самих даних, що
 * вже є на екрані. Уся логіка — в advisory.ts; тут лише стан точки й показ.
 *
 * Точка й сторона вікон памʼятаються локально: під тривогою не час
 * перевибирати їх щоразу.
 */

const LS_POINT = "infraua.me.point.v1";
const LS_WINDOW = "infraua.me.window.v1";
const LS_SOUND = "infraua.me.sound.v1";

// Колір індексу небезпеки за рівнем: спокій → зелений, укриття → червоний.
const DANGER_FG: Record<DangerLevel, string> = {
  calm: "text-emerald-400",
  watch: "text-sky-400",
  attention: "text-amber-400",
  shelter: "text-red-400",
};
const DANGER_BG: Record<DangerLevel, string> = {
  calm: "bg-emerald-500/10 border border-emerald-500/25",
  watch: "bg-sky-500/10 border border-sky-500/25",
  attention: "bg-amber-500/10 border border-amber-500/30",
  shelter: "bg-red-500/12 border border-red-500/40",
};

const SIDES: WindowSide[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const SIDE_TEXT: Record<WindowSide, string> = {
  N: "Пн",
  NE: "ПнСх",
  E: "Сх",
  SE: "ПдСх",
  S: "Пд",
  SW: "ПдЗх",
  W: "Зх",
  NW: "ПнЗх",
};

type Point = { lat: number; lon: number };

/** Спільний вигляд для пошуку: регістр, апострофи (’ ʼ ` → '), пробіли. */
function normPlace(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[’ʼ`´]/g, "'")
    .replace(/\s+/g, " ");
}

/**
 * Місце за набраним рядком серед усіх міст і областей. Точний збіг — завжди;
 * префікс — лише коли просимо (по Enter/після поля), щоб набір «к» не ставив
 * точку на перше-ліпше місто на «к» під час друку.
 */
function resolvePlace(query: string, allowPrefix: boolean): (typeof ALL_PLACES)[number] | null {
  const n = normPlace(query);
  if (n.length < 2) return null;
  const exact = ALL_PLACES.find((p) => normPlace(p.name) === n);
  if (exact) return exact;
  if (!allowPrefix) return null;
  return (
    ALL_PLACES.filter((p) => normPlace(p.name).startsWith(n)).sort(
      (a, b) => a.name.length - b.name.length,
    )[0] ?? null
  );
}

function loadPoint(): Point | null {
  try {
    const raw = localStorage.getItem(LS_POINT);
    return raw ? (JSON.parse(raw) as Point) : null;
  } catch {
    return null;
  }
}

function TypeLabel(t: string | undefined | null): string {
  return (
    {
      shahed: "Shahed/БпЛА",
      recon: "Розвід. БпЛА",
      reactive: "Реактивний БпЛА",
      cruise: "Крилата ракета",
      missile: "Ракета",
      ballistic: "Балістика",
      kab: "КАБ",
      aircraft: "Авіація",
      unknown: "Ціль",
    }[t ?? "unknown"] ?? "Ціль"
  );
}

export default function PersonalThreatPanel({
  threats,
  weather,
}: {
  threats: Threat[];
  weather?: WeatherNow | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [point, setPoint] = useState<Point | null>(null);
  const [side, setSide] = useState<WindowSide | "">("");
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<LocationFailure | null>(null);
  const [canOpenSettings, setCanOpenSettings] = useState(false);
  const [sound, setSound] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const prevInboundRef = useRef<string[]>([]);

  useEffect(() => {
    setPoint(loadPoint());
    try {
      const w = localStorage.getItem(LS_WINDOW);
      if (w) setSide(w as WindowSide);
      setSound(localStorage.getItem(LS_SOUND) === "1");
    } catch {
      /* приватний режим */
    }
  }, []);

  function persistPoint(p: Point | null) {
    setPoint(p);
    try {
      if (p) localStorage.setItem(LS_POINT, JSON.stringify(p));
      else localStorage.removeItem(LS_POINT);
    } catch {
      /* приватний режим */
    }
  }

  function persistSide(s: WindowSide | "") {
    setSide(s);
    try {
      if (s) localStorage.setItem(LS_WINDOW, s);
      else localStorage.removeItem(LS_WINDOW);
    } catch {
      /* приватний режим */
    }
  }

  /**
   * Визначення точки — спершу через Telegram, і лише потім через браузер.
   *
   * Порядок саме такий, бо всередині вікна Telegram `navigator.geolocation`
   * НЕ ПРАЦЮЄ: у власному WebView немає браузерного діалогу дозволу, тож
   * виклик мовчки відхиляється, а часом не кличе жодного зворотного виклику
   * взагалі. Саме це й виглядало як «натиснув кнопку — нічого не сталося»:
   * ні точки, ні помилки, ні пояснення, а кнопка лишалась у стані «визначення…»
   * до перезавантаження сторінки.
   */
  async function locate() {
    setGeoError(null);
    setLocating(true);
    const webApp = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram
      ?.WebApp;
    const manager = webApp?.LocationManager;

    let outcome = await requestTelegramLocation(manager);
    // Поза Telegram (звичайна вкладка) менеджера немає — там питає браузер.
    if (!outcome.ok && outcome.reason === "unsupported") {
      outcome = await requestBrowserLocation(navigator.geolocation);
    }

    setLocating(false);
    if (outcome.ok) {
      persistPoint({ lat: outcome.lat, lon: outcome.lon });
      return;
    }
    // Показуємо ПРИЧИНУ: «доступ закрито» і «пристрій не дає координат» —
    // це різні дії людини, і спільне «не вдалося» не підказує жодної.
    setGeoError(outcome.reason);
    setCanOpenSettings(outcome.reason === "denied" && typeof manager?.openSettings === "function");
  }

  /** Відкриває налаштування доступу Telegram — лише у відповідь на дотик. */
  function openLocationSettings() {
    const webApp = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram
      ?.WebApp;
    webApp?.LocationManager?.openSettings?.();
  }

  const assessment = useMemo(
    () => (point ? personalAssessment(threats, point) : null),
    [threats, point],
  );

  const inboundBearing = useMemo(() => {
    if (!assessment) return null;
    const inb = assessment.nearest.find((n) => n.inbound);
    // Азимут, ЗВІДКИ підходить найближча вхідна ціль (протилежний до «на ціль»).
    return inb ? (inb.bearingToThreat + 180) % 360 : null;
  }, [assessment]);

  const window = side && inboundBearing != null ? windowExposure(inboundBearing, side) : null;
  const debris =
    weather && !weather.degraded ? debrisDrift(weather.windDir, weather.windKmh) : null;

  // Тривога на НОВУ вхідну ціль. Працює й коли панель згорнута: вночі саме це
  // має розбудити. Порівнюємо набір вхідних із попереднім — сигналимо лише на
  // появу, а не на кожен перерахунок (інакше сирена не змовкала б).
  const inboundIds = useMemo(
    () => (assessment ? assessment.nearest.filter((n) => n.inbound).map((n) => n.threat.id) : []),
    [assessment],
  );
  useEffect(() => {
    const fresh = newInboundIds(prevInboundRef.current, inboundIds);
    prevInboundRef.current = inboundIds;
    if (!sound || fresh.length === 0 || !assessment) return;
    try {
      if (!audioRef.current) audioRef.current = new AudioContext();
      if (audioRef.current.state === "suspended") void audioRef.current.resume();
      playBeep(audioRef.current);
    } catch {
      /* браузер без WebAudio */
    }
    vibrate();
    const mins = assessment.minutesToNearest;
    notify(
      "⚠ Ціль у вашому напрямку",
      mins != null ? `Найближча за ~${mins} хв` : "Перевірте обстановку",
      "infraua-inbound",
    );
  }, [inboundIds, sound, assessment]);

  function toggleSound() {
    const next = !sound;
    setSound(next);
    try {
      localStorage.setItem(LS_SOUND, next ? "1" : "0");
    } catch {
      /* приватний режим */
    }
    if (next) {
      // Дозвіл і «розблокування» звуку треба брати у відповідь на дотик.
      try {
        if (!audioRef.current) audioRef.current = new AudioContext();
        void audioRef.current.resume();
        playBeep(audioRef.current);
      } catch {
        /* без WebAudio */
      }
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          void Notification.requestPermission();
        }
      } catch {
        /* без Notifications */
      }
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Що загрожує саме моїй точці"
        className="pointer-events-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-cyan-400/40 bg-background/90 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan-300 hover:border-cyan-400"
      >
        <Crosshair className="size-3.5" /> Я тут
      </button>
    );
  }

  const verdictTone =
    assessment && assessment.minutesToNearest != null && assessment.minutesToNearest <= 15
      ? "text-red-400"
      : assessment && assessment.inboundCount > 0
        ? "text-amber-400"
        : "text-emerald-400";

  return (
    <div className="pointer-events-auto max-h-full w-[250px] max-w-full overflow-y-auto rounded border border-cyan-400/40 bg-background/95 p-2.5 backdrop-blur">
      <div className="mb-2 flex items-center gap-2">
        <Crosshair className="size-3.5 text-cyan-300" />
        <span className="flex-1 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-300">
          Моя точка
        </span>
        <button
          type="button"
          onClick={toggleSound}
          className={sound ? "text-emerald-400" : "text-muted-foreground hover:text-foreground"}
          aria-label={sound ? "Вимкнути звук тривоги" : "Увімкнути звук тривоги"}
          title="Звук, вібрація та сповіщення на нову вхідну ціль"
        >
          {sound ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:text-red-400"
          aria-label="Закрити"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {!point ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={locate}
            disabled={locating}
            className="w-full rounded border border-cyan-400/40 bg-cyan-400/10 px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-cyan-300 hover:border-cyan-400 disabled:opacity-50"
          >
            {locating ? "визначення…" : "Визначити за геолокацією"}
          </button>
          {geoError ? (
            <>
              <p className="font-mono text-[9px] leading-relaxed text-muted-foreground">
                {locationErrorText(geoError)}
              </p>
              {canOpenSettings ? (
                <button
                  type="button"
                  onClick={openLocationSettings}
                  className="w-full rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-amber-300 hover:border-amber-400"
                >
                  Відкрити налаштування доступу
                </button>
              ) : null}
            </>
          ) : null}
          {/*
            Пошук замість довгого списку: міст і областей під вісімдесят, і
            гортати їх на телефоні — мука. Вводиш кілька літер — datalist сам
            підказує. Точний збіг ставить точку одразу; частковий (напр.
            «кремен») — по Enter або коли поле втрачає фокус.
          */}
          <input
            list="me-places"
            inputMode="text"
            placeholder="Місто або область — почніть вводити…"
            className="w-full rounded border border-border bg-card px-1.5 py-1 font-mono text-[10px] text-foreground placeholder:text-muted-foreground/60"
            onChange={(e) => {
              const c = resolvePlace(e.target.value, false);
              if (c) persistPoint({ lat: c.lat, lon: c.lon });
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const c = resolvePlace((e.target as HTMLInputElement).value, true);
              if (c) persistPoint({ lat: c.lat, lon: c.lon });
            }}
            onBlur={(e) => {
              const c = resolvePlace(e.target.value, true);
              if (c) persistPoint({ lat: c.lat, lon: c.lon });
            }}
          />
          <datalist id="me-places">
            {ALL_PLACES.map((c) => (
              <option key={c.name} value={c.name} />
            ))}
          </datalist>
        </div>
      ) : assessment ? (
        <div className="space-y-2">
          {(() => {
            // Індекс «спати чи в укриття» — головне число для точки. Це оцінка
            // обстановки, не ймовірність влучання (див. advisory.dangerIndex).
            const di = dangerIndex(assessment);
            return (
              <div
                className={`flex items-center gap-2 rounded px-2 py-1.5 ${DANGER_BG[di.level]}`}
                title={di.caveat}
              >
                <span className={`flex items-baseline font-mono font-bold ${DANGER_FG[di.level]}`}>
                  {/* Без «%»: це індекс обстановки 0–100, а не ймовірність
                      влучання. Знак відсотка читався б саме як «шанс прильоту»,
                      якого ми не знаємо, — те, чого dangerIndex навмисно уникає. */}
                  <span className="text-[22px] leading-none">{di.percent}</span>
                  <span className="ml-0.5 text-[10px] opacity-60">/100</span>
                </span>
                <div className="min-w-0">
                  <div className={`text-[12px] font-bold leading-tight ${DANGER_FG[di.level]}`}>
                    {di.verdict}
                  </div>
                  <div className="font-mono text-[9px] leading-tight text-muted-foreground">
                    індекс небезпеки для точки
                  </div>
                </div>
              </div>
            );
          })()}
          <div className={`font-mono text-[12px] font-bold leading-tight ${verdictTone}`}>
            {assessment.minutesToNearest != null
              ? `~${assessment.minutesToNearest} хв до найближчої цілі`
              : assessment.inboundCount > 0
                ? `${assessment.inboundCount} у вашому напрямку`
                : assessment.sky.verdict}
          </div>

          {window ? (
            <div
              className={`rounded px-2 py-1.5 text-[11px] font-medium leading-snug ${
                window.exposed
                  ? "border border-red-500/40 bg-red-500/10 text-red-300"
                  : "border border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-300"
              }`}
            >
              {window.advice}
            </div>
          ) : null}

          <div className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground">
            <span>Вікна на:</span>
            <select
              value={side}
              onChange={(e) => persistSide(e.target.value as WindowSide | "")}
              className="ml-auto rounded border border-border bg-card px-1 py-0.5 text-[10px] text-foreground"
            >
              <option value="">—</option>
              {SIDES.map((s) => (
                <option key={s} value={s}>
                  {SIDE_TEXT[s]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-0.5">
            {assessment.nearest.length ? (
              assessment.nearest.map((n) => (
                <div
                  key={n.threat.id}
                  className="flex items-baseline gap-1.5 border-t border-border/60 py-0.5 text-[11px]"
                >
                  <span className={n.inbound ? "text-red-400" : "text-muted-foreground"}>
                    {n.inbound ? "➤" : "•"}
                  </span>
                  <span className="flex-1 truncate">{TypeLabel(n.threat.type)}</span>
                  <span className="font-mono text-[9px] text-muted-foreground">
                    {compass(n.bearingToThreat)} {n.distanceKm} км
                  </span>
                  {n.inbound && n.etaMin != null ? (
                    <span
                      className="font-mono text-[10px] font-bold text-red-400"
                      title={
                        n.etaRangeMin
                          ? `Оцінка ${n.etaRangeMin[0]}–${n.etaRangeMin[1]} хв — позиція цілі відома з точністю, яку називає джерело`
                          : undefined
                      }
                    >
                      {/* Широка вилка показується вилкою: одне число тут було б
                          випадковою точкою інтервалу, поданою як вимір. */}
                      {n.etaRangeMin && n.etaRangeMin[1] - n.etaRangeMin[0] >= 3
                        ? `${n.etaRangeMin[0]}–${n.etaRangeMin[1]}′`
                        : `${n.etaMin}′`}
                    </span>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="font-mono text-[10px] text-muted-foreground">
                Цілей у видачі поруч немає
              </p>
            )}
          </div>

          {debris ? (
            <div className="border-t border-border/60 pt-1.5 font-mono text-[9px] leading-relaxed text-cyan-300/90">
              💨 Вітер {(weather!.windKmh / 3.6).toFixed(1)} м/с · знос уламків на{" "}
              {debris.driftToLabel} ≈ {debris.driftMeters} м
            </div>
          ) : null}

          <p className="border-t border-border/60 pt-1.5 font-mono text-[9px] leading-relaxed text-muted-foreground">
            {assessment.sky.caveat}
          </p>

          <button
            type="button"
            onClick={() => persistPoint(null)}
            className="w-full font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground hover:text-foreground"
          >
            змінити точку
          </button>
        </div>
      ) : null}
    </div>
  );
}
