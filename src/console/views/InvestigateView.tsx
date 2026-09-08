import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Ban,
  Calculator,
  Check,
  FileText,
  Network,
  Search,
  Sparkles,
  Terminal,
} from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  PanelHeader,
} from "@/console/components/primitives";
import { ClearanceBadge } from "@/console/components/ClearanceBadge";
import { GraphCanvas } from "@/console/components/GraphCanvas";
import { api } from "@/console/lib/api";
import { useSession } from "@/console/hooks/useSession";
import type { InvestigationResult, PlanStep } from "@/console/lib/types";
import { cn } from "@/lib/utils";
import { entityClasses } from "@/console/lib/format";

const EXAMPLES = [
  "Яка загальна сума контрактів, повʼязаних з John Doe?",
  "Які постачальники афілійовані з директором?",
  "Яка відстань між складами?",
  "Де найдовші зафіксовані затримки?",
];

const PLAN_ICONS: Record<PlanStep["action"], React.ComponentType<{ className?: string }>> = {
  semantic_search: FileText,
  resolve_anchors: Search,
  expand_graph: Network,
  execute_code: Terminal,
  synthesize_narrative: Sparkles,
};

/**
 * The investigation surface.
 *
 * The point of this view is that the answer is never presented alone. An
 * analyst gets the narrative *and* the plan that produced it, the documents it
 * drew on, the subgraph it traversed, and — when a number is involved — the
 * actual code result it came from. That is the difference between a system you
 * can act on and a chatbot with a database.
 */
export function InvestigateView() {
  const { apiKey } = useSession();
  const [query, setQuery] = React.useState("");
  const [result, setResult] = React.useState<InvestigationResult | null>(null);

  const investigation = useMutation({
    mutationFn: (q: string) => api.investigate(apiKey, q),
    onSuccess: setResult,
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed) investigation.mutate(trimmed);
  };

  const runExample = (example: string) => {
    setQuery(example);
    investigation.mutate(example);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Розслідування</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Запитуйте звичайною мовою. Результати фільтруються за вашим допуском ще до складання, а
          будь-яка арифметика виконується як справжній код у пісочниці — її ніколи не вигадує мовна
          модель.
        </p>
      </div>

      <Panel className="p-4">
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-10 pl-9"
              placeholder="напр. Яка загальна сума контрактів, повʼязаних з John Doe?"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Запит розслідування"
            />
          </div>
          <Button type="submit" className="h-10 sm:w-32" loading={investigation.isPending}>
            Дослідити
          </Button>
        </form>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => runExample(example)}
              disabled={investigation.isPending}
              className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
            >
              {example}
            </button>
          ))}
        </div>
      </Panel>

      {investigation.isError && <ErrorNote>{(investigation.error as Error).message}</ErrorNote>}

      {!result && !investigation.isPending && !investigation.isError && (
        <Panel>
          <EmptyState
            icon={Search}
            title="Розслідувань ще не було"
            description="Кожен запуск додається до журналу аудиту разом з повним планом, тож будь-яку відповідь можна відтворити й перевірити пізніше."
          />
        </Panel>
      )}

      {result && <InvestigationReport result={result} />}
    </div>
  );
}

