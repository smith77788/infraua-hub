import type { ReactNode } from "react";

import { SOURCE_STATE_LABEL, SOURCE_STATE_TONE, type SourceState } from "@/lib/sources";
import type { WeatherNow } from "@/lib/air";
import type { SpaceWeather, InternetOutages } from "@/lib/infra.functions";

/*
 * Смуга під заголовком: наскільки можна вірити тому, що показано.
 *
 * Раніше вона повторювала рівень обстановки — той самий напис, що й у
 * `SituationBar` рядком нижче. Два однакові написи поспіль читаються як два
 * різні твердження, і око щоразу витрачає час, щоб переконатися, що ні. Тому
 * межа тут проста: `SituationBar` каже про світ, ця смуга — про дані (стан
 * джерел, частка фактів) і про фон, який на світ впливає, але дії не вимагає.
 *
 * Кожен чип має власний поріг видимості: важливіші лишаються на вузькому
 * екрані, фонові ховаються, а на мобільному все горизонтально прокручується.
 */

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
  worstSource,
  observedShare,
  spaceWeather,
  outages,
  weather,
}: {
  worstSource: SourceState;
  observedShare: number;
  spaceWeather?: SpaceWeather | undefined;
  outages?: InternetOutages | undefined;
  weather?: WeatherNow | undefined;
}) {
  return (
    <div className="flex h-6 shrink-0 items-center justify-start gap-4 overflow-x-auto whitespace-nowrap border-b border-border bg-card/20 px-4 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 sm:justify-center">
      <span className="flex items-center gap-1.5">
        <span className={`size-1.5 rounded-full ${SOURCE_STATE_TONE[worstSource]}`} />
        джерела: {SOURCE_STATE_LABEL[worstSource]}
      </span>
      <Chip from="sm" title="Частка звʼязків мережі, підтверджених спостереженням, а не виведених.">
        факт {Math.round(observedShare * 100)}% звʼязків
      </Chip>
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
