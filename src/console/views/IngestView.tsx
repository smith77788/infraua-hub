import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, FileText, Upload } from "lucide-react";
import {
  Badge,
  Button,
  ErrorNote,
  Field,
  Input,
  Panel,
  PanelHeader,
  Select,
  Tabs,
  Textarea,
} from "@/console/components/primitives";
import { api } from "@/console/lib/api";
import { useSession } from "@/console/hooks/useSession";
import { CLEARANCE_NAMES, CLEARANCE_ORDER, type StructuredMapping } from "@/console/lib/types";
import { clearanceName } from "@/console/lib/format";

const SECTORS = ["Corporate", "Defense"] as const;

const SAMPLE_TEXT =
  "Compliance audit: Director John Doe approved a no-bid contract worth $1,500,000 with Shell Consulting LLC, a hidden beneficiary vendor.";

const SAMPLE_CSV = `emp_id,emp_name,org_id,org_name,role
1,John Doe,A1,Acme Corp,Director
2,Jane Roe,A1,Acme Corp,Analyst`;

const SAMPLE_MAPPING: StructuredMapping = {
  entities: [
    { type: "Person", idField: "emp_id", labelField: "emp_name", properties: ["role"] },
    { type: "Organization", idField: "org_id", labelField: "org_name" },
  ],
  edges: [{ relation: "AFFILIATED_WITH", fromField: "emp_id", toField: "org_id" }],
};

/**
 * Both ingestion paths in one place.
 *
 * The clearance selector here offers only levels at or below the operator's
 * own — and the server clamps it again regardless, because a UI restriction is
 * a convenience, not a control.
 */
export function IngestView() {
  const { apiKey, clearance } = useSession();
  const queryClient = useQueryClient();
  const [tab, setTab] = React.useState<"text" | "structured">("text");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["graph"] });
    void queryClient.invalidateQueries({ queryKey: ["analytics"] });
    void queryClient.invalidateQueries({ queryKey: ["audit"] });
    void queryClient.invalidateQueries({ queryKey: ["health"] });
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Ingest</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Free text goes through entity extraction; already-tabular data maps straight onto the
          ontology. Both write to the same graph and the same audit chain.
        </p>
      </div>

      <Tabs
        tabs={[
          { id: "text" as const, label: "Free text" },
          { id: "structured" as const, label: "Structured / CSV" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "text" ? (
        <TextIngestForm apiKey={apiKey} maxClearance={clearance ?? 0} onDone={invalidate} />
      ) : (
        <StructuredIngestForm apiKey={apiKey} maxClearance={clearance ?? 0} onDone={invalidate} />
      )}
    </div>
  );
}

