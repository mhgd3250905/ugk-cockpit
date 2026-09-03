import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createServiceHandlers } from '../src/mcp/service-client.mjs';
import {
  TOOLS,
  createMcpServer,
  createMcpStdioServer,
  dispatchMessage
} from '../src/mcp/stdio-protocol.mjs';

test('TOOLS definition includes preflight and no path/projectId/worktreeId/token', () => {
  const toolNames = TOOLS.map((t) => t.name);
  assert.deepEqual(toolNames, [
    'ugk_work_context',
    'ugk_work_accept',
    'ugk_work_progress',
    'ugk_work_submit_preflight',
    'ugk_work_submit',
    'ugk_work_submit_note',
    'ugk_submit_note_get',
    'ugk_submit_note_update',
    'ugk_integration_begin',
    'ugk_integration_review',
    'ugk_integration_merge',
    'ugk_work_finish',
    'ugk_work_handoff',
    'ugk_work_begin',
    'ugk_work_init',
    'ugk_work_relay',
    'ugk_work_resume'
  ]);
  assert.deepEqual(
    TOOLS.find((tool) => tool.name === 'ugk_work_handoff').inputSchema.properties.outcome.enum,
    ['completed', 'blocked', 'abandoned']
  );
  assert.deepEqual(
    TOOLS.find((tool) => tool.name === 'ugk_work_progress').inputSchema.properties.status.enum,
    ['working', 'in_progress']
  );
  const progressTool = TOOLS.find((tool) => tool.name === 'ugk_work_progress');
  assert.deepEqual(progressTool.inputSchema.anyOf, [
    { required: ['summary'] },
    { required: ['note'] }
  ]);
  assert.strictEqual(progressTool.inputSchema.properties.summary.minLength, 1);
  assert.strictEqual(progressTool.inputSchema.properties.details.items.minLength, 1);

  const descriptions = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.description]));
  assert.match(descriptions.ugk_work_context, /read.*current.*session|read-only/i);
  assert.match(descriptions.ugk_work_progress, /only.*eligible for implicit/i);
  assert.match(descriptions.ugk_work_accept, /explicitly.*code/i);
  assert.match(descriptions.ugk_work_begin, /explicitly instructs beginning/i);
  assert.match(descriptions.ugk_work_init, /explicitly instructs initialization/i);
  assert.match(descriptions.ugk_work_resume, /explicitly.*continueCode/i);
  assert.match(descriptions.ugk_work_relay, /explicitly asks to switch AI conversations/i);
  assert.match(descriptions.ugk_work_finish, /explicitly asks to end the current phase/i);
  assert.match(descriptions.ugk_work_handoff, /explicitly asks to end the current phase/i);
  assert.match(
    TOOLS.find((tool) => tool.name === 'ugk_work_progress').inputSchema.properties.status.description,
    /never ends the phase|never.*handoff/i,
  );

  for (const tool of TOOLS) {
    const props = Object.keys(tool.inputSchema.properties || {});
    assert.strictEqual(props.includes('path'), false, `${tool.name} must not contain path`);
    assert.strictEqual(props.includes('projectId'), false, `${tool.name} must not contain projectId`);
    assert.strictEqual(props.includes('worktreeId'), false, `${tool.name} must not contain worktreeId`);
    assert.strictEqual(props.includes('token'), false, `${tool.name} must not contain token`);

    const required = tool.inputSchema.required || [];
    assert.strictEqual(required.includes('path'), false);
    assert.strictEqual(required.includes('projectId'), false);
    assert.strictEqual(required.includes('worktreeId'), false);
    assert.strictEqual(required.includes('token'), false);
    assert.strictEqual(tool.inputSchema.additionalProperties, false);
  }
  const contextTool = TOOLS.find((tool) => tool.name === 'ugk_work_context');
  assert.deepEqual(Object.keys(contextTool.inputSchema.properties), ['confirmSessionId', 'expectedRevision']);
  assert.deepEqual(contextTool.inputSchema.required ?? [], []);
});

test('context validation keeps confirmation fields optional but paired', async () => {
  const invalid = await dispatchMessage({
    jsonrpc: '2.0', id: 'context-invalid', method: 'tools/call',
    params: { name: 'ugk_work_context', arguments: { confirmSessionId: 'session-1' } },
  });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /provided together/);

  const received = [];
  const valid = await dispatchMessage({
    jsonrpc: '2.0', id: 'context-valid', method: 'tools/call',
    params: {
      name: 'ugk_work_context',
      arguments: { confirmSessionId: 'session-1', expectedRevision: 4 },
    },
  }, {
    handlers: {
      ugk_work_context: async (args) => {
        received.push(args);
        return { ok: true, canContinue: false };
      },
    },
  });
  assert.equal(valid.result.content[0].text, JSON.stringify({ ok: true, canContinue: false }));
  assert.deepEqual(received, [{ confirmSessionId: 'session-1', expectedRevision: 4 }]);
});

