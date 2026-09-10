import { NarrativeAdapter, NarrativeInput } from './NarrativeAdapter';

/**
 * The default, zero-dependency narrative: a template filled from the
 * verified facts, nothing generated. Always available (no API key
 * required) and always grounded by construction, since it only ever
 * states counts and the computation's own description - never a fact
 * it invented. This is what InvestigatorAgent falls back to whenever a
 * generative adapter's output fails the grounding check, or isn't
 * configured at all.
 */
export class DeterministicNarrativeAdapter implements NarrativeAdapter {
  readonly name = 'deterministic';

  async synthesize(input: NarrativeInput): Promise<string> {
    if (input.hits.length === 0 && input.subgraphNodeCount === 0) {
      return "No matching documents or graph entities found for this query at the requester's clearance level.";
    }
    const parts = [`Found ${input.hits.length} relevant document(s) and ${input.subgraphNodeCount} related graph entities.`];
    if (input.computation) parts.push(input.computation.description);
    return parts.join(' ');
  }
}
