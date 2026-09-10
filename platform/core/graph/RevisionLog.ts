import * as fs from 'fs';
import * as path from 'path';
import { GraphEdge, GraphNode } from './types';

/**
 * Every change the graph has ever undergone, in order.
 *
 * The store keeps the present. `upsertNode` overwrites properties in place and
 * `retractSource` deletes, so without this the graph could answer "what is
 * true" and nothing else. Three questions the platform is supposed to answer
 * were therefore unanswerable:
 *
 * - **What did we know on the fourteenth, when the decision was made?** Not
 *   what is known now about the fourteenth - what was actually in front of the
 *   analyst at the time. That is the question every review of a past decision
 *   opens with.
 * - **What changed since yesterday?** A picture without a previous version
 *   only supports "look again and see if anything strikes you".
 * - **Can this finding be reproduced?** A case pins an audit sequence, but the
 *   graph beneath it had already moved on, so re-running the investigation
 *   produced a different answer with the same provenance attached.
 *
 * ## Two time axes, kept apart
 *
 * `recorded_at` is when the platform learned something. `valid_from` and
 * `valid_to` are when the fact itself holds in the world. They are genuinely
 * different and conflating them is the classic error: a substation destroyed
 * on the 3rd and reported on the 9th was *destroyed* on the 3rd and *known
 * destroyed* from the 9th, and an outage review needs both - the first to
 * reconstruct the grid, the second to judge whether anyone could have acted.
 *
 * ## Why a journal beside the store rather than a rebuild of it
 *
 * The materialised map stays exactly as it was, so every existing read keeps
 * its cost and its behaviour. Replay is paid only by callers who ask for a
 * past state.
 *
 * ## What that replay cost, and what was done about it
 *
 * Measured on 200 000 revisions (a 44 MB journal - roughly a year of daily
 * refreshes of the Ukrainian set): 500 ms to load at boot and 795 ms to
 * reconstruct the head, both growing linearly. A time-travel feature whose
 * cost grows with history is one people stop using, which is the same as not
 * having it.
 *
 * Two changes, and each addresses a different half:
 *
 * - **An index, not the entries.** What stays in memory is a byte offset, a
 *   timestamp and an op code per revision; the revision itself is read from
 *   disk when a replay actually needs it. Same reasoning, and the same shape,
 *   as `core/audit/AuditLog`.
 * - **Periodic materialised snapshots.** A replay starts from the nearest
 *   snapshot at or before the target rather than from nothing. Only the most
 *   recent few are kept, so recent time travel is fast, older time travel
 *   still works and is slower, and that limit is stated rather than
 *   discovered.
 *
 * ## Why a snapshot is sometimes skipped
 *
 * A snapshot is only worth writing when the state it holds is *smaller* than
 * the stretch of journal it saves replaying, and whether that is true depends
 * entirely on what the workload does. Measured on 200 000 revisions of each
 * shape:
 *
 * - refreshing the same 4109 facilities, which is what this platform actually
 *   does daily: a 44.7 MB journal, 5.0 MB of snapshots, and reconstructing the
 *   head drops from 795 ms to **16 ms**;
 * - a revision per new entity: a 45.4 MB journal and **226 MB** of snapshots -
 *   five times the journal - for no speedup at all, since each snapshot is as
 *   big as the journal that produced it.
 *
 * So the decision is made per boundary rather than by a fixed schedule: when
 * the state has more nodes and edges than there have been revisions since the
 * last snapshot, the snapshot would cost more to write and load than the
 * replay it replaces, and it is skipped. The comparison is on counts, not on
 * serialised bytes, so deciding is free - serialising the state to find out
 * whether to serialise it is the trap this avoids.
 */

export type RevisionOp = 'upsert_node' | 'upsert_edge' | 'retract_source';

const OP_CODES: RevisionOp[] = ['upsert_node', 'upsert_edge', 'retract_source'];

export interface Revision {
  seq: number;
  /** Transaction time: when the platform learned this. */
  at: string;
  op: RevisionOp;
  /** Full record after the change for upserts; `{ source }` for a retraction. */
  payload: GraphNode | GraphEdge | { source: string };
}

export interface GraphState {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface RevisionLogOptions {
  /** Write a materialised snapshot every this many revisions. Default 5000. */
  snapshotEvery?: number;
  /** How many snapshots to keep. Older ones are pruned. Default 8. */
  maxSnapshots?: number;
}

interface SnapshotFile {
  seq: number;
  file: string;
}

export class RevisionLog {
  private offsets = new Float64Array(1024);
  private timestamps = new Float64Array(1024);
  private ops = new Uint8Array(1024);
  private count = 0;
  private fileSize = 0;

  private readonly snapshotEvery: number;
  private readonly maxSnapshots: number;
  private snapshots: SnapshotFile[] = [];
  /** Revision at which the last snapshot was written, for the break-even test. */
  private lastSnapshotSeq = -1;

