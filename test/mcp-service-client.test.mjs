import assert from 'node:assert/strict';
import test from 'node:test';
import { createServiceHandlers } from '../src/mcp/service-client.mjs';

test('MCP service handlers forward only tool arguments with the local bearer token', async () => {
  const calls = [];
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    workingDirectory: 'E:\\fixture\\active-project',
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return new Response(JSON.stringify({ ok: true, sessionId: 'session-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const arguments_ = { dispatchCode: 'dispatch', clientRequestId: 'request-1' };
  assert.equal((await handlers.ugk_work_accept(arguments_)).sessionId, 'session-1');
  assert.equal(calls[0].url, 'http://127.0.0.1:41737/api/v1/mcp/work/accept');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${'x'.repeat(32)}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), arguments_);

  await handlers.ugk_work_begin({
    sessionId: 'session-1', clientRequestId: 'request-2', expectedRevision: 1, task: '开始工作',
  });
  assert.equal(calls[1].url, 'http://127.0.0.1:41737/api/v1/mcp/work/begin');

  const submitArguments = {
    preflightId: 'preflight-1', clientRequestId: 'request-submit',
    summary: '完成开发空间功能',
  };
  await handlers.ugk_work_submit(submitArguments);
  assert.equal(calls[2].url, 'http://127.0.0.1:41737/api/v1/mcp/work/submit');
  assert.deepEqual(JSON.parse(calls[2].options.body), { ...submitArguments, mcpWorkingDirectory: 'E:\\fixture\\active-project' });

  await handlers.ugk_work_handoff({
    sessionId: 'session-1', clientRequestId: 'request-3', expectedRevision: 1,
    outcome: 'completed', nextSessionFocus: '等待安排', summary: 'done',
    currentState: 'clean', completedItems: [], pendingItems: [], decisions: [],
    artifactRefs: [], risks: [], suggestedSkills: [],
  });
  assert.equal(calls[3].url, 'http://127.0.0.1:41737/api/v1/mcp/work/handoff');

  await handlers.ugk_work_init({
    initCode: 'init-code', clientRequestId: 'request-4',
    currentTask: '继续现有开发', currentState: '功能完成一半',
  });
  assert.equal(calls[4].url, 'http://127.0.0.1:41737/api/v1/mcp/work/init');
  assert.deepEqual(JSON.parse(calls[4].options.body), {
    initCode: 'init-code',
    clientRequestId: 'request-4',
    currentTask: '继续现有开发',
    currentState: '功能完成一半',
    mcpWorkingDirectory: 'E:\\fixture\\active-project',
  });

  await handlers.ugk_integration_begin({
    sessionId: 'session-1', clientRequestId: 'review-begin', expectedRevision: 2,
    submissionId: 'sub-1', expectedSubmissionRevision: 0,
  });
  assert.equal(calls[5].url, 'http://127.0.0.1:41737/api/v1/mcp/integration/begin');

  await handlers.ugk_integration_review({
    sessionId: 'session-1', clientRequestId: 'review-result', expectedRevision: 2,
    submissionId: 'sub-1', claimId: 'claim-1', expectedClaimRevision: 0,
    verdict: 'approved', summary: '通过', findings: [], checks: [],
  });
  assert.equal(calls[6].url, 'http://127.0.0.1:41737/api/v1/mcp/integration/review');

  await handlers.ugk_integration_merge({
    sessionId: 'session-1', clientRequestId: 'merge', expectedRevision: 2,
    submissionId: 'sub-1', claimId: 'claim-1', expectedSubmissionRevision: 2,
    expectedClaimRevision: 1, summary: '合入主项目',
  });
  assert.equal(calls[7].url, 'http://127.0.0.1:41737/api/v1/mcp/integration/merge');
});

test('MCP service errors expose the public service message without leaking response details', async () => {
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => new Response(JSON.stringify({
      code: 'DISPATCH_EXPIRED', message: '这次接手码已经过期。', secret: 'must-not-surface',
    }), { status: 409 }),
  });
  await assert.rejects(
    handlers.ugk_work_accept({ dispatchCode: 'old', clientRequestId: 'request-2' }),
    (error) => error.publicMessage === '这次接手码已经过期。' && !error.message.includes('secret'),
  );
});

