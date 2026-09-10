import * as fs from 'fs';

/**
 * Purpose-based access: *why* a request is being made, declared by the caller
 * and recorded against what it returned.
 *
 * A clearance says what a person is allowed to see. It cannot say whether this
 * particular look was part of their job. That distinction is where misuse
 * actually lives: an analyst cleared for the grid pulling their neighbour's
 * substation feed is inside their clearance and outside their work, and no
 * level-based check will ever notice. The only thing that catches it is a
 * stated reason attached to every access, reviewable afterwards.
 *
 * So a purpose is deliberately **not** a second clearance. It does not unlock
 * data. It binds a request to a named reason, refuses reasons this principal
 * was not issued, and writes that reason into the audit chain next to what came
 * back. Detection, not prevention - which is the honest description, and the
 * reason it costs a header rather than a redesign.
 *
 * ## Why it is off by default
 *
 * `require_purpose` starts false. Turning it on with no purposes issued would
 * lock every existing key out of every route at once - a security control whose
 * rollout is an outage teaches operators to disable it. A principal with its
 * own `purposes` list is held to that list regardless, so a deployment can
 * adopt this key by key and only flip the global switch once every key carries
 * a purpose.
 */

export interface PurposePolicyConfig {
  access_purposes?: {
    /** When true, every authenticated request must declare a purpose. */
    require_purpose?: boolean;
    /** Declared purposes: name -> what it means. A purpose not here is refused. */
    declared?: Record<string, string>;
  };
}

export interface PurposeDecision {
  allowed: boolean;
  /** The purpose to record. Null when none was declared and none was required. */
  purpose: string | null;
  reason?: string;
  /** 400 for an undeclared purpose, 403 for one this principal may not assert. */
  status?: 400 | 403;
}

export class PurposePolicy {
  private readonly declared: Map<string, string>;
  private readonly required: boolean;

  constructor(config: PurposePolicyConfig) {
    const section = config.access_purposes ?? {};
    this.declared = new Map(Object.entries(section.declared ?? {}));
    this.required = section.require_purpose === true;
  }

  static fromFile(path: string): PurposePolicy {
    return new PurposePolicy(JSON.parse(fs.readFileSync(path, 'utf-8')));
  }

  get isRequired(): boolean {
    return this.required;
  }

  /** Declared purposes, for the session endpoint to show an operator their options. */
  catalogue(): { id: string; description: string }[] {
    return Array.from(this.declared.entries())
      .map(([id, description]) => ({ id, description }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * @param declaredPurpose what the request asserted, if anything
   * @param principalPurposes purposes this key was issued; empty means unrestricted
   */
  check(declaredPurpose: string | undefined, principalPurposes: readonly string[]): PurposeDecision {
    const purpose = declaredPurpose?.trim().toLowerCase() || '';

    if (!purpose) {
      // A key issued *for* named purposes must say which one it is acting under.
      // Letting it through unnamed would make the whole list decorative.
      if (principalPurposes.length > 0) {
        return {
          allowed: false,
          purpose: null,
          status: 403,
          reason: `This key must declare a purpose (X-Access-Purpose). Issued for: ${principalPurposes.join(', ')}.`,
        };
      }
      if (this.required) {
        return {
          allowed: false,
          purpose: null,
          status: 403,
          reason: 'This deployment requires every request to declare a purpose (X-Access-Purpose).',
        };
      }
      return { allowed: true, purpose: null };
    }

    if (!this.declared.has(purpose)) {
      // An undeclared purpose is a caller mistake, not an authorisation failure:
      // 400, and the message names what is on offer rather than making them guess.
      return {
        allowed: false,
        purpose: null,
        status: 400,
        reason: `Unknown purpose "${purpose}". Declared purposes: ${Array.from(this.declared.keys()).join(', ') || 'none'}.`,
      };
    }

    if (principalPurposes.length > 0 && !principalPurposes.includes(purpose)) {
      return {
        allowed: false,
        purpose: null,
        status: 403,
        reason: `This key was not issued for "${purpose}". Issued for: ${principalPurposes.join(', ')}.`,
      };
    }

    return { allowed: true, purpose };
  }
}
