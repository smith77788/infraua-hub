import * as fs from 'fs';
import * as path from 'path';
import { CodingAgentAdapter, ImplementationInput, ImplementationOutput } from '../CodingAgentAdapter';

const USER_STORE_MODULE = `function createUserStore() {
  const users = new Map();
  let nextId = 1;
  return {
    create(name) {
      if (!name) throw new Error('name is required');
      const user = { id: nextId++, name };
      users.set(user.id, user);
      return user;
    },
    get(id) {
      return users.get(id) || null;
    },
    list() {
      return Array.from(users.values());
    },
    remove(id) {
      return users.delete(id);
    },
  };
}

module.exports = { createUserStore };
`;

// Intentionally buggy: comparing/deleting by String(id) never matches the
// numeric keys the store uses, so a real user can never be removed. This
// is what lets the review->fix loop exercise a genuine, reproducible bug
// instead of a scripted status transition.
const USER_STORE_MODULE_BUGGY = USER_STORE_MODULE.replace(
  'return users.delete(id);',
  'return users.delete(String(id));'
);

const USER_STORE_TEST = `const assert = require('assert');
const { createUserStore } = require('../src/users');

const store = createUserStore();
const alice = store.create('Alice');
assert.strictEqual(alice.name, 'Alice');
assert.strictEqual(store.list().length, 1);

const removed = store.remove(alice.id);
assert.strictEqual(removed, true, 'remove() should return true for an existing user');
assert.strictEqual(store.list().length, 0, 'user should no longer be listed after removal');

console.log('All tests passed');
`;

/**
 * Deterministic stand-in for a real coding agent. It implements a small
 * in-memory "users" module with tests, on the first attempt with a
 * seeded bug so the reviewer/fix loop in the orchestrator has something
 * real to catch, then writes the corrected version on the fix pass.
 *
 * This is a placeholder for CodexAdapter / a future Claude coding
 * adapter (see agents/coder/adapters/CodexAdapter.ts) - the orchestrator
 * and CoderAgent never know the difference.
 */
export class MockCoderAdapter implements CodingAgentAdapter {
  readonly name = 'mock-coder';

  async implement(input: ImplementationInput): Promise<ImplementationOutput> {
    const srcDir = path.join(input.workspaceDir, 'src');
    const testDir = path.join(input.workspaceDir, 'test');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });

    const isFixPass = Boolean(input.reviewFeedback && input.reviewFeedback.length > 0);
    const moduleSource = isFixPass ? USER_STORE_MODULE : USER_STORE_MODULE_BUGGY;

    const modulePath = path.join(srcDir, 'users.js');
    const testPath = path.join(testDir, 'users.test.js');
    fs.writeFileSync(modulePath, moduleSource, 'utf-8');
    fs.writeFileSync(testPath, USER_STORE_TEST, 'utf-8');

    return {
      filesWritten: [path.relative(input.workspaceDir, modulePath), path.relative(input.workspaceDir, testPath)],
      summary: isFixPass
        ? 'Fixed remove() to delete by the stored numeric id instead of a stringified id.'
        : 'Implemented an in-memory user store (create/get/list/remove) with unit tests.',
    };
  }
}
