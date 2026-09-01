import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIENT_ID_KEY, createApiClient } from '../../web/src/api.js';

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
