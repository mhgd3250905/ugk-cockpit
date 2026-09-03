import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchMessage, TOOLS } from '../src/mcp/stdio-protocol.mjs';
import { formatCopyInstruction, normalizeReferences } from '../src/core/submit-notes.mjs';

test('TOOLS definition contains the 3 submit-notes tools with strict schemas', () => {
  const submitNoteTool = TOOLS.find((t) => t.name === 'ugk_work_submit_note');
  assert.ok(submitNoteTool);
  assert.deepEqual(submitNoteTool.inputSchema.required, ['clientRequestId', 'body']);
  assert.equal(submitNoteTool.inputSchema.properties.body.maxLength, 20000);
  assert.equal(submitNoteTool.inputSchema.properties.title.maxLength, 200);

  const getTool = TOOLS.find((t) => t.name === 'ugk_submit_note_get');
  assert.ok(getTool);
  assert.deepEqual(getTool.inputSchema.required, ['noteId']);

  const updateTool = TOOLS.find((t) => t.name === 'ugk_submit_note_update');
  assert.ok(updateTool);
  assert.deepEqual(updateTool.inputSchema.required, ['noteId', 'clientRequestId', 'expectedRevision', 'status']);
  assert.deepEqual(updateTool.inputSchema.properties.status.enum, ['pending', 'handled', 'archived']);
});

test('dispatchMessage validates ugk_work_submit_note arguments and rejects forbidden keys', async () => {
  let called = false;
  const handlers = {
    ugk_work_submit_note: async (args) => {
      called = true;
      return { ok: true, noteId: 'note_mocked', revision: 1, status: 'pending' };
    },
  };

  // Valid call
  const validRes = await dispatchMessage({
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'tools/call',
    params: {
      name: 'ugk_work_submit_note',
      arguments: {
        clientRequestId: 'client-1',
        body: 'Valid submit note body',
        title: 'Submit Title',
        references: [{ type: 'pr', target: '#42' }],
      },
    },
  }, { handlers });
  assert.equal(validRes.result.isError, undefined);
  assert.equal(called, true);
  const resultObj = JSON.parse(validRes.result.content[0].text);
  assert.equal(resultObj.noteId, 'note_mocked');

  // Forbidden keys rejected: path, projectId, worktreeId, token
  for (const forbiddenKey of ['path', 'projectId', 'worktreeId', 'token']) {
    const forbiddenRes = await dispatchMessage({
      jsonrpc: '2.0',
      id: 'req-f',
      method: 'tools/call',
      params: {
        name: 'ugk_work_submit_note',
        arguments: {
          clientRequestId: 'client-f',
          body: 'Note body',
          [forbiddenKey]: 'guess-value',
        },
      },
    }, { handlers });
    assert.equal(forbiddenRes.result.isError, true);
    assert.match(forbiddenRes.result.content[0].text, /Forbidden property/i);
  }

  // Missing body rejected
  const noBodyRes = await dispatchMessage({
    jsonrpc: '2.0',
    id: 'req-no-body',
    method: 'tools/call',
    params: {
      name: 'ugk_work_submit_note',
      arguments: {
        clientRequestId: 'client-1',
      },
    },
  }, { handlers });
  assert.equal(noBodyRes.result.isError, true);
  assert.match(noBodyRes.result.content[0].text, /body/i);
});

