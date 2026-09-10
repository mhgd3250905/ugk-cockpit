import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { CLIENT_ID_KEY, createApiClient, FOLDER_SELECT_TIMEOUT_MS } from '../../web/src/api.js';

function response(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function createClient(options) {
  return createApiClient({ origin: 'http://127.0.0.1:41737', ...options });
}

test('API client renews an expired local browser session and retries once', async () => {
  const calls = [];
  const clientId = 'browser-stable-client-0001';
  const replies = [
    response(401, { code: 'AUTH_REQUIRED', message: '本地控制台身份已失效。' }),
    response(200),
    response(200, { ok: true, projects: [] }),
  ];
  const api = createClient({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return replies.shift();
    },
    storage: memoryStorage({ [CLIENT_ID_KEY]: clientId }),
    randomUUID: () => 'not-used',
  });

  const result = await api('/api/v1/dashboard');

  assert.deepEqual(result, { ok: true, projects: [] });
  assert.deepEqual(calls.map((call) => call.path), ['/api/v1/dashboard', '/', '/api/v1/dashboard']);
  assert.equal(calls[0].options.headers['x-ugk-client-id'], clientId);
  assert.equal(calls[2].options.headers['x-ugk-client-id'], clientId);
  assert.equal(calls[1].options.cache, 'no-store');
  assert.deepEqual(calls[1].options.headers, { accept: 'text/html' });
});

test('API client stops after one failed session renewal', async () => {
  let calls = 0;
  const api = createClient({
    fetchImpl: async (path) => {
      calls += 1;
      if (path === '/') return response(200);
      return response(401, { code: 'AUTH_REQUIRED', message: '本地控制台身份已失效。' });
    },
    storage: memoryStorage({ [CLIENT_ID_KEY]: 'browser-stable-client-0001' }),
    randomUUID: () => 'not-used',
  });

  await assert.rejects(api('/api/v1/dashboard'), { code: 'AUTH_REQUIRED' });
  assert.equal(calls, 3);
});

test('API client renews before a write and never replays the POST', async () => {
  const calls = [];
  const api = createClient({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      if (path === '/') return response(200);
      return response(401, { code: 'AUTH_REQUIRED', message: '本地控制台身份已失效。' });
    },
    storage: memoryStorage({ [CLIENT_ID_KEY]: 'browser-stable-client-0001' }),
    randomUUID: () => 'not-used',
  });
  const body = JSON.stringify({ grantId: 'fixture' });

  await assert.rejects(api('/api/v1/projects', { method: 'POST', body }), { code: 'AUTH_REQUIRED' });

  assert.deepEqual(calls.map((call) => call.path), ['/', '/api/v1/projects']);
  assert.equal(calls[1].options.body, body);
});

test('API client does not send a write when session renewal fails', async () => {
  const calls = [];
  const api = createClient({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return response(503);
    },
    storage: memoryStorage({ [CLIENT_ID_KEY]: 'browser-stable-client-0001' }),
    randomUUID: () => 'not-used',
  });

  await assert.rejects(api('/api/v1/projects', { method: 'POST', body: '{}' }), {
    code: 'AUTH_REQUIRED',
  });
  assert.deepEqual(calls.map((call) => call.path), ['/']);
});

test('API client keeps security-owned request fields same-origin', async () => {
  let call;
  const api = createClient({
    fetchImpl: async (path, options) => {
      call = { path, options };
      return response(200, { ok: true });
    },
    storage: memoryStorage({ [CLIENT_ID_KEY]: 'browser-stable-client-0001' }),
    randomUUID: () => 'not-used',
  });

  await api('/api/v1/dashboard', {
    credentials: 'omit',
    headers: { 'x-ugk-client-id': 'caller-controlled', authorization: 'fixture' },
  });

  assert.equal(call.options.credentials, 'same-origin');
  assert.equal(call.options.headers['x-ugk-client-id'], 'browser-stable-client-0001');
  assert.equal(call.options.headers.authorization, 'fixture');
  await assert.rejects(api('https://attacker.example/api'), TypeError);
  await assert.rejects(api('/\\evil.example/api'), TypeError);
});

test('API client replaces a malformed stored browser identity', async () => {
  const storage = memoryStorage({ [CLIENT_ID_KEY]: 'broken' });
  const replacement = 'browser-replacement-client-0001';
  let sentClientId;
  const api = createClient({
    fetchImpl: async (_path, options) => {
      sentClientId = options.headers['x-ugk-client-id'];
      return response(200, { ok: true });
    },
    storage,
    randomUUID: () => replacement,
  });

  await api('/api/v1/dashboard');

  assert.equal(sentClientId, replacement);
  assert.equal(storage.getItem(CLIENT_ID_KEY), replacement);
});

