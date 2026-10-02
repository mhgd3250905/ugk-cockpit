// 第 35 轮审计（2026-10-03）· 其一：错误码登记闭合族。
//
// `sendError`（http-server）与 `deliveryResponse`（delivery-messages）是产品里
// 唯一两处把内部错误码翻译成用户回执的地方，两处的兜底方向都是「查不到就换成
// 通用文案」。这个方向本身是对的——未经人工审过的字符串绝不能出现在回执里——
// 但代价是静默：新增一个错误码、忘了登记，没有任何东西会变红，客户端只看到
// 「本地操作没有完成 / 请刷新状态后重试」。`src/git/delivery-ops.mjs` 里写着
// 「Public wording is curated in the error maps」，而本轮之前
// `git grep PUBLIC_ERRORS test/` 是零命中：把把关者说成已经存在，是最坏的一种
// 注释——它教人以为有门禁。
//
// 这里钉住两条闭合族：`path-guard` 能抛出的全部 PathScopeError 码、
// `validateRemoteUrlSecurity` 能抛出的全部远程地址拒绝码。族断言写成对提取结果
// 的整体折叠，并先断言提取结果本身的形状；只点名已知成员的话，新增一个形状就会
// 被静默漏掉。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PUBLIC_ERRORS } from '../src/service/http-server.mjs';
import { DELIVERY_ERROR_MESSAGES, deliveryResponse } from '../src/core/delivery-messages.mjs';

function readRepositoryFile(relative) {
  return readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
}

// path-guard.mjs 只用两种写法产生错误码：显式第二参数，以及构造器默认值。
function pathGuardErrorCodes(source = readRepositoryFile('src/core/path-guard.mjs')) {
  const explicit = [...source.matchAll(
    /new\s+PathScopeError\(\s*'[^']*'\s*,\s*'([A-Z][A-Z0-9_]+)'\s*\)/g,
  )].map((match) => match[1]);
  const defaulted = [...source.matchAll(/code\s*=\s*'([A-Z][A-Z0-9_]+)'/g)].map((match) => match[1]);
  return new Set([...explicit, ...defaulted]);
}

// 切片取到函数结尾的列零 `}`，避免把同文件其它检查器（网络共享路径、file: 主机名
// 等，它们统一走 UNSAFE_REMOTE_URL）的码混进这一族。
function remoteUrlValidatorCodes(source = readRepositoryFile('src/git/delivery-ops.mjs')) {
  const start = source.indexOf('export function validateRemoteUrlSecurity');
  if (start < 0) throw new Error('validateRemoteUrlSecurity not found in delivery-ops.mjs');
  const body = source.slice(start);
  const end = body.search(/^\}/m);
  if (end < 0) throw new Error('validateRemoteUrlSecurity body slice did not terminate');
  return new Set([...body.slice(0, end).matchAll(/code\s*=\s*'([A-Z][A-Z0-9_]+)'/g)].map((match) => match[1]));
}

function curatedSomewhere(code) {
  return PUBLIC_ERRORS[code] !== undefined || DELIVERY_ERROR_MESSAGES[code] !== undefined;
}

test('path-guard 抛出的每一个路径码都在 HTTP 白名单里有自己的回执', () => {
  const codes = pathGuardErrorCodes();
  // 提取式的防自证钉：本族在写用例时已知六个码。少一个说明扫描式退化成了只看
  // 一种形状，后面的登记断言就会对着一份残缺清单判绿。
  assert.deepEqual([...codes].sort(), [
    'DIRECTORY_IDENTITY_CHANGED',
    'DIRECTORY_NOT_EMPTY',
    'NOT_A_DIRECTORY',
    'PATH_CHANGED',
    'PATH_OUTSIDE_SCOPE',
    'REPARSE_POINT',
  ], 'path-guard code extraction changed shape');
  const missing = [...codes].filter((code) => PUBLIC_ERRORS[code] === undefined).sort();
  assert.deepEqual(missing, [], 'PathScopeError codes without curated HTTP wording');
});

