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
import { readdirSync, readFileSync } from 'node:fs';
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

function curatedInPublic(code) {
  return Object.hasOwn(PUBLIC_ERRORS, code);
}

function curatedInDelivery(code) {
  return Object.hasOwn(DELIVERY_ERROR_MESSAGES, code);
}

// 每一张表只查自己的键：`sendError` 读不到 `DELIVERY_ERROR_MESSAGES`，
// `deliveryResponse` 也读不到 `PUBLIC_ERRORS`。用「两张表里任意一张有」当判据的门禁
// 会在另一张表被漏掉时判绿——第 1 轮复核就是这样抓出 preflight 路由上的路径码的。
// 可达性依据（本轮逐条核对调用链，不是推测）。PUBLIC_ERRORS 一侧：
// INVALID_VERDICT 与 CLAIM_SUBMISSION_MISMATCH / INVALID_SOURCE_COMMIT /
// MERGE_UNVERIFIED / SUBMISSION_PROJECT_MISMATCH 由 integrations、
// integration-service、integration-ops 返回或抛出后，经
// /api/v1/mcp/integration/{begin,review,merge} 的 sendError(response, result.code)
// 到达回执；GIT_BUFFER_LIMIT_EXCEEDED、GIT_ERROR 由 git 层抛出后经
// /api/v1/projects/:id/refresh、/api/v1/runs/start 与工作副本 reuse 路由到达
// 同一个 sendError；PATH_CHANGED、PATH_OUTSIDE_SCOPE 由 path-guard 在
// observeRegisteredProject 的授权与复核两步抛出，而 refresh 处理函数体没有
// try，直接落到请求处理末尾的 catch。delivery-messages 一侧：preflight 与 submit
// 两条路由的 catch 把任何带字符串码的错误交给 deliveryResponse，因此送审链路上
// 的路径码、探测超限与远程地址拒绝都走这张表。submission-service 的码不在任何
// 一侧——src/ 内零引用，登记为已核查不可达，本轮不为其编造文案。
const RENDERED_BY = {
  PUBLIC_ERRORS: [
    'PATH_OUTSIDE_SCOPE', 'PATH_CHANGED', 'GIT_BUFFER_LIMIT_EXCEEDED', 'GIT_ERROR',
    'INVALID_VERDICT', 'CLAIM_SUBMISSION_MISMATCH', 'INVALID_SOURCE_COMMIT',
    'MERGE_UNVERIFIED', 'SUBMISSION_PROJECT_MISMATCH',
    // 由集成路由转手出来的送审码：`sendError` 只查这张表。
    'DELIVERY_CHECK_FAILED', 'DELIVERY_REMOTE_CHANGED', 'DELIVERY_REVIEW_REF_UNAVAILABLE',
    'DELIVERY_SOURCE_UPDATED',
  ],
  'delivery-messages': [
    'CREDENTIALS_IN_REMOTE_URL', 'DELIVERY_CHECK_FAILED', 'DELIVERY_SOURCE_NOT_FOUND',
    'SOURCE_STATE_CHANGED', 'TREE_MISMATCH', 'REMOTE_BRANCH_NOT_FOUND',
    'UNSAFE_REMOTE_NAME', 'GIT_BUFFER_LIMIT_EXCEEDED',
    'PATH_OUTSIDE_SCOPE', 'PATH_CHANGED', 'REPARSE_POINT',
    'WORKTREE_IDENTITY_CHANGED', 'PATH_NOT_AUTHORIZED', 'PUSH_REMOTE_AMBIGUOUS',
    'SOURCE_COMMIT_MISMATCH', 'GIT_ALTERNATE_UNRESOLVED', 'GIT_METADATA_TOO_LARGE',
  ],
};

// 两个渲染器都会拿到的码：必须在**两张**表里都有，否则其中一个仍在降级。
// 这张清单是人工维护的（机械推导「哪条链能产出哪个码」需要近似一个解释器，本轮
// 不做），所以它只保证已审计过的成员不掉队——登记为已实测局限。
const BOTH_TABLES = [
  'DELIVERY_CHECK_FAILED', 'GIT_BUFFER_LIMIT_EXCEEDED', 'PATH_OUTSIDE_SCOPE', 'PATH_CHANGED',
  'REPARSE_POINT', 'WORKTREE_IDENTITY_CHANGED', 'PATH_NOT_AUTHORIZED', 'PROJECT_NOT_FOUND',
];

