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

// Запасний вибір, коли геолокація закрита. Обласні центри — публічно відомі
// координати, не персональні дані.
const CITIES: { name: string; lat: number; lon: number }[] = [
  { name: "Київ", lat: 50.45, lon: 30.52 },
  { name: "Харків", lat: 49.99, lon: 36.23 },
  { name: "Дніпро", lat: 48.46, lon: 35.05 },
  { name: "Одеса", lat: 46.48, lon: 30.72 },
  { name: "Запоріжжя", lat: 47.84, lon: 35.14 },
  { name: "Львів", lat: 49.84, lon: 24.03 },
  { name: "Миколаїв", lat: 46.97, lon: 32.0 },
  { name: "Полтава", lat: 49.59, lon: 34.54 },
  { name: "Чернігів", lat: 51.49, lon: 31.29 },
  { name: "Суми", lat: 50.91, lon: 34.8 },
  { name: "Черкаси", lat: 49.44, lon: 32.06 },
  { name: "Херсон", lat: 46.64, lon: 32.61 },
];

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
  const [geoError, setGeoError] = useState(false);
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

  function locate() {
    setGeoError(false);
    if (!navigator.geolocation) {
      setGeoError(true);
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        persistPoint({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        setLocating(false);
        setGeoError(true);
      },
      { timeout: 8000, maximumAge: 60000 },
    );
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
        className="absolute left-14 top-2 z-[600] flex items-center gap-1.5 rounded border border-cyan-400/40 bg-background/90 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan-300 hover:border-cyan-400"
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
    <div className="absolute left-14 top-2 z-[600] w-[250px] max-w-[calc(100vw-4rem)] rounded border border-cyan-400/40 bg-background/95 p-2.5 backdrop-blur">
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
            <p className="font-mono text-[9px] leading-relaxed text-muted-foreground">
              Доступ до геолокації закрито. Оберіть місто:
            </p>
          ) : null}
          <select
            className="w-full rounded border border-border bg-card px-1.5 py-1 font-mono text-[10px] text-foreground"
            defaultValue=""
            onChange={(e) => {
              const c = CITIES.find((x) => x.name === e.target.value);
              if (c) persistPoint({ lat: c.lat, lon: c.lon });
            }}
          >
            <option value="">— обрати місто —</option>
            {CITIES.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
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
                    <span className="font-mono text-[10px] font-bold text-red-400">
                      {n.etaMin}′
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