test('API client translates a lost local connection into a Chinese recovery message', async () => {
  const api = createClient({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    storage: memoryStorage({ [CLIENT_ID_KEY]: 'browser-stable-client-0001' }),
    randomUUID: () => 'not-used',
  });

  await assert.rejects(api('/api/v1/dashboard'), (error) => {
    assert.equal(error.code, 'SERVICE_UNAVAILABLE');
    assert.match(error.message, /本地控制台/);
    assert.match(error.required_action, /确认.*运行|重新加载/);
    return true;
  });
});

test('API client treats a non-JSON response as a connection failure with the standard contract', async () => {
  const api = createClient({
    fetchImpl: async () => ({
      status: 502,
      ok: false,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    }),
    storage: memoryStorage({ [CLIENT_ID_KEY]: 'browser-stable-client-0001' }),
    randomUUID: () => 'not-used',
  });

  await assert.rejects(api('/api/v1/dashboard'), (error) => {
    assert.equal(error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(error.impact, '页面还没有收到操作结果；项目代码不会被 Cockpit 修改。');
    assert.match(error.required_action, /Cockpit/);
    return true;
  });
});

test('API client abandons a request the service never answers instead of hanging forever', async () => {
  let seenSignal = null;
  const api = createClient({
    // 服务接受了连接却永不返回：主机休眠或 handler 挂死时的半开连接。
    // 真实 fetch 会在 signal 中止时以 AbortError 拒绝，这里同样模拟。
    fetchImpl: async (path, options) => {
      seenSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        });
      });
    },
    storage: memoryStorage({ [CLIENT_ID_KEY]: 'browser-stable-client-0001' }),
    randomUUID: () => 'not-used',
  });

  // 自行设界：一旦回归，本用例必须失败而不是把整个测试进程挂住。
  const guard = setTimeout(() => {}, 2000);
  const outcome = await Promise.race([
    api('/api/v1/dashboard', { method: 'GET', timeoutMs: 20 })
      .then(() => ({ settled: true }), (error) => ({ error })),
    new Promise((resolve) => { setTimeout(() => resolve({ hung: true }), 1500); }),
  ]);
  clearTimeout(guard);
  assert.equal(outcome.hung, undefined, 'a request the service never answers must not hang the UI');
  assert.equal(seenSignal?.aborted, true, 'the deadline must actually abort the fetch');
  assert.equal(outcome.error?.code, 'SERVICE_UNAVAILABLE');
});

test('the native folder picker keeps waiting while the user is still choosing', async (t) => {
  void t;
  const server = createServer((request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, cancelled: false, canonicalPath: 'C:/repo' }));
    }, 400);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const api = createApiClient({
    origin,
    // 真实 fetch 需要绝对地址；会话续期传的是相对路径 '/'。
    fetchImpl: (path, options) => fetch(new URL(path, origin), options),
    storage: memoryStorage({ [CLIENT_ID_KEY]: 'browser-stable-client-0001' }),
    randomUUID: () => 'not-used',
  });

  // 服务端允许 120 秒等待原生选择器，客户端的预算必须更长，否则用户还在
  // 选择时请求就被掐断。这里用缩放后的延迟验证同一机制。
  assert.ok(FOLDER_SELECT_TIMEOUT_MS >= 125_000, '目录选择预算必须覆盖服务端的 120 秒');
  const result = await api('/api/v1/folders/select', {
    method: 'POST',
    body: '{}',
    timeoutMs: 2_000,
  });
  assert.equal(result.ok, true);
  server.closeAllConnections?.();
  server.close();
});

test('a request that outlives its budget still fails with the connection contract', async () => {
  const server = createServer(() => { /* never respond */ });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const api = createApiClient({
    origin,
    // 真实 fetch 需要绝对地址；会话续期传的是相对路径 '/'。
    fetchImpl: (path, options) => fetch(new URL(path, origin), options),
    storage: memoryStorage({ [CLIENT_ID_KEY]: 'browser-stable-client-0001' }),
    randomUUID: () => 'not-used',
  });
  try {
    await assert.rejects(
      api('/api/v1/dashboard', { method: 'GET', timeoutMs: 150 }),
      (error) => error.code === 'SERVICE_UNAVAILABLE',
    );
  } finally {
    // 未响应的保活连接会让测试进程无法退出。
    server.closeAllConnections?.();
    server.close();
  }
});
