import { GraphEdge, GraphNode } from '../graph/types';
import { buildAdjacency } from './GraphMetrics';

/**
 * Duplicate-entity detection.
 *
 * "John Doe", "J. Doe" and "Doe, John" arriving from three source systems is
 * the single most common reason an affiliation graph understates a
 * connection: the paths that would reveal it are split across records that
 * never meet.
 *
 * This proposes candidates and never merges them. That is a deliberate
 * design limit, not an unfinished feature. Automatically merging two entities
 * on a similarity score rewrites history in a system whose whole value
 * proposition is that its history is auditable, and a wrong merge in a
 * compliance or intelligence context invents a relationship between two real
 * people who have none. So every candidate comes back with the evidence
 * behind it and a human decides.
 */

export interface DuplicateCandidate {
  a: { id: string; label: string; type: string };
  b: { id: string; label: string; type: string };
  /** 0-1. Higher is a stronger case, never a decision. */
  confidence: number;
  reasons: string[];
  /** Neighbour ids both entities are connected to. */
  sharedNeighbors: string[];
}

/** Lowercases, strips punctuation and honorifics, and sorts name tokens. */
export function normalizeLabel(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[.,'"()]/g, ' ')
    .replace(/\b(mr|mrs|ms|dr|prof|sir|the)\b/g, ' ')
    // Corporate suffixes carry no identity: "Acme Corp" and "Acme Inc." are a
    // real candidate pair, and keeping the suffix would hide it.
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|sa|bv|ag)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.split(' ').filter(Boolean).sort().join(' ');
}

function tokens(label: string): Set<string> {
  return new Set(normalizeLabel(label).split(' ').filter(Boolean));
}

/** Jaccard overlap of the two token sets. */
function tokenSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
}

/**
 * Whether one label's tokens are initials of the other's ("j doe" vs
 * "john doe"). Handled explicitly because token overlap scores this pair
 * poorly while it is exactly the case worth catching.
 */
function initialsMatch(a: string, b: string): boolean {
  const ta = normalizeLabel(a).split(' ').filter(Boolean);
  const tb = normalizeLabel(b).split(' ').filter(Boolean);
  if (ta.length !== tb.length || ta.length === 0) return false;

  let sawInitial = false;
  for (let i = 0; i < ta.length; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === y) continue;
    if (x.length === 1 && y.startsWith(x)) {
      sawInitial = true;
      continue;
    }
    if (y.length === 1 && x.startsWith(y)) {
      sawInitial = true;
      continue;
    }
    return false;
  }
  return sawInitial;
}

export interface ResolveOptions {
  /** Minimum confidence to report. Default 0.5. */
  minConfidence?: number;
  /** Maximum candidates returned, highest confidence first. Default 50. */
  limit?: number;
}

export function findDuplicateCandidates(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: ResolveOptions = {},
): DuplicateCandidate[] {
  const minConfidence = options.minConfidence ?? 0.5;
  const limit = options.limit ?? 50;
  const { neighbors } = buildAdjacency(nodes, edges);

  // Only compare within an entity type: a Person and an Organization sharing a
  // name are not the same thing, and comparing across types would be the most
  // common false positive in the whole system.
  const byType = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const list = byType.get(node.type) ?? [];
    list.push(node);
    byType.set(node.type, list);
  }

  const candidates: DuplicateCandidate[] = [];

  for (const group of byType.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.id === b.id) continue;

        const reasons: string[] = [];
        let confidence = 0;
        // Tracked separately from `reasons`: shared counterparties corroborate
        // an identity claim but can never establish one on their own, so a
        // candidate needs at least one of these before it is worth proposing.
        let hasIdentityEvidence = false;

        const normalizedA = normalizeLabel(a.label);
        const normalizedB = normalizeLabel(b.label);

        if (normalizedA && normalizedA === normalizedB) {
          confidence += 0.7;
          hasIdentityEvidence = true;
          reasons.push(`Labels normalise to the same value ("${normalizedA}")`);
        } else {
          const similarity = tokenSimilarity(a.label, b.label);
          if (similarity >= 0.5) {
            confidence += 0.4 * similarity;
            hasIdentityEvidence = true;
            reasons.push(`Name tokens overlap ${Math.round(similarity * 100)}%`);
          }
          if (initialsMatch(a.label, b.label)) {
            // Deliberately scored right at the default floor. An initial is
            // compatible with more than one full name ("J Doe" fits both John
            // and Jane), so this surfaces as a candidate worth a human look
            // rather than a finding - and the reason says so, because a
            // reviewer who cannot see the ambiguity cannot judge the match.
            confidence += 0.5;
            hasIdentityEvidence = true;
            reasons.push(
              'One label uses initials of the other (an initial can match more than one full name — verify before merging)',
            );
          }
        }

        const neighborsA = neighbors.get(a.id) ?? new Set<string>();
        const neighborsB = neighbors.get(b.id) ?? new Set<string>();
        const shared: string[] = [];
        for (const n of neighborsA) {
          if (n !== b.id && neighborsB.has(n)) shared.push(n);
        }
        if (shared.length > 0) {
          // Sharing counterparties is corroboration, not identity — two real
          // directors of the same company share every neighbour — so it
          // strengthens a name match rather than standing on its own.
          confidence += Math.min(0.25, shared.length * 0.1);
          reasons.push(
            `Share ${shared.length} counterpart${shared.length === 1 ? 'y' : 'ies'} in the graph`,
          );
        }

        // Matching identifying properties are the strongest evidence available.
        for (const key of ['serial_number', 'registration', 'passport', 'tax_id', 'email']) {
          const valueA = a.properties[key];
          const valueB = b.properties[key];
          if (valueA != null && valueA === valueB) {
            // The strongest evidence available: an identifier two records
            // share is a far better identity claim than any name similarity.
            confidence += 0.5;
            hasIdentityEvidence = true;
            reasons.push(`Identical ${key} (${String(valueA)})`);
          }
        }

        // Two real colleagues share every counterparty. Without a name or an
        // identifier tying them together, structural overlap is a description
        // of an organisation chart, not a duplicate.
        if (!hasIdentityEvidence) continue;

        confidence = Math.min(1, confidence);
        if (confidence >= minConfidence) {
          candidates.push({
            a: { id: a.id, label: a.label, type: a.type },
            b: { id: b.id, label: b.label, type: b.type },
            confidence: Math.round(confidence * 100) / 100,
            reasons,
            sharedNeighbors: shared,
          });
        }
      }
    }
  }

  return candidates
    .sort((x, y) => y.confidence - x.confidence || x.a.id.localeCompare(y.a.id))
    .slice(0, limit);
}
