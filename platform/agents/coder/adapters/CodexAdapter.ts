import { CodingAgentAdapter, ImplementationInput, ImplementationOutput } from '../CodingAgentAdapter';

/**
 * Real adapter for OpenAI Codex (or any Codex-compatible coding agent),
 * to be wired up after the mock core is validated. Not implemented yet -
 * see docs/architecture.md "Connecting real agents" for the integration
 * plan (call the Codex API/CLI with the plan + workspace diff, apply the
 * returned patch, and let CoderAgent commit it exactly like the mock does).
 */
export class CodexAdapter implements CodingAgentAdapter {
  readonly name = 'codex';

  constructor(private readonly apiKey: string | undefined = process.env.CODEX_API_KEY) {}

  async implement(_input: ImplementationInput): Promise<ImplementationOutput> {
    if (!this.apiKey) {
      throw new Error('CODEX_API_KEY is not set. CodexAdapter is not implemented in the MVP - use MockCoderAdapter.');
    }
    throw new Error('CodexAdapter.implement() is not implemented yet.');
  }
}