test('path-guard 同族里早已登记的兄弟码在本轮前后都保持登记', () => {
  // 反向对照，主干上即绿：这一条钉的是「别把已经写好的挤掉」，不依赖本轮新增项。
  for (const code of ['REPARSE_POINT', 'NOT_A_DIRECTORY', 'DIRECTORY_NOT_EMPTY', 'DIRECTORY_IDENTITY_CHANGED']) {
    assert.notEqual(PUBLIC_ERRORS[code], undefined, `${code} lost its curated wording`);
    assert.ok(PUBLIC_ERRORS[code].message.length > 0, `${code} has an empty message`);
  }
});

test('远程地址校验器抛出的每一个码都有回执，凭据那一支不再共享通用文案', () => {
  const codes = remoteUrlValidatorCodes();
  assert.deepEqual([...codes].sort(), ['CREDENTIALS_IN_REMOTE_URL', 'UNSAFE_REMOTE_URL'],
    'remote URL validator code extraction changed shape');
  const missing = [...codes].filter((code) => !curatedSomewhere(code)).sort();
  assert.deepEqual(missing, [], 'remote URL rejection codes without curated wording');
});

test('带凭据的远程地址得到自己的送审文案，而不是通用的送审兜底', () => {
  const generic = deliveryResponse({ ok: false, code: 'NOT_A_REAL_CODE_AT_ALL', localSaved: false, pushed: false });
  const credentials = deliveryResponse({ ok: false, code: 'CREDENTIALS_IN_REMOTE_URL', localSaved: false, pushed: false });
  const unsafe = deliveryResponse({ ok: false, code: 'UNSAFE_REMOTE_URL', localSaved: false, pushed: false });
  // 反向对照在主干即绿：UNSAFE_REMOTE_URL 早就登记，它的文案不是通用兜底。
  assert.notEqual(unsafe.message, generic.message, 'UNSAFE_REMOTE_URL control regressed to the generic receipt');
  assert.equal(credentials.message, DELIVERY_ERROR_MESSAGES.CREDENTIALS_IN_REMOTE_URL[0]);
  assert.notEqual(credentials.message, generic.message, 'credentials rejection still uses the generic receipt');
  assert.match(credentials.required_action, /凭据/);
  assert.equal(credentials.code, 'CREDENTIALS_IN_REMOTE_URL', 'deliveryResponse must not rewrite the code');
});

test('集成与送审回执用到的码不再塌成通用 REQUEST_FAILED', () => {
  // 可达性依据（本轮逐条核对调用链，不是推测）：INVALID_VERDICT、
  // CLAIM_SUBMISSION_MISMATCH、INVALID_SOURCE_COMMIT、MERGE_UNVERIFIED 由
  // integrations / integration-service / integration-ops 返回或抛出后，经
  // /api/v1/mcp/integration/{review,merge} 的 sendError(response, result.code)
  // 到达回执；GIT_BUFFER_LIMIT_EXCEEDED、GIT_ERROR 由 git 层抛出后经
  // /api/v1/projects/:id/refresh、/api/v1/runs/start 与工作副本 reuse 路由到达
  // 同一个 sendError；PATH_CHANGED、PATH_OUTSIDE_SCOPE 由 path-guard 在
  // observeRegisteredProject 的授权/复核两步抛出，且 refresh 处理函数体没有
  // try，直接落到请求处理末尾的 catch。submission-service 的码不在其中——
  // src/ 内零引用，登记为已核查不可达，本轮不为其编造文案。
  for (const code of [
    'INVALID_VERDICT',
    'CLAIM_SUBMISSION_MISMATCH',
    'INVALID_SOURCE_COMMIT',
    'MERGE_UNVERIFIED',
    'GIT_BUFFER_LIMIT_EXCEEDED',
    'GIT_ERROR',
    'PATH_CHANGED',
    'PATH_OUTSIDE_SCOPE',
  ]) {
    const definition = PUBLIC_ERRORS[code];
    assert.ok(definition, `${code} has no curated definition`);
    for (const field of ['message', 'impact', 'requiredAction']) {
      assert.equal(typeof definition[field], 'string', `${code}.${field} is not a string`);
      assert.ok(definition[field].trim().length > 0, `${code}.${field} is empty`);
    }
    assert.ok([400, 403, 404, 409, 413, 503].includes(definition.status), `${code} status ${definition.status}`);
  }
});

