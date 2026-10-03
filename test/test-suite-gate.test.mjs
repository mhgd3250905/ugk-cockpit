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
  'scripts/test-support/count-test-registrations.mjs',
  'scripts/test-support/test-registrar-hooks.mjs',
  'scripts/test-support/test-registrar-shim.mjs',
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

test('计数与真实 runner 对齐：平台跳过数必须被单独报出来', (t) => {
  const root = scratchTree(t, {
    'one.test.mjs': "import test from 'node:test';\ntest('runs', () => {});\n",
    'skip.test.mjs': "import test from 'node:test';\ntest('annotated skip', { skip: 'by platform' }, () => {});\n",
  });
  const run = runGate(root);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /1 executable registration\(s\), 1 skipped-by-annotation/, run.output);
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
