import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { QUICK_TEST_FILES, runQuickTests } from '../scripts/run-quick-tests.mjs';

test('quick selects existing files once with process isolation; full retains automatic discovery and argument forwarding', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test --test-concurrency=1');
  assert.equal(pkg.scripts.pretest, 'node scripts/check-test-suite.mjs .');
  let calls = 0;
  const status = runQuickTests({ log() {}, run(executable, args, options) {
    calls++;
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, ['--test', '--test-concurrency=2', ...QUICK_TEST_FILES]);
    assert.equal(new Set(args.slice(2)).size, QUICK_TEST_FILES.length);
    assert.equal(path.isAbsolute(options.cwd), true);
    assert.equal(options.stdio, 'inherit');
    return { status: 0, signal: null };
  } });
  assert.equal(status, 0);
  assert.equal(calls, 1);
});

test('quick preserves failed test exits and rejects spawn failures or signal termination', () => {
  const invoke = (result) => runQuickTests({ log() {}, run: () => result });
  assert.equal(invoke({ status: 7 }), 7);
  assert.equal(invoke({ status: null }), 1);
  assert.throws(() => invoke({ error: new Error('spawn failed') }), /spawn failed/);
  assert.throws(() => invoke({ status: null, signal: 'SIGTERM' }), /SIGTERM/);
});

test('two native Node shards discover every fixture once, including a newly added file', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-shard-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'scripts/test-support'), { recursive: true });
  for (const helper of ['scripts/run-quick-tests.mjs', 'scripts/test-support/deadline.mjs']) {
    writeFileSync(path.join(root, helper), "throw new Error('Helper must not be discovered as a test');\n");
  }
  // No explicit file list: an unknown new test must enter full discovery.
  for (let index = 0; index < 5; index++) {
    writeFileSync(path.join(root, `fixture-${index}.test.mjs`),
      `import test from 'node:test'; test('shard-fixture-${index}', () => {});\n`);
  }
  const seen = [];
  const env = { ...process.env };
  // This is a new runner, not a child test worker of the current runner.
  delete env.NODE_TEST_CONTEXT;
  for (const shard of ['1/2', '2/2']) {
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', `--test-shard=${shard}`, '--test-reporter=tap'], {
      cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const names = [...result.stdout.matchAll(/# Subtest: (shard-fixture-\d+)/g)].map((match) => match[1]);
    assert.ok(names.length > 0);
    seen.push(...names);
  }
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
});
