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
 *
 * ## Why this blocks before it compares
 *
 * The first version compared every pair within an entity type. Measured on
 * synthetic graphs the size of the Ukrainian set: 500 nodes - 1.8 s,
 * 1000 - 7.6 s, 2000 - 29 s, 4000 - 116 s. The country has 4109 substations
 * alone, and this runs on every `/api/platform/analytics` request, so the
 * honest description is not "does not scale" but "denies service to its own
 * endpoint".
 *
 * The fix is standard record linkage: **block first, compare second**. Each
 * entity gets a handful of cheap keys, and only entities sharing a key are
 * ever compared. Two properties make this safe rather than merely fast:
 *
 * - The keys are chosen so that every pair the scorer *could* have accepted
 *   shares at least one of them - an identical identifier, an identical
 *   normalised label, the same initials pattern, or a rare token in common.
 *   Pairs with none of those score below the floor anyway, so they are not
 *   being hidden, they are being skipped after the answer is already known.
 * - A key that stops discriminating (every substation contains the token
 *   "підстанція") produces an enormous block and is dropped, because it
 *   carries no information. That *can* cost a candidate, so it is counted and
 *   reported in `stats` rather than being silently swallowed - a resolver that
 *   quietly stops looking is worse than one that is slow.
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

/**
 * Tokens that carry no identity and must not decide a match.
 *
 * Two problems were hiding in the previous version of this, and both mattered
 * for Ukrainian data specifically.
 *
 * The list was Latin-only, so "Дніпро Енерго ТОВ" and "Дніпро Енерго LLC" -
 * the same company as written by two registries - scored 0.27 and fell below
 * the floor, while the identical English pair scored 0.7. Every Ukrainian
 * legal form is here now, because those are exactly the suffixes on every row
 * of the company registry and the procurement feed.
 *
 * And the stripping was a regex with `\b` boundaries. JavaScript's `\b` is
 * defined against `\w`, which is ASCII, so a Cyrillic suffix could not have
 * been matched by that mechanism even if it had been in the list - it would
 * have failed silently, the way the Ukrainian-letter bug in `slugify` did.
 * Filtering whole tokens after the split has no boundary problem in any script.
 */
const NON_IDENTIFYING_TOKENS = new Set([
  // Honorifics.
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sir', 'the',
  'пан', 'пані',
  // Latin corporate forms.
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'gmbh', 'plc', 'sa', 'bv', 'ag', 'srl', 'spa', 'oy', 'ab', 'as',
  // Ukrainian legal forms, as they appear in the company registry.
  'тов', 'пат', 'прат', 'ат', 'тдв', 'дп', 'кп', 'пп', 'фоп', 'нак', 'ват', 'зат',
  // Russian forms, still present in older records.
  'ооо', 'оао', 'зао', 'пао', 'ип',
]);

