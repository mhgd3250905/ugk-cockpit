export const CLIENT_ID_KEY = 'ugk-cockpit-client-id';

const CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;
// The service is a local process: if it accepted the connection it must answer
// quickly. Without a deadline a half-open socket (host sleep, a hung handler)
// leaves the request pending forever, and a fixed-interval poll then stacks
// until the browser's per-origin connection limit blocks every user action.
const DEFAULT_TIMEOUT_MS = 15_000;
const SESSION_TIMEOUT_MS = 10_000;

function deadline(ms) {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

// A caller-supplied signal must not silently disable the deadline: combine them
// so either one aborts the request.
function withDeadline(signal, ms) {
  const timer = deadline(ms);
  if (!timer) return signal;
  if (!signal) return timer;
  return typeof AbortSignal?.any === 'function' ? AbortSignal.any([signal, timer]) : signal;
}

export function createApiClient({ fetchImpl, storage, randomUUID, origin }) {
  let renewalPromise = null;

  function sessionError(cause) {
    return Object.assign(new Error('本地控制台暂时无法建立安全会话。', { cause }), {
      code: 'AUTH_REQUIRED',
      impact: '代码和已有记录都没有被修改。',
      required_action: '请确认本地控制台仍在运行，然后重试。',
    });
  }

  function connectionError(cause) {
    return Object.assign(new Error('暂时无法连接本地控制台。', { cause }), {
      code: 'SERVICE_UNAVAILABLE',
      impact: '页面还没有收到操作结果；项目代码不会被 Cockpit 修改。',
      required_action: '请确认 Cockpit 正在运行，然后重新加载简报；如果刚才在添加项目，请先确认首页是否已有记录。',
    });
  }

  function clientId() {
    let value = storage.getItem(CLIENT_ID_KEY);
    if (!CLIENT_ID_PATTERN.test(value ?? '')) {
      value = randomUUID();
      storage.setItem(CLIENT_ID_KEY, value);
    }
    return value;
  }

  function renewSession() {
    if (!renewalPromise) {
      renewalPromise = fetchImpl('/', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'text/html' },
        signal: deadline(SESSION_TIMEOUT_MS),
      })
        .catch((error) => { throw sessionError(error); })
        .finally(() => { renewalPromise = null; });
    }
    return renewalPromise;
  }

  async function ensureSession() {
    const renewed = await renewSession();
    if (!renewed.ok) throw sessionError();
  }

  async function request(path, options = {}, mayRenewReadSession = true) {
    let target;
    try {
      target = new URL(path, origin);
    } catch {
      throw new TypeError('API path must be a same-origin relative path.');
    }
    if (typeof path !== 'string' || !path.startsWith('/') || target.origin !== origin) {
      throw new TypeError('API path must be a same-origin relative path.');
    }
    const method = (options.method ?? 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    if (!isRead) await ensureSession();

    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const customHeaders = options.headers ?? {};
    const hasContentType = Object.keys(customHeaders).some(
      (k) => k.toLowerCase() === 'content-type',
    );
    const headers = {
      ...customHeaders,
      'x-ugk-client-id': clientId(),
    };
    if (!isFormData && !hasContentType) {
      headers['content-type'] = 'application/json';
    }

    const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...rest } = options;
    let response;
    try {
      response = await fetchImpl(path, {
        ...rest,
        credentials: 'same-origin',
        headers,
        signal: withDeadline(callerSignal, timeoutMs),
      });
    } catch (error) {
      // 超时与连接失败同样进入既有连接错误契约，界面因此始终给出可操作提示。
      throw connectionError(error);
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      // 非 JSON 响应（代理错误页、崩溃中的服务）按连接故障处理，
      // 不让裸解析错误绕过统一的错误契约。
      throw connectionError(error);
    }

    if (isRead && mayRenewReadSession && response.status === 401 && body.code === 'AUTH_REQUIRED') {
      await ensureSession();
      return request(path, options, false);
    }

    if (!response.ok) {
      // 错误体可能是 null、标量或缺失 message 的对象；契约字段必须始终保留，
      // 否则按 code 分支的错误处理会全部退化为无提示失败。
      const payload = (body && typeof body === 'object') ? body : {};
      throw Object.assign(
        new Error(payload.message ?? `请求失败（HTTP ${response.status}）。`),
        payload,
      );
    }
    return body;
  }

  return request;
}
