import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Download,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Select,
  Spinner,
} from "@/console/components/primitives";
import { api } from "@/console/lib/api";
import { useSession } from "@/console/hooks/useSession";
import type { AuditEntry } from "@/console/lib/types";
import { cn } from "@/lib/utils";
import { downloadJson, ellipsize, formatTimestamp, relativeTime } from "@/console/lib/format";

// A stable empty array: `?? []` allocates a new one on every render, which
// makes every useMemo downstream recompute even when the data has not changed.
const NONE: never[] = [];

const ACTION_TONES: Record<string, string> = {
  query_blocked: "border-destructive/40 bg-destructive/10 text-destructive",
  investigate: "border-primary/40 bg-primary/10 text-primary",
  ingest: "border-clearance-public/40 bg-clearance-public/10 text-clearance-public",
  ingest_structured: "border-clearance-public/40 bg-clearance-public/10 text-clearance-public",
};

/**
 * The audit trail, presented around the one fact that matters most: whether
 * the hash chain still verifies. If it does not, that is shown first and
 * loudly — a broken chain means an entry was altered or removed after the
 * fact, which invalidates every claim the platform makes about replayability.
 */
export function AuditView() {
  const { apiKey } = useSession();
  const [expanded, setExpanded] = React.useState<number | null>(null);
  const [search, setSearch] = React.useState("");
  const [actionFilter, setActionFilter] = React.useState("all");

  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.audit(apiKey),
  });

  const entries = audit.data?.entries ?? NONE;
  const verification = audit.data?.verification;

  const actions = React.useMemo(
    () => Array.from(new Set(entries.map((e) => e.action))).sort(),
    [entries],
  );

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return entries
      .filter((e) => actionFilter === "all" || e.action === actionFilter)
      .filter((e) => {
        if (!term) return true;
        return (
          e.actor.toLowerCase().includes(term) ||
          e.action.toLowerCase().includes(term) ||
          JSON.stringify(e.details).toLowerCase().includes(term)
        );
      })
      .slice()
      .reverse();
  }, [entries, search, actionFilter]);

  if (audit.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (audit.isError) return <ErrorNote>{(audit.error as Error).message}</ErrorNote>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Журнал аудиту</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Кожне завантаження, розслідування та заблокований запит — у ланцюжку хешів, тож зміна
            одного минулого запису ламає перевірку для всіх наступних.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadJson("palanter-audit.json", audit.data)}
            disabled={entries.length === 0}
          >
            <Download className="h-3.5 w-3.5" /> Експорт
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => audit.refetch()}
            loading={audit.isFetching}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Оновити
          </Button>
        </div>
      </div>

      {verification && (
        <div
          className={cn(
            "flex items-start gap-3 rounded-lg border p-4",
            verification.valid
              ? "border-clearance-public/40 bg-clearance-public/5"
              : "border-destructive/50 bg-destructive/10",
          )}
        >
          {verification.valid ? (
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-clearance-public" />
          ) : (
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          )}
          <div>
            <p
              className={cn(
                "text-sm font-semibold",
                verification.valid ? "text-clearance-public" : "text-destructive",
              )}
            >
              {verification.valid
                ? "Ланцюжок цілий"
                : `Ланцюжок порушено на записі #${verification.brokenAtSeq}`}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {verification.valid
                ? `Усі ${entries.length} записів перераховано до їхніх хешів. Повний ланцюжок «запит → план → код → результат» можна відтворити.`
                : "Запис змінили або видалили після написання. Усе від цього номера далі більше не можна вважати незміненим."}
            </p>
          </div>
        </div>
      )}

      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <Input
            className="min-w-[180px] flex-1"
            placeholder="Пошук за виконавцем, дією чи деталями…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Пошук записів аудиту"
          />
          <Select
            className="w-auto"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            aria-label="Фільтр за дією"
          >
            <option value="all">Усі дії</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
          <span className="text-xs text-muted-foreground">
            {filtered.length} з {entries.length}
          </span>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={entries.length === 0 ? "Записів ще немає" : "Нічого не збіглося"}
            description={
              entries.length === 0
                ? "Журнал наповнюється щойно ви завантажите документ або запустите розслідування."
                : "Спробуйте ширший пошук або інший фільтр дій."
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((entry) => (
              <AuditRow
                key={entry.seq}
                entry={entry}
                expanded={expanded === entry.seq}
                onToggle={() => setExpanded(expanded === entry.seq ? null : entry.seq)}
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function AuditRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: AuditEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/40"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground">
          #{entry.seq}
        </span>
        <Badge
          className={cn(
            "shrink-0",
            ACTION_TONES[entry.action] ?? "border-border bg-muted text-muted-foreground",
          )}
        >
          {entry.action}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{entry.actor}</span>
        <span
          className="shrink-0 text-[11px] text-muted-foreground"
          title={formatTimestamp(entry.timestamp)}
        >
          {relativeTime(entry.timestamp)}
        </span>
      </button>

      {expanded && (
        <div className="animate-fade-in space-y-3 border-t border-border bg-muted/20 px-4 py-3 pl-12">
          <div className="grid gap-2 text-[11px] sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">Записано </span>
              <span className="font-mono">{formatTimestamp(entry.timestamp)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Виконавець </span>
              <span className="font-mono">{entry.actor}</span>
            </div>
            <div title={entry.prev_hash}>
              <span className="text-muted-foreground">Попередній хеш </span>
              <span className="font-mono">{ellipsize(entry.prev_hash, 20)}</span>
            </div>
            <div title={entry.hash}>
              <span className="text-muted-foreground">Цей хеш </span>
              <span className="font-mono">{ellipsize(entry.hash, 20)}</span>
            </div>
          </div>
          <pre className="json-block">{JSON.stringify(entry.details, null, 2)}</pre>
        </div>
      )}
    </li>
  );
}