test('合并复核未通过的回执不许宣称代码没有被改动，也不许鼓励换新操作号', () => {
  // 抛点紧跟在 fastForwardMain 之后：本地 main 可能已经前进。通用 REQUEST_FAILED
  // 的 impact 写着「代码不会被自动清理或覆盖」，与此刻的事实相反；requiredAction
  // 又写「请刷新状态后重试」，等于鼓励换一个操作编号再合并一次。
  const merge = PUBLIC_ERRORS.MERGE_UNVERIFIED;
  assert.ok(merge, 'MERGE_UNVERIFIED is not curated');
  assert.doesNotMatch(merge.impact, /不会被自动清理或覆盖/, 'MERGE_UNVERIFIED still denies a possible branch move');
  assert.match(merge.impact, /可能已经前进/, 'MERGE_UNVERIFIED must state the local line may have moved');
  assert.match(merge.requiredAction, /操作编号/, 'must point at resuming under the original command id');
  assert.doesNotMatch(merge.requiredAction, /刷新状态后重试/, 'must not invite a fresh-command retry');
});

test('送审回执的降级同样被接线到告警，登记过的码不写这一行', () => {
  // 只测 helper 不等于测了调用点：把 `deliveryResponse` 里那一句删掉，本用例必须
  // 变红，而上一条款件仍全绿。合法侧（已登记的码）必须不写，否则告警会被当成噪音删掉。
  const marker = `R35_UNCURATED_CALLSITE_${process.pid}_${Date.now()}`;
  const writes = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    const text = String(chunk);
    if (text.includes('uncurated error code')) writes.push(text);
    return original(chunk);
  };
  try {
    deliveryResponse({ ok: false, code: marker, localSaved: false, pushed: false });
    deliveryResponse({ ok: false, code: 'UNSAFE_REMOTE_URL', localSaved: false, pushed: false });
    deliveryResponse({ ok: true, code: marker });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(writes.length, 1, JSON.stringify(writes));
  assert.match(writes[0], new RegExp(marker));
  assert.match(writes[0], /delivery-messages/);
});

test('未登记的码在塌成通用回执时会先留下一行可诊断告警，且不回显任意文本', async () => {
  // 门禁之外的下限：真正的完整性靠登记，但「静默」本身可以先消灭。
  const writes = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    // 去重是模块级的，用 cache-busting 拿一份干净实例，不受同套件其它文件影响。
    const { noteUncuratedErrorCode } = await import(
      `../src/core/uncurated-error-code.mjs?case=${process.pid}-${Date.now()}`
    );
    assert.equal(noteUncuratedErrorCode('PUBLIC_ERRORS', 'A_FRESH_CODE'), true);
    assert.equal(noteUncuratedErrorCode('PUBLIC_ERRORS', 'A_FRESH_CODE'), false, 'the same code must not repeat forever');
    // 误红面在调用点一侧证明（见 surfacing 文件里的「已登记的码不许告警」）：
    // 这个 helper 按设计不认识任何一张表，它只负责「被叫到了就留下一行」。
    // 泄漏面：任意文本都不许被当成码回显。
    for (const junk of ['C:\\temp\\x', 'lowercase', 'ab', 'a'.repeat(200), '错误码', undefined, null, 42, {}, '']) {
      assert.equal(noteUncuratedErrorCode('PUBLIC_ERRORS', junk), false, `echoed ${String(junk)}`);
    }
  } finally {
    process.stderr.write = original;
  }
  assert.equal(writes.length, 1, JSON.stringify(writes));
  assert.match(writes[0], /A_FRESH_CODE/);
  assert.match(writes[0], /PUBLIC_ERRORS/);
});
