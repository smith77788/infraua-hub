import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AuditLog } from '../../core/audit/AuditLog';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

describe('AuditLog', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
    filePath = path.join(dir, 'audit.log');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('chains entries and verifies intact', () => {
    const log = new AuditLog(filePath);
    log.append('actor1', 'action1', { a: 1 });
    log.append('actor2', 'action2', { b: 2 });

    expect(log.verify()).toEqual({ valid: true, brokenAtSeq: null });
    expect(log.all()).toHaveLength(2);
  });

  it('detects tampering with a past entry', () => {
    const log = new AuditLog(filePath);
    log.append('actor1', 'action1', { a: 1 });
    log.append('actor2', 'action2', { b: 2 });

    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    const tampered = JSON.parse(lines[0]);
    tampered.details = { a: 999 };
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const reloaded = new AuditLog(filePath);
    const verification = reloaded.verify();
    expect(verification.valid).toBe(false);
  });

  it('reloads and continues the chain across instances', () => {
    const log1 = new AuditLog(filePath);
    log1.append('actor1', 'action1', {});

    const log2 = new AuditLog(filePath);
    log2.append('actor2', 'action2', {});

    expect(log2.all()).toHaveLength(2);
    expect(log2.verify().valid).toBe(true);
  });
});

describe('the log survives its own growth', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-growth-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const build = (n: number) => {
    const file = path.join(dir, 'audit.log');
    const log = new AuditLog(file);
    for (let i = 0; i < n; i++) {
      log.append(i % 2 === 0 ? 'olena' : 'petro', i % 3 === 0 ? 'read_access' : 'tool_call', {
        route: '/api/platform/graph',
        returned: { nodes: i },
      });
    }
    return { file, log };
  };

  it('reopens from disk with the chain intact', () => {
    const { file } = build(200);
    // The index is rebuilt from the file; nothing is carried over in memory.
    const reopened = new AuditLog(file);
    expect(reopened.size()).toBe(200);
    expect(reopened.verify().valid).toBe(true);
    // And the chain continues from where it left off rather than restarting.
    const next = reopened.append('olena', 'tool_call', {});
    expect(next.seq).toBe(200);
    expect(new AuditLog(file).verify().valid).toBe(true);
  });

  it('pages from disk without holding the entries', () => {
    const { log } = build(500);
    const page = log.page({ limit: 10 });
    expect(page.entries).toHaveLength(10);
    expect(page.total).toBe(500);
    // Newest first, so the cursor walks backwards through history.
    expect(page.entries[0].seq).toBe(499);
    expect(page.entries[9].seq).toBe(490);

    const older = log.page({ limit: 10, before: page.nextBefore! });
    expect(older.entries[0].seq).toBe(489);
  });

  it('filters before it cuts the page, not after', () => {
    // "The last N things this principal did", not "whatever of theirs happens
    // to be in the last N entries overall" — the second lies by omission.
    const { log } = build(500);
    const mine = log.page({ actor: 'olena', limit: 5 });
    expect(mine.entries).toHaveLength(5);
    expect(mine.entries.every((e) => e.actor === 'olena')).toBe(true);
    expect(mine.matched).toBe(250);
  });

  it('answers a filter that never matched anything with nothing', () => {
    const { log } = build(50);
    const none = log.page({ actor: 'somebody-else' });
    expect(none.entries).toHaveLength(0);
    expect(none.matched).toBe(0);
    // Different from "no filter", which would have returned everything.
    expect(none.total).toBe(50);
  });

  it('still detects tampering, which is the whole point', () => {
    const { file } = build(100);
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const tampered = JSON.parse(lines[42]);
    tampered.details = { returned: { nodes: 999999 } };
    lines[42] = JSON.stringify(tampered);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');

    const check = new AuditLog(file).verify();
    expect(check.valid).toBe(false);
    expect(check.brokenAtSeq).toBe(42);
  });

  it('detects a deleted entry, not only an altered one', () => {
    const { file } = build(100);
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    lines.splice(60, 1);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
    expect(new AuditLog(file).verify().valid).toBe(false);
  });
});