test('dispatchMessage handles initialize, ping, tools/list, and notifications', async () => {
  // 1. initialize
  const initRes = await dispatchMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  });
  assert.strictEqual(initRes.id, 1);
  assert.strictEqual(initRes.result.serverInfo.name, 'ugk-cockpit');
  assert.strictEqual(initRes.result.protocolVersion, '2025-06-18');
  assert.match(initRes.result.serverInfo.version, /^0\.1\.0-alpha\./);
  assert.deepEqual(initRes.result.capabilities, { tools: {} });

  const negotiated = await dispatchMessage({
    jsonrpc: '2.0', id: 2, method: 'initialize',
    params: { protocolVersion: 'unsupported-version' }
  });
  assert.strictEqual(negotiated.result.protocolVersion, '2025-11-25');

  // 2. notifications/initialized produces no response
  const notifInitRes = await dispatchMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {}
  });
  assert.strictEqual(notifInitRes, null);

  // 3. notification without id produces no response
  const genericNotif = await dispatchMessage({
    jsonrpc: '2.0',
    method: 'custom/notification',
    params: { something: true }
  });
  assert.strictEqual(genericNotif, null);

  // 4. ping
  const pingRes = await dispatchMessage({
    jsonrpc: '2.0',
    id: 'ping-1',
    method: 'ping'
  });
  assert.strictEqual(pingRes.id, 'ping-1');
  assert.deepEqual(pingRes.result, {});

  // 5. tools/list
  const listRes = await dispatchMessage({
    jsonrpc: '2.0',
    id: 'list-1',
    method: 'tools/list'
  });
  assert.strictEqual(listRes.id, 'list-1');
  assert.deepEqual(listRes.result.tools, TOOLS);
});

