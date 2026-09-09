import { CircleHelp } from "lucide-react";

import { BAND_LABEL, type CriticalityBand, type CriticalitySignal } from "@/lib/infra-criticality";

/**
 * Розбір індексу критичності на сигнали.
 *
 * Оцінка, яку не можна розібрати, все одно призводить до дій — і ніхто не
 * може сказати, чи вона знайшла справжню вразливість, чи корелює з чимось
 * стороннім. Тому «73» тут завжди показується разом із рядками, з яких воно
 * складається, і аналітик може не погодитись із кожним окремо.
 */

export const BAND_TONE: Record<CriticalityBand, { text: string; border: string; bg: string }> = {
  severe: { text: "text-red-400", border: "border-red-500/50", bg: "bg-red-500/10" },
  high: { text: "text-orange-400", border: "border-orange-500/50", bg: "bg-orange-500/10" },
  elevated: { text: "text-amber-400", border: "border-amber-500/40", bg: "bg-amber-500/10" },
  low: { text: "text-muted-foreground", border: "border-border", bg: "bg-muted/40" },
};

export function BandChip({ band, score }: { band: CriticalityBand; score: number }) {
  const tone = BAND_TONE[band];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${tone.border} ${tone.bg} ${tone.text}`}
    >
      <span className="tabular-nums">{score}</span>
      {BAND_LABEL[band]}
    </span>
  );
}

export default function CriticalityBreakdown({
  signals,
  score,
  band,
}: {
  signals: CriticalitySignal[];
  score: number;
  band: CriticalityBand;
}) {
  if (signals.length === 0) {
    return (
      <p className="font-mono text-[10px] text-muted-foreground">
        Жоден сигнал не спрацював — оцінка нуль.
      </p>
    );
  }

  const sum = signals.reduce((n, s) => n + s.contribution, 0);
  const ungrounded = signals.filter((s) => !s.grounded).length;

  return (
    <div className="space-y-1.5">
      {signals.map((s) => (
        <div key={s.id} className="rounded border border-border/60 bg-background/40 p-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium">{s.label}</span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-primary">
              +{s.contribution}
            </span>
          </div>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{s.evidence}</p>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{s.reason}</p>
          {s.grounded ? null : (
            <p className="mt-1 flex items-start gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-1 text-[10px] leading-relaxed text-amber-400">
              <CircleHelp className="mt-px size-3 shrink-0" />
              Тримається на виведених звʼязках: якщо прибрати припущення про живлення, сигнал
              зникає. Це висновок про нашу модель мережі, а не про саму мережу.
            </p>
          )}
        </div>
      ))}
      <p className="pt-0.5 font-mono text-[10px] text-muted-foreground">
        Разом {sum}
        {sum > score ? ` → ${score} (обмеження сотнею)` : ""} · {BAND_LABEL[band].toLowerCase()}{" "}
        рівень
        {ungrounded > 0 ? (
          <>
            {" "}
            ·{" "}
            <span className="text-amber-400">
              {ungrounded} з {signals.length}
            </span>{" "}
            тримається лише на припущеннях
          </>
        ) : null}
      </p>
    </div>
  );
}
