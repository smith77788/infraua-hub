import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Every batch that ever arrived, and what it looked like.
 *
 * The console has a source-health panel, and it can only see the fetch it just
 * made: live, loading, stale, down. That answers "is the feed responding" and
 * cannot answer the question that actually costs something - **is the feed
 * still telling the truth**. A source that returns HTTP 200 with a third of
 * its usual rows is not down. It is broken in the way that reaches the graph,
 * moves every derived number, and looks like a quiet day.
 *
 * Telling those apart needs history, which is what this keeps: for each
 * source, the size and content hash of every batch, so the current one can be
 * compared with what that feed normally does.
 *
 * ## Hash of content, not of the response
 *
 * The hash is taken over the normalised records rather than the raw payload,
 * because most feeds change something on every call - a timestamp, an ordering
 * - and a hash that moves every time cannot tell "the data changed" from "the
 * envelope changed". With content hashing, a feed that has silently frozen -
 * still answering, still fast, returning yesterday's rows - becomes visible,
 * and that failure has no other symptom at all.
 */

export type SnapshotVerdict = 'first' | 'normal' | 'shrunk' | 'grew' | 'unchanged' | 'empty';

export interface Snapshot {
  id: string;
  source: string;
  /** What kind of thing this batch was: infraua, prozorro, edr, documents. */
  kind: string;
  fetchedAt: string;
  recordCount: number;
  contentHash: string;
  /** How this batch compares with what this source normally delivers. */
  verdict: SnapshotVerdict;
  /** The comparison in words, for whoever has to decide whether to care. */
  note: string;
  /** Median record count of the preceding snapshots, when there were any. */
  baseline: number | null;
  /** Who or what caused this ingest. */
  actor: string;
}

export interface AssessOptions {
  /** Below this fraction of the baseline the batch is called shrunk. Default 0.5. */
  shrinkFactor?: number;
  /** Above this multiple of the baseline it is called grown. Default 3. */
  growthFactor?: number;
  /** How many previous snapshots form the baseline. Default 10. */
  window?: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Hashes the content of a batch.
 *
 * Keys are sorted at every level so a feed that reorders its fields does not
 * read as a feed whose data changed - the second is worth waking somebody for
 * and the first is noise.
 */
export function contentHashOf(records: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, inner]) => [key, canonical(inner)]),
      );
    }
    return value;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(records))).digest('hex');
}

export class SnapshotStore {
  private snapshots: Snapshot[] = [];

  constructor(private readonly filePath?: string) {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      this.snapshots = fs
        .readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
  }

  /**
   * Records a batch and says how it compares with the source's own history.
   *
   * The verdict is never an error. A feed legitimately returns fewer rows on a
   * quiet day, and refusing the batch would trade a monitoring problem for
   * data loss. It is a stated observation with the baseline next to it, so the
   * person reading it can tell "fewer fires today" from "the parser stopped
   * matching".
   */
  record(
    input: { source: string; kind: string; recordCount: number; contentHash: string; actor: string },
    options: AssessOptions = {},
    now = new Date(),
  ): Snapshot {
    const shrinkFactor = options.shrinkFactor ?? 0.5;
    const growthFactor = options.growthFactor ?? 3;
    const window = options.window ?? 10;

    const history = this.snapshots.filter((s) => s.source === input.source).slice(-window);
    const baseline = history.length > 0 ? median(history.map((s) => s.recordCount)) : null;
    const previous = history[history.length - 1];

    let verdict: SnapshotVerdict;
    let note: string;

    if (input.recordCount === 0) {
      verdict = 'empty';
      note = 'Партія порожня. Це не те саме, що недоступне джерело: воно відповіло і не дало нічого.';
    } else if (baseline === null) {
      verdict = 'first';
      note = `Перша партія з цього джерела: ${input.recordCount} запис(ів). Порівнювати ще нема з чим.`;
    } else if (previous && previous.contentHash === input.contentHash) {
      verdict = 'unchanged';
      note =
        'Вміст побайтово той самий, що й минулого разу. Джерело може бути заморожене — воно відповідає, швидко, і віддає вчорашнє.';
    } else if (input.recordCount < baseline * shrinkFactor) {
      verdict = 'shrunk';
      note = `${input.recordCount} записів проти звичних ${baseline}. Джерело відповіло — але, можливо, не тим. Це не збій звʼязку, і саме тому його ніхто не помітить.`;
    } else if (input.recordCount > baseline * growthFactor) {
      verdict = 'grew';
      note = `${input.recordCount} записів проти звичних ${baseline}. Ймовірно, розширився набір або змінилися межі запиту.`;
    } else {
      verdict = 'normal';
      note = `${input.recordCount} записів, звичні ${baseline}.`;
    }

    const snapshot: Snapshot = {
      id: `snap-${crypto.randomUUID()}`,
      source: input.source,
      kind: input.kind,
      fetchedAt: now.toISOString(),
      recordCount: input.recordCount,
      contentHash: input.contentHash,
      verdict,
      note,
      baseline,
      actor: input.actor,
    };

    this.snapshots.push(snapshot);
    // Newline-delimited and append-only, like the audit chain: a history
    // rewritten whole on every write is a history one bad flush can lose.
    if (this.filePath) fs.appendFileSync(this.filePath, JSON.stringify(snapshot) + '\n', 'utf-8');
    return snapshot;
  }

  /** Snapshots for one source, newest first. */
  forSource(source: string, limit = 50): Snapshot[] {
    return this.snapshots
      .filter((s) => s.source === source)
      .slice(-limit)
      .reverse();
  }

  /** The latest snapshot of every source, newest first — the health board. */
  latestPerSource(): Snapshot[] {
    const latest = new Map<string, Snapshot>();
    for (const snapshot of this.snapshots) latest.set(snapshot.source, snapshot);
    return Array.from(latest.values()).sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  }

  /** Sources whose latest batch says something is off. */
  suspect(): Snapshot[] {
    return this.latestPerSource().filter((s) => s.verdict === 'shrunk' || s.verdict === 'unchanged' || s.verdict === 'empty');
  }

  size(): number {
    return this.snapshots.length;
  }
}
