import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

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
  'diagnosticId',
  'reason',
  'bindingReason',
  'bindingKind',
  'bindingPersistence',
];

const BOOLEAN_FIELDS = [
  'retryable',
  'localIntegrated',
  'pushed',
  'humanActionRequired',
  'canContinue',
  'requiresUserConfirmation',
];
const SAFE_DIAGNOSTIC_ID = /^diag_[A-Za-z0-9_-]{16,64}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_REASON = /^[A-Za-z][A-Za-z0-9_.-]{1,79}$/;
const SAFE_BINDING_KIND = new Set(['host', 'connection', 'legacy']);
const SAFE_BINDING_PERSISTENCE = new Set(['durable', 'connection_only', 'legacy']);

function safeDiagnosticId(value) {
  return typeof value === 'string' && SAFE_DIAGNOSTIC_ID.test(value) ? value : null;
}

function safeSessionId(value) {
  return typeof value === 'string' && SAFE_SESSION_ID.test(value) ? value : null;
}

function safeRevision(value) {
  return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function copySafeConversationContext(source, payload, { includeRevision = true } = {}) {
  const sessionId = safeSessionId(source?.sessionId)
    ?? safeSessionId(source?.session_id);
  if (sessionId) payload.sessionId = sessionId;
  if (includeRevision) {
    const revision = [
      source?.revision,
      source?.currentRevision,
      source?.current_revision,
    ].map(safeRevision).find((value) => value !== null);
    if (revision !== undefined) payload.revision = revision;
  }
  const bindingReason = [
    source?.bindingReason,
    source?.binding_reason,
    source?.reason,
  ].find((value) => typeof value === 'string' && SAFE_REASON.test(value.trim()));
  if (bindingReason) {
    payload.bindingReason = bindingReason.trim();
  }
  for (const field of ['projectId', 'worktreeId']) {
    const value = safeSessionId(source?.[field]);
    if (value) payload[field] = value;
  }
  if (source?.recoveryAction === 'open_workbench_transfer') payload.recoveryAction = source.recoveryAction;
  // Project only public locator fields. Do not forward raw bindings, command
  // requests, authorization codes or additional nested backend properties.
  const publicText = (value, limit) => typeof value === 'string'
    && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  if (source?.owner && typeof source.owner === 'object' && !Array.isArray(source.owner)) {
    const owner = source.owner;
    payload.owner = {
      host: publicText(owner.host, 64),
      conversationLocator: publicText(owner.conversationLocator, 256),
      holderType: ['durable_chat', 'previous_mcp_connection'].includes(owner.holderType) ? owner.holderType : null,
      bindingPersistence: SAFE_BINDING_PERSISTENCE.has(owner.bindingPersistence) ? owner.bindingPersistence : null,
      boundAt: publicText(owner.boundAt, 64), lastActivityAt: publicText(owner.lastActivityAt, 64),
    };
  }
  if (source?.latestNode && typeof source.latestNode === 'object' && !Array.isArray(source.latestNode)) {
    const node = source.latestNode;
    payload.latestNode = {
      id: publicText(node.id, 512), type: publicText(node.type, 64), predecessorId: publicText(node.predecessorId, 512),
      actorKind: ['ai', 'user', 'system', 'unattributed'].includes(node.actorKind) ? node.actorKind : null,
      actorHost: publicText(node.actorHost, 64), actorConversationId: publicText(node.actorConversationId, 256),
      summary: typeof node.summary === 'string' ? node.summary.slice(0, 500) : null,
      createdAt: publicText(node.createdAt, 64),
    };
  }
  return payload;
}

function responseDiagnosticHeader(response) {
  return typeof response?.headers?.get === 'function'
    ? response.headers.get('x-ugk-diagnostic-id')
    : null;
}

export function sanitizeIntegrationErrorPayload(body, fallbackCode = 'REQUEST_FAILED', defaultDiagnosticId = null) {
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

  const diagnosticId = (typeof body?.diagnosticId === 'string' && body.diagnosticId.trim())
    ? body.diagnosticId.trim()
    : defaultDiagnosticId;
  const safeId = safeDiagnosticId(diagnosticId);
  if (safeId) payload.diagnosticId = safeId;

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
    if (typeof body?.[field] !== 'string' || !body[field].trim()) continue;
    const value = body[field].trim();
    const allowed = field === 'diagnosticId'
      ? SAFE_DIAGNOSTIC_ID.test(value)
      : field === 'sessionId'
        ? SAFE_SESSION_ID.test(value)
      : field === 'reason'
        ? SAFE_REASON.test(value)
        : field === 'bindingReason'
          ? SAFE_REASON.test(value)
        : field === 'bindingKind'
          ? SAFE_BINDING_KIND.has(value)
          : field === 'bindingPersistence'
            ? SAFE_BINDING_PERSISTENCE.has(value)
            : true;
    if (allowed) {
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

  copySafeConversationContext(body, payload);
  if (!payload.reason && payload.bindingReason) payload.reason = payload.bindingReason;
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

export function createIntegrationTransportError(arguments_ = {}, cause = null, diagnosticId = null) {
  const message = '无法确认与 UGK Cockpit 的连接结果。请使用完全相同的 clientRequestId 和参数重试，不要创建新的请求编号。';
  const payload = {
    code: 'SERVICE_UNAVAILABLE',
    message,
    impact: '请求中断，无法确认平台是否已执行该操作。',
    required_action: '请使用完全相同的 clientRequestId 和参数重试，不要创建新的请求编号。',
    retryable: true,
    ...(diagnosticId ? { diagnosticId } : {}),
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
  return createIntegrationError(copySafeConversationContext(arguments_, payload, {
    includeRevision: false,
  }), cause);
}

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:41737';

export function createServiceHandlers({
  token,
  refreshToken,
  baseUrl = DEFAULT_SERVICE_URL,
  fetchImpl = fetch,
  workingDirectory = process.cwd(),
  conversationIdentity = null,
  connectionHandle = null,
  shutdownSignal = null,
}) {
  if (token != null && (typeof token !== 'string' || token.length < 32)) {
    throw new Error('UGK Cockpit local API token is unavailable.');
  }

  let scopedToken = null;
  let scopedConnectionHandle = typeof connectionHandle === 'string' && connectionHandle.trim()
    ? connectionHandle.trim()
    : null;
  let bootstrapPromise = null;
  const requests = new AsyncLocalStorage();
  const identity = () => {
    const store = requests.getStore();
    return store && Object.prototype.hasOwnProperty.call(store, 'conversationIdentity')
      ? store.conversationIdentity
      : conversationIdentity;
  };
  // Compatibility for hosts without request identity, before explicit migration.
  // Identified hosts NEVER read/write this cache: their bindings live in SQLite.
  let bridgeBinding = null;

  async function bootstrapScopedToken(diagnosticId = newDiagnosticId()) {
    if (scopedToken) return scopedToken;
    if (bootstrapPromise) return bootstrapPromise;

    bootstrapPromise = (async () => {
      // A service restart can reset the previous keep-alive socket precisely
      // while a host without its own durable credential asks for a fresh scoped
      // token.  One short retry handles that transport hand-off without turning
      // a persistent outage into an unbounded reconnect loop.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let response;
        try {
          response = await fetchImpl(new URL('/api/v1/mcp/session', baseUrl), {
            method: 'POST',
            signal: AbortSignal.timeout(5000),
            headers: {
              'content-type': 'application/json',
              'x-ugk-diagnostic-id': diagnosticId,
            },
            body: JSON.stringify({
              client: 'ugk-cockpit-stdio',
              connectionHandleVersion: 'v1',
              ...(scopedConnectionHandle ? { connectionHandle: scopedConnectionHandle } : {}),
            }),
          });
        } catch (cause) {
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          throw Object.assign(new Error('UGK Cockpit service is unavailable.', { cause }), {
            code: 'SERVICE_UNAVAILABLE',
            transportFailure: true,
            publicMessage: '无法连接 UGK Cockpit，暂时无法确认本次任务是否更新。请确认本地服务正在运行。',
            impact: '请求中断，无法确认平台是否已执行该操作。',
            required_action: '请使用完全相同的 clientRequestId 和参数重试，不要创建新的请求编号。',
            diagnosticId,
          });
        }
        const body = await response.json().catch(() => ({}));
        if (!response.ok || typeof body.token !== 'string' || body.token.length < 32) {
          throw Object.assign(new Error(body.code ?? `HTTP_${response.status}`), {
            code: body.code ?? `HTTP_${response.status}`,
            publicMessage: body.message ?? 'UGK Cockpit 无法建立本地 MCP 会话，请重启 Cockpit 后重试。',
            diagnosticId: safeDiagnosticId(body.diagnosticId)
              ?? safeDiagnosticId(responseDiagnosticHeader(response))
              ?? diagnosticId,
          });
        }
        if (scopedConnectionHandle && typeof body.connectionHandle !== 'string') {
          throw Object.assign(new Error('MCP connection continuity handle was not returned.'), {
            code: 'MCP_CONNECTION_HANDLE_REQUIRED',
            publicMessage: 'UGK Cockpit 没有返回可恢复的 MCP 连接身份；没有创建新的连接归属。请重新连接新版 MCP。',
            impact: '没有创建新的连接归属，代码、工作会话和已有记录都没有被修改。',
            required_action: '请重新连接新版 UGK Cockpit MCP。',
            diagnosticId,
          });
        }
        if (typeof body.connectionHandle === 'string' && body.connectionHandle.trim()) {
          scopedConnectionHandle = body.connectionHandle.trim();
        }
        scopedToken = body.token;
        return scopedToken;
      }
      throw new Error('Unreachable scoped MCP token bootstrap state.');
    })();
    try {
      return await bootstrapPromise;
    } finally {
      bootstrapPromise = null;
    }
  }

  function newDiagnosticId() {
    return `diag_${randomBytes(12).toString('hex')}`;
  }

  async function call(pathname, arguments_, { diagnosticId = newDiagnosticId() } = {}) {
    const isRelay = pathname === '/api/v1/mcp/work/resume' || pathname === '/api/v1/mcp/work/relay';
    const isTakeover = pathname === '/api/v1/mcp/work/takeover';
    const isRecoverableConversationWrite = isRelay || isTakeover;
    const isStructured = typeof pathname === 'string' && (
      pathname.startsWith('/api/v1/mcp/integration/')
      || pathname.startsWith('/api/v1/mcp/submit-notes/')
      || pathname === '/api/v1/mcp/work/submit-note'
    );
    // Every service attempt is bounded: the loopback service must answer
    // within one timeout window, and host shutdown must abort in-flight
    // requests so the process cannot linger on a stalled connection.
    const timeoutMs = isRecoverableConversationWrite ? 10000 : 30000;
    const attemptSignal = () => (shutdownSignal
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), shutdownSignal])
      : AbortSignal.timeout(timeoutMs));
    const ensureBearer = async () => (token ?? scopedToken ?? await bootstrapScopedToken(diagnosticId));
    // Structured writes keep the retry contract even when the failure happens
    // during credential bootstrap: transport-typed bootstrap errors already
    // carry the same-request-id wording and only gain `retryable`, while any
    // other bootstrap failure is normalized into the full transport error.
    const guardedBearer = async () => {
      try {
        return await ensureBearer();
      } catch (cause) {
        if (isStructured) {
          if (cause?.transportFailure === true) {
            if (cause.retryable === undefined) cause.retryable = true;
            throw cause;
          }
          throw createIntegrationTransportError(arguments_, cause, diagnosticId);
        }
        throw cause;
      }
    };
    let response = null;
    // Fail fast before the first attempt: a credential bootstrap failure must
    // not lose the structured retry contract for write operations.
    await guardedBearer();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // A 401 may have rotated the token or invalidated the scoped token,
      // so the credential is re-resolved per attempt under the same guard.
      const bearer = await guardedBearer();
      try {
        response = await fetchImpl(new URL(pathname, baseUrl), {
          method: 'POST',
          signal: attemptSignal(),
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
            'x-ugk-diagnostic-id': diagnosticId,
            ...(identity() ? { 'x-ugk-conversation': Buffer.from(JSON.stringify(identity())).toString('base64url') } : {}),
          },
          body: JSON.stringify(arguments_),
        });
      } catch (cause) {
        if (isStructured) {
          throw createIntegrationTransportError(arguments_, cause, diagnosticId);
        }
        throw Object.assign(new Error('UGK Cockpit service is unavailable.', { cause }), {
          code: 'SERVICE_UNAVAILABLE',
          transportFailure: true,
          publicMessage: '无法连接 UGK Cockpit，暂时无法确认本次任务是否更新。请确认本地服务正在运行。',
          impact: '请求中断，无法确认平台是否已执行该操作。',
          required_action: '请使用完全相同的 clientRequestId 和参数重试，不要创建新的请求编号。',
          diagnosticId,
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
        throw createIntegrationTransportError(arguments_, cause, diagnosticId);
      }
      const hasExplicitError = !response.ok
        || body?.ok === false
        || (typeof body?.code === 'string' && body.code.trim().length > 0);
      if (hasExplicitError) {
        const payload = sanitizeIntegrationErrorPayload(
          body,
          `HTTP_${response.status}`,
          responseDiagnosticHeader(response) ?? diagnosticId,
        );
        throw createIntegrationError(payload);
      }
      const isValidSuccess = response.ok && body && typeof body === 'object' && !Array.isArray(body) && body.ok === true;
      if (isValidSuccess) {
        return body;
      }
      throw createIntegrationTransportError(arguments_, null, diagnosticId);
    }
    const body = await response.json().catch((cause) => {
      throw Object.assign(new Error('Conversation response was lost.', { cause }), {
        code: 'SERVICE_UNAVAILABLE',
        transportFailure: true,
        publicMessage: '无法确认与 UGK Cockpit 的连接结果。请使用完全相同的 clientRequestId 和参数重试。',
        impact: '请求中断，无法确认平台是否已执行该操作。',
        required_action: '请使用完全相同的 clientRequestId 和参数重试，不要创建新的请求编号。',
        diagnosticId,
      });
    });
    if (!response.ok) {
      const responseDiagnosticId = safeDiagnosticId(body?.diagnosticId)
        ?? safeDiagnosticId(responseDiagnosticHeader(response))
        ?? diagnosticId;
      const payload = sanitizeIntegrationErrorPayload(
        body,
        `HTTP_${response.status}`,
        responseDiagnosticId,
      );
      const reason = payload.reason ?? payload.bindingReason ?? payload.code;
      const serviceError = Object.assign(new Error(payload.code), {
        ...payload,
        publicMessage: payload.message,
        reason,
        ...(isRelay ? { relayPayload: {
          ok: false,
          ...payload,
          retryable: false,
          reason,
          clientRequestId: arguments_.clientRequestId,
        } } : isTakeover ? { takeoverPayload: {
          ok: false,
          ...payload,
          retryable: false,
          reason,
          clientRequestId: arguments_.clientRequestId,
        } } : {}),
      });
      serviceError.message = payload.code;
      throw serviceError;
    }
    if (isRecoverableConversationWrite && body?.ok !== true) {
      throw Object.assign(new Error('Conversation recovery outcome is not confirmed.'), {
        code: 'SERVICE_UNAVAILABLE',
        transportFailure: true,
        publicMessage: '无法确认接力或接手结果，请使用完全相同的 clientRequestId 和参数重试。',
        impact: '请求中断，无法确认平台是否已执行该操作。',
        required_action: '请使用完全相同的 clientRequestId 和参数重试，不要创建新的请求编号。',
        diagnosticId,
      });
    }
    return body;
  }

  function rememberBinding(result) {
    if (identity()) return; // The service persists host-identified bindings.
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

  async function callRelay(pathname, arguments_) {
    // Keep the same immutable intent across connection and response-body loss.
    // The journal on the service, not this retry loop, proves the outcome.
    const diagnosticId = newDiagnosticId();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await call(pathname, arguments_, { diagnosticId });
        if (pathname.endsWith('/resume') && result.relayAccepted === true) rememberBinding(result);
        return result;
      } catch (error) {
        if (!error.transportFailure) throw error;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        throw Object.assign(error, { relayPayload: {
          ok: false, code: 'RELAY_TRANSPORT_UNCERTAIN', status: 'recovery_pending',
          retryable: true, clientRequestId: arguments_.clientRequestId,
          diagnosticId,
          message: '暂时无法确认接力结果，自动重试尚未成功。',
          impact: '请求可能已被服务保存；不要重新 init 或假定接手成功。',
          required_action: '连接恢复后在当前聊天原样重试本次请求，沿用同一 clientRequestId。',
        } });
      }
    }
  }

  async function callTakeover(arguments_) {
    // The command journal makes this safe to retry with the identical intent
    // if the local service restarts after committing but before responding.
    const diagnosticId = newDiagnosticId();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await call('/api/v1/mcp/work/takeover', arguments_, { diagnosticId });
        if (result.takeoverAccepted === true) rememberBinding(result);
        return result;
      } catch (error) {
        if (!error.transportFailure) throw error;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        throw Object.assign(error, { takeoverPayload: {
          ok: false, code: 'CONVERSATION_TAKEOVER_TRANSPORT_UNCERTAIN', status: 'recovery_pending',
          retryable: true, clientRequestId: arguments_.clientRequestId,
          diagnosticId,
          message: '暂时无法确认接手结果，自动重试尚未成功。',
          impact: '接手请求可能已被服务保存；原聊天和代码都没有被自动清理或覆盖。',
          required_action: '连接恢复后在当前聊天原样重试本次请求，沿用同一 clientRequestId。',
        } });
      }
    }
  }

  const handlers = {
    ugk_work_context: async (arguments_ = {}) => {
      const request = {};
      if (arguments_ && typeof arguments_ === 'object' && !Array.isArray(arguments_)) {
        if (arguments_.confirmSessionId !== undefined) request.confirmSessionId = arguments_.confirmSessionId;
        if (arguments_.expectedRevision !== undefined) request.expectedRevision = arguments_.expectedRevision;
      }
      if (!identity() && bridgeBinding) request.bridgeBinding = { ...bridgeBinding };
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
      ...(!identity() && bridgeBinding ? { bridgeBinding: { ...bridgeBinding } } : {}),
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
    ugk_work_relay: (arguments_) => callRelay('/api/v1/mcp/work/relay', arguments_),
    ugk_work_takeover: (arguments_) => callTakeover({
      ...arguments_,
      mcpWorkingDirectory: workingDirectory,
    }),
    ugk_work_resume: (arguments_) => callRelay('/api/v1/mcp/work/resume', {
      ...arguments_,
      mcpWorkingDirectory: workingDirectory,
    }),
  };
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name,
    (args, context) => requests.run(context ?? {}, () => handler(args)),
  ]));
}
