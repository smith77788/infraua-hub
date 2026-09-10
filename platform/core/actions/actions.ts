import { ClearanceLevel } from '../security/Clearance';
import { canRead } from '../security/Marking';
import { ActionContext, ActionDefinition, ActionError, ActionOutcome } from './Action';
import { GraphEdge } from '../graph/types';

/**
 * The operations InfraUA actually needs, as opposed to a generic write API.
 *
 * Each of these exists because a person knows something the feeds cannot: that
 * an inferred line is real, that a substation is down, that two records are the
 * same company. Ingestion can never learn any of it, so without these the
 * platform's picture is permanently limited to what open data happens to say.
 */

/** Resolves an edge the caller can actually see, or refuses in the same words as "not there". */
function requireEdge(context: ActionContext, from: string, to: string, relation: string): GraphEdge {
  const snapshot = context.graph.toJSON(context.viewer);
  const edge = snapshot.edges.find((e) => e.source === from && e.target === to && e.relation === relation);
  if (!edge) {
    // Same answer whether it does not exist or sits outside the view: a
    // distinct one would confirm a relation the caller may not know about.
    throw new ActionError(`No ${relation} relation from "${from}" to "${to}" in your view.`, 404);
  }
  return edge;
}

function requireNode(context: ActionContext, id: string) {
  const node = context.graph.getNode(id, context.viewer);
  if (!node) throw new ActionError(`No entity "${id}" in your view.`, 404);
  return node;
}

/**
 * A human confirms that an inferred dependency is real.
 *
 * The console builds the power graph by nearest neighbour and marks every edge
 * `inferred` with a confidence of 0.25-0.35, precisely because it is a guess.
 * Those guesses carry every outage conclusion in the system, and until now
 * there was no way for someone who *knows* - an operator, an engineer who has
 * seen the line - to say so. The knowledge existed and the platform had no
 * hole to put it in.
 *
 * The upgraded edge records who confirmed it and when. It does not pretend to
 * be an observation from the original source: `observed_by` is a person, and
 * a reader can weigh that differently from a reading off a map.
 */
export const confirmDependency: ActionDefinition = {
  id: 'confirm_dependency',
  name: 'Підтвердити залежність живлення',
  description:
    'Позначає виведене ребро як підтверджене людиною. Виведені ребра будуються за найближчим сусідом і несуть впевненість 0.25–0.35, а на них стоять усі висновки про наслідки відмов.',
  requiredClearance: ClearanceLevel.INTERNAL,
  parameters: [
    { name: 'from', type: 'string', required: true, description: 'ідентифікатор джерела живлення' },
    { name: 'to', type: 'string', required: true, description: 'ідентифікатор споживача' },
    { name: 'relation', type: 'string', description: 'назва звʼязку, типово SUPPLIES_POWER' },
    { name: 'note', type: 'string', description: 'на чому ґрунтується підтвердження' },
  ],
  precondition(context) {
    const relation = String(context.parameters.relation ?? 'SUPPLIES_POWER');
    const edge = requireEdge(context, String(context.parameters.from), String(context.parameters.to), relation);
    if (edge.properties.provenance_kind === 'observed' && edge.properties.observed_by) {
      return 'Цю залежність уже підтверджено. Повторне підтвердження нічого не додає.';
    }
    return null;
  },
  apply(context): ActionOutcome {
    const from = String(context.parameters.from);
    const to = String(context.parameters.to);
    const relation = String(context.parameters.relation ?? 'SUPPLIES_POWER');
    const edge = requireEdge(context, from, to, relation);

    context.graph.upsertEdge({
      source: from,
      target: to,
      relation,
      properties: {
        ...edge.properties,
        provenance_kind: 'observed',
        observed_by: context.principal.id,
        observed_at: new Date().toISOString(),
        // The method it *used* to rest on is kept, not overwritten: a reader
        // who wants to know how this edge came to be proposed can still see it.
        inferred_method: edge.properties.method ?? edge.properties.inferred_method ?? null,
        ...(context.parameters.note ? { confirmation_note: String(context.parameters.note) } : {}),
      },
    });

    return {
      summary: `Залежність ${from} → ${to} підтверджено як спостережену.`,
      affected: [from, to],
      details: { relation, previousProvenance: edge.properties.provenance_kind ?? 'inferred' },
    };
  },
};

