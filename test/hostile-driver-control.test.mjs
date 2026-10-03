// Regression pins for scripts/test-support/hostile-driver.mjs.
//
// The hostile-driver guards prove themselves by asserting a marker file was NOT
// created. That only means something if the marker could have been created, and
// Git does not say when it could not: these cases measure that, then require the
// control to notice. Without a control, "the product refused before Git ran the
// repository's driver" and "this fixture's driver can never run" look the same on
// the screen — which is how the family in audit-2026-09-11 and
// repository-config-guard could go green while proving nothing, and how main's CI
// became intermittently red on the one assertion that could still notice.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { gitText } from '../src/git/probe.mjs';
import {
  assertCleanDriverRunsHere,
  assertDriverAttributeBound,
  git,
  hostileDriverBody,
  initFixtureRepo,
  maskedDriverBody,
  nodeDriverBody,
} from '../scripts/test-support/hostile-driver.mjs';

// POSIX 的系统临时目录本身可能是符号链接；夹具必须建立在真实路径下。
function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

function container(t, prefix) {
  const base = mkdtempSync(path.join(fixtureTempRoot(), prefix));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return base;
}

// A repository that binds `filter=evil` to *.txt, points the driver at a marker,
// and then leaves the tracked file modified — the state the shipped fixture
// creates. Skipping that last step would let a case here pass on Git's
// attribute-change re-clean alone, i.e. assert about a state nobody created.
function hostileRepo(base, { body = hostileDriverBody } = {}) {
  const repo = initFixtureRepo(path.join(base, 'repo'));
  const marker = path.join(base, 'sentinel.txt');
  writeFileSync(path.join(repo, 'file.txt'), 'hello\n');
  git(repo, ['add', 'file.txt']);
  git(repo, ['commit', '-qm', 'init']);
  git(repo, ['config', '--local', 'filter.evil.clean', body(marker)]);
  writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=evil\n');
  git(repo, ['add', '.gitattributes']);
  git(repo, ['commit', '-qm', 'attr']);
  writeFileSync(path.join(repo, 'file.txt'), 'changed\n');
  rmSync(marker, { force: true });
  return { repo, marker };
}

