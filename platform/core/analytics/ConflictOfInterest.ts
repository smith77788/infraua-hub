import { GraphEdge, GraphNode } from '../graph/types';
import { normalizeLabel } from './EntityResolver';

/**
 * Finds the shape that procurement fraud actually has.
 *
 * `config/risk_signals.json` has always carried `self_dealing_pattern` at 35
 * points - the heaviest signal in the file - defined as one entity holding
 * both `AWARDED_CONTRACT` and `HIDDEN_BENEFICIARY_OF`. With real data on both
 * sides it turned out that signal cannot fire, and not because of a bug: a
 * person does not award contracts, an organisation does. The two relations sit
 * on different nodes, so a rule that looks at one node's own edges is looking
 * in a place the pattern is never in.
 *
 * The real shape is a path of three hops:
 *
 *     person  --(officer/owner)-->  buyer  --(AWARDED_CONTRACT)-->  supplier
 *        \                                                             /
 *         \-----------------(officer/owner)---------------------------/
 *
 * Somebody sits on both ends of a contract. That is the finding.
 *
 * ## Why most of these come back "unconfirmed", and why that is correct
 *
 * People from the register are keyed per company, because a name is not an
 * identity (see `EdrConnector`). So the two ends of the path are usually two
 * different nodes carrying the same name, and joining them is a **decision** -
 * the `link_same_as` action, recorded with who made it and on what basis.
 *
 * A conflict is therefore reported as **confirmed** only when a human has made
 * that decision. Everything else comes back **unconfirmed**, with the identity
 * question stated in the finding itself. The alternative - treating equal
 * names as the same person - would manufacture an accusation against real
 * people out of a coincidence of spelling, which in this domain is the worst
 * thing the software can do. The two lists are never merged: the unconfirmed
 * one is a queue of identity questions, not a queue of suspects.
 */

/** Relations that put a person in a position to act for an organisation. */
const CONTROL_RELATIONS = new Set([
  'BENEFICIARY_OF',
  'HIDDEN_BENEFICIARY_OF',
  'CONTROLS',
  'AFFILIATED_WITH',
]);

export interface ContractSummary {
  tenderId: string;
  amount?: number;
  currency?: string;
  competitive?: boolean;
  awardedAt?: string;
}

export interface ConflictFinding {
  /** 'confirmed' when a human joined the two ends; 'unconfirmed' when only the names match. */
  status: 'confirmed' | 'unconfirmed';
  buyer: { id: string; label: string };
  supplier: { id: string; label: string };
  /** The person on both ends. Two ids while they are still two records. */
  personIds: string[];
  personLabel: string;
  /** How the person relates to each side, in the register's own words. */
  buyerRole: string;
  supplierRole: string;
  contracts: ContractSummary[];
  totalAmount: number;
  /** One line per link in the path - the whole finding, readable without the graph. */
  evidence: string[];
  /** What has to be settled before this is a finding rather than a question. */
  openQuestion?: string;
}

interface PersonLink {
  personId: string;
  personLabel: string;
  organizationId: string;
  relation: string;
  role: string;
}

function roleOf(edge: GraphEdge): string {
  const role = edge.properties.role;
  if (typeof role === 'string' && role) return role;
  return edge.relation.toLowerCase().replace(/_/g, ' ');
}

/** Identity decisions a human actually made, as a lookup in both directions. */
function sameAsIndex(edges: GraphEdge[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.relation !== 'SAME_AS') continue;
    for (const [a, b] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      const set = index.get(a) ?? new Set<string>();
      set.add(b);
      index.set(a, set);
    }
  }
  return index;
}

function personLinks(nodes: Map<string, GraphNode>, edges: GraphEdge[]): PersonLink[] {
  const links: PersonLink[] = [];
  for (const edge of edges) {
    if (!CONTROL_RELATIONS.has(edge.relation)) continue;
    const person = nodes.get(edge.source);
    const organization = nodes.get(edge.target);
    if (!person || !organization || person.type !== 'Person') continue;
    links.push({
      personId: person.id,
      personLabel: person.label,
      organizationId: organization.id,
      relation: edge.relation,
      role: roleOf(edge),
    });
  }
  return links;
}

