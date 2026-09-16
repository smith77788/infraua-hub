import { useMemo } from "react";
import { Layers3 } from "lucide-react";

import type { Threat, ThreatType } from "@/lib/air";
import { UK } from "@/lib/channel-lexicon";
import { subsetVector } from "@/lib/swarm-forecast";
import type { Wave } from "@/lib/waves";
import CollapsiblePanel from "./CollapsiblePanel";

const COLOR: Record<ThreatType, string> = {
  shahed: "#ffd23f",
  reactive: "#ff8c1a",
  cruise: "#ff6a2a",
  missile: "#ff4d4d",
  ballistic: "#ff2d2d",
  kab: "#ffb020",
  recon: "#22d3ee",
  aircraft: "#38bdf8",
  unknown: "#ffb020",
};

const DIRS = ["Пн", "ПнСх", "Сх", "ПдСх", "Пд", "ПдЗх", "Зх", "ПнЗх"];
function dirUk(bearing: number): string {
  return DIRS[Math.round(bearing / 45) % 8]!;
}

const TREND: Record<Wave["trend"], string> = {
  growing: "росте",
  steady: "стабільно",
  shrinking: "слабшає",
};

/**
 * «Активні хвилі» — структура нальоту, а не купа позначок.
 *
 * Показуємо лише коли хвиль ДВІ або більше: там, де важливо бачити, що це не
 * один рій, а кілька окремих груп з різних боків. Одну хвилю вже описує
 * «Прогноз руху рою», тож дублювати її тут не треба.
 *
 * Курс КОЖНОЇ хвилі — з її власних треків (трек-двигун), а не з усередненого
 * поля: дві хвилі можуть іти в різні боки, і саме це найважливіше показати.
 */
export default function ActiveWaves({
  waves,
  threats,
}: {
  waves: readonly Wave[];
  threats: readonly Threat[];
}) {
  const rows = useMemo(() => {
    const now = Date.now();
    const byId = new Map(threats.map((t) => [t.id, t]));
    const present = waves.filter((w) => w.status !== "fading");
    return present.map((w) => {
      const members = w.threatIds.map((id) => byId.get(id)).filter((t): t is Threat => !!t);
      const sw = subsetVector(members, now);
      const dir = sw && sw.coherence >= 0.5 ? dirUk(sw.bearingDeg) : null;
      return { wave: w, dir };
    });
  }, [waves, threats]);

  const active = rows.length;
  if (active < 2) return null;

  return (
    <CollapsiblePanel
      storageKey="waves"
      borderClass="border-orange-500/40"
      textClass="text-orange-300"
      title={
        <>
          <Layers3 className="size-3 shrink-0" />
          Активних хвиль: {active}
        </>
      }
    >
      <ul className="space-y-1">
        {rows.map(({ wave, dir }) => (
          <li key={wave.id} className="flex items-baseline gap-1.5 text-[11px] leading-tight">
            <span
              className="mt-1 size-2 shrink-0 rounded-full"
              style={{ background: COLOR[wave.dominantType] }}
            />
            <span className="min-w-0 text-foreground">
              <b>{wave.count}</b> {UK.typeName(wave.dominantType, wave.count)}
              <span className="text-muted-foreground">
                {" · "}
                {TREND[wave.trend]}
                {dir ? ` · на ${dir}` : ""}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 text-[8px] leading-snug text-muted-foreground/80">
        окремі скоординовані групи; курс кожної — з її власного треку
      </div>
    </CollapsiblePanel>
  );
}