test('MCP service handlers bootstrap a scoped local session when the API token is unavailable', async () => {
  const calls = [];
  const scopedToken = 'scoped-mcp-token-that-is-long-enough';
  const handlers = createServiceHandlers({
    token: null,
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      if (url.pathname === '/api/v1/mcp/session') {
        return new Response(JSON.stringify({ ok: true, token: scopedToken }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, revision: 3 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await handlers.ugk_work_progress({
    sessionId: 'session-1', clientRequestId: 'progress-1', expectedRevision: 2,
    status: 'working', note: '继续开发',
  });

  assert.equal(result.revision, 3);
  assert.equal(calls[0].url, 'http://127.0.0.1:41737/api/v1/mcp/session');
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[1].options.headers.authorization, `Bearer ${scopedToken}`);
});

test('MCP service handlers refresh an expired scoped session once', async () => {
  let bootstrapCount = 0;
  const calls = [];
  const handlers = createServiceHandlers({
    token: null,
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      if (url.pathname === '/api/v1/mcp/session') {
        bootstrapCount += 1;
        return new Response(JSON.stringify({
          ok: true,
          token: `scoped-token-${bootstrapCount}-${'x'.repeat(32)}`,
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (bootstrapCount === 1) {
        return new Response(JSON.stringify({ code: 'AUTH_REQUIRED' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, revision: 4 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await handlers.ugk_work_progress({
    sessionId: 'session-1', clientRequestId: 'progress-2', expectedRevision: 3,
    status: 'working', note: '刷新会话后继续',
  });

  assert.equal(result.revision, 4);
  assert.equal(bootstrapCount, 2);
  assert.equal(calls.length, 4);
  assert.notEqual(calls[1].options.headers.authorization, calls[3].options.headers.authorization);
});

test('MCP refreshes a replaced local credential and preserves relay payload and bridge binding', async () => {
  const oldToken = 'old-local-token-'.padEnd(40, 'x');
  const newToken = 'new-local-token-'.padEnd(40, 'y');
  const calls = [];
  let refreshes = 0;
  const session = { ok: true, sessionId: 'session-1', worktreeId: 'worktree-1', revision: 17, status: 'active' };
  const handlers = createServiceHandlers({
    token: oldToken,
    refreshToken: () => { refreshes += 1; return newToken; },
    workingDirectory: 'E:\\fixture\\active-project',
    fetchImpl: async (url, options) => {
      calls.push({ pathname: url.pathname, options });
      if (url.pathname.endsWith('/relay') && options.headers.authorization === `Bearer ${oldToken}`) {
        return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });
      }
      return Response.json(session);
    },
  });
  await handlers.ugk_work_resume({ continueCode: 'fixture-code', clientRequestId: 'resume-1' });
  const payload = { sessionId: 'session-1', expectedRevision: 17, clientRequestId: 'relay-1', summary: '接力' };
  await handlers.ugk_work_relay(payload);
  assert.equal(refreshes, 1);
  assert.equal(calls[1].options.headers.authorization, `Bearer ${oldToken}`);
  assert.equal(calls[2].options.headers.authorization, `Bearer ${newToken}`);
  assert.equal(calls[1].options.body, calls[2].options.body);
  assert.deepEqual(JSON.parse(calls[2].options.body), payload);
  await handlers.ugk_work_context({});
  assert.equal(calls[3].options.headers.authorization, `Bearer ${newToken}`);
  assert.equal(JSON.parse(calls[3].options.body).bridgeBinding.sessionId, 'session-1');
  assert.equal(calls.some((call) => call.pathname === '/api/v1/mcp/session'), false);
});

test('MCP does not downgrade a rejected local credential when refresh is unavailable or unchanged', async () => {
  const token = 'local-token-'.padEnd(40, 'x');
  for (const replacement of [null, '', token]) {
    let calls = 0;
    const handlers = createServiceHandlers({
      token,
      refreshToken: () => replacement,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ code: 'AUTH_REQUIRED', message: '身份已失效' }, { status: 401 });
      },
    });
    await assert.rejects(handlers.ugk_work_context({}), /AUTH_REQUIRED/);
    assert.equal(calls, 1);
  }
});

test('MCP retries a rejected replacement credential only once', async () => {
  let calls = 0;
  let refreshes = 0;
  const handlers = createServiceHandlers({
    token: 'old-token-'.padEnd(40, 'x'),
    refreshToken: () => { refreshes += 1; return 'new-token-'.padEnd(40, 'y'); },
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });
    },
  });
  await assert.rejects(handlers.ugk_work_context({}), /AUTH_REQUIRED/);
  assert.equal(refreshes, 1);
  assert.equal(calls, 2);
});

test('integration service handlers preserve typed allowlist on failed HTTP response and drop secrets', async () => {
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => new Response(JSON.stringify({
      code: 'SUBMISSION_REVISION_CONFLICT',
      message: '审核事项刚刚发生了变化。',
      impact: '旧请求没有覆盖最新审核状态，也没有执行合并。',
      required_action: '请使用工具返回的最新 revision 重新确认。',
      sessionId: 'session-1',
      submissionId: 'sub-1',
      currentSubmissionRevision: 3,
      currentRevision: 3,
      status: 'pending',
      retryable: false,
      token: 'leaked-token-value-12345',
      path: '/leaked/filesystem/path',
      raw_exception: 'TypeError: boom',
      nested: { secret: 'unknown' },
    }), { status: 409, headers: { 'content-type': 'application/json' } }),
  });

  await assert.rejects(
    handlers.ugk_integration_begin({
      sessionId: 'session-1',
      clientRequestId: 'req-begin',
      expectedRevision: 2,
      submissionId: 'sub-1',
      expectedSubmissionRevision: 1,
    }),
    (error) => {
      assert.equal(error.code, 'SUBMISSION_REVISION_CONFLICT');
      assert.equal(error.message, '审核事项刚刚发生了变化。');
      assert.equal(error.publicMessage, '审核事项刚刚发生了变化。');
      assert.equal(error.impact, '旧请求没有覆盖最新审核状态，也没有执行合并。');
      assert.equal(error.required_action, '请使用工具返回的最新 revision 重新确认。');
      assert.equal(error.sessionId, 'session-1');
      assert.equal(error.submissionId, 'sub-1');
      assert.equal(error.currentSubmissionRevision, 3);
      assert.equal(error.currentRevision, 3);
      assert.equal(error.status, 'pending');
      assert.equal(error.retryable, false);
      assert.equal(error.token, undefined);
      assert.equal(error.path, undefined);
      assert.equal(error.raw_exception, undefined);
      assert.equal(error.nested, undefined);
      assert.equal(error.secret, undefined);
      return true;
    },
  );
});

test('integration service handlers reject HTTP 200 {ok:false} and push failures with typed fields', async () => {
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      code: 'INTEGRATION_PUSH_FAILED',
      message: '功能已经安全接入本地主项目，但尚未推送到远端。',
      impact: '本地主项目的新保存点保持完整；平台没有回退或重写历史。',
      required_action: '请检查网络或远端权限后，用完全相同的合并请求重试。',
      sessionId: 'session-1',
      submissionId: 'sub-1',
      claimId: 'claim-1',
      localIntegrated: true,
      pushed: false,
      retryable: true,
      integratedCommit: 'commit-sha-safe-evidence',
      token: 'do-not-leak-token',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });

  await assert.rejects(
    handlers.ugk_integration_merge({
      sessionId: 'session-1',
      clientRequestId: 'req-merge',
      expectedRevision: 2,
      submissionId: 'sub-1',
      claimId: 'claim-1',
      expectedSubmissionRevision: 2,
      expectedClaimRevision: 1,
      summary: 'merge',
    }),
    (error) => {
      assert.equal(error.code, 'INTEGRATION_PUSH_FAILED');
      assert.equal(error.localIntegrated, true);
      assert.equal(error.pushed, false);
      assert.equal(error.retryable, true);
      assert.equal(error.integratedCommit, 'commit-sha-safe-evidence');
      assert.equal(error.token, undefined);
      assert.equal(error.required_action, '请检查网络或远端权限后，用完全相同的合并请求重试。');
      return true;
    },
  );
});

test('integration service handlers pass through server-provided non-expiring claim guidance without duplicate client wording', async () => {
  const serverGuidance = '请回到项目页查看当前审核者；如需更换审核者，请由当前会话或用户明确撤回后再领取。';
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => new Response(JSON.stringify({
      code: 'SUBMISSION_ALREADY_CLAIMED',
      message: '这个功能已经由另一条主项目会话领取审核。',
      impact: '没有启动第二次审核，也没有修改代码。',
      required_action: serverGuidance,
      sessionId: 'session-1',
      submissionId: 'sub-1',
      status: 'claimed',
    }), { status: 409, headers: { 'content-type': 'application/json' } }),
  });

  await assert.rejects(
    handlers.ugk_integration_begin({
      sessionId: 'session-1',
      clientRequestId: 'req-begin-claimed',
      expectedRevision: 2,
      submissionId: 'sub-1',
      expectedSubmissionRevision: 0,
    }),
    (error) => {
      assert.equal(error.code, 'SUBMISSION_ALREADY_CLAIMED');
      assert.equal(error.required_action, serverGuidance);
      assert.doesNotMatch(error.required_action, /过期后/);
      assert.equal(error.message, '这个功能已经由另一条主项目会话领取审核。');
      assert.equal(error.impact, '没有启动第二次审核，也没有修改代码。');
      return true;
    },
  );
});