export interface ConflictOptions {
  /** Ignore contracts below this. Default 0 - report everything. */
  minAmount?: number;
  /** Cap on findings returned, largest total first. Default 50. */
  limit?: number;
}

export function findConflictsOfInterest(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: ConflictOptions = {},
): { confirmed: ConflictFinding[]; unconfirmed: ConflictFinding[] } {
  const minAmount = options.minAmount ?? 0;
  const limit = options.limit ?? 50;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const links = personLinks(byId, edges);
  const sameAs = sameAsIndex(edges);

  const contractsByPair = new Map<string, ContractSummary[]>();
  for (const edge of edges) {
    if (edge.relation !== 'AWARDED_CONTRACT') continue;
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const amount = typeof edge.properties.amount === 'number' ? edge.properties.amount : undefined;
    if (amount !== undefined && amount < minAmount) continue;
    const key = `${edge.source} ${edge.target}`;
    const list = contractsByPair.get(key) ?? [];
    list.push({
      tenderId: String(edge.properties.tender_id ?? ''),
      ...(amount !== undefined ? { amount } : {}),
      ...(typeof edge.properties.currency === 'string' ? { currency: edge.properties.currency } : {}),
      ...(typeof edge.properties.competitive === 'boolean'
        ? { competitive: edge.properties.competitive }
        : {}),
      ...(typeof edge.properties.awarded_at === 'string' ? { awardedAt: edge.properties.awarded_at } : {}),
    });
    contractsByPair.set(key, list);
  }

  const confirmed: ConflictFinding[] = [];
  const unconfirmed: ConflictFinding[] = [];
  const seen = new Set<string>();

  for (const [pairKey, contracts] of contractsByPair) {
    const [buyerId, supplierId] = pairKey.split(' ');
    const buyer = byId.get(buyerId)!;
    const supplier = byId.get(supplierId)!;

    const buyerSide = links.filter((l) => l.organizationId === buyerId);
    const supplierSide = links.filter((l) => l.organizationId === supplierId);
    if (buyerSide.length === 0 || supplierSide.length === 0) continue;

    for (const onBuyer of buyerSide) {
      for (const onSupplier of supplierSide) {
        const samePerson = onBuyer.personId === onSupplier.personId;
        const joined = sameAs.get(onBuyer.personId)?.has(onSupplier.personId) ?? false;
        const normalized = normalizeLabel(onBuyer.personLabel);
        const sameName = normalized !== '' && normalized === normalizeLabel(onSupplier.personLabel);

        if (!samePerson && !joined && !sameName) continue;

        const key = [pairKey, onBuyer.personId, onSupplier.personId].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);

        const totalAmount = contracts.reduce((sum, c) => sum + (c.amount ?? 0), 0);
        const status: ConflictFinding['status'] = samePerson || joined ? 'confirmed' : 'unconfirmed';

        const evidence = [
          `${onBuyer.personLabel} - ${onBuyer.role} у замовника "${buyer.label}"`,
          `${onSupplier.personLabel} - ${onSupplier.role} у постачальника "${supplier.label}"`,
          `"${buyer.label}" присудив "${supplier.label}" ${contracts.length} договір(ів)` +
            (totalAmount > 0 ? ` на ${totalAmount.toLocaleString('uk-UA')}` : ''),
        ];
        if (status === 'confirmed' && !samePerson) {
          evidence.push('Тотожність осіб підтверджена рішенням аналітика (SAME_AS)');
        }

        const finding: ConflictFinding = {
          status,
          buyer: { id: buyer.id, label: buyer.label },
          supplier: { id: supplier.id, label: supplier.label },
          personIds: samePerson ? [onBuyer.personId] : [onBuyer.personId, onSupplier.personId],
          personLabel: onBuyer.personLabel,
          buyerRole: onBuyer.role,
          supplierRole: onSupplier.role,
          contracts,
          totalAmount,
          evidence,
          ...(status === 'unconfirmed'
            ? {
                openQuestion:
                  'Це те саме прізвище у двох записах, а не встановлена тотожність. Поки її не підтверджено дією link_same_as, це питання про особу, а не висновок про неї.',
              }
            : {}),
        };

        (status === 'confirmed' ? confirmed : unconfirmed).push(finding);
      }
    }
  }

  const byTotal = (a: ConflictFinding, b: ConflictFinding) =>
    b.totalAmount - a.totalAmount || a.buyer.id.localeCompare(b.buyer.id);

  return {
    confirmed: confirmed.sort(byTotal).slice(0, limit),
    unconfirmed: unconfirmed.sort(byTotal).slice(0, limit),
  };
}

