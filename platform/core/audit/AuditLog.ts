import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface AuditEntry {
  seq: number;
  timestamp: string;
  actor: string;
  action: string;
  details: unknown;
  prev_hash: string;
  hash: string;
}

const GENESIS_HASH = '0'.repeat(64);

function computeHash(entry: Omit<AuditEntry, 'hash'>): string {
  const payload = `${entry.seq}|${entry.timestamp}|${entry.actor}|${entry.action}|${JSON.stringify(entry.details)}|${entry.prev_hash}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Tamper-evident chain-of-thought / decision log. Every agent action -
 * a plan, a graph query, a piece of executed code, a review verdict -
 * is appended here. Each entry commits to the hash of the previous one,
 * so altering or deleting a past entry breaks verify() for every entry
 * after it. This is the MVP's answer to "black box" auditability: an
 * officer of security/compliance can always replay
 * query -> plan -> code -> raw data -> synthesis.
 *
 * Persisted as newline-delimited JSON so it stays append-only and
 * diffable; not a substitute for a real ledger/WORM store in
 * production, but the chain-of-custody guarantee (detecting tampering)
 * is real, not simulated.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];

  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      this.entries = lines.map((l) => JSON.parse(l));
    }
  }

  append(actor: string, action: string, details: unknown): AuditEntry {
    const prev = this.entries[this.entries.length - 1];
    const base = {
      seq: this.entries.length,
      timestamp: new Date().toISOString(),
      actor,
      action,
      details,
      prev_hash: prev ? prev.hash : GENESIS_HASH,
    };
    const entry: AuditEntry = { ...base, hash: computeHash(base) };
    this.entries.push(entry);
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    return entry;
  }

  all(): AuditEntry[] {
    return [...this.entries];
  }

  /** Recomputes every hash in the chain; false means the log was tampered with. */
  verify(): { valid: boolean; brokenAtSeq: number | null } {
    let prevHash = GENESIS_HASH;
    for (const entry of this.entries) {
      const { hash, ...rest } = entry;
      if (rest.prev_hash !== prevHash || computeHash(rest) !== hash) {
        return { valid: false, brokenAtSeq: entry.seq };
      }
      prevHash = hash;
    }
    return { valid: true, brokenAtSeq: null };
  }
}
