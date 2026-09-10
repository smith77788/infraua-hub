import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Siren, Table2, X } from "lucide-react";

import { BAND_TONE } from "@/components/CriticalityBreakdown";
import {
  buildRows,
  COLUMNS,
  ROW_LIMIT,
  sortRows,
  type SortDirection,
  type SortKey,
} from "@/lib/entity-table";
import type { FacilityAnalytics } from "@/lib/infra-analytics";
import type { Facility } from "@/lib/infra-types";

/**
 * Таблиця обʼєктів під картою.
 *
 * Карта відповідає «де», граф «через що», а це — «які саме і в якому
 * порядку». До неї впорядкувати обʼєкти можна було тільки так, як вирішили
 * ми: єдиний рейтинг за критичністю. Тут порядок обирає аналітик.
 *
 * Таблиця показує рівно те, що зараз на карті: ті самі фільтри, той самий
 * пошук. Інакше два зрізи одних даних суперечили б одне одному на сусідніх
 * панелях.
 */
export default function EntityTable({
  facilities,
  analytics,
  selectedId,
  onSelect,
  onOperator,
  onClose,
}: {
  facilities: Facility[];
  analytics: Map<string, FacilityAnalytics>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Оператор — теж сутність, а не текст у комірці. */
  onOperator: (operator: string) => void;
  onClose: () => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [direction, setDirection] = useState<SortDirection>("desc");

  const rows = useMemo(() => buildRows(facilities, analytics), [facilities, analytics]);
  const sorted = useMemo(() => sortRows(rows, sortKey, direction), [rows, sortKey, direction]);
  const shown = sorted.slice(0, ROW_LIMIT);

  const toggle = (key: SortKey) => {
    if (key === sortKey) {
      setDirection((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    // Числові стовпці корисніші згори вниз: найбільший індекс — те, заради
    // чого на них узагалі натискають.
    setDirection(COLUMNS.find((c) => c.key === key)?.numeric ? "desc" : "asc");
  };

  return (
    <div className="flex h-56 shrink-0 flex-col border-t border-border bg-card">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Table2 className="size-3 text-muted-foreground" />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Обʼєкти
        </span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {shown.length < sorted.length ? `${shown.length} з ${sorted.length}` : sorted.length}
        </span>
        <button
          onClick={onClose}
          className="ml-auto rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Сховати таблицю"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-left font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={`px-2 py-1 font-normal ${c.numeric ? "text-right" : ""}`}
                >
                  <button
                    onClick={() => toggle(c.key)}
                    className={`inline-flex items-center gap-0.5 hover:text-foreground ${
                      sortKey === c.key ? "text-foreground" : ""
                    }`}
                  >
                    {c.label}
                    {sortKey === c.key ? (
                      direction === "asc" ? (
                        <ChevronUp className="size-2.5" />
                      ) : (
                        <ChevronDown className="size-2.5" />
                      )
                    ) : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.id}
                onClick={() => onSelect(r.id)}
                className={`cursor-pointer border-b border-border/40 transition-colors hover:bg-muted ${
                  selectedId === r.id ? "bg-muted" : ""
                }`}
              >
                <td
                  className={`px-2 py-1 text-right font-mono tabular-nums ${BAND_TONE[r.band].text}`}
                >
                  {r.score}
                </td>
                <td className="max-w-[18rem] truncate px-2 py-1">{r.name}</td>
                <td className="px-2 py-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ background: r.categoryColor }}
                    />
                    <span className="truncate text-muted-foreground">{r.categoryLabel}</span>
                  </span>
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                  {r.voltageLabel || "—"}
                </td>
                <td className="max-w-[12rem] truncate px-2 py-1 text-muted-foreground">
                  {r.operator ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onOperator(r.operator);
                      }}
                      className="truncate underline decoration-dotted underline-offset-2 transition-colors hover:text-primary"
                      title="Відкрити досьє оператора"
                    >
                      {r.operator}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                  {r.dependents || "—"}
                </td>
                <td className="px-2 py-1">
                  <span className="flex items-center gap-1.5">
                    {r.underAlarm ? <Siren className="size-3 text-red-400" /> : null}
                    {r.atRisk ? <span className="size-1.5 rounded-full bg-amber-400" /> : null}
                    {!r.underAlarm && !r.atRisk ? (
                      <span className="text-muted-foreground">—</span>
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {shown.length < sorted.length ? (
          <p className="px-2 py-1.5 font-mono text-[9px] text-muted-foreground">
            Показано перші {ROW_LIMIT} за поточним сортуванням. Звузьте фільтри або пошук, щоб
            побачити решту.
          </p>
        ) : null}
      </div>
    </div>
  );
}