export interface CommonOwnershipFinding {
  status: 'confirmed' | 'unconfirmed';
  personLabel: string;
  personIds: string[];
  buyer: { id: string; label: string };
  suppliers: { id: string; label: string; totalAmount: number }[];
  evidence: string[];
  openQuestion?: string;
}

/**
 * One person behind several suppliers of the same buyer.
 *
 * A different shape from self-dealing, and a different question: not "who is
 * on both ends" but "was there a choice at all". A competitive procedure
 * between companies that share an owner is the classic way a competition is
 * staged, and no measure of a single contract can see it.
 */
export function findCommonOwnership(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: ConflictOptions = {},
): CommonOwnershipFinding[] {
  const limit = options.limit ?? 50;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sameAs = sameAsIndex(edges);

  const ownersOf = new Map<string, { personId: string; label: string }[]>();
  for (const link of personLinks(byId, edges)) {
    const list = ownersOf.get(link.organizationId) ?? [];
    list.push({ personId: link.personId, label: link.personLabel });
    ownersOf.set(link.organizationId, list);
  }

  const awards = new Map<string, Map<string, number>>();
  for (const edge of edges) {
    if (edge.relation !== 'AWARDED_CONTRACT') continue;
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const perBuyer = awards.get(edge.source) ?? new Map<string, number>();
    const amount = typeof edge.properties.amount === 'number' ? edge.properties.amount : 0;
    perBuyer.set(edge.target, (perBuyer.get(edge.target) ?? 0) + amount);
    awards.set(edge.source, perBuyer);
  }

  const findings: CommonOwnershipFinding[] = [];

  for (const [buyerId, suppliers] of awards) {
    if (suppliers.size < 2) continue;
    const buyer = byId.get(buyerId)!;

    const byOwnerName = new Map<
      string,
      { personIds: Set<string>; label: string; suppliers: Map<string, number> }
    >();
    for (const [supplierId, amount] of suppliers) {
      for (const owner of ownersOf.get(supplierId) ?? []) {
        const key = normalizeLabel(owner.label);
        if (!key) continue;
        const group =
          byOwnerName.get(key) ??
          { personIds: new Set<string>(), label: owner.label, suppliers: new Map<string, number>() };
        group.personIds.add(owner.personId);
        group.suppliers.set(supplierId, amount);
        byOwnerName.set(key, group);
      }
    }

    for (const group of byOwnerName.values()) {
      if (group.suppliers.size < 2) continue;
      const personIds = Array.from(group.personIds);
      const allJoined =
        personIds.length === 1 ||
        personIds.every((id) =>
          personIds.every((other) => id === other || (sameAs.get(id)?.has(other) ?? false)),
        );

      findings.push({
        status: allJoined ? 'confirmed' : 'unconfirmed',
        personLabel: group.label,
        personIds,
        buyer: { id: buyer.id, label: buyer.label },
        suppliers: Array.from(group.suppliers.entries())
          .map(([id, totalAmount]) => ({ id, label: byId.get(id)?.label ?? id, totalAmount }))
          .sort((a, b) => b.totalAmount - a.totalAmount),
        evidence: [
          `"${buyer.label}" присудив ${group.suppliers.size} постачальникам, за якими стоїть ${group.label}`,
          ...Array.from(group.suppliers.entries()).map(
            ([id, amount]) => `  ${byId.get(id)?.label ?? id}: ${amount.toLocaleString('uk-UA')}`,
          ),
        ],
        ...(allJoined
          ? {}
          : {
              openQuestion:
                'Однакове прізвище в кількох записах - ще не встановлена тотожність. Підтвердьте дією link_same_as, перш ніж робити висновок.',
            }),
      });
    }
  }

  return findings
    .sort((a, b) => b.suppliers.length - a.suppliers.length || a.buyer.id.localeCompare(b.buyer.id))
    .slice(0, limit);
}
