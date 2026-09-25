// Audit round 2026-09-26, finding 1 (P0).
//
// A worktree can hold an unresolved conflict with no marker file in `.git` at
// all: `git stash pop` onto a branch that moved, or `git checkout -m`, leave
// stage 1/2/3 index entries plus conflict markers in the file, and nothing else.
// The preflight only looked for marker files, so such a worktree passed: the
// marker text was hashed into the candidate commit, and saving rewrote the
// conflicted index entries to stage 0 — the user lost the conflict state while
// `<<<<<<<` stayed in history and `git status` reported a clean tree.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  checkUnfinishedGitOperations,
  computeContentFingerprint,
  inspectDelivery,
  readDeliveryLocation,
} from '../src/git/delivery-ops.mjs';
import { safeGitEnvironment, SAFE_GIT_PREFIX } from '../src/git/probe.mjs';
import { rejectUnsupportedSubmitFeatures } from '../src/git/submit-ops.mjs';

const execFileAsync = promisify(execFile);

function tempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

async function git(cwd, args) {
  const result = await execFileAsync('git', [...SAFE_GIT_PREFIX, ...args], {
    cwd,
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
    env: safeGitEnvironment(),
  });
  return result.stdout.trim();
}

// A bare origin plus a clone, because a delivery preflight has to reach both
// ends of the flow. `fileName` ends up conflicted the way a real AI session
// does it: park work in a stash, let the branch move under it, pop.
async function conflictedFixture(t, fileName = 'file.txt') {
  const root = mkdtempSync(path.join(tempRoot(), 'ugk-conflict-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'work');
  mkdirSync(root, { recursive: true });

  await git(root, ['init', '--bare', '-q', '-b', 'main', origin]);
  await git(root, ['clone', '-q', origin, repo]);
  await git(repo, ['config', 'user.name', 'Cockpit Test']);
  await git(repo, ['config', 'user.email', 'cockpit-test@example.invalid']);

  const target = path.join(repo, fileName);
  const targetDirectory = path.dirname(target);
  if (targetDirectory !== repo) mkdirSync(targetDirectory, { recursive: true });
  writeFileSync(target, 'shared base\n');
  await git(repo, ['add', '--', fileName]);
  await git(repo, ['commit', '-qm', 'base']);
  await git(repo, ['push', '-q', 'origin', 'main']);
  await git(repo, ['checkout', '-q', '-b', 'feature']);

  writeFileSync(target, 'local edit\n');
  await git(repo, ['stash', 'push', '-q', '-u']);

  writeFileSync(target, 'upstream edit\n');
  await git(repo, ['commit', '-qam', 'upstream']);
  await git(repo, ['push', '-q', 'origin', 'main']);
  await git(repo, ['checkout', '-q', 'feature']);
  await git(repo, ['merge', '-q', 'main']);

  // The pop conflicts: the parked edit and the moved branch touched the same
  // line. `git stash pop` exits non-zero and leaves the conflict in place.
  await git(repo, ['stash', 'pop']).then(
    () => { throw new Error('the stash pop was expected to conflict'); },
    () => {},
  );

  return { root, repo, origin, fileName, target };
}

async function unmergedPaths(repo) {
  const listing = await git(repo, ['ls-files', '--unmerged', '-z']);
  const paths = new Set();
  for (const entry of listing.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab !== -1) paths.add(entry.slice(tab + 1));
  }
  return [...paths];
}

test('the fixture conflicts without leaving any marker file behind', async (t) => {
  const { repo, target } = await conflictedFixture(t);
  assert.deepEqual(await unmergedPaths(repo), ['file.txt']);
  assert.match(readFileSync(target, 'utf8'), /<{7} /u);
  const gitDir = path.resolve(repo, await git(repo, ['rev-parse', '--git-dir']));
  for (const indicator of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    assert.equal(existsSync(path.join(gitDir, indicator)), false,
      `fixture left a ${indicator} marker, so it no longer proves the unmerged-index case`);
  }
  const status = await git(repo, ['status', '--porcelain=v1']);
  assert.equal(status, 'UU file.txt');
});

test('an unresolved conflict with no marker file is refused before delivery', async (t) => {
  const { repo, target } = await conflictedFixture(t);
  const headBefore = await git(repo, ['rev-parse', 'HEAD']);
  const markersBefore = readFileSync(target, 'utf8');

  await assert.rejects(
    () => checkUnfinishedGitOperations(repo),
    (error) => {
      assert.equal(error.code, 'UNFINISHED_GIT_OPERATION');
      assert.deepEqual(error.details.conflictedPaths, ['file.txt']);
      assert.match(error.message, /Unresolved merge conflict/u);
      return true;
    },
  );

  // The preflight as a whole must refuse, so no candidate commit is ever built.
  await assert.rejects(
    () => inspectDelivery({ sourcePath: repo, targetPath: repo, files: ['file.txt'], targetBranch: 'main' }),
    (error) => {
      assert.equal(error.code, 'UNFINISHED_GIT_OPERATION');
      return true;
    },
  );

  // Refusing must be a pure read: the conflict stays exactly where it was.
  assert.equal(await git(repo, ['rev-parse', 'HEAD']), headBefore, 'the refusal created a commit');
  assert.equal(readFileSync(target, 'utf8'), markersBefore);
  assert.deepEqual(await unmergedPaths(repo), ['file.txt']);
});

test('a non-ASCII conflicted path is detected too', async (t) => {
  const { repo } = await conflictedFixture(t, path.join('测试目录', '数据.txt'));
  await assert.rejects(
    () => checkUnfinishedGitOperations(repo),
    (error) => {
      assert.equal(error.code, 'UNFINISHED_GIT_OPERATION');
      assert.deepEqual(error.details.conflictedPaths, ['测试目录/数据.txt']);
      return true;
    },
  );
});

// The managed submission flow stages everything with `git add --all`, which
// would resolve a conflict the same silent way, so it shares the preflight.
test('the submission preflight refuses a conflicted worktree too', async (t) => {
  const { repo } = await conflictedFixture(t);
  await assert.rejects(
    () => rejectUnsupportedSubmitFeatures(repo),
    (error) => {
      assert.equal(error.code, 'UNFINISHED_GIT_OPERATION');
      return true;
    },
  );
});

test('a clean worktree still passes the unfinished-operation check', async (t) => {
  const root = mkdtempSync(path.join(tempRoot(), 'ugk-conflict-clean-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const repo = path.join(root, 'work');
  mkdirSync(repo, { recursive: true });
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Cockpit Test']);
  await git(repo, ['config', 'user.email', 'cockpit-test@example.invalid']);
  writeFileSync(path.join(repo, 'file.txt'), 'one\n');
  await git(repo, ['add', '--', 'file.txt']);
  await git(repo, ['commit', '-qm', 'base']);
  writeFileSync(path.join(repo, 'file.txt'), 'two\n');

  await checkUnfinishedGitOperations(repo);
  const location = await readDeliveryLocation(repo);
  assert.deepEqual(location.changes.map((item) => item.path), ['file.txt']);
});

// The save path re-computes the fingerprint under its own index lock, so a
// conflict that appears *after* a passed preflight still has to be rejected.
// That second layer only holds while the fingerprint covers index stages — the
// conflict state is not visible in HEAD, and a conflicted file can carry the
// same bytes as a resolved one.
test('the content fingerprint distinguishes an unmerged index from a staged one', async (t) => {
  const { repo } = await conflictedFixture(t);
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const conflictedFingerprint = await computeContentFingerprint(repo, head, ['file.txt']);

  // Same path, but the conflict resolved into the index.
  writeFileSync(path.join(repo, 'file.txt'), 'local edit\n');
  await git(repo, ['add', '--', 'file.txt']);
  assert.deepEqual(await unmergedPaths(repo), []);
  const stagedFingerprint = await computeContentFingerprint(repo, head, ['file.txt']);

  assert.notEqual(conflictedFingerprint, stagedFingerprint,
    'an unmerged index fingerprints the same as a resolved one, so saveDelivery cannot notice it');
});