test('integration service handlers treat truncated or lost HTTP 200 body as uncertain outcome', async () => {
  const truncatedHandlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => new Response('{"ok": true, "truncated', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(
    truncatedHandlers.ugk_integration_begin({
      sessionId: 'session-1',
      clientRequestId: 'req-trunc',
      expectedRevision: 2,
      submissionId: 'sub-1',
      expectedSubmissionRevision: 0,
    }),
    (error) => {
      assert.equal(error.code, 'SERVICE_UNAVAILABLE');
      assert.equal(error.retryable, true);
      assert.match(error.required_action, /完全相同的 clientRequestId/);
      return true;
    },
  );

  const lostHandlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(
    lostHandlers.ugk_integration_merge({
      sessionId: 'session-1',
      clientRequestId: 'req-lost',
      expectedRevision: 2,
      submissionId: 'sub-1',
      claimId: 'claim-1',
      expectedSubmissionRevision: 2,
      expectedClaimRevision: 1,
      summary: 'merge',
    }),
    (error) => {
      assert.equal(error.code, 'SERVICE_UNAVAILABLE');
      assert.equal(error.retryable, true);
      assert.match(error.required_action, /完全相同的 clientRequestId/);
      return true;
    },
  );
});

test('integration service handlers provide safe retry instruction without claiming no state update on transport failure', async () => {
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => {
      throw new Error('Connection reset by peer');
    },
  });

  await assert.rejects(
    handlers.ugk_integration_review({
      sessionId: 'session-1',
      clientRequestId: 'req-review',
      expectedRevision: 2,
      submissionId: 'sub-1',
      claimId: 'claim-1',
      expectedClaimRevision: 0,
      verdict: 'approved',
      summary: 'LGTM',
      findings: [],
      checks: [],
    }),
    (error) => {
      assert.equal(error.code, 'SERVICE_UNAVAILABLE');
      assert.equal(error.retryable, true);
      assert.match(error.publicMessage, /完全相同的 clientRequestId.*重试|不要创建新/i);
      assert.doesNotMatch(error.publicMessage, /没有更新/);
      assert.equal(error.required_action, '请使用完全相同的 clientRequestId 和参数重试，不要创建新的请求编号。');
      return true;
    },
  );
});

