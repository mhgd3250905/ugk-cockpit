// The hostile-configuration gate used to open every attribute source Git would
// consult, including the free-form value of `core.attributesFile`. Repository
// content therefore chose a path the service would read, with no bound and no
// relation to what the user granted: a large target made every project
// observation allocate the whole file (and the synchronous twin does it while
// the database opens), an unreachable target never returned at all, and any
// non-ENOENT read error was reported as "this repository uses filters".
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertRepositoryAllowed,
  assertRepositoryAllowedSync,
  findHostileRepositoryConfiguration,
  findHostileRepositoryConfigurationSync,
} from '../src/git/repository-policy.mjs';

const tmpRoot = () => (process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir()));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function fixture(t, prefix) {
  const base = mkdtempSync(path.join(tmpRoot(), prefix));
  t.after(() => {
    try { rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {}
  });
  const repo = path.join(base, 'repo');
  git(base, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'fixture@localhost');
  git(repo, 'config', 'user.name', 'fixture');
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'fixture');
  return { base, repo };
}

const reason = (value) => value?.reason ?? null;

test('a filter driver inside the repository is still detected', async (t) => {
  const { repo } = fixture(t, 'ugk-attrs-indriver-');
  writeFileSync(path.join(repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  assert.deepEqual(await findHostileRepositoryConfiguration(repo), { kind: 'attributes', reason: 'driver' });
});

test('a benign .gitattributes inside the repository is still allowed', async (t) => {
  const { repo } = fixture(t, 'ugk-attrs-benign-');
  writeFileSync(path.join(repo, '.gitattributes'), '*.png -diff\n[attr]binary -diff -merge -text\n');
  assert.equal(await findHostileRepositoryConfiguration(repo), null);
  await assertRepositoryAllowed(repo);
});

test('an attribute source outside the repository is refused without being read', async (t) => {
  const { base, repo } = fixture(t, 'ugk-attrs-outside-');
  // Two different contents, one that names a driver and one that names nothing:
  // the old code reached two different verdicts, so the service learned the
  // content of a file no grant ever covered. Both now refuse for the same reason.
  const hostile = path.join(base, 'outside-hostile.txt');
  const benign = path.join(base, 'outside-benign.txt');
  writeFileSync(hostile, '*.bin filter=lfs\n');
  writeFileSync(benign, 'nothing that names a driver\n');

  for (const target of [hostile, benign]) {
    git(repo, 'config', '--local', 'core.attributesFile', target);
    const verdict = await findHostileRepositoryConfiguration(repo);
    assert.equal(verdict?.kind, 'attributes', `refused: ${target}`);
    assert.equal(reason(verdict), 'outside-repository', `never opened: ${target}`);
    await assert.rejects(() => assertRepositoryAllowed(repo), (error) => {
      assert.equal(error.code, 'GIT_FILTER_UNSUPPORTED');
      assert.match(error.message, /outside the repository/);
      return true;
    });
  }

  // A relative value that climbs out of the repository is the same case.
  git(repo, 'config', '--local', 'core.attributesFile', '../outside-benign.txt');
  assert.equal(reason(await findHostileRepositoryConfiguration(repo)), 'outside-repository');
});

test('an oversized attribute source is refused instead of allocated', async (t) => {
  const { repo } = fixture(t, 'ugk-attrs-oversize-');
  // In scope, past the read bound: the gate decides from the size alone, where
  // it used to allocate the whole file on every call.
  const huge = path.join(repo, 'huge.gitattributes');
  writeFileSync(huge, `${'.'.repeat(1023)}\n`.repeat(400)); // ~400KB
  const started = Date.now();
  const verdict = await findHostileRepositoryConfiguration(repo);
  assert.equal(verdict?.kind, 'attributes');
  assert.equal(reason(verdict), 'oversized');
  assert.ok(Date.now() - started < 5_000, 'the bound must not depend on the file size');

  // The synchronous twin (it runs while the database opens) bounds the same way.
  assert.equal(reason(findHostileRepositoryConfigurationSync(repo)), 'oversized');
  assert.throws(() => assertRepositoryAllowedSync(repo), (error) => {
    assert.equal(error.code, 'GIT_FILTER_UNSUPPORTED');
    assert.match(error.message, /larger than the safe read limit/);
    return true;
  });
});

test('a directory named as the attribute source is not reported as a filter', async (t) => {
  const { base, repo } = fixture(t, 'ugk-attrs-notfile-');
  git(repo, 'config', '--local', 'core.attributesFile', base);
  const verdict = await findHostileRepositoryConfiguration(repo);
  assert.equal(verdict?.kind, 'attributes');
  assert.equal(reason(verdict), 'outside-repository');

  // In scope but not a regular file: the reason names what was found, not a
  // filter driver the repository never configured. POSIX may surface this as a
  // failed open rather than a stat answer, so both honest reasons are accepted.
  git(repo, 'config', '--local', 'core.attributesFile', '.git');
  const asyncReason = reason(await findHostileRepositoryConfiguration(repo));
  const syncReason = reason(findHostileRepositoryConfigurationSync(repo));
  assert.ok(['not-a-file', 'unreadable'].includes(asyncReason), `async answer: ${asyncReason}`);
  assert.ok(['not-a-file', 'unreadable'].includes(syncReason), `sync answer: ${syncReason}`);
});

test('a missing attribute source stays missing rather than hostile', async (t) => {
  const { base, repo } = fixture(t, 'ugk-attrs-missing-');
  git(repo, 'config', '--local', 'core.attributesFile', path.join(base, 'gone.txt'));
  assert.equal(reason(await findHostileRepositoryConfiguration(repo)), 'outside-repository');
  // The synchronous twin is the one that runs while the database opens, so the
  // same answer has to come back without promises anywhere in the chain.
  assert.equal(reason(findHostileRepositoryConfigurationSync(repo)), 'outside-repository');
  assert.throws(() => assertRepositoryAllowedSync(repo), (error) => {
    assert.equal(error.code, 'GIT_FILTER_UNSUPPORTED');
    assert.match(error.publicMessage, /仓库自身之外/);
    return true;
  });
  // Inside the repository and absent: Git simply has no such source, and the
  // repository stays usable.
  git(repo, 'config', '--local', 'core.attributesFile', '.git/does-not-exist');
  assert.equal(await findHostileRepositoryConfiguration(repo), null);
  assert.equal(findHostileRepositoryConfigurationSync(repo), null);
});

// `git ls-files` escapes non-ASCII names by default, and the escaped text is not
// a path anybody can open: this repository names a real filter driver and the
// gate used to answer "nothing hostile here".
test('an attribute source named in non-ASCII characters is still found', async (t) => {
  const { repo } = fixture(t, 'ugk-attrs-unicode-');
  writeFileSync(path.join(repo, '配置.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  git(repo, 'add', '配置.gitattributes');
  git(repo, 'commit', '-q', '-m', 'unicode attribute source');
  assert.deepEqual(await findHostileRepositoryConfiguration(repo), { kind: 'attributes', reason: 'driver' });
  assert.deepEqual(findHostileRepositoryConfigurationSync(repo), { kind: 'attributes', reason: 'driver' });
});

test('an attribute source reached through a link is refused without following it', async (t) => {
  const { base, repo } = fixture(t, 'ugk-attrs-linked-');
  const outside = path.join(base, 'outside-secret.txt');
  writeFileSync(outside, '*.bin filter=lfs\n');
  let linked;
  try {
    symlinkSync(outside, path.join(repo, 'linked.gitattributes'));
    linked = true;
  } catch {
    linked = false; // Windows without the privilege to create links.
  }
  if (!linked) { console.log('[skip] this host cannot create symlinks'); return; }
  assert.deepEqual(await findHostileRepositoryConfiguration(repo), { kind: 'attributes', reason: 'symbolic-path' });
  assert.deepEqual(findHostileRepositoryConfigurationSync(repo), { kind: 'attributes', reason: 'symbolic-path' });
});
