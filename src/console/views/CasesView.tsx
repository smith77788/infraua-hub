import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  FolderPlus,
  Folders,
  MessageSquarePlus,
  Search,
  ShieldAlert,
} from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  PanelHeader,
  Spinner,
  Textarea,
} from "@/console/components/primitives";
import { ClearanceBadge } from "@/console/components/ClearanceBadge";
import { api } from "@/console/lib/api";
import { useSession } from "@/console/hooks/useSession";
import type { AnalystCase } from "@/console/lib/types";
import { clearanceName, formatTimestamp, relativeTime } from "@/console/lib/format";

// A stable empty array: `?? []` allocates a new one on every render, which
// makes every useMemo downstream recompute even when the data has not changed.
const NONE: never[] = [];

/**
 * Cases are what an analyst keeps. An investigation on its own is gone the
 * moment you navigate away; a case holds the question, the findings gathered
 * against it, and the notes saying what they meant.
 *
 * The one behaviour worth being loud about: a case's classification rises to
 * cover whatever is attached to it and never falls. That is what stops a case
 * from becoming a way to read classified findings at a lower level — but it
 * also means attaching a sensitive finding can take a shared case out of a
 * colleague's view, so the UI says so at the moment it happens rather than
 * leaving them to discover it.
 */
export function CasesView() {
  const { apiKey } = useSession();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const cases = useQuery({ queryKey: ["cases"], queryFn: () => api.cases(apiKey) });

  if (cases.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (cases.isError) return <ErrorNote>{(cases.error as Error).message}</ErrorNote>;

  if (selectedId) {
    return <CaseDetail id={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return <CaseList cases={cases.data?.cases ?? NONE} onOpen={setSelectedId} />;
}

function CaseList({ cases, onOpen }: { cases: AnalystCase[]; onOpen: (id: string) => void }) {
  const { apiKey } = useSession();
  const queryClient = useQueryClient();
  const [title, setTitle] = React.useState("");

  const create = useMutation({
    mutationFn: () => api.createCase(apiKey, title.trim()),
    onSuccess: (created) => {
      setTitle("");
      void queryClient.invalidateQueries({ queryKey: ["cases"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
      onOpen(created.id);
    },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Cases</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A case keeps the question, the findings gathered against it, and what you concluded. Its
          classification rises to cover whatever you attach, and never falls.
        </p>
      </div>

      <Panel className="p-4">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) create.mutate();
          }}
        >
          <Input
            className="flex-1"
            placeholder="New case title — e.g. Q3 vendor affiliations"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="New case title"
          />
          <Button type="submit" loading={create.isPending} disabled={!title.trim()}>
            <FolderPlus className="h-3.5 w-3.5" /> Create
          </Button>
        </form>
        {create.isError && (
          <div className="mt-2">
            <ErrorNote>{(create.error as Error).message}</ErrorNote>
          </div>
        )}
      </Panel>

      {cases.length === 0 ? (
        <Panel>
          <EmptyState
            icon={Folders}
            title="No cases at your clearance"
            description="Create one above. If a colleague raised a shared case above your level by attaching a sensitive finding, it will have dropped out of this list."
          />
        </Panel>
      ) : (
        <Panel>
          <PanelHeader title="Open cases" description={`${cases.length}`} />
          <ul className="divide-y divide-border">
            {cases.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => onOpen(c.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {c.findings.length} finding{c.findings.length === 1 ? "" : "s"} ·{" "}
                      {c.notes.length} note{c.notes.length === 1 ? "" : "s"} · updated{" "}
                      {relativeTime(c.updatedAt)}
                    </p>
                  </div>
                  <ClearanceBadge level={c.clearance} />
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function CaseDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { apiKey } = useSession();
  const queryClient = useQueryClient();
  const [query, setQuery] = React.useState("");
  const [note, setNote] = React.useState("");
  const [raiseNotice, setRaiseNotice] = React.useState<{ from: number; to: number } | null>(null);

  const detail = useQuery({ queryKey: ["case", id], queryFn: () => api.case(apiKey, id) });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["case", id] });
    void queryClient.invalidateQueries({ queryKey: ["cases"] });
    void queryClient.invalidateQueries({ queryKey: ["audit"] });
  };

  const attach = useMutation({
    mutationFn: () => api.attachFinding(apiKey, id, query.trim()),
    onSuccess: (result) => {
      setQuery("");
      setRaiseNotice(
        result.clearanceRaised
          ? { from: result.previousClearance, to: result.case.clearance }
          : null,
      );
      refresh();
    },
  });

  const addNote = useMutation({
    mutationFn: () => api.addCaseNote(apiKey, id, note.trim()),
    onSuccess: () => {
      setNote("");
      refresh();
    },
  });

  if (detail.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="mx-auto max-w-4xl space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </Button>
        <ErrorNote>{(detail.error as Error).message}</ErrorNote>
      </div>
    );
  }

  const c = detail.data!;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="h-3.5 w-3.5" /> All cases
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{c.title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Created {formatTimestamp(c.createdAt)} · updated {relativeTime(c.updatedAt)}
          </p>
        </div>
        <ClearanceBadge level={c.clearance} showIcon />
      </div>

      {raiseNotice && (
        <div className="flex items-start gap-2 rounded-lg border border-clearance-confidential/50 bg-clearance-confidential/10 p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-clearance-confidential" />
          <p className="text-xs leading-relaxed">
            <span className="font-medium text-clearance-confidential">
              Case classification raised from {clearanceName(raiseNotice.from)} to{" "}
              {clearanceName(raiseNotice.to)}.
            </span>{" "}
            <span className="text-muted-foreground">
              The finding you attached rests on {clearanceName(raiseNotice.to)} entities, so the
              case now sits at that level to cover them. Colleagues below it can no longer open this
              case.
            </span>
          </p>
        </div>
      )}

      <Panel>
        <PanelHeader
          title="Add a finding"
          description="Runs the investigation and attaches the result, so what is stored is what the audit log holds"
        />
        <form
          className="flex flex-col gap-2 p-4 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) attach.mutate();
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Ask a question to attach its answer…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Investigation query to attach"
            />
          </div>
          <Button type="submit" loading={attach.isPending} disabled={!query.trim()}>
            Investigate &amp; attach
          </Button>
        </form>
        {attach.isError && (
          <div className="px-4 pb-4">
            <ErrorNote>{(attach.error as Error).message}</ErrorNote>
          </div>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Findings" description={`${c.findings.length}`} />
        {c.findings.length === 0 ? (
          <EmptyState
            title="Nothing attached yet"
            description="Every finding carries the audit sequence of the investigation that produced it, so it stays checkable later."
          />
        ) : (
          <ul className="divide-y divide-border">
            {c.findings.map((f, i) => (
              <li key={`${f.auditSeq}-${i}`} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xs font-medium">{f.query}</p>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <ClearanceBadge level={f.clearance} />
                    <span
                      className="font-mono text-[11px] text-muted-foreground"
                      title="Audit sequence — replay the full chain from here"
                    >
                      #{f.auditSeq}
                    </span>
                  </div>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed">{f.summary}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {f.entityIds.length} entit{f.entityIds.length === 1 ? "y" : "ies"} ·{" "}
                  {f.narrativeSource} · attached {relativeTime(f.attachedAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Notes" description={`${c.notes.length}`} />
        <form
          className="space-y-2 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) addNote.mutate();
          }}
        >
          <Textarea
            className="min-h-[72px]"
            placeholder="What did you conclude, and what still needs checking?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Case note"
          />
          <Button type="submit" size="sm" loading={addNote.isPending} disabled={!note.trim()}>
            <MessageSquarePlus className="h-3.5 w-3.5" /> Add note
          </Button>
          {addNote.isError && <ErrorNote>{(addNote.error as Error).message}</ErrorNote>}
        </form>
        {c.notes.length > 0 && (
          <ul className="divide-y divide-border border-t border-border">
            {c.notes.map((n, i) => (
              <li key={i} className="px-4 py-2.5">
                <p className="text-sm leading-relaxed">{n.text}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  <span className="font-mono">{n.authorKeyId.slice(0, 8)}</span> ·{" "}
                  {relativeTime(n.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {c.pinnedEntityIds.length > 0 && (
        <Panel>
          <PanelHeader title="Pinned entities" description={`${c.pinnedEntityIds.length}`} />
          <div className="flex flex-wrap gap-1.5 p-4">
            {c.pinnedEntityIds.map((entityId) => (
              <Badge
                key={entityId}
                className="border-border bg-muted font-mono text-muted-foreground"
              >
                {entityId}
              </Badge>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
