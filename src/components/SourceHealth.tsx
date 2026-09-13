import { Database } from "lucide-react";

import {
  SOURCE_STATE_LABEL,
  SOURCE_STATE_TONE,
  trustState,
  type SourceStatus,
} from "@/lib/sources";

/**
 * Панель джерел: чи можна зараз вірити тому, що на екрані.
 *
 * До цього кожне джерело повідомляло про себе окремим рядком у різних кутах
 * консолі. Оператор не міг за секунду відповісти на це питання, хоча вся
 * потрібна інформація вже була в системі.
 */
export default function SourceHealth({ sources }: { sources: SourceStatus[] }) {
  // Загальний індикатор — trustState: порожній benign-фід (немає збоїв/подій)
  // не робить усю панель тривожною. Порядок кожного джерела нижче лишається.
  const worst = trustState(sources);

  return (
    <section>
      <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <Database className="size-3" /> Джерела
        <span
          className={`ml-auto inline-flex items-center gap-1.5 ${worst === "live" ? "text-emerald-400" : "text-amber-400"}`}
        >
          <span className={`size-1.5 rounded-full ${SOURCE_STATE_TONE[worst]}`} />
          {SOURCE_STATE_LABEL[worst]}
        </span>
      </p>
      <div className="mt-2 space-y-1">
        {sources.map((s) => (
          <div key={s.id} className="flex items-baseline gap-2 text-[11px]">
            <span
              className={`mt-1 size-1.5 shrink-0 rounded-full ${SOURCE_STATE_TONE[s.state]} ${
                s.state === "loading" ? "animate-pulse" : ""
              }`}
            />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
              {s.count}
            </span>
            <span
              className="shrink-0 truncate font-mono text-[9px] text-muted-foreground"
              title={s.detail}
            >
              {s.detail}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
