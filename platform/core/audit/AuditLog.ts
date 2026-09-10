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
 * Walks a newline-delimited file, handing each line to `onLine` with the byte
 * offset it started at.
 *
 * Splits on newline **bytes** and decodes one line at a time, rather than
 * concatenating decoded chunks. The string-concatenation version was the
 * obvious way to write this and cost twice the time in `verify()` - the
 * operation most likely to be run against the largest log, and the one that
 * must not become the reason somebody stops running it.
 *
 * Chunked rather than whole-file so a large log does not become a string twice
 * its size at the one moment - process start - when the memory is least
 * available.
 */
function forEachLine(filePath: string, onLine: (line: string, offset: number) => void): number {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = Buffer.alloc(1 << 20);
    let leftover = Buffer.alloc(0);
    let position = 0;
    let offset = 0;

    while (position < size) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (read <= 0) break;
      position += read;

      let buffer = leftover.length > 0 ? Buffer.concat([leftover, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      let from = 0;
      for (;;) {
        const newline = buffer.indexOf(0x0a, from);
        if (newline === -1) break;
        const length = newline - from;
        if (length > 0) onLine(buffer.subarray(from, newline).toString('utf-8'), offset);
        offset += length + 1;
        from = newline + 1;
      }
      leftover = Buffer.from(buffer.subarray(from));
      buffer = leftover;
    }

    if (leftover.length > 0) {
      const line = leftover.toString('utf-8');
      if (line.trim().length > 0) onLine(line, offset);
    }
    return size;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Tamper-evident decision log. Every agent action, every tool call, every read
 * - a plan, a graph query, a piece of executed code, a review verdict - is
 * appended here. Each entry commits to the hash of the previous one, so
 * altering or deleting a past entry breaks `verify()` for every entry after
 * it. This is the answer to "black box" auditability: an officer of security
 * or compliance can always replay query -> plan -> code -> raw data ->
 * synthesis.
 *
 * Newline-delimited JSON, append-only. Not a substitute for a WORM store in
 * production, but the chain-of-custody guarantee is real rather than simulated.
 *
 * ## Why this holds an index rather than the entries
 *
 * The first version parsed the whole file into objects at construction and
 * kept them. That was fine while the log recorded only what agents *did*.
 * Recording what people *read* changed the growth curve: the log now grows
 * with traffic, and a trail that turns into a memory problem is a trail
 * somebody eventually turns off - which loses the property the rest of this
 * system is built on.
 *
 * Measured on entries the size this actually writes: 200 000 of them are a
 * 65 MB file that took 458 ms to load at boot and stayed on the heap as
 * parsed objects.
 *
 * So what stays in memory is an index, not the content: one byte offset per
 * entry, plus the actor and action as small integers into a dictionary of the
 * handful of distinct values those ever take. Entries are read from disk by
 * offset when somebody actually asks for them. Filtering by actor or action -
 * the two things the audit endpoint filters on - still happens in memory,
 * against the index, so paging does not degrade into scanning the file.
 */
export class AuditLog {
  /** Byte offset of each entry's line. Grows as a typed array, not an object array. */
  private offsets = new Float64Array(1024);
  private actorIds = new Uint32Array(1024);
  private actionIds = new Uint32Array(1024);
  private count = 0;

  /** The few distinct values actor and action ever take, interned. */
  private readonly actors: string[] = [];
  private readonly actions: string[] = [];
  private readonly actorIndex = new Map<string, number>();
  private readonly actionIndex = new Map<string, number>();

  private lastHash = GENESIS_HASH;
  private fileSize = 0;

  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) this.rebuildIndex();
  }

  private intern(value: string, table: string[], index: Map<string, number>): number {
    const existing = index.get(value);
    if (existing !== undefined) return existing;
    const id = table.length;
    table.push(value);
    index.set(value, id);
    return id;
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.offsets.length) return;
    let size = this.offsets.length;
    while (size < needed) size *= 2;
    const offsets = new Float64Array(size);
    offsets.set(this.offsets);
    const actorIds = new Uint32Array(size);
    actorIds.set(this.actorIds);
    const actionIds = new Uint32Array(size);
    actionIds.set(this.actionIds);
    this.offsets = offsets;
    this.actorIds = actorIds;
    this.actionIds = actionIds;
  }

  /**
   * Walks the file once to build the index.
   *
   * Reads in chunks rather than slurping the whole file into one string: a
   * 65 MB log becomes a 130 MB string otherwise, at the one moment - process
   * start - when the memory is least available and the delay is most visible.
   */
  private rebuildIndex(): void {
    this.fileSize = forEachLine(this.filePath, (line, offset) => this.indexLine(line, offset));
  }

  private indexLine(line: string, offset: number): void {
    const entry = JSON.parse(line) as AuditEntry;
    this.ensureCapacity(this.count + 1);
    this.offsets[this.count] = offset;
    this.actorIds[this.count] = this.intern(entry.actor, this.actors, this.actorIndex);
    this.actionIds[this.count] = this.intern(entry.action, this.actions, this.actionIndex);
    this.count += 1;
    this.lastHash = entry.hash;
  }

  /**
   * Reads the named entries, opening the file once for all of them.
   *
   * The per-entry version opened and closed a descriptor fifty times to serve
   * one page of fifty. Cheap to get wrong and cheap to fix, and it is the only
   * place the on-disk design costs anything a caller notices.
   */
  private readMany(indexes: number[]): AuditEntry[] {
    if (indexes.length === 0) return [];
    const fd = fs.openSync(this.filePath, 'r');
    try {
      return indexes.map((index) => {
        const start = this.offsets[index];
        const end = index + 1 < this.count ? this.offsets[index + 1] : this.fileSize;
        const length = Math.max(0, Math.floor(end - start));
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        return JSON.parse(buffer.toString('utf-8').trim()) as AuditEntry;
      });
    } finally {
      fs.closeSync(fd);
    }
  }

  append(actor: string, action: string, details: unknown): AuditEntry {
    const base = {
      seq: this.count,
      timestamp: new Date().toISOString(),
      actor,
      action,
      details,
      prev_hash: this.lastHash,
    };
    const entry: AuditEntry = { ...base, hash: computeHash(base) };
    const line = JSON.stringify(entry) + '\n';

    this.ensureCapacity(this.count + 1);
    this.offsets[this.count] = this.fileSize;
    this.actorIds[this.count] = this.intern(actor, this.actors, this.actorIndex);
    this.actionIds[this.count] = this.intern(action, this.actions, this.actionIndex);
    this.count += 1;
    this.lastHash = entry.hash;
    this.fileSize += Buffer.byteLength(line, 'utf-8');

    fs.appendFileSync(this.filePath, line, 'utf-8');
    return entry;
  }

  /**
   * Every entry, read from disk.
   *
   * Kept because a handful of callers legitimately want the whole chain, but
   * it is no longer free: it now costs a full read, which is the honest price
   * and the reason `page()` exists next to it.
   */
  all(): AuditEntry[] {
    if (this.count === 0) return [];
    return fs
      .readFileSync(this.filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  size(): number {
    return this.count;
  }

  /**
   * A page of the chain, newest first.
   *
   * Filters are applied before the page is cut, so `actor` + `limit` means
   * "the last N things this principal did" rather than "whatever of theirs
   * happens to be in the last N entries overall" - the second is a
   * surveillance tool that lies by omission. That is why the index carries
   * actor and action: filtering has to work without reading the file.
   */
  page(
    options: { limit?: number; before?: number; actor?: string; action?: string } = {},
  ): { entries: AuditEntry[]; total: number; matched: number; nextBefore: number | null } {
    const limit = Math.max(1, Math.min(1000, options.limit ?? 200));
    const actorId = options.actor !== undefined ? this.actorIndex.get(options.actor) : undefined;
    const actionId = options.action !== undefined ? this.actionIndex.get(options.action) : undefined;

    // A filter naming something that never appeared matches nothing, which is
    // a different answer from "no filter".
    if ((options.actor !== undefined && actorId === undefined) || (options.action !== undefined && actionId === undefined)) {
      return { entries: [], total: this.count, matched: 0, nextBefore: null };
    }

    const matching: number[] = [];
    for (let i = 0; i < this.count; i++) {
      if (options.before !== undefined && i >= options.before) break;
      if (actorId !== undefined && this.actorIds[i] !== actorId) continue;
      if (actionId !== undefined && this.actionIds[i] !== actionId) continue;
      matching.push(i);
    }

    const pageIndexes = matching.slice(Math.max(0, matching.length - limit)).reverse();
    const entries = this.readMany(pageIndexes);
    const oldest = pageIndexes[pageIndexes.length - 1];
    const nextBefore = oldest !== undefined && matching.length > pageIndexes.length ? oldest : null;

    return { entries, total: this.count, matched: matching.length, nextBefore };
  }

  /**
   * Recomputes every hash in the chain; false means the log was tampered with.
   *
   * Streams the file rather than holding it: verification is the operation
   * most likely to be run against the largest log, and the one that must not
   * be the reason somebody stops running it.
   */
  verify(): { valid: boolean; brokenAtSeq: number | null } {
    if (this.count === 0) return { valid: true, brokenAtSeq: null };

    let prevHash = GENESIS_HASH;
    let brokenAtSeq: number | null = null;

    forEachLine(this.filePath, (line) => {
      if (brokenAtSeq !== null) return;
      const entry = JSON.parse(line) as AuditEntry;
      const { hash, ...rest } = entry;
      if (rest.prev_hash !== prevHash || computeHash(rest) !== hash) {
        brokenAtSeq = entry.seq;
        return;
      }
      prevHash = hash;
    });

    return { valid: brokenAtSeq === null, brokenAtSeq };
  }
}
