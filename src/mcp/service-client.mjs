const GENERIC_ERROR_FALLBACK = {
  message: '本地操作没有完成。',
  impact: 'Cockpit 没有确认保存成功，代码不会被自动清理或覆盖。',
  requiredAction: '请刷新状态后重试；如果仍然失败，请保留当前代码并查看技术详情。',
};

const INTEGER_FIELDS = [
  'currentSessionRevision',
  'expectedSessionRevision',
  'currentSubmissionRevision',
  'expectedSubmissionRevision',
  'currentClaimRevision',
  'expectedClaimRevision',
  'currentRevision',
  'expectedRevision',
  'revision',
];

const STRING_FIELDS = [
  'sessionId',
  'submissionId',
  'claimId',
  'activeClaimId',
  'status',
  'integratedCommit',
  'currentHead',
  'sourceCommit',
  'targetHead',
  'currentSourceCommit',
  'currentTargetHead',
  'expectedSourceCommit',
  'expectedTargetHead',
  'noteId',
];

const BOOLEAN_FIELDS = [
  'retryable',
  'localIntegrated',
  'pushed',
  'humanActionRequired',
];

export function sanitizeIntegrationErrorPayload(body, fallbackCode = 'REQUEST_FAILED') {
  const code = (typeof body?.code === 'string' && body.code.trim())
    ? body.code.trim()
    : fallbackCode;

  const isGeneric = code === 'REQUEST_FAILED';
  const payload = { code };

  const message = (typeof body?.message === 'string' && body.message.trim() && !(body instanceof Error))
    ? body.message.trim()
    : (typeof body?.publicMessage === 'string' && body.publicMessage.trim() ? body.publicMessage.trim() : null)
      || (isGeneric ? GENERIC_ERROR_FALLBACK.message : 'UGK Cockpit 拒绝了这次状态更新，请刷新页面确认当前任务。');
  payload.message = message;

  const impact = (typeof body?.impact === 'string' && body.impact.trim())
    ? body.impact.trim()
    : (isGeneric ? GENERIC_ERROR_FALLBACK.impact : null);
  if (impact) {
    payload.impact = impact;
  }

  const requiredAction = (typeof body?.required_action === 'string' && body.required_action.trim() ? body.required_action.trim() : null)
    || (typeof body?.requiredAction === 'string' && body.requiredAction.trim() ? body.requiredAction.trim() : null)
    || (isGeneric ? GENERIC_ERROR_FALLBACK.requiredAction : null);
  if (requiredAction) {
    payload.required_action = requiredAction;
  }

  for (const field of STRING_FIELDS) {
    if (typeof body?.[field] === 'string' && body[field].trim()) {
      payload[field] = body[field].trim();
    }
  }

  for (const field of INTEGER_FIELDS) {
    if (Number.isInteger(body?.[field])) {
      payload[field] = body[field];
    }
  }

  for (const field of BOOLEAN_FIELDS) {
    if (typeof body?.[field] === 'boolean') {
      payload[field] = body[field];
    }
  }

  return payload;
}

export function createIntegrationError(payload, cause = null) {
  return Object.assign(
    new Error(payload.message || payload.code || 'Integration operation failed.', cause ? { cause } : {}),
    payload,
    {
      publicMessage: payload.message,
      isIntegrationError: true,
      integrationPayload: payload,
    },
  );
}

export function createIntegrationTransportError(arguments_ = {}, cause = null) {
  const message = '无法确认与 UGK Cockpit 的连接结果。请使用完全相同的 clientRequestId 和参数重试，不要创建新的请求编号。';
  const payload = {
    code: 'SERVICE_UNAVAILABLE',
    message,
    impact: '请求中断，无法确认平台是否已执行该操作。',
    required_action: '请使用完全相同的 clientRequestId 和参数重试，不要创建新的请求编号。',
    retryable: true,
  };
  if (typeof arguments_?.sessionId === 'string' && arguments_.sessionId.trim()) {
    payload.sessionId = arguments_.sessionId.trim();
  }
  if (typeof arguments_?.submissionId === 'string' && arguments_.submissionId.trim()) {
    payload.submissionId = arguments_.submissionId.trim();
  }
  if (typeof arguments_?.claimId === 'string' && arguments_.claimId.trim()) {
    payload.claimId = arguments_.claimId.trim();
  }
  if (typeof arguments_?.noteId === 'string' && arguments_.noteId.trim()) {
    payload.noteId = arguments_.noteId.trim();
  }
  return createIntegrationError(payload, cause);
}

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:41737';