/**
 * Lowercases, drops punctuation and non-identifying tokens, and sorts what is
 * left. Sorting is what makes "Южноукраїнська АЕС" and "АЕС Южноукраїнська"
 * the same string - word order carries no identity either.
 */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFC')
    .replace(/[.,'"()\u00ab\u00bb\u2018\u2019\u201c\u201d]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && !NON_IDENTIFYING_TOKENS.has(token))
    .sort()
    .join(' ');
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
  /**
   * Blocks larger than this are dropped as non-discriminating. Default 150.
   * Raising it costs quadratic time inside the block; lowering it drops more
   * keys. Either way the count comes back in `stats`.
   */
  maxBlockSize?: number;
}

export interface ResolveStats {
  entities: number;
  /** Pairs actually scored. Compare against entities²/2 to see what blocking saved. */
  pairsCompared: number;
  /** Keys dropped for being too common to discriminate. */
  blocksDropped: number;
  /** Entities that fell in a dropped block and were compared through no other key. */
  entitiesUnblocked: number;
}

/** Properties that identify rather than describe. An exact match is the strongest evidence there is. */
const IDENTIFYING_PROPERTIES = ['serial_number', 'registration', 'passport', 'tax_id', 'email'] as const;

/**
 * Cheap keys for one entity. Two entities are compared when they share any.
 *
 * Every key mirrors a branch of the scorer below, which is what makes the
 * blocking lossless for the pairs that could have passed:
 *   `id:`   -> the identical-identifier branch
 *   `full:` -> labels normalising to the same value
 *   `init:` -> the initials branch ("J Doe" / "John Doe")
 *   `tok:`  -> the token-overlap branch, restricted to tokens rare enough to mean something
 */
function blockKeysFor(node: GraphNode, rareTokens: Set<string>): string[] {
  const keys: string[] = [];

  for (const property of IDENTIFYING_PROPERTIES) {
    const value = node.properties[property];
    if (value !== undefined && value !== null && value !== '') keys.push(`id:${property}=${String(value)}`);
  }

  const normalized = normalizeLabel(node.label);
  if (!normalized) return keys;
  keys.push(`full:${normalized}`);

  const tokens = normalized.split(' ').filter(Boolean);
  keys.push(`init:${tokens.length}:${tokens.map((t) => t[0]).join('')}`);
  for (const token of new Set(tokens)) {
    if (rareTokens.has(token)) keys.push(`tok:${token}`);
  }

  return keys;
}

/**
 * Scores one pair. Exported so a test can run it exhaustively over every pair
 * and check that blocking loses nothing - the property that makes the fast
 * path trustworthy, and the only one worth proving rather than asserting.
 */
export function scorePair(
  a: GraphNode,
  b: GraphNode,
  neighbors: Map<string, Set<string>>,
  minConfidence = 0.5,
): DuplicateCandidate | null {
  if (a.id === b.id) return null;
  if (a.type !== b.type) return null;

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
    reasons.push(`Share ${shared.length} counterpart${shared.length === 1 ? 'y' : 'ies'} in the graph`);
  }

  // Matching identifying properties are the strongest evidence available.
  // Same list the `id:` blocking keys are built from, so a pair the
  // scorer would accept on an identifier is always in a block together.
  for (const key of IDENTIFYING_PROPERTIES) {
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
  if (!hasIdentityEvidence) return null;

  confidence = Math.min(1, confidence);
  if (confidence < minConfidence) return null;

  return {
    a: { id: a.id, label: a.label, type: a.type },
    b: { id: b.id, label: b.label, type: b.type },
    confidence: Math.round(confidence * 100) / 100,
    reasons,
    sharedNeighbors: shared,
  };
}

export function findDuplicateCandidates(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: ResolveOptions = {},
): DuplicateCandidate[] {
  return resolveDuplicates(nodes, edges, options).candidates;
}

export function resolveDuplicates(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: ResolveOptions = {},
): { candidates: DuplicateCandidate[]; stats: ResolveStats } {
  const minConfidence = options.minConfidence ?? 0.5;
  const limit = options.limit ?? 50;
  const maxBlockSize = options.maxBlockSize ?? 150;
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
  const stats: ResolveStats = {
    entities: nodes.length,
    pairsCompared: 0,
    blocksDropped: 0,
    entitiesUnblocked: 0,
  };

  for (const group of byType.values()) {
    // A token earns a blocking key by being rare enough within its own type to
    // narrow anything. Measured against the data rather than a stopword list:
    // in a set of substations "підстанція" is in every label and means nothing,
    // while "южноукраїнська" is in one and is a near-certain reference. That
    // falls out of the corpus and needs no maintenance as the corpus changes.
    const tokenFrequency = new Map<string, number>();
    for (const node of group) {
      for (const token of new Set(normalizeLabel(node.label).split(' ').filter(Boolean))) {
        tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
      }
    }
    const rareTokens = new Set(
      Array.from(tokenFrequency.entries())
        .filter(([, count]) => count <= maxBlockSize)
        .map(([token]) => token),
    );

    const blocks = new Map<string, number[]>();
    const keyCount = new Array<number>(group.length).fill(0);
    group.forEach((node, index) => {
      for (const key of blockKeysFor(node, rareTokens)) {
        const block = blocks.get(key) ?? [];
        block.push(index);
        blocks.set(key, block);
      }
    });

    const pairs = new Set<number>();
    for (const [key, members] of blocks) {
      if (members.length < 2) continue;
      // An identifier block is never dropped however large it grows: if a
      // thousand records share a tax id, that is the finding, not the noise.
      if (members.length > maxBlockSize && !key.startsWith('id:')) {
        stats.blocksDropped += 1;
        continue;
      }
      for (const index of members) keyCount[index] += 1;
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const lo = Math.min(members[i], members[j]);
          const hi = Math.max(members[i], members[j]);
          // Pair key in one number: group sizes stay far below 2^21.
          pairs.add(lo * 2097152 + hi);
        }
      }
    }
    stats.entitiesUnblocked += keyCount.filter((c) => c === 0).length;
    stats.pairsCompared += pairs.size;

    for (const packed of pairs) {
      const candidate = scorePair(
        group[Math.floor(packed / 2097152)],
        group[packed % 2097152],
        neighbors,
        minConfidence,
      );
      if (candidate) candidates.push(candidate);
    }
  }

  return {
    candidates: candidates.sort((x, y) => y.confidence - x.confidence || x.a.id.localeCompare(y.a.id)).slice(0, limit),
    stats,
  };
}
