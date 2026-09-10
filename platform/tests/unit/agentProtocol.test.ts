import { createMessage } from '../../core/agents/AgentMessage';
import { hasBlockingIssues, ReviewResult } from '../../core/agents/Review';
import { describe, expect, it } from 'bun:test';

describe('Agent protocol', () => {
  it('createMessage fills in timestamp and defaults', () => {
    const msg = createMessage({
      task_id: 'TASK-1',
      sender: 'architect',
      recipient: 'coder',
      type: 'implementation_request',
      content: { hello: 'world' },
    });

    expect(msg.artifacts).toEqual([]);
    expect(msg.constraints).toEqual([]);
    expect(typeof msg.timestamp).toBe('string');
    expect(new Date(msg.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('hasBlockingIssues is true only for high/critical severities', () => {
    const clean: ReviewResult = { approved: true, issues: [], summary: 'ok' };
    expect(hasBlockingIssues(clean)).toBe(false);

    const minor: ReviewResult = { approved: true, issues: [{ severity: 'low', description: 'nit' }], summary: 'ok' };
    expect(hasBlockingIssues(minor)).toBe(false);

    const blocking: ReviewResult = {
      approved: false,
      issues: [{ severity: 'high', description: 'bug' }],
      summary: 'not ok',
    };
    expect(hasBlockingIssues(blocking)).toBe(true);
  });
});