function ClearanceSelect({
  value,
  onChange,
  maxClearance,
}: {
  value: number;
  onChange: (v: number) => void;
  maxClearance: number;
}) {
  return (
    <Field
      label="Classification"
      hint={`You can classify at or below your own clearance (${clearanceName(maxClearance)}). The server clamps this regardless of what the console sends.`}
    >
      <Select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {CLEARANCE_ORDER.filter((level) => level <= maxClearance).map((level) => (
          <option key={level} value={level}>
            {CLEARANCE_NAMES[level]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function ResultSummary({
  nodesCreated,
  edgesCreated,
  edgesRejected,
  extra,
}: {
  nodesCreated: string[];
  edgesCreated: string[];
  edgesRejected: { edge: string; reason: string }[];
  extra?: React.ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-md border border-clearance-public/40 bg-clearance-public/5 p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-clearance-public">
        <CheckCircle2 className="h-4 w-4" /> Ingested
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Badge className="border-border bg-muted text-muted-foreground">
          {nodesCreated.length} entities
        </Badge>
        <Badge className="border-border bg-muted text-muted-foreground">
          {edgesCreated.length} relations
        </Badge>
        {extra}
      </div>

      {edgesRejected.length > 0 && (
        <div className="rounded border border-clearance-confidential/40 bg-clearance-confidential/10 p-2.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-clearance-confidential">
            <AlertTriangle className="h-3.5 w-3.5" />
            {edgesRejected.length} relation{edgesRejected.length === 1 ? "" : "s"} rejected by the
            ontology
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {edgesRejected.map((r, i) => (
              <li key={i} className="font-mono text-[11px] text-muted-foreground">
                {r.edge} — {r.reason}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Rejections are shown rather than silently dropped: a relation the ontology refuses is
            usually a mapping mistake worth seeing.
          </p>
        </div>
      )}
    </div>
  );
}

function TextIngestForm({
  apiKey,
  maxClearance,
  onDone,
}: {
  apiKey: string;
  maxClearance: number;
  onDone: () => void;
}) {
  const [text, setText] = React.useState("");
  const [source, setSource] = React.useState("");
  const [sector, setSector] = React.useState<string>(SECTORS[0]);
  const [level, setLevel] = React.useState(Math.min(1, maxClearance));

  const mutation = useMutation({
    mutationFn: () =>
      api.ingestText(apiKey, {
        text,
        source,
        sector,
        clearance: CLEARANCE_NAMES[level as 0 | 1 | 2 | 3 | 4],
      }),
    onSuccess: onDone,
  });

  return (
    <Panel>
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <FileText className="h-4 w-4" /> Free-text document
          </span>
        }
        description="Entities and relations are extracted, then validated against config/ontology.json"
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setText(SAMPLE_TEXT);
              setSource("Audit_Report.txt");
            }}
          >
            Use example
          </Button>
        }
      />
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && source.trim()) mutation.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Source" hint="Where this came from — kept as provenance.">
            <Input
              placeholder="Audit_Report.txt"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              required
            />
          </Field>
          <Field label="Sector">
            <Select value={sector} onChange={(e) => setSector(e.target.value)}>
              {SECTORS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <ClearanceSelect value={level} onChange={setLevel} maxClearance={maxClearance} />
        </div>

        <Field label="Document text">
          <Textarea
            className="min-h-[160px]"
            placeholder="Paste the document…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
          />
        </Field>

        {mutation.isError && <ErrorNote>{(mutation.error as Error).message}</ErrorNote>}
        {mutation.isSuccess && (
          <ResultSummary
            nodesCreated={mutation.data.nodesCreated}
            edgesCreated={mutation.data.edgesCreated}
            edgesRejected={mutation.data.edgesRejected}
          />
        )}

        <Button
          type="submit"
          loading={mutation.isPending}
          disabled={!text.trim() || !source.trim()}
        >
          <Upload className="h-3.5 w-3.5" /> Ingest document
        </Button>
      </form>
    </Panel>
  );
}

function StructuredIngestForm({
  apiKey,
  maxClearance,
  onDone,
}: {
  apiKey: string;
  maxClearance: number;
  onDone: () => void;
}) {
  const [csv, setCsv] = React.useState("");
  const [mappingText, setMappingText] = React.useState(JSON.stringify(SAMPLE_MAPPING, null, 2));
  const [source, setSource] = React.useState("");
  const [sector, setSector] = React.useState<string>(SECTORS[0]);
  const [level, setLevel] = React.useState(Math.min(1, maxClearance));
  const [mappingError, setMappingError] = React.useState<string | null>(null);

  // Parse the mapping in the browser so an obvious JSON typo is caught before
  // a round trip; the server validates the shape properly either way.
  const parsedMapping = React.useMemo(() => {
    try {
      const parsed = JSON.parse(mappingText) as StructuredMapping;
      if (!Array.isArray(parsed.entities) || !Array.isArray(parsed.edges)) {
        return {
          ok: false as const,
          error: "Mapping needs both an `entities` and an `edges` array.",
        };
      }
      return { ok: true as const, value: parsed };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [mappingText]);

  const columns = React.useMemo(() => {
    const firstLine = csv.split("\n")[0]?.trim();
    if (!firstLine) return [];
    return firstLine.split(",").map((c) => c.trim());
  }, [csv]);

  const mutation = useMutation({
    mutationFn: () => {
      if (!parsedMapping.ok) throw new Error(parsedMapping.error);
      return api.ingestStructured(apiKey, {
        csv,
        mapping: parsedMapping.value,
        source,
        sector,
        clearance: CLEARANCE_NAMES[level as 0 | 1 | 2 | 3 | 4],
      });
    },
    onSuccess: onDone,
  });

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setCsv(await file.text());
    if (!source) setSource(file.name);
  };

  return (
    <Panel>
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4" /> Structured records
          </span>
        }
        description="A field mapping projects rows straight onto the ontology — no regex over prose"
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setCsv(SAMPLE_CSV);
              setSource("roster.csv");
              setMappingText(JSON.stringify(SAMPLE_MAPPING, null, 2));
            }}
          >
            Use example
          </Button>
        }
      />
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!parsedMapping.ok) {
            setMappingError(parsedMapping.error);
            return;
          }
          setMappingError(null);
          if (csv.trim() && source.trim()) mutation.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Source">
            <Input
              placeholder="roster.csv"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              required
            />
          </Field>
          <Field label="Sector">
            <Select value={sector} onChange={(e) => setSector(e.target.value)}>
              {SECTORS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <ClearanceSelect value={level} onChange={setLevel} maxClearance={maxClearance} />
        </div>

        <Field
          label="CSV"
          hint={
            columns.length > 0 ? (
              <span>
                Detected columns: <span className="font-mono">{columns.join(", ")}</span>
              </span>
            ) : (
              "First row is the header. Upload a file or paste rows directly."
            )
          }
        >
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={onFile}
            className="mb-2 block w-full text-xs text-muted-foreground file:mr-3 file:rounded file:border file:border-border file:bg-secondary file:px-2 file:py-1 file:text-xs file:text-foreground"
          />
          <Textarea
            className="min-h-[120px] font-mono text-xs"
            placeholder="col_a,col_b&#10;value,value"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            required
          />
        </Field>

        <Field
          label="Field mapping"
          hint="idField / fromField / toField must name columns present in the CSV above."
        >
          <Textarea
            className="min-h-[180px] font-mono text-xs"
            value={mappingText}
            onChange={(e) => setMappingText(e.target.value)}
            spellCheck={false}
          />
        </Field>

        {!parsedMapping.ok && (
          <ErrorNote>Mapping is not valid JSON: {parsedMapping.error}</ErrorNote>
        )}
        {mappingError && <ErrorNote>{mappingError}</ErrorNote>}
        {mutation.isError && <ErrorNote>{(mutation.error as Error).message}</ErrorNote>}
        {mutation.isSuccess && (
          <ResultSummary
            nodesCreated={mutation.data.nodesCreated}
            edgesCreated={mutation.data.edgesCreated}
            edgesRejected={mutation.data.edgesRejected}
            extra={
              <Badge className="border-border bg-muted text-muted-foreground">
                {mutation.data.rowsProcessed} rows
              </Badge>
            }
          />
        )}

        <Button
          type="submit"
          loading={mutation.isPending}
          disabled={!csv.trim() || !source.trim() || !parsedMapping.ok}
        >
          <Upload className="h-3.5 w-3.5" /> Ingest records
        </Button>
      </form>
    </Panel>
  );
}