test('dispatchMessage accurately forwards tool calls to handlers once with exact arguments', async () => {
  const callCounts = { accept: 0, progress: 0, submit: 0, integrationBegin: 0, integrationReview: 0, integrationMerge: 0, finish: 0, handoff: 0, begin: 0, init: 0 };
  const receivedArgs = {};

  const handlers = {
    ugk_work_accept: async (args) => {
      callCounts.accept += 1;
      receivedArgs.accept = args;
      return { sessionId: 'sess-100', revision: 1 };
    },
    ugk_work_progress: async (args) => {
      callCounts.progress += 1;
      receivedArgs.progress = args;
      return { revision: 2, status: 'running' };
    },
    ugk_work_submit: async (args) => {
      callCounts.submit += 1;
      receivedArgs.submit = args;
      return { submissionId: 'sub-1', localSaved: true, pushed: true };
    },
    ugk_integration_begin: async (args) => {
      callCounts.integrationBegin += 1;
      receivedArgs.integrationBegin = args;
      return { claimId: 'claim-1', claimRevision: 0 };
    },
    ugk_integration_review: async (args) => {
      callCounts.integrationReview += 1;
      receivedArgs.integrationReview = args;
      return { verdict: args.verdict, claimRevision: 1 };
    },
    ugk_integration_merge: async (args) => {
      callCounts.integrationMerge += 1;
      receivedArgs.integrationMerge = args;
      return { receiptId: 'receipt-1', pushed: true };
    },
    ugk_work_finish: async (args) => {
      callCounts.finish += 1;
      receivedArgs.finish = args;
      return { closed: true, outcome: 'completed' };
    },
    ugk_work_handoff: async (args) => {
      callCounts.handoff += 1;
      receivedArgs.handoff = args;
      return { recorded: true, outcome: 'completed' };
    },
    ugk_work_begin: async (args) => {
      callCounts.begin += 1;
      receivedArgs.begin = args;
      return { started: true, sessionId: 'sess-100' };
    },
    ugk_work_init: async (args) => {
      callCounts.init += 1;
      receivedArgs.init = args;
      return { started: true, sessionId: 'sess-init', revision: 2 };
    }
  };

  // Call ugk_work_accept
  const acceptPayload = {
    dispatchCode: 'DISPATCH-999',
    clientRequestId: 'req-accept-1'
  };
  const acceptRes = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'ugk_work_accept',
        arguments: acceptPayload
      }
    },
    { handlers }
  );
  assert.strictEqual(acceptRes.id, 10);
  assert.strictEqual(callCounts.accept, 1);
  assert.deepEqual(receivedArgs.accept, acceptPayload);
  assert.deepEqual(JSON.parse(acceptRes.result.content[0].text), { sessionId: 'sess-100', revision: 1 });

  // Call ugk_work_begin
  const beginPayload = {
    sessionId: 'sess-100',
    clientRequestId: 'req-begin-1',
    expectedRevision: 1,
    task: 'Implement MCP protocol handoff tools'
  };
  const beginRes = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'ugk_work_begin',
        arguments: beginPayload
      }
    },
    { handlers }
  );
  assert.strictEqual(beginRes.id, 13);
  assert.strictEqual(callCounts.begin, 1);
  assert.deepEqual(receivedArgs.begin, beginPayload);
  assert.deepEqual(JSON.parse(beginRes.result.content[0].text), { started: true, sessionId: 'sess-100' });

  // Call ugk_work_progress
  const progressPayload = {
    sessionId: 'sess-100',
    clientRequestId: 'req-prog-1',
    expectedRevision: 1,
    status: 'in_progress',
    note: 'Making changes'
  };
  const progRes = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'ugk_work_progress',
        arguments: progressPayload
      }
    },
    { handlers }
  );
  assert.strictEqual(progRes.id, 11);
  assert.strictEqual(callCounts.progress, 1);
  assert.deepEqual(receivedArgs.progress, progressPayload);
  assert.deepEqual(JSON.parse(progRes.result.content[0].text), { revision: 2, status: 'running' });

  // Call ugk_work_progress (structured progress)
  const structuredProgressPayload = {
    sessionId: 'sess-100',
    clientRequestId: 'req-prog-structured',
    expectedRevision: 2,
    status: 'working',
    summary: 'Completed structured slice',
    details: ['detail 1', 'detail 2']
  };
  const structuredProgRes = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 110,
      method: 'tools/call',
      params: {
        name: 'ugk_work_progress',
        arguments: structuredProgressPayload
      }
    },
    { handlers }
  );
  assert.strictEqual(structuredProgRes.id, 110);
  assert.strictEqual(callCounts.progress, 2);
  assert.deepEqual(receivedArgs.progress, structuredProgressPayload);
  assert.deepEqual(JSON.parse(structuredProgRes.result.content[0].text), { revision: 2, status: 'running' });

  const submitPayload = {
    preflightId: 'preflight-100',
    clientRequestId: 'req-submit-1',
    summary: '完成开发空间功能',
  };
  const submitRes = await dispatchMessage({
    jsonrpc: '2.0', id: 111, method: 'tools/call',
    params: { name: 'ugk_work_submit', arguments: submitPayload },
  }, { handlers });
  assert.strictEqual(callCounts.submit, 1);
  assert.deepEqual(receivedArgs.submit, submitPayload);
  assert.deepEqual(JSON.parse(submitRes.result.content[0].text), {
    submissionId: 'sub-1', localSaved: true, pushed: true,
  });

  const integrationBeginPayload = {
    sessionId: 'sess-100', clientRequestId: 'review-begin-1', expectedRevision: 2,
    submissionId: 'sub-1', expectedSubmissionRevision: 0,
  };
  await dispatchMessage({ jsonrpc: '2.0', id: 112, method: 'tools/call', params: {
    name: 'ugk_integration_begin', arguments: integrationBeginPayload,
  } }, { handlers });
  assert.strictEqual(callCounts.integrationBegin, 1);
  assert.deepEqual(receivedArgs.integrationBegin, integrationBeginPayload);

  const integrationReviewPayload = {
    sessionId: 'sess-100', clientRequestId: 'review-result-1', expectedRevision: 2,
    submissionId: 'sub-1', claimId: 'claim-1', expectedClaimRevision: 0,
    verdict: 'approved', summary: '审核通过', findings: [], checks: ['tests passed'],
  };
  await dispatchMessage({ jsonrpc: '2.0', id: 113, method: 'tools/call', params: {
    name: 'ugk_integration_review', arguments: integrationReviewPayload,
  } }, { handlers });
  assert.strictEqual(callCounts.integrationReview, 1);
  assert.deepEqual(receivedArgs.integrationReview, integrationReviewPayload);

  const integrationMergePayload = {
    sessionId: 'sess-100', clientRequestId: 'merge-1', expectedRevision: 2,
    submissionId: 'sub-1', claimId: 'claim-1', expectedSubmissionRevision: 2,
    expectedClaimRevision: 1, summary: '审核通过并接入主项目',
  };
  await dispatchMessage({ jsonrpc: '2.0', id: 114, method: 'tools/call', params: {
    name: 'ugk_integration_merge', arguments: integrationMergePayload,
  } }, { handlers });
  assert.strictEqual(callCounts.integrationMerge, 1);
  assert.deepEqual(receivedArgs.integrationMerge, integrationMergePayload);

  // Call ugk_work_finish
  const finishPayload = {
    sessionId: 'sess-100',
    clientRequestId: 'req-finish-1',
    expectedRevision: 2,
    outcome: 'completed',
    summary: 'All tasks passed',
    nextStep: 'Ready for merge',
    acknowledgements: ['receipt-1', 'receipt-2']
  };
  const finishRes = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'ugk_work_finish',
        arguments: finishPayload
      }
    },
    { handlers }
  );
  assert.strictEqual(finishRes.id, 12);
  assert.strictEqual(callCounts.finish, 1);
  assert.deepEqual(receivedArgs.finish, finishPayload);
  assert.deepEqual(JSON.parse(finishRes.result.content[0].text), { closed: true, outcome: 'completed' });

  // Call ugk_work_handoff
  const handoffPayload = {
    sessionId: 'sess-100',
    clientRequestId: 'req-handoff-1',
    expectedRevision: 3,
    outcome: 'completed',
    nextSessionFocus: 'Implement next vertical slice',
    summary: 'Completed MCP protocol expansion',
    currentState: 'All tests green',
    completedItems: ['Added tools', 'Added tests'],
    pendingItems: ['Deploy to staging'],
    decisions: ['Use stdio transport'],
    artifactRefs: ['src/mcp/stdio-protocol.mjs'],
    risks: ['None identified'],
    suggestedSkills: ['javascript', 'mcp'],
    acknowledgements: ['commit:abc123']
  };
  const handoffRes = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'ugk_work_handoff',
        arguments: handoffPayload
      }
    },
    { handlers }
  );
  assert.strictEqual(handoffRes.id, 14);
  assert.strictEqual(callCounts.handoff, 1);
  assert.deepEqual(receivedArgs.handoff, handoffPayload);
  assert.deepEqual(JSON.parse(handoffRes.result.content[0].text), { recorded: true, outcome: 'completed' });

  const initPayload = {
    initCode: 'INIT-100',
    clientRequestId: 'req-init-1',
    currentTask: 'Continue the existing implementation',
    currentState: 'Core flow is half complete'
  };
  const initRes = await dispatchMessage({
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: { name: 'ugk_work_init', arguments: initPayload }
  }, { handlers });
  assert.strictEqual(initRes.id, 15);
  assert.strictEqual(callCounts.init, 1);
  assert.deepEqual(receivedArgs.init, initPayload);
});

