import * as fs from 'fs';
import * as path from 'path';
import { ClearanceLevel } from '../../../core/security/Clearance';
import { NodeType } from '../../../core/graph/types';
import { Executor } from '../../../core/execution/Executor';
import { betweenness, degrees } from '../../../core/analytics/GraphMetrics';
import { RiskScorer } from '../../../core/analytics/RiskScorer';
import { findCommonOwnership, findConflictsOfInterest } from '../../../core/analytics/ConflictOfInterest';
import { ToolDefinition, ToolError, ToolResult } from './Tool';

/**
 * The read tools. Each one is a question an analyst actually asks, not a
 * wrapper around a store method - which is the difference between a catalogue
 * a planner can choose from and an API it has to already understand.
 */

const NODE_TYPES = new Set<string>(['Person', 'Organization', 'Asset', 'Location', 'Event']);

function asNodeType(value: string | undefined): NodeType | undefined {
  if (value === undefined) return undefined;
  if (!NODE_TYPES.has(value)) {
    throw new ToolError(`"${value}" is not an entity type. Expected one of: ${Array.from(NODE_TYPES).join(', ')}.`);
  }
  return value as NodeType;
}

export const searchDocuments: ToolDefinition = {
  name: 'search_documents',
  description:
    'Шукає документи, релевантні до тексту запиту, у корпусі, який доступний саме цьому читачеві. Повертає джерело, сектор і уривок.',
  parameters: [
    { name: 'query', type: 'string', required: true, description: 'текст запиту' },
    { name: 'limit', type: 'number', description: 'скільки результатів повернути, типово 5' },
  ],
  requiredClearance: ClearanceLevel.PUBLIC,
  async run(args, context) {
    const limit = Math.max(1, Math.min(50, Number(args.limit ?? 5)));
    const hits = context.vectors.search(String(args.query), context.viewer, limit);
    return {
      summary: `Знайдено ${hits.length} документ(ів) за запитом «${args.query}».`,
      data: hits.map((h) => ({
        source: h.document.source,
        sector: h.document.sector,
        score: Math.round(h.score * 1000) / 1000,
        excerpt: h.document.text.slice(0, 240),
      })),
      shape: { documents: hits.length },
    };
  },
};

export const findEntities: ToolDefinition = {
  name: 'find_entities',
  description:
    'Знаходить сутності за частиною назви, необовʼязково звужуючи типом (Person, Organization, Asset, Location, Event).',
  parameters: [
    { name: 'text', type: 'string', required: true, description: 'частина назви' },
    { name: 'type', type: 'string', description: 'тип сутності, якщо потрібно звузити' },
    { name: 'limit', type: 'number', description: 'скільки повернути, типово 20' },
  ],
  requiredClearance: ClearanceLevel.PUBLIC,
  async run(args, context) {
    const type = asNodeType(args.type as string | undefined);
    const limit = Math.max(1, Math.min(200, Number(args.limit ?? 20)));
    const found = context.graph
      .findByLabelContains(String(args.text), context.viewer)
      .filter((n) => (type ? n.type === type : true))
      .slice(0, limit);
    return {
      summary: `Знайдено ${found.length} сутност(ей) за «${args.text}».`,
      data: found.map((n) => ({ id: n.id, label: n.label, type: n.type, properties: n.properties })),
      shape: { entities: found.length },
    };
  },
};

export const expandEntity: ToolDefinition = {
  name: 'expand_entity',
  description: 'Показує оточення сутності на задану кількість кроків: сусідів і звʼязки між ними.',
  parameters: [
    { name: 'id', type: 'string', required: true, description: 'ідентифікатор сутності' },
    { name: 'depth', type: 'number', description: 'скільки кроків, 1..3; типово 1' },
  ],
  requiredClearance: ClearanceLevel.PUBLIC,
  async run(args, context) {
    const depth = Math.max(1, Math.min(3, Number(args.depth ?? 1)));
    const id = String(args.id);
    if (!context.graph.getNode(id, context.viewer)) {
      // Same answer as "not there": a distinct one would confirm that an
      // entity outside this reader's view exists.
      throw new ToolError(`Сутності "${id}" немає у вашому погляді на граф.`, 404);
    }
    const result = context.graph.expand(id, depth, context.viewer);
    return {
      summary: `Оточення "${id}" на ${depth} крок(ів): ${result.nodes.length} сутностей, ${result.edges.length} звʼязків.`,
      data: result,
      shape: { nodes: result.nodes.length, edges: result.edges.length },
    };
  },
};