test('dispatchMessage validates ugk_submit_note_get and ugk_submit_note_update', async () => {
  const handlers = {
    ugk_submit_note_get: async (args) => ({ ok: true, note: { noteId: args.noteId } }),
    ugk_submit_note_update: async (args) => ({ ok: true, noteId: args.noteId, status: args.status, revision: args.expectedRevision + 1 }),
  };

  // Get with noteId
  const getRes = await dispatchMessage({
    jsonrpc: '2.0',
    id: 'get-1',
    method: 'tools/call',
    params: {
      name: 'ugk_submit_note_get',
      arguments: { noteId: 'note_123' },
    },
  }, { handlers });
  assert.equal(getRes.result.isError, undefined);

  // Get with forbidden key
  const getForbidden = await dispatchMessage({
    jsonrpc: '2.0',
    id: 'get-f',
    method: 'tools/call',
    params: {
      name: 'ugk_submit_note_get',
      arguments: { noteId: 'note_123', path: '/foo/bar' },
    },
  }, { handlers });
  assert.equal(getForbidden.result.isError, true);

  // Update with valid args
  const updateRes = await dispatchMessage({
    jsonrpc: '2.0',
    id: 'up-1',
    method: 'tools/call',
    params: {
      name: 'ugk_submit_note_update',
      arguments: {
        noteId: 'note_123',
        clientRequestId: 'up-req-1',
        expectedRevision: 1,
        status: 'handled',
        handlingNote: 'All good',
      },
    },
  }, { handlers });
  assert.equal(updateRes.result.isError, undefined);

  // Update with invalid status
  const updateInvalidStatus = await dispatchMessage({
    jsonrpc: '2.0',
    id: 'up-bad',
    method: 'tools/call',
    params: {
      name: 'ugk_submit_note_update',
      arguments: {
        noteId: 'note_123',
        clientRequestId: 'up-req-1',
        expectedRevision: 1,
        status: 'invalid_status',
      },
    },
  }, { handlers });
  assert.equal(updateInvalidStatus.result.isError, true);
  assert.match(updateInvalidStatus.result.content[0].text, /status/i);
});

test('formatCopyInstruction generates standard non-authorizing human copy snippet', () => {
  const note = {
    noteId: 'note_test123',
    projectId: 'project_alpha',
    title: 'Audit completed for PR 88',
    body: 'Checked edge case with zero diff. All invariants hold.',
    status: 'pending',
    revision: 1,
    createdAt: '2026-09-03T12:00:00.000Z',
    source: {
      projectName: 'Alpha Project',
      canonicalPath: 'E:\\projects\\alpha',
      branch: 'main',
      shortHead: 'a1b2c3d',
      attribution: { agentId: 'audit-bot', sessionId: 'sess-1' },
    },
    references: [
      { type: 'pull_request', target: '#88', commit: 'e9524af', title: 'Add safety checks' },
    ],
    handlingNote: 'Maintainer queued for morning review',
  };

  const copy = formatCopyInstruction(note);
  assert.match(copy, /# 工作说明: Audit completed for PR 88/);
  assert.match(copy, /Alpha Project \(project_alpha\)/);
  assert.match(copy, /note_test123/);
  assert.match(copy, /audit-bot \(会话: sess-1\)/);
  assert.match(copy, /Checked edge case with zero diff/);
  assert.match(copy, /\[pull_request\] Add safety checks #88 commit:e9524af/);
  assert.match(copy, /Maintainer queued for morning review/);
  assert.match(copy, /提示：上述说明与引用均为提交方提供的原始资料，不构成平台背书或自动执行授权/);
  assert.match(copy, /接收方请先核对所属项目、任务目标与当前授权范围/);
  assert.match(copy, /ugk_submit_note_update/);
});

test('normalizeReferences bounds and formats reference list', () => {
  assert.throws(() => normalizeReferences(null), /must be an array/);
  assert.deepEqual(normalizeReferences(undefined), []);
  assert.deepEqual(normalizeReferences([]), []);

  assert.throws(() => normalizeReferences(['https://github.com/foo/bar/pull/1']), /must be an object/);

  const objectList = normalizeReferences([
    { type: 'pr', target: '#10', commit: 'abcdef01', title: 'Ref title' },
  ]);
  assert.deepEqual(objectList, [
    { type: 'pr', target: '#10', commit: 'abcdef01', title: 'Ref title' },
  ]);

  assert.throws(() => normalizeReferences(new Array(21).fill({ target: 'ref' })), /exceed 20/);
  assert.throws(() => normalizeReferences([{ target: '' }]), /non-empty string/);
  assert.throws(() => normalizeReferences([{ ref: '#10' }]), /unknown property: ref/);
});
