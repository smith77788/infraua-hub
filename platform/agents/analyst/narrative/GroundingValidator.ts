import { NarrativeInput } from './NarrativeAdapter';

export interface GroundingCheck {
  grounded: boolean;
  reason?: string;
}

const NUMBER_PATTERN = /\d[\d,]*(?:\.\d+)?/g;
const PROPER_NOUN_RUN = /\b(?:[A-Z][\w'-]*\s+){1,4}[A-Z][\w'-]*\b/g;

function collectNumbers(value: unknown, acc: Set<string>): void {
  if (typeof value === 'number') {
    acc.add(String(value));
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectNumbers(v, acc));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectNumbers(v, acc));
  }
}

/**
 * Fail-closed check that a generated narrative introduces no fact the
 * structured pipeline didn't itself produce. This is what makes it safe
 * to let a real LLM write the prose (agents/analyst/narrative/ClaudeNarrativeAdapter.ts)
 * without reopening the "the model must never compute or invent a fact"
 * guarantee the whole investigator is built around: any number above a
 * small structural threshold must trace back to the executed
 * computation or a graph property, and any multi-word capitalized phrase
 * must match a known entity label or document source. On any doubt the
 * caller is expected to discard the narrative and fall back to
 * DeterministicNarrativeAdapter - a false rejection just means a plainer
 * answer, a false acceptance would mean a fabricated one.
 */
export function checkGrounding(narrative: string, input: NarrativeInput): GroundingCheck {
  const knownNumbers = new Set<string>();
  if (input.computation) collectNumbers(input.computation.result, knownNumbers);
  for (const n of input.subgraph.nodes) collectNumbers(n.properties, knownNumbers);
  for (const e of input.subgraph.edges) collectNumbers(e.properties, knownNumbers);
  knownNumbers.add(String(input.hits.length));
  knownNumbers.add(String(input.subgraphNodeCount));

  const mentionedNumbers = Array.from(narrative.matchAll(NUMBER_PATTERN)).map((m) => m[0].replace(/,/g, ''));
  for (const raw of mentionedNumbers) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 5) continue; // tolerate small structural counts ("2 hops")
    if (!knownNumbers.has(raw) && !knownNumbers.has(String(value))) {
      return { grounded: false, reason: `Narrative mentions a number (${raw}) not found in the supplied facts.` };
    }
  }

  const knownLabels = [
    ...input.subgraph.nodes.map((n) => n.label.toLowerCase()),
    ...input.hits.map((h) => h.document.source.toLowerCase()),
  ];
  const mentionedEntities = Array.from(narrative.matchAll(PROPER_NOUN_RUN)).map((m) => m[0]);
  for (const entity of mentionedEntities) {
    const lower = entity.toLowerCase();
    const known = knownLabels.some((label) => label.includes(lower) || lower.includes(label));
    if (!known) {
      return { grounded: false, reason: `Narrative mentions an entity ("${entity}") not found in the supplied facts.` };
    }
  }

  return { grounded: true };
}
