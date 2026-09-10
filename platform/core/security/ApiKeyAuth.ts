import { ClearanceLevel, parseClearance } from './Clearance';

export interface ApiKeyAuth {
  resolveClearance(key: string): ClearanceLevel | null;
}

/**
 * Resolves an API key to the clearance level it was issued at, read
 * from the PLATFORM_API_KEYS environment variable (JSON map of
 * key -> clearance name), never from a committed file. This closes a
 * real hole in the earlier version of the platform: every endpoint
 * trusted a `clearance` value the caller supplied in the request body
 * or query string, so a PUBLIC caller could simply claim
 * "clearance": "TOP_SECRET" and read everything. Now the caller's
 * clearance is looked up server-side from their key and the client-
 * supplied value is ignored for reads (see apps/platform/api/server.ts).
 *
 * PLATFORM_API_KEYS is a demo/local bootstrap mechanism, not a
 * production secrets store - see .env.example for the "never commit
 * real keys" warning that already applies to every other credential
 * in this repo.
 */
export class EnvApiKeyAuth implements ApiKeyAuth {
  private readonly keys: Record<string, string>;

  constructor(rawJson: string | undefined) {
    this.keys = rawJson ? JSON.parse(rawJson) : {};
  }

  static fromEnv(): EnvApiKeyAuth {
    return new EnvApiKeyAuth(process.env.PLATFORM_API_KEYS);
  }

  resolveClearance(key: string): ClearanceLevel | null {
    const raw = this.keys[key];
    if (raw === undefined) return null;
    return parseClearance(raw, ClearanceLevel.PUBLIC);
  }
}