export const connectionsBetween: ToolDefinition = {
  name: 'connections_between',
  description:
    'Показує, як повʼязані дві сутності: найкоротший шлях між ними, якщо він існує у вашому погляді на граф.',
  parameters: [
    { name: 'from', type: 'string', required: true, description: 'ідентифікатор першої сутності' },
    { name: 'to', type: 'string', required: true, description: 'ідентифікатор другої сутності' },
  ],
  requiredClearance: ClearanceLevel.PUBLIC,
  async run(args, context) {
    const path = context.graph.shortestPath(String(args.from), String(args.to), context.viewer);
    if (!path) {
      return {
        summary: `Шляху між "${args.from}" і "${args.to}" у вашому погляді немає.`,
        data: { connected: false, hops: null, nodes: [], edges: [] },
        shape: { nodes: 0, edges: 0 },
      };
    }
    return {
      summary: `Звʼязок за ${path.nodes.length - 1} крок(ів).`,
      data: { connected: true, hops: path.nodes.length - 1, ...path },
      shape: { nodes: path.nodes.length, edges: path.edges.length },
    };
  },
};

export const structuralImportance: ToolDefinition = {
  name: 'structural_importance',
  description:
    'Рахує, які сутності тримають мережу: посередництво (через кого течуть шляхи) і кількість звʼязків. Рахується по тому графу, який бачить саме цей читач.',
  parameters: [{ name: 'limit', type: 'number', description: 'скільки верхніх повернути, типово 10' }],
  requiredClearance: ClearanceLevel.PUBLIC,
  async run(args, context) {
    const limit = Math.max(1, Math.min(100, Number(args.limit ?? 10)));
    const { nodes, edges } = context.graph.toJSON(context.viewer);
    return {
      summary: `Пораховано по ${nodes.length} сутностях, видимих цьому читачеві.`,
      data: {
        centrality: betweenness(nodes, edges).slice(0, limit),
        connectivity: degrees(nodes, edges).slice(0, limit),
      },
      shape: { nodes: nodes.length, edges: edges.length },
    };
  },
};

/**
 * Risk needs the signal configuration, so the factory takes it rather than
 * reading a file at call time: a tool that re-reads config on every invocation
 * is a tool whose answers change under it mid-plan.
 */
export function riskAssessmentTool(scorer: RiskScorer): ToolDefinition {
  return {
    name: 'risk_assessment',
    description:
      'Оцінка ризику з розбором: кожен бал належить названому сигналу з причиною і доказом, що його запустив.',
    parameters: [
      { name: 'id', type: 'string', description: 'ідентифікатор однієї сутності; без нього — верхні за ризиком' },
      { name: 'limit', type: 'number', description: 'скільки верхніх повернути, типово 10' },
    ],
    requiredClearance: ClearanceLevel.INTERNAL,
    async run(args, context): Promise<ToolResult> {
      const { nodes, edges } = context.graph.toJSON(context.viewer);
      const scored = scorer.score(nodes, edges);
      if (args.id) {
        const one = scored.find((r) => r.id === String(args.id));
        if (!one) throw new ToolError(`Сутності "${args.id}" немає у вашому погляді на граф.`, 404);
        return {
          summary: `Ризик "${one.label}": ${one.score} (${one.band}).`,
          data: one,
          shape: { signals: one.signals.length },
        };
      }
      const limit = Math.max(1, Math.min(100, Number(args.limit ?? 10)));
      const top = scored.slice(0, limit);
      return { summary: `Верхні ${top.length} за ризиком.`, data: top, shape: { entities: top.length } };
    },
  };
}