function InvestigationReport({ result }: { result: InvestigationResult }) {
  const anchorIds = React.useMemo(
    () => new Set(result.subgraph.nodes.map((n) => n.id)),
    [result.subgraph.nodes],
  );

  if (result.blocked) {
    return (
      <Panel className="border-destructive/40">
        <PanelHeader
          title={
            <span className="flex items-center gap-2 text-destructive">
              <Ban className="h-4 w-4" /> Запит заблоковано
            </span>
          }
          description="Захисні правила відхилили цей запит ще до виконання."
        />
        <div className="space-y-2 p-4">
          <p className="text-sm">{result.summary}</p>
          <p className="text-xs text-muted-foreground">
            Саме відхилення записано в аудит під номером #{result.auditSeq} — заблоковані запити
            логуються, а не зникають.
          </p>
        </div>
      </Panel>
    );
  }

  const isDeterministic = result.narrativeSource.toLowerCase().includes("deterministic");

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader
          title="Відповідь"
          description={`Запис аудиту #${result.auditSeq}`}
          actions={
            <Badge
              className={cn(
                isDeterministic
                  ? "border-clearance-internal/40 bg-clearance-internal/10 text-clearance-internal"
                  : "border-primary/40 bg-primary/10 text-primary",
              )}
              title={
                isDeterministic
                  ? "Складено за фіксованим шаблоном з первинних фактів — обґрунтовано за побудовою."
                  : "Згенеровано, потім перевірено за первинними фактами перед показом."
              }
            >
              {result.narrativeSource}
            </Badge>
          }
        />
        <div className="space-y-3 p-4">
          <p className="text-sm leading-relaxed">{result.summary}</p>
          {!isDeterministic && (
            <p className="flex items-center gap-1.5 text-xs text-clearance-public">
              <Check className="h-3 w-3" />
              Перевірку обґрунтованості пройдено — кожна сутність і кожне число з цього викладу є в
              наведених нижче доказах.
            </p>
          )}
        </div>
      </Panel>

      {result.computation && (
        <Panel className="border-primary/30">
          <PanelHeader
            title={
              <span className="flex items-center gap-2">
                <Calculator className="h-4 w-4 text-primary" /> Обчислений результат
              </span>
            }
            description="Отримано кодом, виконаним у пісочниці, а не моделлю"
          />
          <div className="space-y-2 p-4">
            <p className="text-sm">{result.computation.description}</p>
            <pre className="json-block">{JSON.stringify(result.computation.result, null, 2)}</pre>
          </div>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="План виконання" description={`${result.plan.length} кроків`} />
          <ol className="divide-y divide-border">
            {result.plan.map((step) => {
              const Icon = PLAN_ICONS[step.action] ?? Search;
              return (
                <li key={step.step} className="flex gap-3 px-4 py-2.5">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-secondary text-[10px] font-semibold text-muted-foreground">
                    {step.step}
                  </span>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-xs font-medium">
                      <Icon className="h-3 w-3 text-muted-foreground" />
                      {step.action.replace(/_/g, " ")}
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {step.detail}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </Panel>

        <Panel>
          <PanelHeader
            title="Докази"
            description={`Знайдено документів: ${result.documentHits.length}`}
          />
          {result.documentHits.length === 0 ? (
            <EmptyState
              title="Жоден документ не збігся"
              description="Відповідь вище спирається лише на граф. Якщо ви очікували підтвердження документами, джерела можуть бути вище вашого допуску."
            />
          ) : (
            <ul className="divide-y divide-border">
              {result.documentHits.map((hit, i) => (
                <li key={`${hit.source}-${i}`} className="px-4 py-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-xs font-medium">{hit.source}</p>
                    <span
                      className="shrink-0 font-mono text-[11px] text-muted-foreground"
                      title="Оцінка семантичної подібності"
                    >
                      {hit.score.toFixed(3)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                    {hit.excerpt}
                  </p>
                  <Badge className="mt-1.5 border-border bg-muted text-muted-foreground">
                    {hit.sector}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel>
        <PanelHeader
          title="Пройдений підграф"
          description={`Сутностей: ${result.subgraph.nodes.length}, звʼязків: ${result.subgraph.edges.length}`}
        />
        {result.subgraph.nodes.length === 0 ? (
          <EmptyState
            icon={Network}
            title="Жодної сутності не досягнуто"
            description="Жодна сутність графа не збіглася з назвою в запиті, тож розгортати не було чого. Завантажте документ, де названо цю сутність, або перевірте, чи не вища вона за ваш допуск."
          />
        ) : (
          <>
            <GraphCanvas
              nodes={result.subgraph.nodes}
              edges={result.subgraph.edges}
              highlightIds={anchorIds}
              height={340}
              className="px-2 pt-2"
            />
            <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-3">
              {result.subgraph.nodes.slice(0, 24).map((node) => (
                <Badge key={node.id} className={entityClasses(node.type)} title={node.id}>
                  {node.label}
                </Badge>
              ))}
              {result.subgraph.nodes.length > 24 && (
                <Badge className="border-border bg-muted text-muted-foreground">
                  +{result.subgraph.nodes.length - 24} ще
                </Badge>
              )}
            </div>
          </>
        )}
      </Panel>

      {result.subgraph.edges.length > 0 && (
        <Panel>
          <PanelHeader title="Звʼязки" description="Кожне ребро, яке перетнув обхід" />
          <div className="scroll-x">
            <table className="w-full text-xs">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Від</th>
                  <th className="px-4 py-2 text-left font-medium">Звʼязок</th>
                  <th className="px-4 py-2 text-left font-medium">До</th>
                  <th className="px-4 py-2 text-left font-medium">Властивості</th>
                  <th className="px-4 py-2 text-left font-medium">Клас.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.subgraph.edges.map((edge, i) => (
                  <tr key={`${edge.source}-${edge.relation}-${edge.target}-${i}`}>
                    <td className="px-4 py-2 font-mono">{edge.source}</td>
                    <td className="px-4 py-2">
                      <Badge className="border-border bg-muted text-muted-foreground">
                        {edge.relation}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 font-mono">{edge.target}</td>
                    <td className="px-4 py-2 font-mono text-muted-foreground">
                      {Object.keys(edge.properties).length === 0
                        ? "—"
                        : Object.entries(edge.properties)
                            .map(([k, v]) => `${k}=${String(v)}`)
                            .join(", ")}
                    </td>
                    <td className="px-4 py-2">
                      <ClearanceBadge level={edge.clearance} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
