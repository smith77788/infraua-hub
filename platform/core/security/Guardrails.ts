import * as fs from 'fs';

export interface GuardrailsConfig {
  ingress_guardrails: {
    blocked_patterns: string[];
    max_query_length: number;
  };
}

export interface GuardrailCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Input guardrail for free-text queries that drive graph traversal and
 * sandboxed code execution. Blocks two classes of abuse: prompt-injection
 * style attempts to make an agent ignore its instructions or claim a
 * clearance it doesn't have, and queries aimed at the system itself
 * rather than the data (drop the graph, wipe the database). This is a
 * deny-list, not a full semantic classifier - it catches the literal
 * phrasing patterns named in the config, not paraphrases of them; see
 * docs/analyst-architecture.md "Guardrails" for what a production
 * deployment should add on top.
 */
export class Guardrails {
  constructor(private readonly config: GuardrailsConfig) {}

  static fromFile(path: string): Guardrails {
    return new Guardrails(JSON.parse(fs.readFileSync(path, 'utf-8')));
  }

  validateQuery(query: string): GuardrailCheck {
    const { blocked_patterns, max_query_length } = this.config.ingress_guardrails;

    if (query.length > max_query_length) {
      return { allowed: false, reason: `Query exceeds the maximum allowed length (${max_query_length} characters).` };
    }
    for (const pattern of blocked_patterns) {
      if (new RegExp(pattern, 'i').test(query)) {
        return { allowed: false, reason: `Query matched a blocked pattern: "${pattern}".` };
      }
    }
    return { allowed: true };
  }
}
