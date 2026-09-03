const DEFAULT_SERVICE_URL = 'http://127.0.0.1:41737';

export function createServiceHandlers({
  token,
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
        throw Object.assign(new Error('UGK Cockpit service is unavailable.', { cause }), {
          publicMessage: '无法连接 UGK Cockpit，本次任务状态没有更新。请确认本地服务正在运行。',
        });
      }
      if (response.status !== 401 || token || attempt === 1) break;
      scopedToken = null;
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