test('dispatchMessage rejects disallowed parameters (path, projectId, worktreeId) and invalid inputs', async () => {
  let called = false;
  const handlers = {
    ugk_work_accept: async () => {
      called = true;
      return { ok: true };
    },
    ugk_work_begin: async () => {
      called = true;
      return { ok: true };
    },
    ugk_work_progress: async () => {
      called = true;
      return { ok: true };
    },
    ugk_work_submit: async () => {
      called = true;
      return { ok: true };
    },
    ugk_work_handoff: async () => {
      called = true;
      return { ok: true };
    },
    ugk_work_init: async () => {
      called = true;
      return { ok: true };
    }
  };

  // Try injecting path to ugk_work_accept
  const resWithPath = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'ugk_work_accept',
        arguments: {
          dispatchCode: 'CODE-1',
          clientRequestId: 'req-1',
          path: '/some/unauthorized/path'
        }
      }
    },
    { handlers }
  );
  assert.strictEqual(called, false);
  assert.strictEqual(resWithPath.result.isError, true);
  assert.match(resWithPath.result.content[0].text, /Forbidden property/);

  // Try injecting projectId
  const resWithProject = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'ugk_work_accept',
        arguments: {
          dispatchCode: 'CODE-1',
          clientRequestId: 'req-1',
          projectId: 'p1'
        }
      }
    },
    { handlers }
  );
  assert.strictEqual(called, false);
  assert.strictEqual(resWithProject.result.isError, true);
  assert.match(resWithProject.result.content[0].text, /Forbidden property/);

  // Try missing required field
  const resMissing = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: {
        name: 'ugk_work_accept',
        arguments: {
          dispatchCode: 'CODE-1'
        }
      }
    },
    { handlers }
  );
  assert.strictEqual(called, false);
  assert.strictEqual(resMissing.result.isError, true);
  assert.match(resMissing.result.content[0].text, /required field/);

  const terminalProgress = await dispatchMessage({
    jsonrpc: '2.0',
    id: 23,
    method: 'tools/call',
    params: {
      name: 'ugk_work_progress',
      arguments: {
        sessionId: 's1',
        clientRequestId: 'progress-terminal',
        expectedRevision: 2,
        status: 'completed',
        note: '任务完成',
      },
    },
  }, { handlers });
  assert.strictEqual(called, false);
  assert.strictEqual(terminalProgress.result.isError, true);
  assert.match(terminalProgress.result.content[0].text, /finish or handoff/);

  const progressNoSummaryNoNote = await dispatchMessage({
    jsonrpc: '2.0',
    id: 231,
    method: 'tools/call',
    params: {
      name: 'ugk_work_progress',
      arguments: {
        sessionId: 's1',
        clientRequestId: 'progress-empty',
        expectedRevision: 2,
        status: 'working',
      },
    },
  }, { handlers });
  assert.strictEqual(progressNoSummaryNoNote.result.isError, true);
  assert.match(progressNoSummaryNoNote.result.content[0].text, /at least one of summary or note/i);

  const progressEmptySummary = await dispatchMessage({
    jsonrpc: '2.0',
    id: 232,
    method: 'tools/call',
    params: {
      name: 'ugk_work_progress',
      arguments: {
        sessionId: 's1',
        clientRequestId: 'progress-empty-summary',
        expectedRevision: 2,
        status: 'working',
        summary: '   ',
      },
    },
  }, { handlers });
  assert.strictEqual(progressEmptySummary.result.isError, true);
  assert.match(progressEmptySummary.result.content[0].text, /summary/i);

  const progressEmptyDetailsItem = await dispatchMessage({
    jsonrpc: '2.0',
    id: 233,
    method: 'tools/call',
    params: {
      name: 'ugk_work_progress',
      arguments: {
        sessionId: 's1',
        clientRequestId: 'progress-empty-detail',
        expectedRevision: 2,
        status: 'working',
        summary: 'Valid summary',
        details: ['valid', '   '],
      },
    },
  }, { handlers });
  assert.strictEqual(progressEmptyDetailsItem.result.isError, true);
  assert.match(progressEmptyDetailsItem.result.content[0].text, /details/i);

  for (const field of ['path', 'projectId', 'worktreeId', 'token', 'branch', 'remote']) {
    const res = await dispatchMessage({
      jsonrpc: '2.0', id: `submit-disallowed-${field}`, method: 'tools/call',
      params: {
        name: 'ugk_work_submit',
        arguments: {
          sessionId: 's1', clientRequestId: 'submit-1', expectedRevision: 2,
          summary: '完成开发', [field]: 'spoofed-value',
        },
      },
    }, { handlers });
    assert.strictEqual(res.result.isError, true);
    assert.match(res.result.content[0].text, /Forbidden property|Unexpected property/i);
  }

  const integrationWithPath = await dispatchMessage({
    jsonrpc: '2.0', id: 'integration-path', method: 'tools/call',
    params: {
      name: 'ugk_integration_begin',
      arguments: {
        sessionId: 's1', clientRequestId: 'review-1', expectedRevision: 2,
        submissionId: 'sub-1', expectedSubmissionRevision: 0, path: 'E:\\forged',
      },
    },
  }, { handlers });
  assert.strictEqual(integrationWithPath.result.isError, true);
  assert.match(integrationWithPath.result.content[0].text, /Forbidden property/);

  for (const field of ['gitBranch', 'gitHead', 'gitCoherence', 'path', 'projectId', 'worktreeId']) {
    const res = await dispatchMessage({
      jsonrpc: '2.0',
      id: `progress-disallowed-${field}`,
      method: 'tools/call',
      params: {
        name: 'ugk_work_progress',
        arguments: {
          sessionId: 's1',
          clientRequestId: `req-${field}`,
          expectedRevision: 2,
          status: 'working',
          summary: 'Valid summary',
          [field]: 'spoofed-value',
        },
      },
    }, { handlers });
    assert.strictEqual(res.result.isError, true);
    assert.match(res.result.content[0].text, /Forbidden property|Unexpected property/i);
  }

  // ugk_work_begin with forbidden path
  const beginForbiddenPath = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 25,
      method: 'tools/call',
      params: {
        name: 'ugk_work_begin',
        arguments: {
          sessionId: 's1',
          clientRequestId: 'cr1',
          expectedRevision: 1,
          task: 'do task',
          path: '/some/path'
        }
      }
    },
    { handlers }
  );
  assert.strictEqual(called, false);
  assert.strictEqual(beginForbiddenPath.result.isError, true);
  assert.match(beginForbiddenPath.result.content[0].text, /Forbidden property/);

  // ugk_work_begin with invalid revision (0)
  const beginInvalidRev = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 26,
      method: 'tools/call',
      params: {
        name: 'ugk_work_begin',
        arguments: {
          sessionId: 's1',
          clientRequestId: 'cr1',
          expectedRevision: 0,
          task: 'do task'
        }
      }
    },
    { handlers }
  );
  assert.strictEqual(called, false);
  assert.strictEqual(beginInvalidRev.result.isError, true);
  assert.match(beginInvalidRev.result.content[0].text, /expectedRevision/);

  // ugk_work_handoff with forbidden worktreeId
  const handoffForbidden = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 27,
      method: 'tools/call',
      params: {
        name: 'ugk_work_handoff',
        arguments: {
          sessionId: 's1',
          clientRequestId: 'cr1',
          expectedRevision: 1,
          outcome: 'completed',
          nextSessionFocus: 'focus',
          summary: 'sum',
          currentState: 'state',
          completedItems: [],
          pendingItems: [],
          decisions: [],
          artifactRefs: [],
          risks: [],
          suggestedSkills: [],
          worktreeId: 'wt-123'
        }
      }
    },
    { handlers }
  );
  assert.strictEqual(called, false);
  assert.strictEqual(handoffForbidden.result.isError, true);
  assert.match(handoffForbidden.result.content[0].text, /Forbidden property/);

  // ugk_work_handoff with invalid outcome
  const handoffInvalidOutcome = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 28,
      method: 'tools/call',
      params: {
        name: 'ugk_work_handoff',
        arguments: {
          sessionId: 's1',
          clientRequestId: 'cr1',
          expectedRevision: 1,
          outcome: 'unknown_outcome',
          nextSessionFocus: 'focus',
          summary: 'sum',
          currentState: 'state',
          completedItems: [],
          pendingItems: [],
          decisions: [],
          artifactRefs: [],
          risks: [],
          suggestedSkills: []
        }
      }
    },
    { handlers }
  );
  assert.strictEqual(called, false);
  assert.strictEqual(handoffInvalidOutcome.result.isError, true);
  assert.match(handoffInvalidOutcome.result.content[0].text, /outcome/);

  // ugk_work_handoff with non-string array elements
  const handoffNonStringArray = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 29,
      method: 'tools/call',
      params: {
        name: 'ugk_work_handoff',
        arguments: {
          sessionId: 's1',
          clientRequestId: 'cr1',
          expectedRevision: 1,
          outcome: 'completed',
          nextSessionFocus: 'focus',
          summary: 'sum',
          currentState: 'state',
          completedItems: ['valid', 12345],
          pendingItems: [],
          decisions: [],
          artifactRefs: [],
          risks: [],
          suggestedSkills: []
        }
      }
    },
    { handlers }
  );
  assert.strictEqual(called, false);
  assert.strictEqual(handoffNonStringArray.result.isError, true);
  assert.match(handoffNonStringArray.result.content[0].text, /completedItems/);

  // ugk_work_handoff with non-array value for list field
  const handoffNotArray = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: {
        name: 'ugk_work_handoff',
        arguments: {
          sessionId: 's1',
          clientRequestId: 'cr1',
          expectedRevision: 1,
          outcome: 'completed',
          nextSessionFocus: 'focus',
          summary: 'sum',
          currentState: 'state',
          completedItems: [],
          pendingItems: 'not an array',
          decisions: [],
          artifactRefs: [],
          risks: [],
          suggestedSkills: []
        }
      }
    },
    { handlers }
  );
  assert.strictEqual(called, false);
  assert.strictEqual(handoffNotArray.result.isError, true);
  assert.match(handoffNotArray.result.content[0].text, /pendingItems/);

  // Try unknown tool
  const resUnknownTool = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'unknown_tool',
        arguments: {}
      }
    },
    { handlers }
  );
  assert.strictEqual(resUnknownTool.result.isError, true);
  assert.match(resUnknownTool.result.content[0].text, /Unknown tool/);

  // Try unknown method
  const resUnknownMethod = await dispatchMessage({
    jsonrpc: '2.0',
    id: 32,
    method: 'unknown/method'
  });
  assert.strictEqual(resUnknownMethod.error.code, -32601);
});