test('Git reports success through the product runner when a clean filter cannot write its marker', async (t) => {
  const base = container(t, 'ugk-driver-masked-');
  const { repo, marker } = hostileRepo(base, { body: maskedDriverBody });

  // The product's own command runner: same -c prefix, same stripped environment.
  const status = await gitText(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  assert.match(status, /file\.txt/, 'the tracked file must still read as modified');
  assert.equal(existsSync(marker), false,
    'a chained driver body hides its own failure, so Git never learns the marker was not written');
});

test('the control refuses a chained driver body in the very repository that uses it', async (t) => {
  const base = container(t, 'ugk-driver-caught-');
  const { repo, marker } = hostileRepo(base, { body: maskedDriverBody });
  const indexBefore = git(repo, ['ls-files', '--stage']);
  // Bidirectional: the violation is caught, and the message names the
  // consequence rather than only the symptom.
  assert.throws(
    () => assertCleanDriverRunsHere(repo, marker),
    (error) => error.code === 'HOSTILE_DRIVER_CONTROL_FAILED'
      && /did not create its marker/.test(error.message)
      && /cannot prove[\s\S]*refuses to report a pass/.test(error.message),
  );
  // Cleanup runs even on the throwing branch: a leftover control file or staged
  // entry would change the repository the product is then shown.
  assert.equal(existsSync(path.join(repo, 'hostile-driver-control.txt')), false,
    'the control has to remove its control file even when it fails');
  assert.equal(git(repo, ['ls-files', '--stage']), indexBefore,
    'the control has to unstage its control file even when it fails');
});

test('the control accepts a driver body Git can run, and leaves the repository as it found it', async (t) => {
  const base = container(t, 'ugk-driver-passes-');
  const { repo, marker } = hostileRepo(base);
  const indexBefore = git(repo, ['ls-files', '--stage']);
  assert.doesNotThrow(() => assertCleanDriverRunsHere(repo, marker));
  assert.equal(git(repo, ['ls-files', '--stage']), indexBefore,
    'the control must unstage its control file, so the repository the product sees is unchanged');
  assert.equal(existsSync(path.join(repo, 'hostile-driver-control.txt')), false);
  assert.equal(existsSync(marker), false, 'the control removes the marker it produced');
});

// A configured driver is not a reachable driver: Git only runs it once an
// attribute source names it for a path. Fixtures that set `filter.evil.clean`
// with no attribute have a marker that can never appear — the shape
// confirm-location.test.mjs and audit-2026-09-27-identity-retry.test.mjs shipped.
test('the attribute control separates a bound driver from a configured one', async (t) => {
  const base = container(t, 'ugk-driver-unbound-');
  const repo = initFixtureRepo(path.join(base, 'repo'));
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-qm', 'fixture']);
  git(repo, ['config', '--local', 'filter.evil.clean', hostileDriverBody(path.join(base, 'never.txt'))]);

  assert.throws(
    () => assertDriverAttributeBound(repo, 'README.md', 'evil'),
    (error) => error.code === 'HOSTILE_DRIVER_CONTROL_FAILED'
      && /not filter=evil/.test(error.message),
  );

  writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');
  assert.equal(assertDriverAttributeBound(repo, 'README.md', 'evil'), 'evil');
});

// The control's own comparison must not be a prefix match: measured, a repository
// bound to `filter=evil2` satisfied `report.includes('filter: evil')`, so the
// control that exists to rule out vacuity passed for a different driver.
test('the attribute control does not accept a longer driver name as a match', async (t) => {
  const base = container(t, 'ugk-driver-prefix-');
  const repo = initFixtureRepo(path.join(base, 'repo'));
  writeFileSync(path.join(repo, 'file.txt'), 'x\n');
  git(repo, ['add', 'file.txt']);
  git(repo, ['commit', '-qm', 'x']);
  git(repo, ['config', '--local', 'filter.evil2.clean', ':']);
  writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* filter=evil2\n');

  assert.throws(
    () => assertDriverAttributeBound(repo, 'file.txt', 'evil'),
    (error) => error.code === 'HOSTILE_DRIVER_CONTROL_FAILED'
      && /filter=evil2/.test(error.message),
  );
  assert.equal(assertDriverAttributeBound(repo, 'file.txt', 'evil2'), 'evil2');
});

// Ask Git what the command actually ran and what its filter returned. Parsing
// the command string would mistake a quoted semicolon for a second command or
// reject the escaping required by an apostrophe in the interpreter's path.
test('a driver body runs the current interpreter without fabricating filter output', async (t) => {
  const base = container(t, 'ugk-driver-body-');
  const repo = initFixtureRepo(path.join(base, 'repo'));
  writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=identity\n');
  git(repo, ['add', '.gitattributes']);
  git(repo, ['commit', '-qm', 'attributes']);
  git(repo, ['config', '--local', 'filter.identity.clean',
    nodeDriverBody('process.stdout.write(process.execPath)')]);
  writeFileSync(path.join(repo, 'interpreter.txt'), 'control\n');
  git(repo, ['add', '--', 'interpreter.txt']);
  assert.equal(git(repo, ['show', ':interpreter.txt']), process.execPath,
    'the driver must run this interpreter, including when another node is on PATH');

  const marker = path.join(base, 'sentinel.txt');
  git(repo, ['config', '--local', 'filter.identity.clean', hostileDriverBody(marker)]);
  writeFileSync(path.join(repo, 'body.txt'), 'control\n');
  git(repo, ['add', '--', 'body.txt']);
  assert.equal(existsSync(marker), true, 'the driver must produce its marker');
  assert.equal(git(repo, ['cat-file', '-s', ':body.txt']), '0',
    'the marker command must not fabricate successful filter output');
  assert.throws(() => hostileDriverBody(''), /requires the marker path/);
});

// The other half of the same lesson: do not let anyone re-justify this family by
// "Git will fail if the driver fails". It does not.
test('Git ignores a failing clean filter unless the driver is marked required', async (t) => {
  const base = container(t, 'ugk-driver-required-');
  const repo = initFixtureRepo(path.join(base, 'repo'));
  const body = nodeDriverBody('process.exit(3)');
  git(repo, ['config', '--local', 'filter.e.clean', body]);
  writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=e\n');
  git(repo, ['add', '.gitattributes']);
  git(repo, ['commit', '-qm', 'attributes']);
  git(repo, ['config', '--local', 'filter.e.required', 'false']);
  writeFileSync(path.join(repo, 'optional.txt'), 'one\n');
  git(repo, ['add', '--', 'optional.txt']);
  assert.match(git(repo, ['diff', '--cached', '--name-only']), /optional\.txt/,
    'a non-required filter that exits non-zero must still let git add succeed');

  git(repo, ['config', '--local', 'filter.e.required', 'true']);
  writeFileSync(path.join(repo, 'mandatory.txt'), 'two\n');
  assert.throws(
    () => git(repo, ['add', '--', 'mandatory.txt']),
    (error) => /external filter .* failed 3/.test(String(error.stderr ?? error.message)),
  );
});

// Re-run the real Git controls with the same Node binary at paths that broke
// the old command-string assertions and the unescaped failing-driver command.
// A copied executable is intentional: a symlink can make process.execPath
// resolve back to its ordinary installation path and miss the regression.
test('the Git controls work when the Node installation path needs shell quoting', async (t) => {
  const base = container(t, 'ugk-driver-node-path-');
  const selected = [
    'the control accepts a driver body Git can run, and leaves the repository as it found it',
    'a driver body runs the current interpreter without fabricating filter output',
    'Git ignores a failing clean filter unless the driver is marked required',
  ];
  const selectedPattern = `^(${selected.join('|')})$`;
  const testFile = fileURLToPath(import.meta.url);
  const childEnvironment = { ...process.env };
  // A nested --test invocation must start a new runner. The parent runner's
  // private marker would otherwise make it act as an empty test-file child.
  delete childEnvironment.NODE_TEST_CONTEXT;
  for (const directoryName of ["o'brien Node", 'semicolon; Node']) {
    await t.test(directoryName, () => {
      const directory = path.join(base, directoryName);
      mkdirSync(directory);
      const executable = path.join(directory, path.basename(process.execPath));
      copyFileSync(process.execPath, executable);
      if (process.platform !== 'win32') chmodSync(executable, 0o755);
      const output = execFileSync(executable, [
        '--test', '--test-reporter=tap', `--test-name-pattern=${selectedPattern}`, testFile,
      ], {
        cwd: path.dirname(testFile),
        env: childEnvironment,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.match(output, /^# pass 3\r?$/m,
        'the child must execute all three selected controls, rather than succeed with no matches');
    });
  }
});

// Quoting is the failure mode, so quote it: a profile or temp path containing an
// apostrophe, a dollar sign, a backtick or a space used to make the body fail to
// write while the surrounding git command still reported success.
test('a driver body survives a marker path that needs shell quoting', async (t) => {
  const base = container(t, 'ugk-driver-quotes-');
  const tricky = path.join(base, "o'brien $HOME", 'tick `y`', 'with space');
  mkdirSync(tricky, { recursive: true });
  const { repo, marker } = hostileRepo(tricky);
  assert.equal(assertDriverAttributeBound(repo, 'file.txt', 'evil'), 'evil');
  assert.doesNotThrow(() => assertCleanDriverRunsHere(repo, marker));
});
