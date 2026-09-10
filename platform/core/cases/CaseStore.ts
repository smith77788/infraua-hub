import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ClearanceLevel } from '../security/Clearance';

/**
 * Cases: the unit of work an analyst actually keeps.
 *
 * Investigations are ephemeral today - you run one, read it, and it is gone.
 * A case is the durable artefact: a question being worked, the findings
 * attached to it over time, and the notes explaining what the analyst
 * concluded. It is what gets handed to a colleague, revisited in three
 * months, or produced when someone asks how a decision was reached.
 *
 * ## Classification is a high-water mark
 *
 * The security property that makes this safe is that a case's clearance
 * *rises* to the highest classification of anything attached to it, and never
 * falls. Without that rule a case is a laundering channel: an analyst cleared
 * to SECRET attaches a SECRET finding to a case marked INTERNAL, and every
 * INTERNAL reader now sees SECRET material with its classification stripped.
 *
 * The consequence is deliberate and worth stating: attaching a highly
 * classified finding to a shared case narrows who can read that case. That is
 * correct - the alternative is disclosure - but it is surprising if you do not
 * expect it, so `attachFinding` reports when it happened.
 */

export interface CaseFinding {
  /** Sequence in the audit log where the underlying investigation is recorded. */
  auditSeq: number;
  query: string;
  summary: string;
  /** Which narrative engine produced the summary, carried through verbatim. */
  narrativeSource: string;
  /** Entity ids the investigation traversed, so the case can be re-opened on them. */
  entityIds: string[];
  /** Highest classification among the entities this finding rests on. */
  clearance: ClearanceLevel;
  attachedAt: string;
}

export interface CaseNote {
  text: string;
  /** Hashed api key of the author - never the key itself. */
  authorKeyId: string;
  createdAt: string;
}

export interface AnalystCase {
  id: string;
  title: string;
  /** High-water mark: the highest clearance of anything attached. */
  clearance: ClearanceLevel;
  createdAt: string;
  updatedAt: string;
  createdByKeyId: string;
  findings: CaseFinding[];
  notes: CaseNote[];
  /** Entities the analyst pinned as central to this case. */
  pinnedEntityIds: string[];
}

export interface AttachResult {
  case: AnalystCase;
  /** True when attaching this finding raised the case's classification. */
  clearanceRaised: boolean;
  previousClearance: ClearanceLevel;
}

export class CaseStore {
  private cases = new Map<string, AnalystCase>();

  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AnalystCase[];
      for (const entry of raw) this.cases.set(entry.id, entry);
    }
  }

  private persist(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(Array.from(this.cases.values()), null, 2), 'utf-8');
  }

  create(input: {
    title: string;
    clearance: ClearanceLevel;
    createdByKeyId: string;
  }): AnalystCase {
    const title = input.title.trim();
    if (!title) throw new Error('A case needs a title.');

    const now = new Date().toISOString();
    const created: AnalystCase = {
      id: `case-${crypto.randomUUID()}`,
      title,
      clearance: input.clearance,
      createdAt: now,
      updatedAt: now,
      createdByKeyId: input.createdByKeyId,
      findings: [],
      notes: [],
      pinnedEntityIds: [],
    };
    this.cases.set(created.id, created);
    this.persist();
    return created;
  }

  /**
   * Cases the caller is cleared to read. As everywhere else in this platform,
   * they are filtered out rather than returned redacted - a redacted entry
   * still tells the reader that a case exists.
   */
  list(clearance: ClearanceLevel): AnalystCase[] {
    return Array.from(this.cases.values())
      .filter((c) => c.clearance <= clearance)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Null both when the case does not exist and when it is above the caller. */
  get(id: string, clearance: ClearanceLevel): AnalystCase | null {
    const found = this.cases.get(id);
    if (!found || found.clearance > clearance) return null;
    return found;
  }

  /**
   * Attaches a finding, raising the case's classification to cover it.
   *
   * The caller must already be cleared for the case (checked by the API layer)
   * *and* for the finding - which is implied, since a finding can only contain
   * entities the investigation was allowed to return.
   */
  attachFinding(id: string, clearance: ClearanceLevel, finding: Omit<CaseFinding, 'attachedAt'>): AttachResult | null {
    const target = this.get(id, clearance);
    if (!target) return null;

    const previousClearance = target.clearance;
    target.findings.push({ ...finding, attachedAt: new Date().toISOString() });
    // High-water mark: never lower, only raise.
    target.clearance = Math.max(target.clearance, finding.clearance);
    target.updatedAt = new Date().toISOString();
    this.persist();

    return {
      case: target,
      clearanceRaised: target.clearance > previousClearance,
      previousClearance,
    };
  }

  addNote(id: string, clearance: ClearanceLevel, text: string, authorKeyId: string): AnalystCase | null {
    const target = this.get(id, clearance);
    if (!target) return null;
    const trimmed = text.trim();
    if (!trimmed) throw new Error('A note needs text.');

    target.notes.push({ text: trimmed, authorKeyId, createdAt: new Date().toISOString() });
    target.updatedAt = new Date().toISOString();
    this.persist();
    return target;
  }

  /**
   * Pins entities as central to the case. Pinning does not raise the case's
   * clearance on its own: the entity ids come from a graph read the caller was
   * already allowed to make, and the API layer passes the classification of
   * those entities so the same high-water rule applies.
   */
  pinEntities(
    id: string,
    clearance: ClearanceLevel,
    entityIds: string[],
    entityClearance: ClearanceLevel,
  ): AttachResult | null {
    const target = this.get(id, clearance);
    if (!target) return null;

    const previousClearance = target.clearance;
    target.pinnedEntityIds = Array.from(new Set([...target.pinnedEntityIds, ...entityIds]));
    target.clearance = Math.max(target.clearance, entityClearance);
    target.updatedAt = new Date().toISOString();
    this.persist();

    return {
      case: target,
      clearanceRaised: target.clearance > previousClearance,
      previousClearance,
    };
  }

  size(): number {
    return this.cases.size;
  }
}