test('handles handler exceptions gracefully, logs to stderr, and isolates errors', async () => {
  let stderrOutput = '';
  const fakeStderr = {
    write: (chunk) => {
      stderrOutput += chunk;
    }
  };

  const handlers = {
    ugk_work_accept: async () => {
      throw new Error('Database locked simulation');
    }
  };

  const res = await dispatchMessage(
    {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: {
        name: 'ugk_work_accept',
        arguments: {
          dispatchCode: 'CODE-ERR',
          clientRequestId: 'req-err'
        }
      }
    },
    { handlers, stderr: fakeStderr }
  );

  assert.strictEqual(res.id, 30);
  assert.strictEqual(res.result.isError, true);
  assert.match(res.result.content[0].text, /暂时无法完成/);
  assert.match(stderrOutput, /Database locked simulation/);
});

test('createMcpServer stdio protocol loop: verifies single-line JSON on stdout and stderr isolation', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  let stdoutBuffer = '';
  stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
  });

  let stderrBuffer = '';
  stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString('utf8');
  });

  const handlers = {
    ugk_work_accept: async (args) => ({ accepted: true, dispatchCode: args.dispatchCode }),
    ugk_work_progress: async () => ({ progress: true }),
    ugk_work_finish: async () => {
      throw new Error('Boom in finish handler');
    }
  };

  const server = createMcpServer({ stdin, stdout, stderr, handlers });
  assert.ok(server);
  assert.ok(typeof createMcpStdioServer === 'function');

  // Send a sequence of messages into stdin:
  // 1. empty line (should be ignored)
  // 2. valid initialize
  // 3. notifications/initialized (should produce no output)
  // 4. malformed JSON (should produce parse error on stdout and diagnostic on stderr)
  // 5. valid tools/call accept
  // 6. valid tools/call finish that throws (should produce error response on stdout and diagnostic on stderr)
  // 7. invalid non-object JSON (should produce Invalid Request error)
  const inputs = [
    '',
    JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'initialize' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    '{ malformed json line',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 102,
      method: 'tools/call',
      params: {
        name: 'ugk_work_accept',
        arguments: { dispatchCode: 'D-123', clientRequestId: 'CR-123' }
      }
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 103,
      method: 'tools/call',
      params: {
        name: 'ugk_work_finish',
        arguments: {
          sessionId: 's-1',
          clientRequestId: 'CR-124',
          expectedRevision: 1,
          outcome: 'blocked',
          summary: 'test fail',
          nextStep: 'retry'
        }
      }
    }),
    '12345'
  ];

  for (const line of inputs) {
    stdin.write(`${line}\n`);
  }

  // Allow async events to settle
  await new Promise((resolve) => setTimeout(resolve, 50));
  server.close();

  // Validate stdout lines:
  const lines = stdoutBuffer.split('\n').filter((l) => l.trim().length > 0);
  assert.strictEqual(lines.length, 5, 'Should have exactly 5 responses (empty line & notification skipped)');

  for (const line of lines) {
    // Each line must be a single line (no internal newlines) and parse as valid JSON
    assert.strictEqual(line.includes('\r'), false);
    const parsed = JSON.parse(line);
    assert.strictEqual(parsed.jsonrpc, '2.0');
    assert.ok('id' in parsed);
  }

  const r1 = JSON.parse(lines[0]);
  assert.strictEqual(r1.id, 101);
  assert.strictEqual(r1.result.serverInfo.name, 'ugk-cockpit');

  const r2 = JSON.parse(lines[1]);
  assert.strictEqual(r2.id, null);
  assert.strictEqual(r2.error.code, -32700);

  const r3 = JSON.parse(lines[2]);
  assert.strictEqual(r3.id, 102);
  assert.deepEqual(JSON.parse(r3.result.content[0].text), { accepted: true, dispatchCode: 'D-123' });

  const r4 = JSON.parse(lines[3]);
  assert.strictEqual(r4.id, 103);
  assert.strictEqual(r4.result.isError, true);
  assert.match(r4.result.content[0].text, /暂时无法完成/);

  const r5 = JSON.parse(lines[4]);
  assert.strictEqual(r5.id, null);
  assert.strictEqual(r5.error.code, -32600);

  // Verify stderr received diagnostics
  assert.match(stderrBuffer, /JSON parse error/);
  assert.match(stderrBuffer, /Boom in finish handler/);
});

