export const CLIENT_ID_KEY = 'ugk-cockpit-client-id';

const CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

export function createApiClient({ fetchImpl, storage, randomUUID, origin }) {
  let renewalPromise = null;

  function sessionError(cause) {
    return Object.assign(new Error('本地控制台暂时无法建立安全会话。', { cause }), {
      code: 'AUTH_REQUIRED',
      impact: '代码和已有记录都没有被修改。',
      required_action: '请确认本地控制台仍在运行，然后重试。',
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

    const response = await fetchImpl(path, {
      ...options,
      credentials: 'same-origin',
      headers: {
        ...(options.headers ?? {}),
        'content-type': 'application/json',
        'x-ugk-client-id': clientId(),
      },
    });
    const body = await response.json();

    if (isRead && mayRenewReadSession && response.status === 401 && body.code === 'AUTH_REQUIRED') {
      await ensureSession();
      return request(path, options, false);
    }

    if (!response.ok) throw Object.assign(new Error(body.message), body);
    return body;
  }

  return request;
}
