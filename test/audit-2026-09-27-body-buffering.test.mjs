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
