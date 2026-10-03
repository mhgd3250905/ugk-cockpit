// 第 36 轮审计（2026-10-04）· 门禁自身的双向探针，从「手工跑过一次」变成用例。
//
// `scripts/check-test-suite.mjs` 的有效性此前只在台账里被写成「八例双向探针全绿」，
// 仓库里没有任何用例执行过它（`grep -rn check-test-suite test/` 在本轮之前只有
// `test/test-quick.test.mjs` 断言 `pretest` 这个字符串）。台账第 32 轮那句
// 「只有注释判红」因此无人复核，而它当时是错的：块注释里缩进的 `test(` 满足了
// `^\s*test\(` 判据，一个 0 断言的文件照样绿灯通过，runner 还把它记成 1 项通过。
// 本轮把判据换成真实引擎（用录制替身替换 `node:test` 后导入文件，不执行任何用例体），
// 并把两个方向都钉住：违规必须红、合法写法不许红。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const COPIED = [
  'scripts/check-test-suite.mjs',
  'scripts/test-support/count-registrations.mjs',
  'scripts/test-support/registrar-recorder-hooks.mjs',
  'scripts/test-support/registrar-recorder.mjs',
];

function scratchTree(t, testFiles) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-suite-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  for (const relative of COPIED) {
    const dest = path.join(root, relative);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(path.join(REPO, relative), 'utf8'));
  }
  writeFileSync(path.join(root, 'package.json'), '{"name":"gate-fixture","type":"module"}\n');
  for (const [name, body] of Object.entries(testFiles)) {
    const dest = path.join(root, 'test', name);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, `${body}\n`);
  }
  return root;
}

function runGate(root, target = '.') {
  const child = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-test-suite.mjs'), target], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000,
  });
  return { status: child.status, output: `${child.stdout ?? ''}${child.stderr ?? ''}` };
}

const VALID = { 'good.test.mjs': "import test from 'node:test';\n  test('indented is still a declaration', () => {});\n" };

test('合法写法不判红（误红面：缩进声明、平台跳过标注、describe、test.js 后缀）', (t) => {
  const root = scratchTree(t, {
    'good.test.mjs': "import test from 'node:test';\n  test('indented', () => {});\n",
    'platform.test.mjs': "import test from 'node:test';\nconst skip = process.platform === 'win32' && 'windows';\ntest('posix only', { skip }, () => {});\n",
    'grouped.test.mjs': "import { describe, it } from 'node:test';\ndescribe('a group', () => { it('inner', () => {}); });\n",
    'sibling.test.js': "import test from 'node:test';\ntest('js suffix is runner-discovered', () => {});\n",
    'prefixed.test.mjs': "import test from 'node:test';\nexport const NAMES = ['a'];\nawait test('await prefixed', () => {});\n",
  });
  const run = runGate(root);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /5 test file\(s\)/, run.output);
});

for (const [label, body, expect] of [
  ['空文件', '', /registers 0 tests/],
  ['整份被块注释包起来', "import test from 'node:test';\n/*\n  test('never registered', () => {\n    throw new Error('must not run');\n  });\n*/\n", /registers 0 tests/],
  ['只在空列表里注册', "import test from 'node:test';\nfor (const name of []) {\n  test(name, () => {});\n}\n", /registers 0 tests/],
  ['只导出常量', "export const NOTHING = 1;\n", /registers 0 tests/],
  ['导入即炸', "import test from 'node:test';\nthrow new Error('fixture blows up on import');\n", /cannot be imported/],
  ['`.test.js` 同族后缀被空文件钻进来', "export const NOTHING = 1;\n", /sibling-empty\.test\.js[\s\S]*registers 0 tests/],
]) {
  const name = label === '`.test.js` 同族后缀被空文件钻进来' ? 'sibling-empty.test.js' : 'vacuous.test.mjs';
  test(`违规必须判红：${label}`, (t) => {
    const root = scratchTree(t, { ...VALID, [name]: body });
    const run = runGate(root);
    assert.equal(run.status, 1, `expected red for ${label}, got:\n${run.output}`);
    assert.match(run.output, expect, run.output);
  });
}

test('测试目录被改名或清空时门禁红，而不是把「没有用例」当成通过', (t) => {
  const empty = scratchTree(t, {});
  assert.equal(runGate(empty).status, 1);
  assert.match(runGate(empty).output, /no runner-discovered test file/);
  const missing = scratchTree(t, {});
  rmSync(path.join(missing, 'test'), { recursive: true, force: true });
  const run = runGate(missing);
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /cannot read the test tree|no runner-discovered test file/, run.output);
});