test('mocked HTTP -> createServiceHandlers -> dispatchMessage for submission revision conflict exposes safe JSON recovery fields', async () => {
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => new Response(JSON.stringify({
      code: 'SUBMISSION_REVISION_CONFLICT',
      message: '审核事项刚刚发生了变化。',
      impact: '旧请求没有覆盖最新审核状态，也没有执行合并。',
      required_action: '请使用工具返回的最新 revision 重新确认。',
      sessionId: 'sess-100',
      submissionId: 'sub-test-1',
      currentSubmissionRevision: 4,
      currentRevision: 4,
      token: 'leaked-token-123',
      path: '/secret/path',
      unknown_secret: 'do-not-surface',
      nested_data: { private: true },
    }), { status: 409, headers: { 'content-type': 'application/json' } }),
  });

  const response = await dispatchMessage({
    jsonrpc: '2.0',
    id: 201,
    method: 'tools/call',
    params: {
      name: 'ugk_integration_begin',
      arguments: {
        sessionId: 'sess-100',
        clientRequestId: 'req-conflict-1',
        expectedRevision: 2,
        submissionId: 'sub-test-1',
        expectedSubmissionRevision: 2,
      },
    },
  }, { handlers });

  assert.equal(response.id, 201);
  assert.equal(response.result.isError, true);
  assert.ok(Array.isArray(response.result.content));
  assert.equal(response.result.content[0].type, 'text');

  const parsed = JSON.parse(response.result.content[0].text);
  assert.equal(parsed.code, 'SUBMISSION_REVISION_CONFLICT');
  assert.equal(parsed.currentSubmissionRevision, 4);
  assert.equal(parsed.required_action, '请使用工具返回的最新 revision 重新确认。');
  assert.equal(parsed.message, '审核事项刚刚发生了变化。');
  assert.equal(parsed.impact, '旧请求没有覆盖最新审核状态，也没有执行合并。');
  assert.equal(parsed.submissionId, 'sub-test-1');
  assert.equal(parsed.sessionId, 'sess-100');
  assert.equal(parsed.token, undefined);
  assert.equal(parsed.path, undefined);
  assert.equal(parsed.unknown_secret, undefined);
  assert.equal(parsed.nested_data, undefined);
  assert.equal(response.result.content[0].text.includes('leaked'), false);
  assert.equal(response.result.content[0].text.includes('do-not-surface'), false);
});

