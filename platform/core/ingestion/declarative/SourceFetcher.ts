import * as fs from 'fs';
import { AuditLog } from '../../audit/AuditLog';
import { ManifestError, SourceManifest } from './SourceManifest';

/**
 * The deployment's own rules about what the platform may reach out to.
 *
 * Deliberately not part of a manifest. A manifest is written by whoever
 * connects a feed; if it named the hosts it may call, it would be granting
 * itself the right, and the review that is supposed to catch that is the same
 * review that just approved the mapping. So the allowlist lives in
 * `config/security_policies.json`, next to the other things a deployment
 * decides rather than a feed.
 *
 * The default is empty. A platform that fetches nothing until somebody says
 * which hosts are acceptable fails in the direction that costs a conversation;
 * the other default costs an outbound request nobody authorised.
 */
export interface FetchPolicy {
  allowedHosts: string[];
  maxResponseBytes: number;
  timeoutMs: number;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export function parseFetchPolicy(raw: unknown): FetchPolicy {
  const block = (raw as Record<string, unknown> | undefined)?.outbound_fetch as Record<string, unknown> | undefined;
  const hosts = Array.isArray(block?.allowed_hosts) ? block!.allowed_hosts : [];
  return {
    allowedHosts: hosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean),
    maxResponseBytes:
      typeof block?.max_response_bytes === 'number' && block.max_response_bytes > 0
        ? block.max_response_bytes
        : DEFAULT_MAX_BYTES,
    timeoutMs: typeof block?.timeout_ms === 'number' && block.timeout_ms > 0 ? block.timeout_ms : DEFAULT_TIMEOUT_MS,
  };
}

export function fetchPolicyFromFile(path: string): FetchPolicy {
  try {
    return parseFetchPolicy(JSON.parse(fs.readFileSync(path, 'utf-8')));
  } catch {
    return { allowedHosts: [], maxResponseBytes: DEFAULT_MAX_BYTES, timeoutMs: DEFAULT_TIMEOUT_MS };
  }
}

export interface FetchResult {
  /** The parsed payload, ready for the connector. */
  payload: unknown;
  /** What was actually called, so the audit entry is checkable. */
  url: string;
  status: number;
  bytes: number;
  durationMs: number;
}

/** Injected in tests; the network is not a unit under test. */
export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/**
 * Pulls a feed the platform is allowed to pull.
 *
 * Every refusal here is a refusal *before* the request, not after: a host that
 * is not on the list is never contacted, so the check cannot be defeated by
 * what comes back.
 */
export class SourceFetcher {
  constructor(
    private readonly policy: FetchPolicy,
    private readonly audit: AuditLog,
    private readonly doFetch: FetchLike = ((url: string, init: Record<string, unknown>) =>
      (globalThis as unknown as { fetch: FetchLike }).fetch(url, init)) as FetchLike,
  ) {}

  /** Whether this manifest could be pulled, and why not when it could not. */
  check(manifest: SourceManifest): { allowed: boolean; reason?: string } {
    if (!manifest.fetch) {
      return { allowed: false, reason: `Source "${manifest.id}" does not declare where its records come from.` };
    }
    const host = new URL(manifest.fetch.url).hostname.toLowerCase();
    if (!this.policy.allowedHosts.includes(host)) {
      return {
        allowed: false,
        reason: `Host "${host}" is not in this deployment's outbound allowlist (config/security_policies.json → outbound_fetch.allowed_hosts).`,
      };
    }
    return { allowed: true };
  }

  async fetch(manifest: SourceManifest, actor: string): Promise<FetchResult> {
    const allowed = this.check(manifest);
    if (!allowed.allowed) throw new ManifestError(allowed.reason!);
    const spec = manifest.fetch!;

    const url = new URL(spec.url);
    for (const [key, value] of Object.entries(spec.query ?? {})) url.searchParams.set(key, value);

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.policy.timeoutMs);
    let status = 0;
    let body = '';
    try {
      const response = await this.doFetch(url.toString(), {
        method: spec.method,
        headers: { 'User-Agent': 'InfraUaHub/1.0 (critical infrastructure platform)', ...(spec.headers ?? {}) },
        ...(spec.method === 'POST' && spec.body ? { body: spec.body } : {}),
        signal: controller.signal,
      });
      status = response.status;
      body = await response.text();
      if (!response.ok) {
        throw new Error(`${manifest.id}: ${url.host} answered HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }

    const bytes = Buffer.byteLength(body, 'utf-8');
    if (bytes > this.policy.maxResponseBytes) {
      // Refused after reading rather than never: the cap is about what enters
      // the graph and memory, and a feed that grew past it is a fact worth
      // knowing rather than a silent truncation into a half-ingested batch.
      throw new Error(
        `${manifest.id}: response is ${bytes} bytes, over this deployment's limit of ${this.policy.maxResponseBytes}.`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`${manifest.id}: ${url.host} did not answer with JSON.`);
    }

    const result: FetchResult = { payload, url: url.toString(), status, bytes, durationMs: Date.now() - started };
    this.audit.append(actor, 'fetch_source', {
      source: manifest.id,
      manifestVersion: manifest.version,
      url: result.url,
      status: result.status,
      bytes: result.bytes,
      durationMs: result.durationMs,
    });
    return result;
  }
}
