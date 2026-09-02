import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  TOOLS,
  createMcpServer,
  createMcpStdioServer,
  dispatchMessage
} from '../src/mcp/stdio-protocol.mjs';

test('TOOLS definition contains the required 9 tools and no path/projectId/worktreeId/token', () => {
  const toolNames = TOOLS.map((t) => t.name);
  assert.deepEqual(toolNames, [
    'ugk_work_accept',
    'ugk_work_progress',
    'ugk_work_submit',
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
  const callCounts = { accept: 0, progress: 0, submit: 0, finish: 0, handoff: 0, begin: 0, init: 0 };
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
    sessionId: 'sess-100',
    clientRequestId: 'req-submit-1',
    expectedRevision: 2,
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
