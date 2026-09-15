import { useMemo } from "react";
import { Navigation } from "lucide-react";

import { type RaidFrame, timedTracks } from "@/lib/raid-replay";
import { estimateVelocity, reachedPlaces, swarmVector, type Velocity } from "@/lib/trajectory";
import { ALL_PLACES } from "@/lib/ua-cities";

const DIRS = [
  "північ",
  "північний схід",
  "схід",
  "південний схід",
  "південь",
  "південний захід",
  "захід",
  "північний захід",
];
function dirUk(bearing: number): string {
  return DIRS[Math.round(bearing / 45) % 8]!;
}

const MIN_CONFIDENCE = 0.4;

/**
 * «Куди йде рій» — прогноз руху за СПОСТЕРЕЖЕНИМ треком, не за полем heading.
 *
 * Зʼявляється лише коли накопичилось досить руху, щоб чесно порахувати вектор
 * (буфер реплею наповнюється з моменту відкриття). Немає впевненого треку —
 * панелі немає: порожній прогноз гірший за його відсутність.
 */
export default function WaveForecast({ frames }: { frames: readonly RaidFrame[] }) {
  const model = useMemo(() => {
    const tracks = timedTracks(frames);
    const confident: { lat: number; lon: number; v: Velocity }[] = [];
    for (const tr of tracks) {
      const v = estimateVelocity(tr.points);
      if (v && v.confidence >= MIN_CONFIDENCE) {
        const last = tr.points[tr.points.length - 1]!;
        confident.push({ lat: last.lat, lon: last.lon, v });
      }
    }
    if (confident.length === 0) return null;
    const swarm = swarmVector(confident.map((c) => c.v));
    if (!swarm) return null;
    const centroid = {
      lat: confident.reduce((s, c) => s + c.lat, 0) / confident.length,
      lon: confident.reduce((s, c) => s + c.lon, 0) / confident.length,
    };
    const reach = reachedPlaces(centroid, swarm, ALL_PLACES, { horizonMin: 30 }).slice(0, 3);
    return { swarm, reach, tracked: confident.length };
  }, [frames]);

  if (!model) return null;
  const { swarm, reach, tracked } = model;
  const conf = swarm.confidence >= 0.75 ? "висока" : swarm.confidence >= 0.55 ? "середня" : "нижча";
  const scattered = swarm.coherence < 0.6;

  return (
    <div className="pointer-events-auto absolute left-2 top-2 z-[600] max-w-[240px] rounded border border-cyan-500/40 bg-background/92 px-2.5 py-2 backdrop-blur">
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan-300">
        <Navigation className="size-3" />
        Прогноз руху рою
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-cyan-400/50 text-cyan-200"
          title={`курс ${swarm.bearingDeg}°`}
        >
          <Navigation className="size-4" style={{ transform: `rotate(${swarm.bearingDeg}deg)` }} />
        </span>
        <div className="min-w-0 text-[11px] leading-tight text-foreground">
          На <b>{dirUk(swarm.bearingDeg)}</b>, ~{swarm.speedKmh} км/год
          <div className="text-[9px] text-muted-foreground">
            за {tracked} {tracked === 1 ? "ціллю" : "цілями"} · впевненість {conf}
          </div>
        </div>
      </div>

      {scattered ? (
        <div className="mt-1 text-[9px] leading-snug text-amber-400">
          цілі йдуть урізнобіч — курс усереднений, довіряйте обережно
        </div>
      ) : null}

      {reach.length ? (
        <div className="mt-1.5 border-t border-border/60 pt-1.5">
          <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
            за курсом далі
          </div>
          <ul className="mt-0.5 space-y-0.5">
            {reach.map((r) => (
              <li key={r.name} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="truncate text-foreground">{r.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-cyan-300">~{r.etaMin} хв</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-1.5 text-[8px] leading-snug text-muted-foreground/80">
        оцінка за реально баченим рухом, не за курсом із джерела; похибка росте з часом
      </div>
    </div>
  );
}