/**
 * Marks an asset out of service from a stated moment.
 *
 * The moment matters more than the flag. Recorded as valid time, so the grid
 * can be reconstructed as it stood during the outage rather than only as it is
 * now - which is the difference between reviewing a decision and re-reading
 * its outcome.
 */
export const markDamaged: ActionDefinition = {
  id: 'mark_damaged',
  name: 'Позначити обʼєкт пошкодженим',
  description: 'Виводить обʼєкт із ладу з названого моменту. Момент пишеться як час дійсності, щоб мережу можна було відновити такою, якою вона була під час аварії.',
  requiredClearance: ClearanceLevel.INTERNAL,
  parameters: [
    { name: 'entityId', type: 'string', required: true, description: 'ідентифікатор обʼєкта' },
    { name: 'since', type: 'string', description: 'момент виходу з ладу, ISO 8601; типово зараз' },
    { name: 'cause', type: 'string', description: 'причина, як її знає оператор' },
  ],
  precondition(context) {
    const node = requireNode(context, String(context.parameters.entityId));
    if (node.properties.status === 'damaged') return 'Обʼєкт уже позначено пошкодженим.';
    const since = context.parameters.since;
    if (since !== undefined && Number.isNaN(Date.parse(String(since)))) {
      return '"since" має бути відміткою часу ISO 8601.';
    }
    return null;
  },
  apply(context): ActionOutcome {
    const id = String(context.parameters.entityId);
    const node = requireNode(context, id);
    const since = context.parameters.since ? String(context.parameters.since) : new Date().toISOString();

    context.graph.upsertNode({
      id,
      type: node.type,
      label: node.label,
      properties: {
        ...node.properties,
        status: 'damaged',
        damaged_since: since,
        damaged_reported_by: context.principal.id,
        ...(context.parameters.cause ? { damage_cause: String(context.parameters.cause) } : {}),
      },
      validFrom: since,
    });

    return { summary: `Обʼєкт "${node.label}" позначено пошкодженим з ${since}.`, affected: [id], details: { since } };
  },
};

export const markRestored: ActionDefinition = {
  id: 'mark_restored',
  name: 'Позначити обʼєкт відновленим',
  description: 'Повертає обʼєкт до ладу з названого моменту.',
  requiredClearance: ClearanceLevel.INTERNAL,
  parameters: [
    { name: 'entityId', type: 'string', required: true, description: 'ідентифікатор обʼєкта' },
    { name: 'since', type: 'string', description: 'момент відновлення, ISO 8601; типово зараз' },
  ],
  precondition(context) {
    const node = requireNode(context, String(context.parameters.entityId));
    if (node.properties.status !== 'damaged') return 'Обʼєкт не позначено пошкодженим, тож відновлювати нічого.';
    return null;
  },
  apply(context): ActionOutcome {
    const id = String(context.parameters.entityId);
    const node = requireNode(context, id);
    const since = context.parameters.since ? String(context.parameters.since) : new Date().toISOString();

    context.graph.upsertNode({
      id,
      type: node.type,
      label: node.label,
      properties: { ...node.properties, status: 'operational', restored_at: since, restored_by: context.principal.id },
      validFrom: since,
      // Cleared rather than left: an open-ended damage interval would keep the
      // node invisible to every `validAt` query after the repair.
      validTo: '',
    });

    return { summary: `Обʼєкт "${node.label}" відновлено з ${since}.`, affected: [id], details: { since } };
  },
};

/**
 * Records that two entities are the same, without merging them.
 *
 * The resolver proposes; this is where a human decides. It writes a relation
 * rather than rewriting one record into the other, and that is the whole
 * point: a merge destroys the evidence for itself. If the decision turns out
 * to be wrong - and identity decisions do - a relation can be retracted, while
 * a merge has already eaten both originals.
 */
