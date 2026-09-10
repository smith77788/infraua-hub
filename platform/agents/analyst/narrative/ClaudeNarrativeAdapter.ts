import Anthropic from '@anthropic-ai/sdk';
import { NarrativeAdapter, NarrativeInput } from './NarrativeAdapter';

const SYSTEM_PROMPT = `You are an analyst narrator inside a Palantir-style investigation platform.
You are given verified structured findings only: document search hits, a knowledge-graph
subgraph, and (optionally) the result of a sandboxed computation that already ran.

Write a short, plain-language answer (2-4 sentences) to the analyst's question using ONLY the
facts given below. You are not permitted to introduce any number, name, date, or claim that is
not explicitly present in the provided data - you are a narrator of verified facts, not an
analyst forming new conclusions. If the data is insufficient to answer the question, say so
plainly instead of guessing or extrapolating.`;

/**
 * Real Claude-backed narrative synthesis, using the official Anthropic
 * SDK (never the model's own arithmetic or invented facts - it only
 * ever narrates what InvestigatorAgent already verified via graph
 * traversal and sandboxed code execution). Its output still passes
 * through GroundingValidator.checkGrounding() before being trusted;
 * on any grounding failure or API error, InvestigatorAgent falls back
 * to DeterministicNarrativeAdapter rather than surfacing an ungrounded
 * or broken response.
 */
export class ClaudeNarrativeAdapter implements NarrativeAdapter {
  readonly name = 'claude';
  private readonly client: Anthropic;

  constructor(apiKey: string | undefined = process.env.ANTHROPIC_API_KEY) {
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set. Use DeterministicNarrativeAdapter instead.');
    }
    this.client = new Anthropic({ apiKey });
  }

  async synthesize(input: NarrativeInput): Promise<string> {
    const facts = {
      document_hits: input.hits.map((h) => ({ source: h.document.source, excerpt: h.document.text.slice(0, 300) })),
      graph_entities: input.subgraph.nodes.map((n) => ({ type: n.type, label: n.label, properties: n.properties })),
      graph_relations: input.subgraph.edges.map((e) => ({
        relation: e.relation,
        source: e.source,
        target: e.target,
        properties: e.properties,
      })),
      computed_result: input.computation ? { description: input.computation.description, result: input.computation.result } : null,
    };

    const response = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Analyst question: ${input.query}\n\nVerified facts (JSON):\n${JSON.stringify(facts, null, 2)}` }],
    });

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock) {
      throw new Error(`Claude response contained no text block (stop_reason: ${response.stop_reason}).`);
    }
    return textBlock.text.trim();
  }
}