test('mocked HTTP -> createServiceHandlers -> dispatchMessage for integration push failure presents isError:true with safe JSON', async () => {
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      code: 'INTEGRATION_PUSH_FAILED',
      message: '功能已经安全接入本地主项目，但尚未推送到远端。',
      impact: '本地主项目的新保存点保持完整；平台没有回退或重写历史。',
      required_action: '请检查网络或远端权限后，用完全相同的合并请求重试。',
      sessionId: 'sess-100',
      submissionId: 'sub-test-1',
      claimId: 'claim-test-1',
      localIntegrated: true,
      pushed: false,
      retryable: true,
      integratedCommit: 'commit-sha-safe-evidence',
      token: 'leak-token',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });

  const response = await dispatchMessage({
    jsonrpc: '2.0',
    id: 202,
    method: 'tools/call',
    params: {
      name: 'ugk_integration_merge',
      arguments: {
        sessionId: 'sess-100',
        clientRequestId: 'req-merge-1',
        expectedRevision: 2,
        submissionId: 'sub-test-1',
        claimId: 'claim-test-1',
        expectedSubmissionRevision: 2,
        expectedClaimRevision: 1,
        summary: 'merge attempt',
      },
    },
  }, { handlers });

  assert.equal(response.id, 202);
  assert.equal(response.result.isError, true);
  const parsed = JSON.parse(response.result.content[0].text);
  assert.equal(parsed.code, 'INTEGRATION_PUSH_FAILED');
  assert.equal(parsed.localIntegrated, true);
  assert.equal(parsed.pushed, false);
  assert.equal(parsed.retryable, true);
  assert.equal(parsed.token, undefined);
  assert.equal(parsed.integratedCommit, 'commit-sha-safe-evidence');
  assert.equal(parsed.required_action, '请检查网络或远端权限后，用完全相同的合并请求重试。');
});

test('mocked HTTP -> createServiceHandlers -> dispatchMessage passes through server-provided non-expiring claim guidance', async () => {
  const serverGuidance = '请回到项目页查看当前审核者；如需更换审核者，请由当前会话或用户明确撤回后再领取。';
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => new Response(JSON.stringify({
      code: 'SUBMISSION_ALREADY_CLAIMED',
      message: '这个功能已经由另一条主项目会话领取审核。',
      impact: '没有启动第二次审核，也没有修改代码。',
      required_action: serverGuidance,
      sessionId: 'sess-100',
      submissionId: 'sub-test-1',
    }), { status: 409, headers: { 'content-type': 'application/json' } }),
  });

  const response = await dispatchMessage({
    jsonrpc: '2.0',
    id: 206,
    method: 'tools/call',
    params: {
      name: 'ugk_integration_begin',
      arguments: {
        sessionId: 'sess-100',
        clientRequestId: 'req-claimed-1',
        expectedRevision: 2,
        submissionId: 'sub-test-1',
        expectedSubmissionRevision: 0,
      },
    },
  }, { handlers });

  assert.equal(response.id, 206);
  assert.equal(response.result.isError, true);
  const parsed = JSON.parse(response.result.content[0].text);
  assert.equal(parsed.code, 'SUBMISSION_ALREADY_CLAIMED');
  assert.equal(parsed.required_action, serverGuidance);
  assert.doesNotMatch(parsed.required_action, /过期后/);
  assert.equal(parsed.message, '这个功能已经由另一条主项目会话领取审核。');
  assert.equal(parsed.impact, '没有启动第二次审核，也没有修改代码。');
});

test('mocked HTTP -> createServiceHandlers -> dispatchMessage on malformed or lost HTTP 200 JSON returns isError:true uncertain outcome', async () => {
  // 1. Malformed JSON on HTTP 200
  const malformedHandlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => new Response('{"truncated', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const malformedRes = await dispatchMessage({
    jsonrpc: '2.0',
    id: 207,
    method: 'tools/call',
    params: {
      name: 'ugk_integration_begin',
      arguments: {
        sessionId: 'sess-100',
        clientRequestId: 'req-malformed-json',
        expectedRevision: 2,
        submissionId: 'sub-test-1',
        expectedSubmissionRevision: 0,
      },
    },
  }, { handlers: malformedHandlers });

  assert.equal(malformedRes.id, 207);
  assert.equal(malformedRes.result.isError, true);
  const parsedMalformed = JSON.parse(malformedRes.result.content[0].text);
  assert.equal(parsedMalformed.code, 'SERVICE_UNAVAILABLE');
  assert.equal(parsedMalformed.retryable, true);
  assert.match(parsedMalformed.message, /完全相同的 clientRequestId.*重试|不要创建新/i);
  assert.equal(parsedMalformed.required_action, '请使用完全相同的 clientRequestId 和参数重试，不要创建新的请求编号。');
  assert.equal(parsedMalformed.sessionId, 'sess-100');
  assert.equal(parsedMalformed.submissionId, 'sub-test-1');

  // 2. Lost HTTP 200 JSON (e.g. empty body {})
  const lostHandlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const lostRes = await dispatchMessage({
    jsonrpc: '2.0',
    id: 208,
    method: 'tools/call',
    params: {
      name: 'ugk_integration_merge',
      arguments: {
        sessionId: 'sess-100',
        clientRequestId: 'req-lost-body',
        expectedRevision: 2,
        submissionId: 'sub-test-1',
        claimId: 'claim-test-1',
        expectedSubmissionRevision: 2,
        expectedClaimRevision: 1,
        summary: 'merge lost attempt',
      },
    },
  }, { handlers: lostHandlers });

  assert.equal(lostRes.id, 208);
  assert.equal(lostRes.result.isError, true);
  const parsedLost = JSON.parse(lostRes.result.content[0].text);
  assert.equal(parsedLost.code, 'SERVICE_UNAVAILABLE');
  assert.equal(parsedLost.retryable, true);
  assert.match(parsedLost.message, /完全相同的 clientRequestId.*重试|不要创建新/i);
  assert.equal(parsedLost.required_action, '请使用完全相同的 clientRequestId 和参数重试，不要创建新的请求编号。');
  assert.equal(parsedLost.sessionId, 'sess-100');
  assert.equal(parsedLost.submissionId, 'sub-test-1');
  assert.equal(parsedLost.claimId, 'claim-test-1');
});

test('mocked HTTP -> createServiceHandlers -> dispatchMessage on integration transport failure presents safe retry instruction without claiming no state update', async () => {
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => {
      throw new Error('ETIMEDOUT');
    },
  });

  const response = await dispatchMessage({
    jsonrpc: '2.0',
    id: 203,
    method: 'tools/call',
    params: {
      name: 'ugk_integration_review',
      arguments: {
        sessionId: 'sess-100',
        clientRequestId: 'req-review-timeout',
        expectedRevision: 2,
        submissionId: 'sub-test-1',
        claimId: 'claim-test-1',
        expectedClaimRevision: 0,
        verdict: 'approved',
        summary: 'Review approved',
        findings: [],
        checks: ['all checks passed'],
      },
    },
  }, { handlers });

  assert.equal(response.id, 203);
  assert.equal(response.result.isError, true);
  const parsed = JSON.parse(response.result.content[0].text);
  assert.equal(parsed.code, 'SERVICE_UNAVAILABLE');
  assert.equal(parsed.retryable, true);
  assert.match(parsed.message, /完全相同的 clientRequestId.*重试|不要创建新/i);
  assert.doesNotMatch(parsed.message, /没有更新/);
  assert.equal(parsed.required_action, '请使用完全相同的 clientRequestId 和参数重试，不要创建新的请求编号。');
});