export function createServiceHandlers({
  token,
  refreshToken,
  baseUrl = DEFAULT_SERVICE_URL,
  fetchImpl = fetch,
  workingDirectory = process.cwd(),
}) {
  if (token != null && (typeof token !== 'string' || token.length < 32)) {
    throw new Error('UGK Cockpit local API token is unavailable.');
  }

  let scopedToken = null;
  // This is deliberately process-local.  It is a conversation/bridge
  // binding, not a durable credential or a second Cockpit session record.
  // Only successful init/accept/resume responses (and an explicit context
  // confirmation) may replace it.
  let bridgeBinding = null;

  async function bootstrapScopedToken() {
    let response;
    try {
      response = await fetchImpl(new URL('/api/v1/mcp/session', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client: 'ugk-cockpit-stdio' }),
      });
    } catch (cause) {
      throw Object.assign(new Error('UGK Cockpit service is unavailable.', { cause }), {
        publicMessage: '无法连接 UGK Cockpit，本次任务状态没有更新。请确认本地服务正在运行。',
      });
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.token !== 'string' || body.token.length < 32) {
      throw Object.assign(new Error(body.code ?? `HTTP_${response.status}`), {
        publicMessage: body.message ?? 'UGK Cockpit 无法建立本地 MCP 会话，请重启 Cockpit 后重试。',
      });
    }
    scopedToken = body.token;
    return scopedToken;
  }

  async function call(pathname, arguments_) {
    const isStructured = typeof pathname === 'string' && (
      pathname.startsWith('/api/v1/mcp/integration/')
      || pathname.startsWith('/api/v1/mcp/submit-notes/')
      || pathname === '/api/v1/mcp/work/submit-note'
    );
    let response = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bearer = token ?? scopedToken ?? await bootstrapScopedToken();
      try {
        response = await fetchImpl(new URL(pathname, baseUrl), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(arguments_),
        });
      } catch (cause) {
        if (isStructured) {
          throw createIntegrationTransportError(arguments_, cause);
        }
        throw Object.assign(new Error('UGK Cockpit service is unavailable.', { cause }), {
          publicMessage: '无法连接 UGK Cockpit，本次任务状态没有更新。请确认本地服务正在运行。',
        });
      }
      if (response.status !== 401 || attempt === 1) break;
      if (token) {
        const replacement = await refreshToken?.();
        if (typeof replacement !== 'string' || replacement.length < 32 || replacement === bearer) break;
        token = replacement;
      } else {
        scopedToken = null;
      }
    }
    if (isStructured) {
      let body;
      try {
        body = await response.json();
      } catch (cause) {
        throw createIntegrationTransportError(arguments_, cause);
      }
      const hasExplicitError = !response.ok
        || body?.ok === false
        || (typeof body?.code === 'string' && body.code.trim().length > 0);
      if (hasExplicitError) {
        const payload = sanitizeIntegrationErrorPayload(body, `HTTP_${response.status}`);
        throw createIntegrationError(payload);
      }
      const isValidSuccess = response.ok && body && typeof body === 'object' && !Array.isArray(body) && body.ok === true;
      if (isValidSuccess) {
        return body;
      }
      throw createIntegrationTransportError(arguments_);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(body.code ?? `HTTP_${response.status}`), {
        publicMessage: body.message ?? 'UGK Cockpit 拒绝了这次状态更新，请刷新页面确认当前任务。',
      });
    }
    return body;
  }

  function rememberBinding(result) {
    if (result?.ok !== true || typeof result.sessionId !== 'string'
      || !result.sessionId.trim() || typeof result.worktreeId !== 'string'
      || !result.worktreeId.trim()) {
      return;
    }
    const returned = result.binding && typeof result.binding === 'object'
      ? result.binding
      : {};
    const relay = result.relay && typeof result.relay === 'object'
      ? result.relay
      : {};
    if (returned.sessionId !== undefined && returned.sessionId !== result.sessionId) return;
    if (returned.worktreeId !== undefined && returned.worktreeId !== result.worktreeId) return;
    bridgeBinding = Object.freeze({
      sessionId: result.sessionId,
      worktreeId: result.worktreeId,
      relayId: returned.relayId ?? relay.relayId ?? null,
      relaySequence: returned.relaySequence ?? relay.sequence ?? null,
      acceptedRevision: returned.acceptedRevision ?? relay.acceptedRevision ?? null,
    });
  }

  async function callAndRemember(pathname, arguments_) {
    const result = await call(pathname, arguments_);
    rememberBinding(result);
    return result;
  }

  return {
    ugk_work_context: async (arguments_ = {}) => {
      const request = {};
      if (arguments_ && typeof arguments_ === 'object' && !Array.isArray(arguments_)) {
        if (arguments_.confirmSessionId !== undefined) request.confirmSessionId = arguments_.confirmSessionId;
        if (arguments_.expectedRevision !== undefined) request.expectedRevision = arguments_.expectedRevision;
      }
      if (bridgeBinding) request.bridgeBinding = { ...bridgeBinding };
      request.mcpWorkingDirectory = workingDirectory;
      const result = await call('/api/v1/mcp/work/context', request);
      if (result?.bindingEstablished === true) rememberBinding(result);
      return result;
    },
    ugk_work_accept: (arguments_) => callAndRemember('/api/v1/mcp/work/accept', arguments_),
    ugk_work_progress: (arguments_) => call('/api/v1/mcp/work/progress', arguments_),
    ugk_work_submit_preflight: (arguments_) => call('/api/v1/mcp/work/submit/preflight', {
      ...arguments_, mcpWorkingDirectory: workingDirectory,
    }),
    ugk_work_submit: (arguments_) => call('/api/v1/mcp/work/submit', {
      ...arguments_, mcpWorkingDirectory: workingDirectory,
    }),
    ugk_work_submit_note: (arguments_) => call('/api/v1/mcp/work/submit-note', {
      ...arguments_,
      mcpWorkingDirectory: workingDirectory,
      ...(bridgeBinding ? { bridgeBinding: { ...bridgeBinding } } : {}),
    }),
    ugk_submit_note_get: (arguments_) => call('/api/v1/mcp/submit-notes/get', {
      ...arguments_,
      mcpWorkingDirectory: workingDirectory,
    }),
    ugk_submit_note_update: (arguments_) => call('/api/v1/mcp/submit-notes/update', {
      ...arguments_,
      mcpWorkingDirectory: workingDirectory,
    }),
    ugk_integration_begin: (arguments_) => call('/api/v1/mcp/integration/begin', arguments_),
    ugk_integration_review: (arguments_) => call('/api/v1/mcp/integration/review', arguments_),
    ugk_integration_merge: (arguments_) => call('/api/v1/mcp/integration/merge', arguments_),
    ugk_work_finish: (arguments_) => call('/api/v1/mcp/work/finish', arguments_),
    ugk_work_handoff: (arguments_) => call('/api/v1/mcp/work/handoff', arguments_),
    ugk_work_init: (arguments_) => callAndRemember('/api/v1/mcp/work/init', {
      ...arguments_,
      mcpWorkingDirectory: workingDirectory,
    }),
    ugk_work_begin: (arguments_) => call('/api/v1/mcp/work/begin', arguments_),
    ugk_work_relay: (arguments_) => call('/api/v1/mcp/work/relay', arguments_),
    ugk_work_resume: (arguments_) => callAndRemember('/api/v1/mcp/work/resume', {
      ...arguments_,
      mcpWorkingDirectory: workingDirectory,
    }),
  };
}