export const graphAsOf: ToolDefinition = {
  name: 'graph_as_of',
  description:
    'Показує, яким граф був у минулому: за номером ревізії (точно) або за відміткою часу. Окремо приймає момент дійсності — як стояв світ, а не що ми тоді знали.',
  parameters: [
    { name: 'asOfSeq', type: 'number', description: 'номер ревізії — точний курсор' },
    { name: 'asOf', type: 'string', description: 'відмітка часу ISO 8601 — що ми знали на той момент' },
    { name: 'validAt', type: 'string', description: 'відмітка часу ISO 8601 — як стояв світ на той момент' },
  ],
  requiredClearance: ClearanceLevel.PUBLIC,
  async run(args, context) {
    const options: { asOf?: string; asOfSeq?: number; validAt?: string } = {};
    if (args.asOfSeq !== undefined) options.asOfSeq = Number(args.asOfSeq);
    if (args.asOf !== undefined) options.asOf = String(args.asOf);
    if (args.validAt !== undefined) options.validAt = String(args.validAt);
    if (Object.keys(options).length === 0) {
      throw new ToolError('Потрібен принаймні один із курсорів: asOfSeq, asOf або validAt.');
    }
    try {
      const result = context.graph.asOf(options, context.viewer);
      return {
        summary: `Стан графа: ${result.nodes.length} сутностей, ${result.edges.length} звʼязків.`,
        data: result,
        shape: { nodes: result.nodes.length, edges: result.edges.length },
      };
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
  },
};

/**
 * Conflicts sit behind a clearance of their own.
 *
 * Everything else here is filtered by the reader's view and needs no extra
 * gate. This one is different in kind: the result is a statement about named
 * people shaped like an accusation, and being able to read the parts is not
 * the same right as being handed the conclusion assembled from them.
 */
export function conflictsTool(): ToolDefinition {
  return {
    name: 'conflicts_of_interest',
    description:
      'Знаходить, хто стоїть на обох кінцях договору, і спільну власність за кількома постачальниками одного замовника. Підтверджене і непідтверджене повертає окремо.',
    parameters: [
      { name: 'minAmount', type: 'number', description: 'нижня межа суми договору, типово 0' },
      { name: 'limit', type: 'number', description: 'скільки знахідок, типово 20' },
    ],
    requiredClearance: ClearanceLevel.CONFIDENTIAL,
    async run(args, context) {
      const { nodes, edges } = context.graph.toJSON(context.viewer);
      const options = {
        minAmount: args.minAmount === undefined ? 0 : Number(args.minAmount),
        limit: Math.max(1, Math.min(100, Number(args.limit ?? 20))),
      };
      const conflicts = findConflictsOfInterest(nodes, edges, options);
      const commonOwnership = findCommonOwnership(nodes, edges, options);
      return {
        summary: `Підтверджених ${conflicts.confirmed.length}, питань про тотожність ${conflicts.unconfirmed.length}, спільної власності ${commonOwnership.length}.`,
        data: { ...conflicts, commonOwnership },
        shape: {
          confirmed: conflicts.confirmed.length,
          unconfirmed: conflicts.unconfirmed.length,
          commonOwnership: commonOwnership.length,
        },
      };
    },
  };
}

/**
 * Arithmetic, in the sandbox, over values the caller has already been given.
 *
 * The rule the whole investigator is built around is that a language model
 * never computes a number - it is shown one. This tool is how that rule
 * survives a model-driven plan: the model may ask for a sum, and the sum is
 * done by executed code over an explicit list of values, outside the model.
 *
 * It takes literal values rather than a graph query on purpose. A tool that
 * both selected and totalled would let a plan quietly change which rows were
 * counted while reporting the same description.
 */
export const computeTotal: ToolDefinition = {
  name: 'compute_total',
  description:
    'Рахує суму, максимум, мінімум або середнє над явно переданим переліком чисел. Обчислення виконує запущений код, а не мовна модель.',
  parameters: [
    { name: 'values', type: 'string', required: true, description: 'числа через кому' },
    { name: 'operation', type: 'string', description: 'sum, max, min або mean; типово sum' },
  ],
  requiredClearance: ClearanceLevel.PUBLIC,
  async run(args, context) {
    const operation = String(args.operation ?? 'sum');
    if (!['sum', 'max', 'min', 'mean'].includes(operation)) {
      throw new ToolError(`Невідома операція "${operation}". Доступні: sum, max, min, mean.`);
    }
    const values = String(args.values)
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v));
    if (values.length === 0) throw new ToolError('Потрібне хоча б одне число.');

    fs.mkdirSync(context.sandboxDir, { recursive: true });
    const scriptPath = path.join(
      context.sandboxDir,
      `tool-${Date.now()}-${Math.random().toString(36).slice(2)}.js`,
    );
    const script = `const v = ${JSON.stringify(values)};
const op = ${JSON.stringify(operation)};
const out = op === 'sum' ? v.reduce((a, b) => a + b, 0)
  : op === 'max' ? Math.max(...v)
  : op === 'min' ? Math.min(...v)
  : v.reduce((a, b) => a + b, 0) / v.length;
console.log(JSON.stringify({ operation: op, count: v.length, result: out }));`;
    fs.writeFileSync(scriptPath, script, 'utf-8');
    try {
      const executor = new Executor({ workingDir: context.sandboxDir, allowedCommands: ['node'] });
      const run = await executor.run('node', [path.basename(scriptPath)]);
      if (run.exitCode !== 0) throw new ToolError(`Обчислення не вдалося: ${run.stderr || run.stdout}`);
      const parsed = JSON.parse(run.stdout.trim()) as { operation: string; count: number; result: number };
      return {
        summary: `${parsed.operation} над ${parsed.count} значенням(и): ${parsed.result}.`,
        data: parsed,
        shape: { values: parsed.count },
      };
    } finally {
      fs.unlinkSync(scriptPath);
    }
  },
};

export function builtInTools(scorer: RiskScorer): ToolDefinition[] {
  return [
    searchDocuments,
    findEntities,
    expandEntity,
    connectionsBetween,
    structuralImportance,
    riskAssessmentTool(scorer),
    graphAsOf,
    conflictsTool(),
    computeTotal,
  ];
}
