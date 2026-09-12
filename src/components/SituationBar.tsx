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
 *
 * Колір тут — не оформлення, а рівень терміновості, і словник у нього рівно
 * один:
 *
 * - **червоне** — вимагає дії зараз (ціль іде на наші обʼєкти, постраждало
 *   життєзабезпечення);
 * - **бурштинове** — тримати в полі зору (тривога, обʼєкти під подією);
 * - **сіре** — фон.
 *
 * До цього червоним світилися одночасно тривога, цілі й життєзабезпечення, і
 * всі три пульсували. Коли терміновим позначено все, не позначено нічого:
 * повітряна тривога в Україні майже щоденна, тож червоний чип на ній горів
 * постійно і забирав увагу в тих двох, які справді означають «дій зараз».
 */
export default function SituationBar({
  summary,
  loading,
  threats = 0,
  airThreat = { total: 0, critical: 0 },
  focus = null,
  onFocus,
  eventKind = null,
  onEventKind,
  showInfra = true,
}: {
  summary: SituationSummary;
  loading: boolean;
  /** Лічильники, що рахують наші обʼєкти, зникають разом із ними. */
  showInfra?: boolean;
  threats?: number;
  /** Скільки наших обʼєктів корелює з цілями в повітрі — з них і береться червоне. */
  airThreat?: { total: number; critical: number };
  focus?: Focus;
  onFocus?: (focus: Focus) => void;
  /** Обраний вид події — стрічка й карта показують лише його. */
  eventKind?: keyof typeof EVENT_KINDS | null;
  onEventKind?: (kind: keyof typeof EVENT_KINDS | null) => void;
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
        <span
          title={
            airThreat.total > 0
              ? `Цілей у повітрі: ${threats}. Поруч із ними ${airThreat.total} наших обʼєкт(ів).`
              : `Цілей у повітрі: ${threats}. Поруч із нашими обʼєктами наразі немає.`
          }
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] ${
            airThreat.total > 0
              ? "border-red-500/60 bg-red-500/15 text-red-400"
              : "border-amber-500/40 bg-amber-500/10 text-amber-400"
          }`}
        >
          <Crosshair className={`size-3.5 ${airThreat.total > 0 ? "animate-pulse" : ""}`} />
          Повітряні цілі
          <span>{threats}</span>
          {airThreat.total > 0 ? (
            <span className="font-normal normal-case tracking-normal opacity-90">
              → {airThreat.total} обʼєкт(ів)
              {airThreat.critical > 0 ? `, ${airThreat.critical} критич.` : ""}
            </span>
          ) : null}
        </span>
      ) : null}

      {summary.alarms > 0 ? (
        <button
          onClick={toggle({ kind: "alarm" })}
          title={
            summary.underAlarm > 0
              ? `Тривога у ${summary.alarms} обл., під нею ${summary.underAlarm} наших обʼєкт(ів). Показати ${focusLabel({ kind: "alarm" })}`
              : `Тривога у ${summary.alarms} обл., наших обʼєктів у цих областях немає. Показати ${focusLabel({ kind: "alarm" })}`
          }
          className={`flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-400 transition-colors hover:bg-amber-500/20 ${active({ kind: "alarm" })}`}
        >
          <Siren className="size-3.5" />
          Повітряна тривога
          <span>{summary.alarms} обл.</span>
        </button>
      ) : null}

      {showInfra ? (
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
      ) : null}

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
            <button
              key={k}
              onClick={() => onEventKind?.(eventKind === k ? null : k)}
              title={`Показати лише «${EVENT_KINDS[k].label}»`}
              className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 transition-colors hover:text-foreground ${
                eventKind === k ? "bg-primary/10 text-foreground ring-1 ring-primary/70" : ""
              }`}
            >
              <span
                className="size-1.5 rounded-full"
                style={{ background: EVENT_KINDS[k].color }}
              />
              {EVENT_KINDS[k].label}
              <span className="font-semibold text-foreground">{summary.byKind[k]}</span>
            </button>
          ))}
        {summary.eventCount === 0 && !loading ? <span>Подій немає</span> : null}
      </span>
    </div>
  );
}
