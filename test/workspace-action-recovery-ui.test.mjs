import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  WORKSPACE_ACTION_RECOVERY_STORAGE_KEY,
  WorkspaceActionRecoveryConflictError,
  classifyWorkspaceActionError,
  createWorkspaceActionRecord,
  findWorkspaceActionRecord,
  markWorkspaceActionPending,
  markWorkspaceActionUnknown,
  readWorkspaceActionRecords,
  removeWorkspaceActionRecord,
  upsertWorkspaceActionRecord,
} from '../web/src/workspace-action-recovery.mjs';

function storageFixture(initial = null) {
  const values = new Map(initial ? [[WORKSPACE_ACTION_RECOVERY_STORAGE_KEY, initial]] : []);
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
    raw() { return values.get(WORKSPACE_ACTION_RECOVERY_STORAGE_KEY) ?? null; },
  };
}

function reuseRecord(overrides = {}) {
  return createWorkspaceActionRecord({
    kind: 'reuse',
    projectId: 'project-1',
    spaceId: 'space-1',
    spaceName: '空间一',
    request: {
      commandId: 'workspace-reuse-original',
      expectedRevision: 7,
      expectedBaseHead: 'head-original',
    },
    now: '2026-09-08T10:00:00.000Z',
    ...overrides,
  });
}

test('workspace action records persist exact reuse and remove request bodies', () => {
  const storage = storageFixture();
  const reuse = reuseRecord();
  const remove = createWorkspaceActionRecord({
    kind: 'remove',
    projectId: 'project-1',
    spaceId: 'space-2',
    spaceName: '空间二',
    request: { commandId: 'workspace-remove-original', expectedRevision: 4 },
    now: '2026-09-08T10:01:00.000Z',
  });

  upsertWorkspaceActionRecord(reuse, storage);
  upsertWorkspaceActionRecord(remove, storage);

  const restored = readWorkspaceActionRecords(storage);
  assert.deepEqual(restored.map((item) => item.request), [reuse.request, remove.request]);
  assert.equal(restored[0].commandId, 'workspace-reuse-original');
  assert.equal(restored[0].state, 'pending');
  assert.equal(restored[1].request.expectedRevision, 4);
  assert.equal(JSON.parse(storage.raw()).version, 1);
});

test('recreating the store retains the original command id and parameters for retry', () => {
  const firstStore = storageFixture();
  const original = reuseRecord();
  upsertWorkspaceActionRecord(original, firstStore);

  const recreatedStore = storageFixture(firstStore.raw());
  const restored = readWorkspaceActionRecords(recreatedStore)[0];
  assert.deepEqual(restored.request, original.request);
  assert.equal(restored.request.commandId, original.request.commandId);

  const retried = markWorkspaceActionPending(restored, recreatedStore, '2026-09-08T10:02:00.000Z');
  assert.deepEqual(findWorkspaceActionRecord(retried, { projectId: 'project-1', spaceId: 'space-1' }).request, original.request);
});

test('unknown transport, uncertain, and retryable outcomes stay recoverable', () => {
  assert.equal(classifyWorkspaceActionError({ code: 'SERVICE_UNAVAILABLE' }), 'unknown');
  assert.equal(classifyWorkspaceActionError({ code: 'WORKSPACE_RECOVERY_UNCERTAIN' }), 'unknown');
  assert.equal(classifyWorkspaceActionError({ code: 'REPOSITORY_LOCKED', retryable: true }), 'unknown');
  assert.equal(classifyWorkspaceActionError({ outcome: 'unknown', code: 'SOMETHING_NEW' }), 'unknown');
  assert.equal(classifyWorkspaceActionError(new TypeError('network failed')), 'unknown');
});

test('only explicit confirmed failure is definitive; unknown payloads are never inferred as final', () => {
  assert.equal(classifyWorkspaceActionError({ outcome: 'confirmed_failure', retryable: false, code: 'SPACE_REVISION_CONFLICT' }), 'definitive');
  assert.equal(classifyWorkspaceActionError({ code: 'SPACE_REVISION_CONFLICT' }), 'unknown');
  assert.equal(classifyWorkspaceActionError({ outcome: 'confirmed_failure', retryable: true }), 'unknown');
});

test('marking unknown survives reload and removal happens only after confirmed completion', () => {
  const storage = storageFixture();
  const original = reuseRecord();
  upsertWorkspaceActionRecord(original, storage);
  const unknown = markWorkspaceActionUnknown(
    original,
    { code: 'REPOSITORY_LOCKED', outcome: 'unknown', retryable: true, state: 'received' },
    storage,
    '2026-09-08T10:03:00.000Z',
  );
  assert.equal(unknown[0].state, 'unknown');
  assert.deepEqual(unknown[0].lastError, {
    code: 'REPOSITORY_LOCKED',
    outcome: 'unknown',
    retryable: true,
    state: 'received',
  });
  const afterReload = readWorkspaceActionRecords(storage);
  assert.equal(afterReload[0].state, 'unknown');

  const afterSuccess = removeWorkspaceActionRecord(afterReload[0], storage);
  assert.deepEqual(afterSuccess, []);
  assert.deepEqual(readWorkspaceActionRecords(storage), []);
});

test('late same-space responses cannot remove or rewrite a newer command', () => {
  const storage = storageFixture();
  const oldRecord = reuseRecord();
  const newerRecord = reuseRecord({
    request: {
      commandId: 'workspace-reuse-newer',
      expectedRevision: 8,
      expectedBaseHead: 'head-newer',
    },
    now: '2026-09-08T10:04:00.000Z',
  });

  upsertWorkspaceActionRecord(oldRecord, storage);
  removeWorkspaceActionRecord(oldRecord, storage);
  assert.deepEqual(markWorkspaceActionPending(oldRecord, storage), []);
  assert.deepEqual(markWorkspaceActionUnknown(oldRecord, { code: 'SERVICE_UNAVAILABLE' }, storage), []);
  upsertWorkspaceActionRecord(newerRecord, storage);

  assert.deepEqual(removeWorkspaceActionRecord(oldRecord, storage), [newerRecord]);
  assert.throws(
    () => markWorkspaceActionUnknown(oldRecord, { code: 'SERVICE_UNAVAILABLE' }, storage),
    (error) => error instanceof WorkspaceActionRecoveryConflictError
      && error.existingCommandId === newerRecord.commandId,
  );
  assert.throws(
    () => markWorkspaceActionPending(oldRecord, storage),
    (error) => error instanceof WorkspaceActionRecoveryConflictError
      && error.existingCommandId === newerRecord.commandId,
  );
  assert.throws(() => removeWorkspaceActionRecord(oldRecord.id, storage), TypeError);
  assert.deepEqual(readWorkspaceActionRecords(storage), [newerRecord]);
});

test('main wires workspace recovery storage and original request retry entry', () => {
  const main = readFileSync(new URL('../web/src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /workspace-action-recovery\.mjs/);
  assert.match(main, /createWorkspaceActionRecord/);
  assert.match(main, /markWorkspaceActionUnknown/);
  assert.match(main, /readWorkspaceActionRecordsWithStatus/);
  assert.match(main, /恢复并核对/);
  assert.match(main, /record\.request/);
  assert.match(main, /pendingWorkspaceActions/);
  assert.match(main, /isExactWorkspaceActionRecord/);
  assert.doesNotMatch(main, /没有发送新的 workspace 请求/);
});