  constructor(
    private readonly filePath?: string,
    options: RevisionLogOptions = {},
  ) {
    this.snapshotEvery = Math.max(100, options.snapshotEvery ?? 5000);
    this.maxSnapshots = Math.max(1, options.maxSnapshots ?? 8);
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) this.rebuildIndex();
    this.loadSnapshotList();
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.offsets.length) return;
    let size = this.offsets.length;
    while (size < needed) size *= 2;
    const offsets = new Float64Array(size);
    offsets.set(this.offsets);
    const timestamps = new Float64Array(size);
    timestamps.set(this.timestamps);
    const ops = new Uint8Array(size);
    ops.set(this.ops);
    this.offsets = offsets;
    this.timestamps = timestamps;
    this.ops = ops;
  }

  private rebuildIndex(): void {
    const fd = fs.openSync(this.filePath!, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const chunk = Buffer.alloc(1 << 20);
      let leftover = Buffer.alloc(0);
      let position = 0;
      let offset = 0;

      const take = (line: string, at: number) => {
        const revision = JSON.parse(line) as Revision;
        this.ensureCapacity(this.count + 1);
        this.offsets[this.count] = at;
        this.timestamps[this.count] = Date.parse(revision.at);
        this.ops[this.count] = Math.max(0, OP_CODES.indexOf(revision.op));
        this.count += 1;
      };

      while (position < size) {
        const read = fs.readSync(fd, chunk, 0, chunk.length, position);
        if (read <= 0) break;
        position += read;
        const buffer =
          leftover.length > 0 ? Buffer.concat([leftover, chunk.subarray(0, read)]) : chunk.subarray(0, read);
        let from = 0;
        for (;;) {
          const newline = buffer.indexOf(0x0a, from);
          if (newline === -1) break;
          const length = newline - from;
          if (length > 0) take(buffer.subarray(from, newline).toString('utf-8'), offset);
          offset += length + 1;
          from = newline + 1;
        }
        leftover = Buffer.from(buffer.subarray(from));
      }
      if (leftover.length > 0 && leftover.toString('utf-8').trim().length > 0) {
        take(leftover.toString('utf-8'), offset);
      }
      this.fileSize = size;
    } finally {
      fs.closeSync(fd);
    }
  }

  private snapshotDir(): string {
    return path.join(path.dirname(this.filePath!), 'revision-snapshots');
  }

  private loadSnapshotList(): void {
    const dir = this.snapshotDir();
    if (!fs.existsSync(dir)) return;
    this.snapshots = fs
      .readdirSync(dir)
      .map((file) => ({ file: path.join(dir, file), seq: Number(/snapshot-(\d+)\.json/.exec(file)?.[1] ?? NaN) }))
      .filter((s) => Number.isFinite(s.seq))
      .sort((a, b) => a.seq - b.seq);
    this.lastSnapshotSeq = this.snapshots[this.snapshots.length - 1]?.seq ?? -1;
  }

  append(op: RevisionOp, payload: Revision['payload'], at = new Date().toISOString()): Revision {
    const revision: Revision = { seq: this.count, at, op, payload };
    const line = JSON.stringify(revision) + '\n';

    this.ensureCapacity(this.count + 1);
    this.offsets[this.count] = this.fileSize;
    this.timestamps[this.count] = Date.parse(at);
    this.ops[this.count] = Math.max(0, OP_CODES.indexOf(op));
    this.count += 1;
    this.fileSize += Buffer.byteLength(line, 'utf-8');

    // Newline-delimited and append-only, like the audit chain: a history that
    // is rewritten whole on every write is a history one bad flush can lose.
    if (this.filePath) fs.appendFileSync(this.filePath, line, 'utf-8');
    return revision;
  }

  /**
   * Writes a materialised snapshot when enough revisions have passed.
   *
   * The state is asked for lazily so the common path - a revision that is not
   * a snapshot boundary - costs a comparison and nothing else.
   */
  maybeSnapshot(stateProvider: () => GraphState): void {
    if (!this.filePath || this.count === 0) return;
    if (this.count % this.snapshotEvery !== 0) return;

    const seq = this.count - 1;
    if (this.snapshots.some((s) => s.seq === seq)) return;

    const state = stateProvider();
    const stateSize = state.nodes.length + state.edges.length;
    const revisionsSaved = seq - this.lastSnapshotSeq;
    if (stateSize >= revisionsSaved) {
      // The snapshot would be bigger than the journal stretch it replaces, so
      // it costs more to write and load than the replay it saves. Skipped, and
      // reconsidered at the next boundary - a workload that starts out
      // create-heavy and settles into refreshes gets snapshots once it does.
      this.lastSnapshotSeq = seq;
      return;
    }

    const dir = this.snapshotDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `snapshot-${String(seq).padStart(12, '0')}.json`);
    fs.writeFileSync(file, JSON.stringify(state), 'utf-8');
    this.snapshots.push({ seq, file });
    this.snapshots.sort((a, b) => a.seq - b.seq);
    this.lastSnapshotSeq = seq;

    // Bounded storage, stated limit: a snapshot every few thousand revisions
    // over a year is more storage than the journal itself.
    while (this.snapshots.length > this.maxSnapshots) {
      const oldest = this.snapshots.shift()!;
      try {
        fs.unlinkSync(oldest.file);
      } catch {
        // A snapshot that is already gone is the state we wanted.
      }
    }
  }

  /**
   * The most recent snapshot at or before `seq`, if one is still kept.
   *
   * Returns null when the target predates every retained snapshot - the caller
   * then replays from the beginning, which is slower and still correct.
   */
  snapshotAtOrBefore(seq: number): { seq: number; state: GraphState } | null {
    let best: SnapshotFile | null = null;
    for (const snapshot of this.snapshots) {
      if (snapshot.seq <= seq) best = snapshot;
      else break;
    }
    if (!best) return null;
    try {
      return { seq: best.seq, state: JSON.parse(fs.readFileSync(best.file, 'utf-8')) as GraphState };
    } catch {
      // A snapshot that will not load is not an error worth failing the query
      // for: replaying from the journal always works.
      return null;
    }
  }

  /**
   * Reads the named revisions, opening the file once.
   *
   * Used where the wanted set is not a contiguous range. It is not, whenever a
   * caller supplies its own timestamp - which `append` allows and the
   * bitemporal tests do - so the timestamp cursors must not assume the journal
   * is in chronological order. Assuming it silently returned an empty answer
   * for a past instant, which reads exactly like "nothing existed yet".
   */
  private readIndexes(indexes: number[]): Revision[] {
    if (!this.filePath || indexes.length === 0) return [];
    const fd = fs.openSync(this.filePath, 'r');
    try {
      return indexes.map((index) => {
        const start = this.offsets[index];
        const end = index + 1 < this.count ? this.offsets[index + 1] : this.fileSize;
        const length = Math.max(0, Math.floor(end - start));
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        return JSON.parse(buffer.toString('utf-8').trim()) as Revision;
      });
    } finally {
      fs.closeSync(fd);
    }
  }

  private readRange(fromIndex: number, toIndex: number): Revision[] {
    if (!this.filePath || fromIndex > toIndex) return [];
    const start = this.offsets[fromIndex];
    const end = toIndex + 1 < this.count ? this.offsets[toIndex + 1] : this.fileSize;
    const length = Math.max(0, Math.floor(end - start));
    if (length === 0) return [];

    const fd = fs.openSync(this.filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return buffer
        .toString('utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Revision);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Revisions recorded at or before `timestamp`, oldest first.
   *
   * A wall-clock instant cannot separate two changes made in the same
   * millisecond, and ingestion makes hundreds of them per millisecond. So a
   * timestamp is the right cursor for a person asking "how did this look on
   * Tuesday" and the wrong one for anything that must be exact - use
   * `upToSeq` for that, and see `head()`.
   */
  upTo(timestamp: string): Revision[] {
    const cutoff = Date.parse(timestamp);
    const matching: number[] = [];
    for (let i = 0; i < this.count; i++) {
      if (this.timestamps[i] <= cutoff) matching.push(i);
    }
    return this.readIndexes(matching);
  }

  /** Revisions up to and including a sequence number - exact, unlike a timestamp. */
  upToSeq(seq: number): Revision[] {
    const last = Math.min(seq, this.count - 1);
    return last < 0 ? [] : this.readRange(0, last);
  }

  /** Revisions in `(fromSeq, toSeq]` - what a replay from a snapshot needs. */
  afterSeq(fromSeq: number, toSeq: number): Revision[] {
    const start = Math.max(0, fromSeq + 1);
    const end = Math.min(toSeq, this.count - 1);
    return start > end ? [] : this.readRange(start, end);
  }

  /** Revisions recorded strictly after `from` and at or before `to`. */
  between(from: string, to: string): Revision[] {
    const after = Date.parse(from);
    const until = Date.parse(to);
    const matching: number[] = [];
    for (let i = 0; i < this.count; i++) {
      if (this.timestamps[i] > after && this.timestamps[i] <= until) matching.push(i);
    }
    return this.readIndexes(matching);
  }

  all(): Revision[] {
    return this.readRange(0, this.count - 1);
  }

  size(): number {
    return this.count;
  }

  /**
   * The sequence number of the most recent revision, or -1 when empty.
   *
   * This is the cursor to pin a finding to. A case that records the instant it
   * was concluded can be reconstructed to within a millisecond; one that
   * records the sequence can be reconstructed exactly, which is the difference
   * between reproducing an analysis and approximating it.
   */
  head(): number {
    return this.count - 1;
  }

  /**
   * When the log starts, so a caller asking for an earlier instant is told why
   * it is empty. The minimum rather than the first entry, because a caller may
   * supply its own timestamp and the journal is then not in chronological
   * order.
   */
  earliest(): string | null {
    if (this.count === 0) return null;
    let min = this.timestamps[0];
    for (let i = 1; i < this.count; i++) if (this.timestamps[i] < min) min = this.timestamps[i];
    return new Date(min).toISOString();
  }
}