test('MCP submit-note handlers forward arguments and cwd without establishing new binding', async () => {
  const calls = [];
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    workingDirectory: 'E:\\fixture\\submit-notes-project',
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return new Response(JSON.stringify({
        ok: true,
        noteId: 'note_123',
        status: 'pending',
        revision: 1,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const noteArgs = {
    clientRequestId: 'note-req-1',
    body: 'Audit main matches, reviewing PR 123',
    title: 'Audit note',
    references: [{ type: 'pull_request', target: '#123', commit: 'abcdef' }],
  };
  const submitResult = await handlers.ugk_work_submit_note(noteArgs);
  assert.equal(submitResult.noteId, 'note_123');
  assert.equal(calls[0].url, 'http://127.0.0.1:41737/api/v1/mcp/work/submit-note');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${'x'.repeat(32)}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    ...noteArgs,
    mcpWorkingDirectory: 'E:\\fixture\\submit-notes-project',
  });

  const getArgs = { noteId: 'note_123' };
  await handlers.ugk_submit_note_get(getArgs);
  assert.equal(calls[1].url, 'http://127.0.0.1:41737/api/v1/mcp/submit-notes/get');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    ...getArgs,
    mcpWorkingDirectory: 'E:\\fixture\\submit-notes-project',
  });

  const updateArgs = {
    noteId: 'note_123',
    clientRequestId: 'update-req-1',
    expectedRevision: 1,
    status: 'handled',
    handlingNote: 'reviewed and verified',
  };
  await handlers.ugk_submit_note_update(updateArgs);
  assert.equal(calls[2].url, 'http://127.0.0.1:41737/api/v1/mcp/submit-notes/update');
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    ...updateArgs,
    mcpWorkingDirectory: 'E:\\fixture\\submit-notes-project',
  });
});

