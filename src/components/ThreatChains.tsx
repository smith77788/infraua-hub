import { Clock, Radio, Siren } from "lucide-react";

import { CATEGORIES } from "@/lib/infra-types";
import { describeCode } from "@/lib/source-credibility";
import type { ThreatCorrelation, ThreatSeverity } from "@/lib/threat-correlation";
import type { ThreatProjection } from "@/lib/threat-eta";

/*
 * Список звʼязків «загроза → обʼєкт»: та сама кореляція, що й у графі, але
 * прочитана як відповідь, а не як схема.
 *
 * Граф вузлів чесно показує багато-до-багатьох, але щоб дістати з нього
 * відповідь, дивитися треба вміти. Питання під час нальоту завжди одне й те
 * саме — **що під ударом, від чого й скільки лишилось часу**, — і на нього
 * відповідає впорядкований список, де в кожного рядка є назва, а не обрізаний
 * підпис біля кружечка. Тому список тут стоїть першим, а граф лишається другою
 * вкладкою для тих випадків, коли справді треба побачити спільні цілі.
 *
 * Жодне число тут не рахується наново: беруться готові `ThreatCorrelation` і
 * `ThreatProjection`, тож список не може розійтися з картою й графом.
 */

const SEV: Record<ThreatSeverity, { label: string; chip: string; bar: string }> = {
  critical: {
    label: "Критично",
    chip: "border-red-500/50 bg-red-500/10 text-red-300",
    bar: "bg-red-500",
  },
  high: {
    label: "Високий",
    chip: "border-amber-500/50 bg-amber-500/10 text-amber-300",
    bar: "bg-amber-500",
  },
  medium: {
    label: "Середній",
    chip: "border-slate-500/50 bg-slate-500/10 text-slate-300",
    bar: "bg-slate-500",
  },
};

const SEV_ORDER: Record<ThreatSeverity, number> = { critical: 0, high: 1, medium: 2 };

/** Хвилини підльоту в людський вигляд: «<1 хв», «7 хв», «1 год 05 хв». */
function eta(min: number): string {
  if (min < 1) return "<1 хв";
  if (min < 60) return `${Math.round(min)} хв`;
  const h = Math.floor(min / 60);
  return `${h} год ${String(Math.round(min - h * 60)).padStart(2, "0")} хв`;
}

export default function ThreatChains({
  correlations,
  projections,
  onSelect,
}: {
  correlations: ThreatCorrelation[];
  projections: ThreatProjection[];
  onSelect?: (facilityId: string) => void;
}) {
  if (!correlations.length) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-emerald-400">
          Звʼязків «загроза → обʼєкт» немає
        </p>
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
          Це нормальний стан. Щойно повітряна ціль опиниться поруч із критичним обʼєктом, тут
          зʼявиться рядок: який обʼєкт, від чого, скільки часу лишилось і хто про це повідомив.
        </p>
      </div>
    );
  }

  // Найшвидший підліт до кожного обʼєкта — з проєкцій курсу, якщо джерело його дало.
  const soonest = new Map<string, ThreatProjection>();
  for (const p of projections) {
    const cur = soonest.get(p.facility.id);
    if (!cur || p.etaMin < cur.etaMin) soonest.set(p.facility.id, p);
  }

  const rows = [...correlations].sort(
    (a, b) =>
      SEV_ORDER[a.severity] - SEV_ORDER[b.severity] ||
      a.nearestKm - b.nearestKm ||
      a.facility.name.localeCompare(b.facility.name, "uk"),
  );

  return (
    <div className="size-full overflow-y-auto">
      <ul className="divide-y divide-border">
        {rows.map((c) => {
          const sev = SEV[c.severity];
          const p = soonest.get(c.facility.id);
          const cat = CATEGORIES[c.facility.category];
          return (
            <li key={c.facility.id}>
              <button
                type="button"
                onClick={() => onSelect?.(c.facility.id)}
                className="flex w-full items-stretch gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
              >
                <span className={`w-0.5 shrink-0 rounded-full ${sev.bar}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm font-medium text-foreground">
                      {c.facility.name}
                    </span>
                    <span
                      className={`rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] ${sev.chip}`}
                    >
                      {sev.label}
                    </span>
                    {c.inAlarmRegion ? (
                      <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.12em] text-amber-400">
                        <Siren className="size-3" /> тривога
                      </span>
                    ) : null}
                  </span>

                  <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
                    <span>{cat.label}</span>
                    <span>
                      найближча позначка <b className="text-foreground">{c.nearestKm.toFixed(1)}</b>{" "}
                      км
                    </span>
                    <span>
                      цілей поруч <b className="text-foreground">{c.threatCount}</b>
                    </span>
                    {p ? (
                      <span className="flex items-center gap-1 text-red-300">
                        <Clock className="size-3" />
                        підліт ~<b>{eta(p.etaMin)}</b>
                      </span>
                    ) : null}
                  </span>

                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-muted-foreground">
                    <Radio className="size-3 shrink-0" />
                    <span title={describeCode(c.credibility)}>
                      {c.credibility.code} · {c.reportCount} повідомл.
                    </span>
                    {c.sources.slice(0, 3).map((s) => (
                      <span key={s} className="rounded bg-muted/60 px-1 py-0.5 text-[9px]">
                        {s}
                      </span>
                    ))}
                    {c.sources.length > 3 ? <span>+{c.sources.length - 3}</span> : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