test('跨两个渲染表面的码在两张表里都有登记（不许只堵一个表面）', () => {
  for (const code of BOTH_TABLES) {
    assert.ok(curatedInPublic(code), `${code} missing from PUBLIC_ERRORS`);
    assert.ok(curatedInDelivery(code), `${code} missing from DELIVERY_ERROR_MESSAGES`);
  }
  // 提取式形状钉：这张清单本身不许空转。
  assert.ok(BOTH_TABLES.length >= 6);
});

test('送审表里凡是保存路径之后还能抛出的码，文案都不许否认本地成果存在', () => {
  // `deliveryResponse` 用 result.localSaved / result.pushed 派生 impact；而
  // delivery-ops 在 commit-tree + update-ref + afterRefUpdate **之后**才做
  // revalidateAuthorizedPath(indexScope)，其 catch 又把 error.localSaved 置真。
  // 所以这些码的文案若断言「没有修改/没有保存」，就会与同一份响应里的 impact
  // 自相矛盾——本轮修的那个形状的复发面。
  const savePathCodes = ['PATH_CHANGED', 'REPARSE_POINT', 'GIT_BUFFER_LIMIT_EXCEEDED',
    'DELIVERY_CHECK_FAILED', 'WORKTREE_IDENTITY_CHANGED', 'PATH_OUTSIDE_SCOPE'];
  const denials = /没有保存|没有上传任何|没有修改、切换或删除任何文件|未保存/;
  for (const code of savePathCodes) {
    const [message, action] = DELIVERY_ERROR_MESSAGES[code];
    assert.ok(message && action, `${code} missing from DELIVERY_ERROR_MESSAGES`);
    assert.doesNotMatch(`${message} ${action}`, denials,
      `${code} denies a local result that its own save path can already have produced`);
    // 两条真值分支都要读得通。
    for (const flags of [{ localSaved: true, pushed: false }, { localSaved: false, pushed: false }]) {
      const rendered = deliveryResponse({ ok: false, code, ...flags });
      assert.equal(rendered.message, message);
      assert.ok(rendered.required_action.startsWith(action));
    }
  }
  // 反向对照：这条判据不能只会红——被忽略内容确认挡下的删除用的就是这种全称否认，
  // 而那条路径上确实还没有任何本地成果。
  assert.match(DELIVERY_ERROR_MESSAGES.DELIVERY_CONTENT_TOO_LARGE[1], /平台保留现有文件/);
});

test('本轮登记的每个码都出现在真正会渲染它的那张表里，且文案不是通用兜底的复读', () => {
  const generic = PUBLIC_ERRORS.REQUEST_FAILED;
  const deliveryGeneric = ['送审检查或保存没有完成，不能确认已送达审核。', '请核对错误代码、远端连接与分支状态；保留已有改动，不要强推或重置。'];
  for (const [surface, codes] of Object.entries(RENDERED_BY)) {
    for (const code of codes) {
      if (surface === 'PUBLIC_ERRORS') {
        assert.ok(curatedInPublic(code), `${code} missing from PUBLIC_ERRORS (rendered by sendError)`);
        const definition = PUBLIC_ERRORS[code];
        for (const field of ['message', 'impact', 'requiredAction']) {
          assert.equal(typeof definition[field], 'string', `${code}.${field} is not a string`);
          assert.ok(definition[field].trim().length > 0, `${code}.${field} is empty`);
          // 形状钉：把通用回执的三件套原样复制进来，必须判红。
          assert.notEqual(definition[field], generic[field],
            `${code}.${field} is a copy of the generic REQUEST_FAILED wording`);
        }
        assert.ok([400, 403, 404, 409, 413, 503].includes(definition.status), `${code} status ${definition.status}`);
      } else {
        assert.ok(curatedInDelivery(code), `${code} missing from DELIVERY_ERROR_MESSAGES (rendered by deliveryResponse)`);
        const pair = DELIVERY_ERROR_MESSAGES[code];
        assert.equal(pair.length, 2, `${code} must be [message, required_action] like its family`);
        assert.notEqual(pair[0], deliveryGeneric[0], `${code} message copies the generic delivery receipt`);
        assert.notEqual(pair[1], deliveryGeneric[1], `${code} action copies the generic delivery receipt`);
      }
    }
  }
});

