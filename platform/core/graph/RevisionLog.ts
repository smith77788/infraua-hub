import * as fs from 'fs';
import * as path from 'path';
import { GraphEdge, GraphNode } from './types';

/**
 * Every change the graph has ever undergone, in order.
 *
 * The store keeps the present. `upsertNode` overwrites properties in place and
 * `retractSource` deletes, so until now the graph could answer "what is true"
 * and nothing else. Three questions the platform is supposed to answer were
 * therefore unanswerable:
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
 * past state. The cost of that replay grows with history, which is a real
 * limit and is written down (findings 21) rather than hidden: the answer when
 * it starts to hurt is periodic snapshots, not a different design.
 */

export type RevisionOp = 'upsert_node' | 'upsert_edge' | 'retract_source';

export interface Revision {
  seq: number;
  /** Transaction time: when the platform learned this. */
  at: string;
  op: RevisionOp;
  /** Full record after the change for upserts; `{ source }` for a retraction. */
  payload: GraphNode | GraphEdge | { source: string };
}

export class RevisionLog {
  private revisions: Revision[] = [];

  constructor(private readonly filePath?: string) {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      this.revisions = lines.map((line) => JSON.parse(line));
    }
  }

  append(op: RevisionOp, payload: Revision['payload'], at = new Date().toISOString()): Revision {
    const revision: Revision = { seq: this.revisions.length, at, op, payload };
    this.revisions.push(revision);
    // Newline-delimited and append-only, like the audit chain: a history that
    // is rewritten whole on every write is a history one bad flush can lose.
    if (this.filePath) fs.appendFileSync(this.filePath, JSON.stringify(revision) + '\n', 'utf-8');
    return revision;
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
    return this.revisions.filter((r) => r.at <= timestamp);
  }

  /** Revisions up to and including a sequence number — exact, unlike a timestamp. */
  upToSeq(seq: number): Revision[] {
    return this.revisions.filter((r) => r.seq <= seq);
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
    return this.revisions.length - 1;
  }

  /** Revisions recorded strictly after `from` and at or before `to`. */
  between(from: string, to: string): Revision[] {
    return this.revisions.filter((r) => r.at > from && r.at <= to);
  }

  all(): Revision[] {
    return [...this.revisions];
  }

  size(): number {
    return this.revisions.length;
  }

  /** When the log starts, so a caller asking for an earlier instant is told why it is empty. */
  earliest(): string | null {
    return this.revisions[0]?.at ?? null;
  }
}
