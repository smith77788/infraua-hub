import {
  AlertTriangle,
  Crosshair,
  HeartPulse,
  ShieldAlert,
  ShieldCheck,
  Siren,
} from "lucide-react";

import { focusLabel, sameFocus, type Focus } from "@/lib/focus";
import { EVENT_KINDS, type SituationLevel, type SituationSummary } from "@/lib/infra-types";

const LEVEL_STYLE: Record<
  SituationLevel,
  { dot: string; text: string; border: string; bg: string }
> = {
  normal: {
    dot: "bg-emerald-400",
    text: "text-emerald-400",
    border: "border-emerald-500/40",
    bg: "bg-emerald-500/10",
  },
  elevated: {
    dot: "bg-amber-400",
    text: "text-amber-400",
    border: "border-amber-500/40",
    bg: "bg-amber-500/10",
  },
  critical: {
    dot: "bg-red-500",
    text: "text-red-400",
    border: "border-red-500/50",
    bg: "bg-red-500/10",
  },
};

function LevelIcon({ level, className }: { level: SituationLevel; className?: string }) {
  if (level === "critical") return <ShieldAlert className={className} />;
  if (level === "elevated") return <AlertTriangle className={className} />;
  return <ShieldCheck className={className} />;
}

/**
 * Смуга обстановки під шапкою.
 *
 * Кожне число тут — вхід у свій зріз, а не напис. «Під загрозою 14» без
 * можливості побачити ці чотирнадцять змушувало шукати їх очима по карті
 * серед тисяч інших.
 */
export default function SituationBar({
  summary,
  loading,
  threats = 0,
  focus = null,
  onFocus,
}: {
  summary: SituationSummary;
  loading: boolean;
  threats?: number;
  focus?: Focus;
  onFocus?: (focus: Focus) => void;
}) {
  const s = LEVEL_STYLE[summary.level];

  /** Повторне натискання знімає фокус — інакше з нього не вийти тим же рухом. */
  const toggle = (next: Focus) => () => onFocus?.(sameFocus(focus, next) ? null : next);
  const active = (f: Focus) =>
    sameFocus(focus, f) ? "ring-1 ring-primary/70 bg-primary/10 rounded-full" : "";

  return (
    <div className="z-10 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card/40 px-4 py-2">
      <span
        className={`flex items-center gap-2 rounded-full border px-2.5 py-1 ${s.border} ${s.bg}`}
      >
        <span className="relative flex size-2">
          <span
            className={`absolute inline-flex size-full rounded-full ${s.dot} ${
              summary.level === "normal" ? "" : "animate-ping opacity-75"
            }`}
          />
          <span className={`relative inline-flex size-2 rounded-full ${s.dot}`} />
        </span>
        <LevelIcon level={summary.level} className={`size-3.5 ${s.text}`} />
        <span
          className={`font-mono text-[10px] font-semibold uppercase tracking-[0.14em] ${s.text}`}
        >
          {loading ? "Оцінка обстановки…" : summary.label}
        </span>
      </span>

      {threats > 0 ? (
        <span className="flex items-center gap-1.5 rounded-full border border-red-500/60 bg-red-500/15 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-red-400">
          <Crosshair className="size-3.5 animate-pulse" />
          Повітряні цілі
          <span>{threats}</span>
        </span>
      ) : null}

      {summary.alarms > 0 ? (
        <button
          onClick={toggle({ kind: "alarm" })}
          title={`Показати ${focusLabel({ kind: "alarm" })}`}
          className={`flex items-center gap-1.5 rounded-full border border-red-500/50 bg-red-500/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-red-400 transition-colors hover:bg-red-500/20 ${active({ kind: "alarm" })}`}
        >
          <Siren className="size-3.5 animate-pulse" />
          Повітряна тривога
          <span>{summary.alarms} обл.</span>
        </button>
      ) : null}

      <button
        onClick={toggle({ kind: "risk" })}
        disabled={summary.atRisk === 0}
        title={`Показати ${focusLabel({ kind: "risk" })}`}
        className={`flex items-center gap-1.5 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground ${active({ kind: "risk" })}`}
      >
        <AlertTriangle className="size-3 text-amber-400" />
        Під загрозою
        <span className="font-semibold text-foreground">{summary.atRisk}</span>
      </button>

      {summary.lifeAtRisk > 0 ? (
        <button
          onClick={toggle({ kind: "life-risk" })}
          title={`Показати ${focusLabel({ kind: "life-risk" })}`}
          className={`flex items-center gap-1.5 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-red-400 transition-colors hover:text-red-300 ${active({ kind: "life-risk" })}`}
        >
          <HeartPulse className="size-3" />
          Життєзабезпечення
          <span className="font-semibold">{summary.lifeAtRisk}</span>
        </button>
      ) : null}

      <span className="ml-auto flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {(Object.keys(EVENT_KINDS) as (keyof typeof EVENT_KINDS)[])
          .filter((k) => summary.byKind[k] > 0)
          .map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <span
                className="size-1.5 rounded-full"
                style={{ background: EVENT_KINDS[k].color }}
              />
              {EVENT_KINDS[k].label}
              <span className="font-semibold text-foreground">{summary.byKind[k]}</span>
            </span>
          ))}
        {summary.eventCount === 0 && !loading ? <span>Подій немає</span> : null}
      </span>
    </div>
  );
}
