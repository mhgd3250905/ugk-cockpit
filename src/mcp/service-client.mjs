const DEFAULT_SERVICE_URL = 'http://127.0.0.1:41737';

export function createServiceHandlers({ token, baseUrl = DEFAULT_SERVICE_URL, fetchImpl = fetch }) {
  if (typeof token !== 'string' || token.length < 32) {
    throw new Error('UGK Cockpit local API token is unavailable.');
  }

  async function call(pathname, arguments_) {
    let response;
    try {
      response = await fetchImpl(new URL(pathname, baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(arguments_),
      });
    } catch (cause) {
      throw Object.assign(new Error('UGK Cockpit service is unavailable.', { cause }), {
        publicMessage: '无法连接 UGK Cockpit，本次任务状态没有更新。请确认本地服务正在运行。',
      });
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(body.code ?? `HTTP_${response.status}`), {
        publicMessage: body.message ?? 'UGK Cockpit 拒绝了这次状态更新，请刷新页面确认当前任务。',
      });
    }
    return body;
  }

  return {
    ugk_work_accept: (arguments_) => call('/api/v1/mcp/work/accept', arguments_),
    ugk_work_progress: (arguments_) => call('/api/v1/mcp/work/progress', arguments_),
    ugk_work_finish: (arguments_) => call('/api/v1/mcp/work/finish', arguments_),
  };
}