test('兜底码的文案必须与它自己那两条真值字段兼容（不许再说「没有保存」）', () => {
  // DELIVERY_CHECK_FAILED 是 preflight 与 submit 两条路径共同的 catch-all，而
  // submit 的 catch 在 recordDelivery 已经建好并推上本地成果之后仍会到达（例如
  // after_delivery_receipt 注入点抛出）。同一份响应里 localSaved/pushed 是真值、
  // impact 由它们派生，所以文案若断言「没有保存或上传」就会与自己的字段矛盾——
  // 这正是本轮在修的那类谎，只不过这次是我自己写进去的。
  const [message, action] = DELIVERY_ERROR_MESSAGES.DELIVERY_CHECK_FAILED;
  const denial = /没有保存|没有上传任何|未保存/;
  assert.doesNotMatch(message, denial, 'DELIVERY_CHECK_FAILED denies a save it cannot rule out');
  assert.doesNotMatch(action, denial, 'DELIVERY_CHECK_FAILED action denies a save it cannot rule out');
  // 两条分支都要读得通：impact 由 localSaved/pushed 派生，文案不得与之一致性相反。
  const saved = deliveryResponse({ ok: false, code: 'DELIVERY_CHECK_FAILED', localSaved: true, pushed: true });
  const notSaved = deliveryResponse({ ok: false, code: 'DELIVERY_CHECK_FAILED', localSaved: false, pushed: false });
  assert.match(saved.impact, /代码已上传/);
  assert.match(notSaved.impact, /尚未确认新的保存/);
  assert.equal(saved.message, message);
  assert.match(action, /确认这次是否已经留下本地成果|原操作号/);
});

test('没有出现在任何一张表里的码，端到端仍只能得到通用回执（不许发明第三处兜底）', () => {
  const absent = 'DEFINITELY_NOT_CURATED_ANYWHERE_R35';
  assert.equal(curatedInPublic(absent), false);
  assert.equal(curatedInDelivery(absent), false);
  const viaDelivery = deliveryResponse({ ok: false, code: absent, localSaved: false, pushed: false });
  assert.equal(viaDelivery.code, absent, 'deliveryResponse must not rewrite the code');
  const viaSend = PUBLIC_ERRORS[absent] ?? PUBLIC_ERRORS.REQUEST_FAILED;
  assert.equal(viaSend, PUBLIC_ERRORS.REQUEST_FAILED);
});

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
  const missing = [...codes].filter((code) => !curatedInDelivery(code)).sort();
  assert.deepEqual(missing, [], 'remote URL rejection codes without curated delivery wording');
});

