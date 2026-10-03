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
  workspaceActionRequestBody,
  writeWorkspaceActionRecords,
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
  // The body comes from the durable record through one builder, so the first
  // attempt and the replay cannot drift apart (alpha.59: the removal
  // confirmation is added there rather than stored in the record).
  assert.match(main, /workspaceActionRequestBody\(record\)/);
  assert.match(main, /pendingWorkspaceActions/);
  assert.match(main, /isExactWorkspaceActionRecord/);
  assert.doesNotMatch(main, /没有发送新的 workspace 请求/);
});

// 第 36 轮审计（2026-10-04）· 恢复存储的「读入容忍」。
//
// `normalizeRequest` 的注释写着「Unknown keys are therefore dropped on read」，
// 代码却在同一个函数里对着白名单外的键 `return null`。两者不是等价的：返回 null 会让
// `readRawStrict` 对**整份**存储抛 WORKSPACE_ACTION_RECOVERY_INVALID_DATA，而
// upsert / markPending / markUnknown / removeRecord 全部要先过 `readRawStrict`。
// 于是一个多余键的实际后果是：待核对的删除/重新开始记录从界面上消失（这个面板没有
// 任何丢弃入口），并且此后任何开发空间操作都记不进去——用户既看不到悬着的删除，
// 也发不出新操作。注释描述的正是第 30 轮定下的三段式姿势（读入容忍 + 写出规范形状
// + 由唯一发送口按记录派生确认），本轮把代码补成它自己声称的样子。
function storeWith(records) {
  return storageFixture(JSON.stringify({ version: 1, records }));
}

function removeRecord() {
  return createWorkspaceActionRecord({
    kind: 'remove',
    projectId: 'project-2',
    spaceId: 'space-2',
    spaceName: '空间二',
    request: { commandId: 'workspace-remove-original', expectedRevision: 3 },
    now: '2026-10-04T10:00:00.000Z',
  });
}

test('一个多余键不得让整份恢复存储变得不可读', () => {
  const drifted = {
    ...reuseRecord(),
    request: { ...reuseRecord().request, bundleField: 'newer-build-writes-this' },
  };
  const storage = storeWith([drifted]);

  const visible = readWorkspaceActionRecords(storage);
  assert.equal(visible.length, 1, 'a record with one unknown key vanished from the UI read');
  assert.deepEqual(Object.keys(visible[0].request).sort(), ['commandId', 'expectedBaseHead', 'expectedRevision'],
    'reads must hand back the canonical shape, not the drifted one');

  // The mutation paths are the reason this is not cosmetic: all of them gate on
  // readRawStrict, so one unknown key used to lock every later workspace action.
  assert.doesNotThrow(() => upsertWorkspaceActionRecord(removeRecord(), storage));
  assert.doesNotThrow(() => removeWorkspaceActionRecord(drifted, storage));
});

test('多余键被丢弃后仍由唯一发送口派生删除确认（不许静默去掉确认）', () => {
  const withExtra = {
    ...removeRecord(),
    request: { ...removeRecord().request, userConfirmedIgnoredRemoval: true, attempt: 2 },
  };
  const storage = storeWith([withExtra]);
  const [record] = readWorkspaceActionRecords(storage);
  const body = workspaceActionRequestBody(record);
  assert.equal(body.userConfirmedIgnoredRemoval, true,
    'the removal confirmation must survive a stored record that carries it twice');
  // 读宽容必须配上写规范：任何一次落盘都该把漂移掉的形状收敛回规范形状。
  const persisted = upsertWorkspaceActionRecord(record, storage);
  assert.deepEqual(Object.keys(persisted[0].request).sort(), ['commandId', 'expectedRevision']);
  assert.deepEqual(Object.keys(JSON.parse(storage.raw()).records[0].request).sort(),
    ['commandId', 'expectedRevision'],
    'the extra keys must not survive a write back into the store');
});

// 反向对照（主干上即绿）：宽容只针对多余键。缺必要字段的记录是真的读不出来，
// 继续响亮失败正是它防止「用空列表顶替损坏存储」的手段——把这条也一并宽容掉，
// 就等于把上一轮防住的静默清空重新打开。
test('写路径不比读路径宽容：混进一条坏记录要响亮失败而不是被静默丢掉', () => {
  // 读侧 `readRawStrict` 对无法归一化的记录抛错（防止用空列表顶替损坏存储），而写侧
  // `normalizeStoredActions` 原先是 `if (action) byId.set(...)`——同一份字节，一个抛错
  // 一个丢弃。丢弃就是丢用户还没核对的删除记录，且重复 id 会被「后写覆盖前写」消掉。
  const storage = storageFixture();
  assert.throws(() => writeWorkspaceActionRecords([removeRecord(), { not: 'a record' }], storage),
    (error) => error.code === 'WORKSPACE_ACTION_RECOVERY_INVALID_DATA');
  assert.equal(storage.raw(), null, 'a refused write must not have replaced the store');

  // 反向对照：两条合法记录照常写入，重复编号也要红而不是择一保留。
  assert.equal(writeWorkspaceActionRecords([removeRecord(), reuseRecord()], storage).length, 2);
  assert.throws(() => writeWorkspaceActionRecords([removeRecord(), removeRecord()], storage),
    (error) => error.code === 'WORKSPACE_ACTION_RECOVERY_INVALID_DATA');
});

test('反向对照：缺必要字段的记录仍然整份响亮失败', () => {
  const broken = { ...reuseRecord(), request: { expectedRevision: 7, expectedBaseHead: 'head-original' } };
  const storage = storeWith([broken]);
  assert.equal(readWorkspaceActionRecords(storage).length, 0);
  assert.throws(() => upsertWorkspaceActionRecord(removeRecord(), storage),
    (error) => error.code === 'WORKSPACE_ACTION_RECOVERY_INVALID_DATA');

  // reuse 分支的同族落点：少了基线锚点同样是读不出来，不是宽容对象。
  // 注意被 upsert 的必须是一条**合法**记录，否则会先撞上入参自身的守卫
  // （TypeError 'Invalid workspace action recovery record.'），那条红与本用例
  // 要钉的「整份存储被一条坏记录卡死」不是同一件事。
  const noBaseline = { ...reuseRecord(), request: { commandId: 'workspace-reuse-no-baseline', expectedRevision: 1 } };
  const baselineStorage = storeWith([noBaseline]);
  assert.equal(readWorkspaceActionRecords(baselineStorage).length, 0);
  assert.throws(() => upsertWorkspaceActionRecord(removeRecord(), baselineStorage),
    (error) => error.code === 'WORKSPACE_ACTION_RECOVERY_INVALID_DATA');
});

test('反向对照：remove 分支里非布尔的确认值不再能卡住整份存储', () => {
  // 该字段没有任何读取方（发送口按记录重新派生），所以它的形状不是存储完整性。
  // 旧实现先按白名单拒绝，这一支永远走不到；现在必须证明它确实被忽略而不是被判坏。
  const odd = {
    ...removeRecord(),
    request: { ...removeRecord().request, userConfirmedIgnoredRemoval: 'yes' },
  };
  const storage = storeWith([odd]);
  assert.equal(readWorkspaceActionRecords(storage).length, 1);
});
