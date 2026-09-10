import type { ReactNode } from "react";

import { SOURCE_STATE_LABEL, SOURCE_STATE_TONE, type SourceState } from "@/lib/sources";
import type { SituationLevel } from "@/lib/infra-types";
import type { WeatherNow } from "@/lib/air";
import type { SpaceWeather, InternetOutages } from "@/lib/infra.functions";

/*
 * Смуга стану під заголовком. Раніше вона жила великим інлайновим блоком у
 * маршруті — з ростом кількості фідів (повітря/Kp/інтернет/погода) це стало
 * важко читати й підтримувати. Тут вона зібрана в один компонент: кожен чип із
 * власним рівнем пріоритету видимості (важливіші лишаються на вузькому екрані,
 * фонові ховаються), а на мобільному все горизонтально прокручується.
 */

const LEVEL_STRIP: Record<SituationLevel, string> = {
  critical: "border-red-500/40 bg-red-500/10 text-red-300",
  elevated: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  normal: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
};

const COMPASS8 = ["Пн", "ПнСх", "Сх", "ПдСх", "Пд", "ПдЗх", "Зх", "ПнЗх"];
const compass = (deg: number) => COMPASS8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** Чип із порогом видимості: base=завжди, sm/md/lg — ховається на вужчому. */
function Chip({
  children,
  from,
  tone,
  title,
}: {
  children: ReactNode;
  from?: "sm" | "md" | "lg";
  tone?: string;
  title?: string;
}) {
  const vis =
    from === "lg"
      ? "hidden lg:flex"
      : from === "md"
        ? "hidden md:flex"
        : from === "sm"
          ? "hidden sm:flex"
          : "flex";
  return (
    <>
      <span className="opacity-40">·</span>
      <span className={`${vis} items-center gap-1.5 ${tone ?? ""}`} title={title}>
        {children}
      </span>
    </>
  );
}

export default function StatusStrip({
  level,
  label,
  worstSource,
  observedShare,
  airThreat,
  spaceWeather,
  outages,
  weather,
}: {
  level: SituationLevel;
  label: string;
  worstSource: SourceState;
  observedShare: number;
  airThreat: { total: number; critical: number };
  spaceWeather?: SpaceWeather | undefined;
  outages?: InternetOutages | undefined;
  weather?: WeatherNow | undefined;
}) {
  return (
    <div
      className={`flex h-6 shrink-0 items-center justify-start gap-4 overflow-x-auto whitespace-nowrap border-b px-4 font-mono text-[10px] uppercase tracking-[0.16em] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 sm:justify-center ${LEVEL_STRIP[level]}`}
    >
      <span>{label}</span>
      <Chip>
        <span className={`size-1.5 rounded-full ${SOURCE_STATE_TONE[worstSource]}`} />
        джерела: {SOURCE_STATE_LABEL[worstSource]}
      </Chip>
      <Chip from="sm">факт {Math.round(observedShare * 100)}% звʼязків</Chip>
      {airThreat.total > 0 ? (
        <Chip tone="text-red-300">
          <span className="size-1.5 animate-pulse rounded-full bg-red-400" />
          повітря: {airThreat.total} обʼєкт(ів) під загрозою
          {airThreat.critical > 0 ? `, ${airThreat.critical} критич.` : ""}
        </Chip>
      ) : null}
      {spaceWeather && !spaceWeather.degraded ? (
        <Chip
          from="sm"
          tone={
            spaceWeather.level === "storm"
              ? "text-red-300"
              : spaceWeather.level === "unsettled"
                ? "text-amber-300"
                : "text-muted-foreground"
          }
          title="Планетарний Kp-індекс (NOAA). Бурі погіршують ГНСС/навігацію."
        >
          Kp {spaceWeather.kp}
          {spaceWeather.gScale > 0 ? ` · буря G${spaceWeather.gScale}` : ""}
        </Chip>
      ) : null}
      {outages && !outages.degraded && outages.count > 0 ? (
        <Chip
          from="md"
          tone="text-amber-300"
          title="Інтернет-збої по Україні за 24 год (IODA, Georgia Tech). Падіння звʼязності часто супроводжує удари по інфраструктурі."
        >
          інтернет-збої: {outages.count} за 24 год
        </Chip>
      ) : null}
      {weather && !weather.degraded ? (
        <Chip
          from="lg"
          tone="text-muted-foreground"
          title="Погода над Києвом (open-meteo). Вітер важить для роботи БпЛА й поширення пожеж."
        >
          Київ {weather.tempC}° · вітер {weather.windKmh} км/год {compass(weather.windDir)}
        </Chip>
      ) : null}
    </div>
  );
}
