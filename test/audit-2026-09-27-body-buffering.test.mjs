// 第 29 轮审计（2026-09-27）：请求体上限必须在「读第一个字节之前」生效一次。
// MCP 工具路由按 18MiB 宽度读体（为了让最宽的合法 payload 与其原样重放能通过），
// 但 readJson 完全忽略 content-length，只在累加之后判超。于是任何本机进程都能用
// N 个并发连接把 N×18MiB 读进内存再收 413 —— 实测服务进程 RSS 从 76MB 涨到 301MB。
// 修复：声明体积超限直接拒绝（不消费请求流），流内累加上限保持原样作为第二道。
import assert from 'node:assert/strict';
import test from 'node:test';

function fakeRequest({ contentLength, chunks }) {
  const consumed = [];
  return {
    consumed,
    headers: contentLength === undefined ? {} : { 'content-length': String(contentLength) },
    [Symbol.asyncIterator]: async function * () {
      for (const chunk of chunks) {
        consumed.push(chunk.length);
        yield Buffer.from(chunk);
      }
    },
  };
}

async function loadReadJson() {
  const module = await import('../src/service/http-server.mjs');
  assert.equal(
    typeof module.readJson,
    'function',
    '读体契约必须可被直接验证（readJson 是它的唯一实现）',
  );
  return module.readJson;
}

test('a declared body over the limit is refused without reading the stream', async () => {
  const readJson = await loadReadJson();
  const limit = 64 * 1024;
  const request = fakeRequest({ contentLength: limit + 1, chunks: ['a', 'b'] });
  await assert.rejects(
    () => readJson(request, { maxBytes: limit }),
    (error) => error.code === 'REQUEST_TOO_LARGE',
    '声明体积超限时应在读到第一个字节前拒绝',
  );
  assert.deepEqual(request.consumed, [], '拒绝路径不得把请求体搬进内存');
});

test('an undeclared oversized body still fails closed at the streaming bound', async () => {
  const readJson = await loadReadJson();
  const limit = 1024;
  const request = fakeRequest({ contentLength: undefined, chunks: ['x'.repeat(600), 'y'.repeat(600), 'z'.repeat(600)] });
  await assert.rejects(
    () => readJson(request, { maxBytes: limit }),
    (error) => error.code === 'REQUEST_TOO_LARGE',
  );
  assert.ok(request.consumed.length > 0, '没有 content-length 时仍由流内累加兜住');
});

test('a body that lies about its declared size is still capped while streaming', async () => {
  const readJson = await loadReadJson();
  const limit = 1024;
  const request = fakeRequest({ contentLength: 8, chunks: ['x'.repeat(900), 'y'.repeat(900)] });
  await assert.rejects(
    () => readJson(request, { maxBytes: limit }),
    (error) => error.code === 'REQUEST_TOO_LARGE',
    '预检不能被偏小的 content-length 绕过',
  );
});

test('legitimate bodies parse exactly as before', async () => {
  const readJson = await loadReadJson();
  const payload = JSON.stringify({ commandId: 'x'.repeat(40), note: '中文正文'.repeat(400) });
  for (const contentLength of [payload.length, undefined, String(Number(payload.length))]) {
    const request = fakeRequest({ contentLength, chunks: [payload] });
    const parsed = await readJson(request, { maxBytes: 18 * 1024 * 1024 });
    assert.deepEqual(parsed, JSON.parse(payload));
  }
  const empty = fakeRequest({ contentLength: 0, chunks: [] });
  assert.deepEqual(await readJson(empty, { maxBytes: 1024 }), {}, '空体保持既有语义');
});

test('an oversize MCP request is refused at the HTTP layer and the socket survives', async (t) => {
  const { mkdirSync, mkdtempSync, realpathSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const http = await import('node:http');
  const { pathToFileURL } = await import('node:url');
  const { openCockpitDatabase } = await import(pathToFileURL(
    path.join(import.meta.dirname, '..', 'src', 'core', 'database.mjs'),
  ).href);
  const { createCockpitHttpServer } = await import(pathToFileURL(
    path.join(import.meta.dirname, '..', 'src', 'service', 'http-server.mjs'),
  ).href);

  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-body-http-')));
  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  db.close();
  const token = 'body-buffering-http-test-token-long-enough';
  const service = await createCockpitHttpServer({ dbPath, token });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  const agent = new http.Agent({ keepAlive: true });
  const post = ({ body, declaredLength, end = true }) => new Promise((resolve, reject) => {
    const request = http.request({
      host: service.host, port: service.port, path: '/api/v1/mcp/work/context', method: 'POST', agent,
      headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'content-length': String(declaredLength),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text, socket: request.socket }));
    });
    request.on('error', reject);
    request.write(body);
    if (end) request.end();
  });

  // 关键判据：声明 20 MiB 而只发出 16 字节且**不结束请求**。只有「读第一个字节
  // 之前就按声明体积拒绝」才可能在这里给出响应；先缓冲的实现会一直等正文，
  // 于是这条断言超时失败（而不是靠随后再发一个大 body 蒙过去）。
  // 关键判据：声明 20 MiB 而只发出 16 字节且**不结束请求**。只有「读第一个字节
  // 之前就按声明体积拒绝」才可能在这里给出响应；先缓冲的实现会一直等正文（实测还
  // 会把随后的关停一起拖住），所以这里限时等待并在收尾时主动销毁那条请求。
  let early = null;
  let earlyRequest;
  try {
    early = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      const done = (value) => { clearTimeout(timer); resolve(value); };
      earlyRequest = http.request({
        host: service.host, port: service.port, path: '/api/v1/mcp/work/context', method: 'POST', agent,
        headers: {
          authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'content-length': String(20 * 1024 * 1024),
        },
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => done({ status: response.statusCode, text }));
      });
      earlyRequest.on('error', () => done(null));
      earlyRequest.write(Buffer.from('{"clientRequestId"'));
    });
  } finally {
    earlyRequest?.destroy();
  }
  assert.ok(early, '服务没有在不接收请求体的情况下给出答复：仍在先缓冲后判定');
  assert.equal(early.status, 413, early.text);
  assert.match(early.text, /REQUEST_TOO_LARGE/);

  const refused = await post({ body: Buffer.alloc(18 * 1024 * 1024 + 64 * 1024, 0x61), declaredLength: 18 * 1024 * 1024 + 64 * 1024 });
  assert.equal(refused.status, 413, refused.text);
  assert.match(refused.text, /REQUEST_TOO_LARGE/);
  // 预检不得把服务本身一起废掉：随后一条正常请求必须仍被服务。
  const small = await post({ body: Buffer.from('{"clientRequestId":"ok"}'), declaredLength: 24 });
  assert.notEqual(small.status, 413, small.text);
  agent.destroy();
});
