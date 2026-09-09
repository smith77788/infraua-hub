import { AlertTriangle, Building2, Siren, X } from "lucide-react";

import { BandChip } from "@/components/CriticalityBreakdown";
import type { OperatorProfile } from "@/lib/operators";
import { CATEGORIES } from "@/lib/infra-types";

/**
 * Досьє оператора.
 *
 * Відмова однієї організації — це не один обʼєкт, а вся її частка мережі.
 * Концентрація критичних вузлів в одного оператора і є той ризик, якого не
 * видно, поки дивишся на обʼєкти поодинці.
 */
export default function OperatorPanel({
  profile,
  onSelect,
  onClose,
}: {
  profile: OperatorProfile;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <section className="mb-5">
      <div className="flex items-center gap-2">
        <Building2 className="size-3 text-muted-foreground" />
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Оператор
        </p>
        <button
          onClick={onClose}
          className="ml-auto rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Закрити досьє"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <h2 className="mt-1.5 text-sm font-semibold leading-snug">{profile.operator}</h2>

      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <div className="rounded border border-border bg-card p-2">
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
            Обʼєктів
          </p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums">{profile.total}</p>
        </div>
        <div className="rounded border border-border bg-card p-2">
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
            Макс. індекс
          </p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-primary">
            {profile.maxScore}
          </p>
        </div>
        <div className="rounded border border-border bg-card p-2">
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
            Середній
          </p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-muted-foreground">
            {profile.avgScore}
          </p>
        </div>
      </div>

      {profile.atRisk > 0 || profile.underAlarm > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {profile.atRisk > 0 ? (
            <span className="flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-mono text-[10px] text-amber-400">
              <AlertTriangle className="size-3" />
              {profile.atRisk} під загрозою
            </span>
          ) : null}
          {profile.underAlarm > 0 ? (
            <span className="flex items-center gap-1.5 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 font-mono text-[10px] text-red-400">
              <Siren className="size-3" />
              {profile.underAlarm} у зоні тривоги
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Присутність у кількох секторах і концентрація в одному — різні ризики. */}
      <div className="mt-2 space-y-1">
        {profile.sectors.map((s) => (
          <div key={s.tier} className="flex items-center gap-2 text-[11px]">
            <span className="flex-1 truncate text-muted-foreground">{s.label}</span>
            <span className="font-mono tabular-nums">{s.count}</span>
            <span className="h-1 w-16 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-primary/70"
                style={{ width: `${Math.round((s.count / profile.total) * 100)}%` }}
              />
            </span>
          </div>
        ))}
      </div>

      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        Обʼєкти — найкритичніші першими
      </p>
      <div className="mt-1 space-y-0.5">
        {profile.facilities.slice(0, 20).map(({ facility, analytics }) => (
          <button
            key={facility.id}
            onClick={() => onSelect(facility.id)}
            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-muted"
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: CATEGORIES[facility.category].color }}
            />
            <span className="min-w-0 flex-1 truncate text-[11px]">{facility.name}</span>
            {analytics ? <BandChip band={analytics.band} score={analytics.score} /> : null}
          </button>
        ))}
        {profile.facilities.length > 20 ? (
          <p className="px-1.5 pt-1 font-mono text-[9px] text-muted-foreground">
            Показано 20 з {profile.facilities.length}. Фокус на операторі лишає на карті всі.
          </p>
        ) : null}
      </div>
    </section>
  );
}