test('族提取的覆盖面按「写法总数」核对，不只是按结果集合（防只看一种形状）', () => {
  // 折叠断言只能发现成员**消失**，发现不了新写法被正则整个跳过。这里用与提取式
  // 无关的计数做独立核对：`new PathScopeError(` 的每一次出现都必须被两种写法之一
  // 消费掉，否则说明有人用了第三种写法（双引号、模板串、变量第二参数……）。
  const source = readRepositoryFile('src/core/path-guard.mjs');
  const throwSites = (source.match(/new\s+PathScopeError\(/g) ?? []).length;
  const explicit = (source.match(/new\s+PathScopeError\(\s*'[^']*'\s*,\s*'[A-Z][A-Z0-9_]+'\s*\)/g) ?? []).length;
  const bare = (source.match(/new\s+PathScopeError\(\s*'[^']*'\s*\)/g) ?? []).length;
  assert.equal(explicit + bare, throwSites,
    `path-guard throw sites ${throwSites} but extraction consumed ${explicit + bare}`);
  // 构造器默认码必须仍然是那一个，否则「裸写 = PATH_OUTSIDE_SCOPE」的前提失效。
  assert.match(source, /constructor\(message, code = 'PATH_OUTSIDE_SCOPE'\)/);
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

test('路径回执不许声称「读到了内容之前」就停止（本轮自查引入的失实句已钉住）', () => {
  // 抛序事实：observeRegisteredProject 先 authorizeExistingPath，再 await
  // observeProjectFolder（这一步真的读过 Git 状态），最后才是抛 PATH_CHANGED 的
  // revalidateAuthorizedPath。第一版文案写着「在读到任何内容之前就停止了」，是
  // 本轮自己写进去的失实句——守卫文案里的「谁读了什么」同样要对着调用序核。
  const changed = PUBLIC_ERRORS.PATH_CHANGED;
  assert.ok(changed, 'PATH_CHANGED is not curated');
  assert.doesNotMatch(changed.impact, /读到任何内容之前|没有读取/, 'PATH_CHANGED denies a read that does happen');
  assert.match(changed.impact, /没有修改、切换或删除任何文件/);
  // PATH_OUTSIDE_SCOPE 由 authorizeExistingPath 抛出，确实在任何文件读取之前，
  // 但 realpath 属于元数据操作，文案不许扩大到「任何内容」。
  assert.match(PUBLIC_ERRORS.PATH_OUTSIDE_SCOPE.impact, /文件内容/, 'scope denial must not overclaim to metadata');
});

test('告警只点名码本身：大写常量原样、其它形状只报种类、没有码时不报', async () => {
  // 产生者的码不总是字符串：`git()` 原样重抛 execFile 错误，其 code 是数字退出码
  // （送审层自己就按 `typeof error.code === 'number'` 分支），Node errno 是小写串。
  // 只报「大写常量名」会让这一类降级继续静默；原样回显又会把子进程打印的东西
  // 抄进日志。因此分三档：常量名照说，其它形状只说种类，没有码不说。
  const all = [];
  const writes = [];
  const drain = () => { const taken = writes.splice(0, writes.length); all.push(...taken); return taken; };
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    // 去重是模块级的，用 cache-busting 拿一份干净实例，不受同套件其它文件影响。
    const { noteUncuratedErrorCode } = await import(
      `../src/core/uncurated-error-code.mjs?case=${process.pid}-${Date.now()}`
    );
    assert.equal(noteUncuratedErrorCode('PUBLIC_ERRORS', 'A_FRESH_CODE'), true);
    assert.equal(drain().length, 1);
    assert.equal(noteUncuratedErrorCode('PUBLIC_ERRORS', 'A_FRESH_CODE'), false, 'the same code must not repeat forever');
    assert.equal(drain().length, 0);
    // 非大写常量的形状按「种类」归并：第一件报警一次，之后同类不再刷屏，且任何
    // 一件的原始值都不许出现在日志里。
    assert.equal(noteUncuratedErrorCode('PUBLIC_ERRORS', 'eACCES'), true, 'silent on a lowercase errno');
    assert.match(drain().join(''), /string-code/);
    assert.equal(noteUncuratedErrorCode('PUBLIC_ERRORS', '-x'), false, 'same shape bucket must not re-warn');
    assert.equal(drain().length, 0);
    assert.equal(noteUncuratedErrorCode('PUBLIC_ERRORS', 128), true, 'silent on a numeric exit code');
    const numeric = drain().join('');
    assert.match(numeric, /number-code/);
    assert.doesNotMatch(numeric, /128/, 'echoed the raw exit status');
    // 大写 errno 名与产品常量同形状，但它是「文件/网络出错」而不是「表里缺一项」；
    // 说成后者会把调查方向带到不存在的缺失上。允许带出名字，因为名字是 OS 常量。
    assert.equal(noteUncuratedErrorCode('PUBLIC_ERRORS', 'ENOENT'), true);
    const errnoLine = drain().join('');
    assert.match(errnoLine, /errno\(ENOENT\)/);
    assert.doesNotMatch(errnoLine, /uncurated error code "ENOENT"/, 'errno reported as a table miss');
    assert.equal(noteUncuratedErrorCode('PUBLIC_ERRORS', 'EACCES'), true);
    assert.match(drain().join(''), /errno\(EACCES\)/, 'each errno name stays individually diagnosable');
    // 不许把任意文本当码回显，也不许把「根本没有码」说成表里缺一项。
    for (const junk of ['C:\\temp\\x', 'a'.repeat(200), '错误码', undefined, null, {}, '']) {
      const shaped = /^[A-Z][A-Z0-9_]{2,63}$/.test(String(junk ?? ''));
      assert.equal(noteUncuratedErrorCode('PUBLIC_ERRORS', junk), shaped && typeof junk === 'string');
      assert.ok(!drain().some((line) => /temp|错误码/.test(line)), `echoed ${String(junk)}`);
    }
  } finally {
    process.stderr.write = original;
  }
  assert.match(all.join(''), /A_FRESH_CODE/);
  assert.match(all.join(''), /PUBLIC_ERRORS/);
  assert.ok(!all.some((line) => /eACCES|128/.test(line)), `echoed a raw value: ${JSON.stringify(all)}`);
});

// 第 36 轮审计（2026-10-04）· caught-error 收束族。
//
// `mergeApprovedSubmissionOnce` 的外层 catch 原先写成 `error.code ?? 'INTEGRATION_FAILED'`，
// 而 `git()` 对失败的 git 子进程原样重抛 execFile 错误：其 `code` 是数字退出码
// （本机实测 128）。`128 ?? x` 取的是 128，于是这个数字同时成为 HTTP 回执里的 `code`
// （表里查不到 → 降级成通用回执，真实码丢失）与 `integration_attempts.last_error_code`
// 及命令流水里的持久值，重放时原样再发一次。`publicErrorCode` 把「什么才算产品码」
// 收在一处，判据沿用本文件上面那条告警的同一形状。
//
// 兜底字面量按文件核对到**渲染它的那张表**：本族的文件清单与表面归属是人工维护的
// （和上面 RENDERED_BY 同一款已实测局限），但「新增一个收束点却忘了登记兜底码」
// 与「把兜底写成变量/模板串从而绕过提取」这两类都会立刻判红。
const COLLAPSE_SITES = [
  { file: 'src/core/integration-service.mjs', tables: ['PUBLIC_ERRORS'] },
  { file: 'src/core/workspaces.mjs', tables: ['PUBLIC_ERRORS'] },
  // 送审结果的码可能同时被两张表读到，因此这里的兜底要求两边都在。
  { file: 'src/core/delivery-service.mjs', tables: ['PUBLIC_ERRORS', 'delivery-messages'] },
];

const COLLAPSE_FILES = COLLAPSE_SITES.map((site) => site.file);

function collapseFallbacks(source) {
  return [...source.matchAll(/publicErrorCode\(\s*[\w.]+\s*,\s*'([A-Z][A-Z0-9_]+)'\s*\)/g)].map((m) => m[1]);
}

test('publicErrorCode 的每个兜底字面量都在渲染它的表里登记', () => {
  let sites = 0;
  for (const { file, tables } of COLLAPSE_SITES) {
    const source = readRepositoryFile(file);
    const calls = (source.match(/publicErrorCode\(/g) ?? []).length;
    const fallbacks = collapseFallbacks(source);
    // 消费计数钉：调用了 N 次就必须提取到 N 个字面量兜底。写成变量、模板串或
    // 漏参数都会在这里断开，而不是静默少审一个落点。
    assert.equal(fallbacks.length, calls, `${file}: ${calls} collapse sites but extraction consumed ${fallbacks.length}`);
    sites += calls;
    for (const code of new Set(fallbacks)) {
      for (const table of tables) {
        const curated = table === 'PUBLIC_ERRORS' ? curatedInPublic(code) : curatedInDelivery(code);
        assert.ok(curated, `${file}: fallback ${code} is not curated in ${table}, so collapsing only renames the miss`);
      }
    }
  }
  // 形状钉：提取式退化成一个也不匹配时，上面每条断言都会空转。
  assert.ok(sites >= 9, `expected the whole collapse family, extracted ${sites} sites`);
});

test('收束规则本身双向可判：数字与 errno 塌、产品码原样、坏兜底响亮失败', async () => {
  const { publicErrorCode, isProductErrorCode } = await import(
    `../src/core/uncurated-error-code.mjs?collapse-case=${process.pid}-${Date.now()}`
  );
  // 应被抓到的违规形状：`git()` 的真实产物。
  assert.equal(publicErrorCode(128, 'INTEGRATION_FAILED'), 'INTEGRATION_FAILED', 'numeric exit status passed through');
  assert.equal(publicErrorCode('ENOENT', 'INTEGRATION_FAILED'), 'INTEGRATION_FAILED', 'errno passed through');
  assert.equal(publicErrorCode('eACCES', 'INTEGRATION_FAILED'), 'INTEGRATION_FAILED', 'lowercase errno passed through');
  assert.equal(publicErrorCode('git exited', 'INTEGRATION_FAILED'), 'INTEGRATION_FAILED', 'free text passed through');
  assert.equal(publicErrorCode(undefined, 'INTEGRATION_FAILED'), 'INTEGRATION_FAILED');
  assert.equal(publicErrorCode(null, 'INTEGRATION_FAILED'), 'INTEGRATION_FAILED');
  // 合法写法（误红面）：产品码必须原样，否则这条守卫会把已登记的回执也塌成通用码。
  assert.equal(publicErrorCode('GIT_BUFFER_LIMIT_EXCEEDED', 'INTEGRATION_FAILED'), 'GIT_BUFFER_LIMIT_EXCEEDED');
  assert.equal(isProductErrorCode('PATH_CHANGED'), true);
  assert.equal(isProductErrorCode('ENOENT'), false, 'errno must not be mistaken for a product code');
  // 守卫自己不许带着一个没登记的兜底上线：那样只是把 128 换成另一个静默缺失。
  assert.throws(() => publicErrorCode(128, 128), TypeError);
  assert.throws(() => publicErrorCode(128, 'definitely_not_curated'), TypeError);
});

// 上一条款件只保证「已经收束的落点兜底是登记的」。把某个落点整体退回
// `error.code ?? 'X'` 时，调用次数与提取次数会**一起**少一，上面的消费钉仍然全绿
// ——第 36 轮变异矩阵实测如此（M1、M4 退回原写法后本文件的判据都没红）。所以再加
// 一条形状禁令：本族文件里不许再出现「把 caught error 的 code 直接当公开码/持久码」。
const COLLAPSE_FORBIDDEN = [
  [/code\s*:\s*error\.code\b(?!\s*\))/g, 'code: error.code'],
  [/,error\.code\s*\?\?|,\s*error\.code\s*\?\?/g, ', error.code ??'],
  [/retryableMergeError\([^)]*error\.code/gs, 'retryableMergeError(..., error.code'],
  [/failCommand\([^)]*code:\s*error\.code/gs, 'failCommand(... code: error.code'],
];

test('接入与开发空间族文件里不再出现把 caught-error 码直接当公开码的写法', () => {
  for (const file of COLLAPSE_FILES) {
    const source = readRepositoryFile(file);
    for (const [pattern, label] of COLLAPSE_FORBIDDEN) {
      const hits = [...source.matchAll(pattern)];
      assert.deepEqual(hits, [], `${file}: ${label} escaped the collapse rule again`);
    }
  }
});

// 豁免必须自带前提，并且前提本身每次重查：`submission-service.mjs` 有同形状的写法
// 却按「src/ 内零引用 = 不可达」登记不修（第 35 轮实测）。那种结论有保质期——
// 一旦有人接上它，本条就会红，而不是等到用户在回执里看到数字退出码。
const COLLAPSE_EXEMPTIONS = {
  'src/core/submission-service.mjs': 'code: error.code',
};

test('不可达豁免的前提仍然成立（被接上就必须收束）', () => {
  const srcFiles = readdirSync(new URL('../src/', import.meta.url), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => `src/${name.replaceAll('\\', '/')}`);
  assert.ok(srcFiles.length > 40, `src walk only produced ${srcFiles.length} modules`);
  for (const [file, label] of Object.entries(COLLAPSE_EXEMPTIONS)) {
    // 前提一：该文件确实还带着这种写法（否则豁免对象已消失，应删除本条）。
    assert.ok(readRepositoryFile(file).includes(label), `${file} no longer needs the exemption`);
    // 前提二：src/ 里没有任何模块 import 它。按 import 位置匹配，注释里提一句
    // 不算被接上。
    const base = file.split('/').pop();
    const importShape = new RegExp(`from\\s+'[^']*${base}'`);
    const referrers = srcFiles.filter((candidate) => candidate !== file
      && importShape.test(readRepositoryFile(candidate)));
    assert.deepEqual(referrers, [], `${file} is now imported by ${referrers.join(', ')}: collapse its codes too`);
  }
});