test('MCP submit-note handlers preserve noteId, currentRevision, and expectedRevision on error and transport failure', async () => {
  // 1. Conflict error preserves noteId, currentRevision, expectedRevision
  const conflictHandlers = createServiceHandlers({
    token: 'x'.repeat(32),
    workingDirectory: 'E:\\fixture\\submit-notes-project',
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      code: 'NOTE_REVISION_CONFLICT',
      message: 'Revision conflict',
      noteId: 'note_conflict_1',
      currentRevision: 3,
      expectedRevision: 2,
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(
    conflictHandlers.ugk_submit_note_update({
      noteId: 'note_conflict_1',
      clientRequestId: 'req-conflict',
      expectedRevision: 2,
      status: 'handled',
    }),
    (err) => {
      assert.equal(err.code, 'NOTE_REVISION_CONFLICT');
      assert.equal(err.integrationPayload?.noteId, 'note_conflict_1');
      assert.equal(err.integrationPayload?.currentRevision, 3);
      assert.equal(err.integrationPayload?.expectedRevision, 2);
      return true;
    },
  );

  // 2. Transport failure preserves noteId and sets retryable: true
  const transportHandlers = createServiceHandlers({
    token: 'x'.repeat(32),
    workingDirectory: 'E:\\fixture\\submit-notes-project',
    fetchImpl: async () => {
      throw new Error('fetch failed: network down');
    },
  });

  await assert.rejects(
    transportHandlers.ugk_submit_note_update({
      noteId: 'note_transport_1',
      clientRequestId: 'req-transport',
      expectedRevision: 1,
      status: 'handled',
    }),
    (err) => {
      assert.equal(err.code, 'SERVICE_UNAVAILABLE');
      assert.equal(err.integrationPayload?.noteId, 'note_transport_1');
      assert.equal(err.integrationPayload?.retryable, true);
      return true;
    },
  );
});
