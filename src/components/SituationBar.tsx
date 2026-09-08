import { AlertTriangle, HeartPulse, ShieldAlert, ShieldCheck, Siren } from "lucide-react";

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

/** Compact operational-status strip shown under the header. */
export default function SituationBar({
  summary,
  loading,
}: {
  summary: SituationSummary;
  loading: boolean;
}) {
  const s = LEVEL_STYLE[summary.level];

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

      {summary.alarms > 0 ? (
        <span className="flex items-center gap-1.5 rounded-full border border-red-500/50 bg-red-500/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-red-400">
          <Siren className="size-3.5 animate-pulse" />
          Повітряна тривога
          <span>{summary.alarms} обл.</span>
        </span>
      ) : null}

      <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        <AlertTriangle className="size-3 text-amber-400" />
        Під загрозою
        <span className="font-semibold text-foreground">{summary.atRisk}</span>
      </span>

      {summary.lifeAtRisk > 0 ? (
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-red-400">
          <HeartPulse className="size-3" />
          Життєзабезпечення
          <span className="font-semibold">{summary.lifeAtRisk}</span>
        </span>
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