test('dispatchMessage keeps generic/unexpected failures safe for integration tools and compatible for other tools', async () => {
  let stderrOutput = '';
  const fakeStderr = {
    write: (chunk) => {
      stderrOutput += chunk;
    },
  };

  const handlers = {
    ugk_integration_begin: async () => {
      throw new TypeError('Cannot read property undefined of crash');
    },
    ugk_work_accept: async () => {
      throw new Error('Accept custom failure');
    },
  };

  // Integration tool with generic crash: should return safe JSON, no TypeError leakage
  const resIntegration = await dispatchMessage({
    jsonrpc: '2.0',
    id: 204,
    method: 'tools/call',
    params: {
      name: 'ugk_integration_begin',
      arguments: {
        sessionId: 'sess-100',
        clientRequestId: 'req-generic-fail',
        expectedRevision: 2,
        submissionId: 'sub-test-1',
        expectedSubmissionRevision: 0,
      },
    },
  }, { handlers, stderr: fakeStderr });

  assert.equal(resIntegration.id, 204);
  assert.equal(resIntegration.result.isError, true);
  const parsed = JSON.parse(resIntegration.result.content[0].text);
  assert.equal(parsed.code, 'REQUEST_FAILED');
  assert.equal(resIntegration.result.content[0].text.includes('Cannot read property'), false);
  assert.match(stderrOutput, /Cannot read property undefined of crash/);

  // Non-integration tool: should return plain string public message (compatible)
  const resAccept = await dispatchMessage({
    jsonrpc: '2.0',
    id: 205,
    method: 'tools/call',
    params: {
      name: 'ugk_work_accept',
      arguments: {
        dispatchCode: 'DISPATCH-1',
        clientRequestId: 'req-accept-fail',
      },
    },
  }, { handlers, stderr: fakeStderr });

  assert.equal(resAccept.id, 205);
  assert.equal(resAccept.result.isError, true);
  assert.match(resAccept.result.content[0].text, /暂时无法完成/);
});

test('dispatchMessage formats submit-note errors as safe structured JSON with noteId and revision fields', async () => {
  const handlers = {
    ugk_submit_note_update: async (args) => {
      if (args.noteId === 'note-conflict') {
        const error = new Error('Revision conflict');
        error.isIntegrationError = true;
        error.integrationPayload = {
          code: 'NOTE_REVISION_CONFLICT',
          message: 'Note revision conflict',
          noteId: 'note-conflict',
          currentRevision: 4,
          expectedRevision: 3,
        };
        throw error;
      }
      if (args.noteId === 'note-transport') {
        const error = new Error('Transport error');
        error.isIntegrationError = true;
        error.integrationPayload = {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service unavailable',
          noteId: 'note-transport',
          retryable: true,
        };
        throw error;
      }
      return { ok: true };
    },
  };

  // Conflict test
  const resConflict = await dispatchMessage({
    jsonrpc: '2.0',
    id: 301,
    method: 'tools/call',
    params: {
      name: 'ugk_submit_note_update',
      arguments: {
        noteId: 'note-conflict',
        clientRequestId: 'req-301',
        expectedRevision: 3,
        status: 'handled',
      },
    },
  }, { handlers });

  assert.equal(resConflict.id, 301);
  assert.equal(resConflict.result.isError, true);
  const payloadConflict = JSON.parse(resConflict.result.content[0].text);
  assert.equal(payloadConflict.code, 'NOTE_REVISION_CONFLICT');
  assert.equal(payloadConflict.noteId, 'note-conflict');
  assert.equal(payloadConflict.currentRevision, 4);
  assert.equal(payloadConflict.expectedRevision, 3);

  // Transport test
  const resTransport = await dispatchMessage({
    jsonrpc: '2.0',
    id: 302,
    method: 'tools/call',
    params: {
      name: 'ugk_submit_note_update',
      arguments: {
        noteId: 'note-transport',
        clientRequestId: 'req-302',
        expectedRevision: 1,
        status: 'archived',
      },
    },
  }, { handlers });

  assert.equal(resTransport.id, 302);
  assert.equal(resTransport.result.isError, true);
  const payloadTransport = JSON.parse(resTransport.result.content[0].text);
  assert.equal(payloadTransport.code, 'SERVICE_UNAVAILABLE');
  assert.equal(payloadTransport.noteId, 'note-transport');
  assert.equal(payloadTransport.retryable, true);
});