export const linkSameAs: ActionDefinition = {
  id: 'link_same_as',
  name: 'Позначити дві сутності однією',
  description:
    'Записує, що два записи — та сама сутність. Саме запис звʼязку, а не злиття: злиття знищує докази на власну користь, а рішення про тотожність буває помилковим.',
  requiredClearance: ClearanceLevel.CONFIDENTIAL,
  parameters: [
    { name: 'a', type: 'string', required: true, description: 'перший ідентифікатор' },
    { name: 'b', type: 'string', required: true, description: 'другий ідентифікатор' },
    { name: 'basis', type: 'string', required: true, description: 'на чому ґрунтується рішення' },
  ],
  precondition(context) {
    const a = requireNode(context, String(context.parameters.a));
    const b = requireNode(context, String(context.parameters.b));
    if (a.id === b.id) return 'Це один і той самий запис.';
    if (a.type !== b.type) {
      return `Різні типи сутностей (${a.type} і ${b.type}) не можуть бути тим самим — найпоширеніша хибна тотожність у системі.`;
    }
    return null;
  },
  apply(context): ActionOutcome {
    const a = String(context.parameters.a);
    const b = String(context.parameters.b);
    context.graph.upsertEdge({
      source: a,
      target: b,
      relation: 'SAME_AS',
      properties: {
        decided_by: context.principal.id,
        decided_at: new Date().toISOString(),
        basis: String(context.parameters.basis),
      },
    });
    return { summary: `Записано: ${a} і ${b} — та сама сутність.`, affected: [a, b] };
  },
};

/**
 * Lowers an entity's classification. Two people, always.
 *
 * This is the action that can undo every other protection here, and the one a
 * single stolen key would reach for first. It is the only control in the
 * system that does not merely fail closed - it cannot be exercised alone at
 * all. The proposer names a reason; a *different* principal, cleared to read
 * the thing being declassified, approves.
 */
export const declassify: ActionDefinition = {
  id: 'declassify',
  name: 'Знизити рівень таємності',
  description:
    'Знижує рівень доступу до сутності. Потребує другої людини: ця дія скасовує всі інші захисти, і саме до неї першою потягнеться вкрадений ключ.',
  requiredClearance: ClearanceLevel.SECRET,
  requiresSecondPerson: true,
  parameters: [
    { name: 'entityId', type: 'string', required: true, description: 'ідентифікатор сутності' },
    { name: 'toClearance', type: 'string', required: true, description: 'новий рівень: PUBLIC, INTERNAL, CONFIDENTIAL, SECRET' },
    { name: 'reason', type: 'string', required: true, description: 'підстава для зниження' },
  ],
  precondition(context) {
    const node = requireNode(context, String(context.parameters.entityId));
    const target = ClearanceLevel[String(context.parameters.toClearance).toUpperCase() as keyof typeof ClearanceLevel];
    if (typeof target !== 'number') return `Невідомий рівень "${context.parameters.toClearance}".`;
    if (target >= node.clearance) return 'Це не зниження. Підвищення рівня робиться завантаженням, а не цією дією.';
    if (!canRead(context.viewer, node)) return 'Не можна знімати позначку з того, чого не бачиш.';
    return null;
  },
  apply(context): ActionOutcome {
    const id = String(context.parameters.entityId);
    const node = requireNode(context, id);
    const target = ClearanceLevel[String(context.parameters.toClearance).toUpperCase() as keyof typeof ClearanceLevel];

    context.graph.upsertNode({
      id,
      type: node.type,
      label: node.label,
      properties: {
        ...node.properties,
        declassified_from: ClearanceLevel[node.clearance],
        declassified_reason: String(context.parameters.reason),
      },
      clearance: target,
    });

    return {
      summary: `"${node.label}": рівень знижено з ${ClearanceLevel[node.clearance]} до ${ClearanceLevel[target]}.`,
      affected: [id],
      details: { from: node.clearance, to: target, reason: String(context.parameters.reason) },
    };
  },
};

export const BUILT_IN_ACTIONS: ActionDefinition[] = [
  confirmDependency,
  markDamaged,
  markRestored,
  linkSameAs,
  declassify,
];