test('runner 的 `test-*.mjs` 发现形状必须在门禁视野里', (t) => {
  // 第 36 轮自己踩的坑：`node --test` 会执行 `test-*.mjs`（本机实测），而门禁第一版
  // 只列了四种后缀，于是本仓两个 `test-registrar-*.mjs` helper 被 runner 当成
  // 「0 用例但通过」的文件跑掉，门禁从头到尾没看见它们。
  const root = scratchTree(t, {
    ...VALID,
    'test-helper-shape.mjs': 'export const NOTHING = 1;\n',
  });
  const run = runGate(root);
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /test-helper-shape\.mjs[\s\S]*registers 0 tests/, run.output);
});

test('反向对照：`test-` 前缀但确有内容的模块文件不判红', (t) => {
  const root = scratchTree(t, {
    ...VALID,
    'test-helper-shape.mjs': "import test from 'node:test';\ntest('prefixed shape still counts', () => {});\n",
  });
  const run = runGate(root);
  assert.equal(run.status, 0, run.output);
});

test('反向对照：suite 形状的嵌套注册要算进所属文件', (t) => {
  // 替身如果把 `suite` 原样透传给真实模块，就会出现两件事：只写 suite 的文件被报成
  // 0 注册（误红），以及真实 suite 被排进计数器进程里执行（"runs nothing" 变成假话）。
  // 这里只放一个文件，所以 "1 executable" 同时证明内部用例被看见、外层容器没被当成断言。
  const root = scratchTree(t, {
    'nested.test.mjs': "import { suite, test as t } from 'node:test';\nsuite('group', () => { t('inner', () => {}); });\n",
  });
  const run = runGate(root);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /1 test file\(s\)[\s\S]*1 executable registration\(s\), 0 skipped/, run.output);
});

test('计数与真实 runner 对齐：平台跳过数必须被单独报出来', (t) => {
  const root = scratchTree(t, {
    'one.test.mjs': "import test from 'node:test';\ntest('runs', () => {});\n",
    'skip.test.mjs': "import test from 'node:test';\ntest('annotated skip', { skip: 'by platform' }, () => {});\n",
  });
  const run = runGate(root);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /1 executable registration\(s\), 1 skipped-by-annotation/, run.output);
});

test('替身的导出面必须跟上真实 node:test（缺名字会让合法新测试文件被误红）', async () => {
  // 门禁现在靠 `node:test` 的录制替身数注册数。替身少一个具名导出，将来某个测试文件
  // 只要用到它就会以 "cannot be imported" 判红——那是误红，而误红的守卫会被删掉。
  // 这里不手写清单，直接和真实模块比。
  const real = await import('node:test');
  const shim = await import('../scripts/test-support/registrar-recorder.mjs');
  const missing = Object.keys(real)
    .filter((name) => typeof real[name] === 'function' && !(name in shim));
  assert.deepEqual(missing, [], `shim is missing live node:test exports: ${missing.join(', ')}`);
});

test('只有 describe 头、里面被掏空的用例文件必须判红', (t) => {
  // 第 36 轮第 2 遍补的形状：替身如果不执行 describe 回调，嵌套注册就看不见，
  // 「保住了组名、丢掉了断言」的文件会继续被记成有内容。
  const root = scratchTree(t, {
    'hollow.test.mjs': "import { describe } from 'node:test';\ndescribe('kept the group, dropped every assertion', () => {});\n",
  });
  const run = runGate(root);
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /hollow\.test\.mjs[\s\S]*registers 0 tests/, run.output);
});

test('门禁仍然由 pretest / pretest:quick / pretest:phase0 三个入口执行', async () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const entry = 'node scripts/check-test-suite.mjs';
  for (const hook of ['pretest', 'pretest:quick', 'pretest:phase0']) {
    assert.ok(String(pkg.scripts[hook] ?? '').startsWith(entry), `${hook} no longer runs the gate`);
  }
  // 反向：判据不许只在临时副本里成立——对本仓库自身必须绿。
  // 份数只钉下界不钉等号：等号会在每加一个测试文件的那一轮自己过期，而那类过期
  // 数字正是本仓反复登记过的缺陷形态。
  const child = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'check-test-suite.mjs'), '.'], {
    cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 120_000,
  });
  assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
  const self = /^test suite gate: (\d+) test file\(s\) under \., (\d+) executable registration\(s\), (\d+) skipped-by-annotation$/m
    .exec(child.stdout);
  assert.ok(self, `unparsable gate line: ${child.stdout}`);
  const [, fileCount, executableCount, skippedCount] = self.map(Number);
  assert.ok(fileCount >= 140, `gate only saw ${fileCount} test files`);
  // The gate's own promise is "every file registers at least one thing", so the
  // two reported buckets must together cover the files.
  assert.ok(executableCount + skippedCount >= fileCount,
    `${executableCount}+${skippedCount} cannot cover ${fileCount} files`);
});
