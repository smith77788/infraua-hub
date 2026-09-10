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
