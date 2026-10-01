// Regression pins for scripts/test-support/hostile-driver.mjs.
//
// The hostile-driver guards prove themselves by asserting a marker file was NOT
// created. That only means something if the marker could have been created, and
// Git does not say when it could not: these cases measure that, and then require
// the control to notice. Without a control, "the product refused before Git ran
// the repository's driver" and "this fixture's driver can never run" look the
// same on the screen — which is how the family in audit-2026-09-11 and
// repository-config-guard went green while proving nothing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { gitText } from '../src/git/probe.mjs';
import {
  assertCleanDriverWrites,
  assertDriverAttributeBound,
  hostileDriverBody,
  maskedDriverBody,
} from '../scripts/test-support/hostile-driver.mjs';

// POSIX 的系统临时目录本身可能是符号链接；夹具必须建立在真实路径下。
function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

function container(t, prefix) {
  const base = mkdtempSync(path.join(fixtureTempRoot(), prefix));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'control@example.invalid']);
  git(dir, ['config', 'user.name', 'Control']);
  return dir;
}

test('Git reports success through the product runner when a clean filter cannot write its marker', async (t) => {
  const base = container(t, 'ugk-driver-masked-');
  const repo = initRepo(path.join(base, 'repo'));
  const marker = path.join(base, 'never-written.txt');
  writeFileSync(path.join(repo, 'file.txt'), 'hello\n');
  git(repo, ['add', 'file.txt']);
  git(repo, ['commit', '-qm', 'init']);
  git(repo, ['config', '--local', 'filter.evil.clean', maskedDriverBody(marker)]);
  writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=evil\n');
  git(repo, ['add', '.gitattributes']);
  git(repo, ['commit', '-qm', 'attr']);
  rmSync(marker, { force: true });

  // The product's own command runner: same -c prefix, same stripped environment.
  const status = await gitText(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  assert.match(status, /file\.txt/, 'the tracked file must still read as modified');
  assert.equal(existsSync(marker), false,
    'a chained driver body hides its own failure, so Git never learns the marker was not written');
});

test('the driver control refuses a body whose marker step Git cannot see fail', async (t) => {
  const base = container(t, 'ugk-driver-control-caught-');
  assert.throws(
    () => assertCleanDriverWrites(base, { bodyFor: maskedDriverBody }),
    (error) => error.code === 'HOSTILE_DRIVER_CONTROL_FAILED'
      && /did not|was not created/.test(error.message),
  );
  // The throw must name the consequence, not just the symptom: an operator
  // reading it has to know the guard tests are now uninformative.
  assert.throws(
    () => assertCleanDriverWrites(base, { bodyFor: maskedDriverBody }),
    /cannot prove[\s\S]*refuses to report a pass/,
  );
});

test('the driver control accepts a body Git can run', async (t) => {
  const base = container(t, 'ugk-driver-control-passes-');
  assert.doesNotThrow(() => assertCleanDriverWrites(base));
  // No residue: the control is meant to run inside somebody else's fixture.
  assert.equal(existsSync(path.join(base, 'clean-driver-proof')), false,
    'the control must clean up its throwaway repository');
  assert.equal(existsSync(path.join(base, 'clean-driver-proof-marker.txt')), false);
});

// A configured driver is not a reachable driver: git only runs it once an
// attribute source names it for a path. Fixtures that set `filter.evil.clean`
// and no attribute have a marker that can never appear, which is the shape
// confirm-location.test.mjs and audit-2026-09-27-identity-retry.test.mjs shipped.
test('the attribute control separates a bound driver from a configured one', async (t) => {
  const base = container(t, 'ugk-driver-attribute-');
  const repo = initRepo(path.join(base, 'repo'));
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-qm', 'fixture']);
  git(repo, ['config', '--local', 'filter.evil.clean', hostileDriverBody(path.join(base, 'unbound.txt'))]);

  assert.throws(
    () => assertDriverAttributeBound(repo, 'README.md', 'evil'),
    (error) => error.code === 'HOSTILE_DRIVER_CONTROL_FAILED',
  );

  writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');
  assert.match(assertDriverAttributeBound(repo, 'README.md', 'evil'), /filter: evil/);
});

// The rule itself, so the next fixture cannot quietly reintroduce the shape that
// failed 5 of 40 builds on this machine.
test('a driver body is one command and never relies on a second binary', async (t) => {
  const base = container(t, 'ugk-driver-body-');
  const marker = path.join(base, 'sub', 'dir', 'marker.txt');
  const body = hostileDriverBody(marker);
  assert.equal(body.split(';').length, 1, `chained body would mask its own failure: ${body}`);
  assert.ok(body.includes(`"${process.execPath}"`),
    'the interpreter must be addressed absolutely, not by whatever node is first on PATH');
  assert.ok(body.includes(marker.split(path.sep).join('/')),
    'the marker path must survive the shell Git spawns, which means forward slashes on Windows');
  assert.throws(() => hostileDriverBody(''), /requires the marker path/);
});
