import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CaseStore } from '../../core/cases/CaseStore';
import { ClearanceLevel } from '../../core/security/Clearance';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

describe('CaseStore', () => {
  let dir: string;
  let store: CaseStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-'));
    store = new CaseStore(path.join(dir, 'cases.json'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const finding = (clearance: ClearanceLevel, auditSeq = 1) => ({
    auditSeq,
    query: 'q',
    summary: 's',
    narrativeSource: 'deterministic',
    entityIds: ['e1'],
    clearance,
  });

  it('creates a case at the requested clearance', () => {
    const created = store.create({
      title: 'Procurement review',
      clearance: ClearanceLevel.INTERNAL,
      createdByKeyId: 'key1',
    });
    expect(created.title).toBe('Procurement review');
    expect(created.clearance).toBe(ClearanceLevel.INTERNAL);
    expect(created.findings).toEqual([]);
  });

  it('refuses a case with no title', () => {
    expect(() =>
      store.create({ title: '   ', clearance: ClearanceLevel.PUBLIC, createdByKeyId: 'key1' }),
    ).toThrow(/title/i);
  });

  it('raises the case clearance to cover an attached finding', () => {
    // The laundering case: without this, a SECRET finding on an INTERNAL case
    // would be readable by every INTERNAL reader with its classification gone.
    const created = store.create({
      title: 'Case',
      clearance: ClearanceLevel.INTERNAL,
      createdByKeyId: 'key1',
    });

    const attached = store.attachFinding(
      created.id,
      ClearanceLevel.SECRET,
      finding(ClearanceLevel.SECRET),
    )!;

    expect(attached.clearanceRaised).toBe(true);
    expect(attached.previousClearance).toBe(ClearanceLevel.INTERNAL);
    expect(attached.case.clearance).toBe(ClearanceLevel.SECRET);
  });

  it('never lowers a case clearance when a less sensitive finding is attached', () => {
    const created = store.create({
      title: 'Case',
      clearance: ClearanceLevel.SECRET,
      createdByKeyId: 'key1',
    });

    const attached = store.attachFinding(
      created.id,
      ClearanceLevel.SECRET,
      finding(ClearanceLevel.PUBLIC),
    )!;

    expect(attached.clearanceRaised).toBe(false);
    expect(attached.case.clearance).toBe(ClearanceLevel.SECRET);
  });

  it('drops a case out of a reader view once it is raised above them', () => {
    const created = store.create({
      title: 'Case',
      clearance: ClearanceLevel.INTERNAL,
      createdByKeyId: 'key1',
    });
    expect(store.list(ClearanceLevel.INTERNAL)).toHaveLength(1);

    store.attachFinding(created.id, ClearanceLevel.SECRET, finding(ClearanceLevel.SECRET));

    // The INTERNAL analyst who created it can no longer read it. That is the
    // intended consequence of the high-water rule, not a bug.
    expect(store.list(ClearanceLevel.INTERNAL)).toHaveLength(0);
    expect(store.get(created.id, ClearanceLevel.INTERNAL)).toBeNull();
    expect(store.get(created.id, ClearanceLevel.SECRET)).not.toBeNull();
  });

  it('hides a case above the caller from both list and get', () => {
    store.create({ title: 'Secret case', clearance: ClearanceLevel.SECRET, createdByKeyId: 'key1' });
    expect(store.list(ClearanceLevel.PUBLIC)).toHaveLength(0);
  });

  it('returns null identically for a hidden case and a nonexistent one', () => {
    const created = store.create({
      title: 'Secret case',
      clearance: ClearanceLevel.SECRET,
      createdByKeyId: 'key1',
    });
    expect(store.get(created.id, ClearanceLevel.PUBLIC)).toBeNull();
    expect(store.get('case-does-not-exist', ClearanceLevel.PUBLIC)).toBeNull();
  });

  it('refuses to attach to a case the caller cannot read', () => {
    const created = store.create({
      title: 'Secret case',
      clearance: ClearanceLevel.SECRET,
      createdByKeyId: 'key1',
    });
    expect(
      store.attachFinding(created.id, ClearanceLevel.PUBLIC, finding(ClearanceLevel.PUBLIC)),
    ).toBeNull();
  });

  it('records notes with an author id and a timestamp', () => {
    const created = store.create({
      title: 'Case',
      clearance: ClearanceLevel.PUBLIC,
      createdByKeyId: 'key1',
    });
    const updated = store.addNote(created.id, ClearanceLevel.PUBLIC, '  Follow up on the vendor  ', 'key2')!;

    expect(updated.notes).toHaveLength(1);
    expect(updated.notes[0].text).toBe('Follow up on the vendor');
    expect(updated.notes[0].authorKeyId).toBe('key2');
    expect(Date.parse(updated.notes[0].createdAt)).not.toBeNaN();
  });

  it('refuses an empty note', () => {
    const created = store.create({
      title: 'Case',
      clearance: ClearanceLevel.PUBLIC,
      createdByKeyId: 'key1',
    });
    expect(() => store.addNote(created.id, ClearanceLevel.PUBLIC, '   ', 'key1')).toThrow(/text/i);
  });

  it('pins entities without duplicating them, and raises clearance to cover them', () => {
    const created = store.create({
      title: 'Case',
      clearance: ClearanceLevel.PUBLIC,
      createdByKeyId: 'key1',
    });

    store.pinEntities(created.id, ClearanceLevel.SECRET, ['e1', 'e2'], ClearanceLevel.PUBLIC);
    const second = store.pinEntities(
      created.id,
      ClearanceLevel.SECRET,
      ['e2', 'e3'],
      ClearanceLevel.CONFIDENTIAL,
    )!;

    expect(second.case.pinnedEntityIds.sort()).toEqual(['e1', 'e2', 'e3']);
    expect(second.case.clearance).toBe(ClearanceLevel.CONFIDENTIAL);
    expect(second.clearanceRaised).toBe(true);
  });

  it('survives a restart, including a raised clearance', () => {
    const filePath = path.join(dir, 'cases.json');
    const created = store.create({
      title: 'Case',
      clearance: ClearanceLevel.INTERNAL,
      createdByKeyId: 'key1',
    });
    store.attachFinding(created.id, ClearanceLevel.SECRET, finding(ClearanceLevel.SECRET));
    store.addNote(created.id, ClearanceLevel.SECRET, 'note', 'key1');

    const reopened = new CaseStore(filePath);
    const reloaded = reopened.get(created.id, ClearanceLevel.SECRET)!;

    expect(reloaded.clearance).toBe(ClearanceLevel.SECRET);
    expect(reloaded.findings).toHaveLength(1);
    expect(reloaded.notes).toHaveLength(1);
    // And it is still hidden from the level it was raised above.
    expect(reopened.get(created.id, ClearanceLevel.INTERNAL)).toBeNull();
  });

  it('orders the list by most recently updated', () => {
    const first = store.create({ title: 'A', clearance: ClearanceLevel.PUBLIC, createdByKeyId: 'k' });
    store.create({ title: 'B', clearance: ClearanceLevel.PUBLIC, createdByKeyId: 'k' });
    store.addNote(first.id, ClearanceLevel.PUBLIC, 'touched', 'k');

    const listed = store.list(ClearanceLevel.PUBLIC);
    expect(listed).toHaveLength(2);
    expect(listed[0].title).toBe('A');
  });
});
