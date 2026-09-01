import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { probeGitWorktree } from '../../src/git/probe.mjs';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function createRepository(t, marker = 'fixture') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'UGK Fixture']);
  git(root, ['config', 'user.email', 'fixture@localhost']);
  writeFileSync(path.join(root, 'README.md'), `${marker}\n`, 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', `${marker} baseline`]);
  return root;
}

test('Git probe returns a coherent bounded observation', async (t) => {
  const root = createRepository(t);
  const result = await probeGitWorktree(root);
  assert.equal(result.coherence, 'coherent');
  assert.equal(result.before.head, result.after.head);
  assert.match(result.before.head, /^[0-9a-f]{40}$/);
  assert.equal(result.before.branch, 'main');
  assert.notEqual(result.before.indexFingerprint, result.before.worktreeFingerprint);
  assert.ok(result.gitDirectory.startsWith(root));
  assert.ok(result.indexPath.startsWith(root));
  assert.ok(result.objectDirectories.every((item) => item.startsWith(root)));
  assert.match(result.repositoryIdentity, /^[0-9a-f]{64}$/);
  assert.match(result.worktreeIdentity, /^[0-9a-f]{64}$/);
});

test('Git probe refuses to call a changing worktree coherent', async (t) => {
  const root = createRepository(t);
  const result = await probeGitWorktree(root, {
    onBetweenObservations: async () => {
      writeFileSync(path.join(root, 'README.md'), 'changed during probe\n', 'utf8');
    },
  });
  assert.equal(result.coherence, 'incoherent');
  assert.notEqual(result.before.worktreeFingerprint, result.after.worktreeFingerprint);
});

test('Git probe ignores inherited repository redirection variables', async (t) => {
  const inside = createRepository(t, 'inside');
  const outside = createRepository(t, 'outside');
  const insideHead = git(inside, ['rev-parse', 'HEAD']).trim();
  const outsideHead = git(outside, ['rev-parse', 'HEAD']).trim();
  assert.notEqual(insideHead, outsideHead);
  const previousGitDir = process.env.GIT_DIR;
  const previousGitWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = path.join(outside, '.git');
  process.env.GIT_WORK_TREE = outside;
  try {
    const result = await probeGitWorktree(inside);
    assert.equal(result.after.head, insideHead);
    assert.notEqual(result.after.head, outsideHead);
    assert.ok(result.repositoryCommonDir.startsWith(inside));
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
    if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previousGitWorkTree;
  }
});

test('Git probe refuses oversized alternates metadata before reading object directories', async (t) => {
  const root = createRepository(t);
  const alternatesPath = path.join(root, '.git', 'objects', 'info', 'alternates');
  writeFileSync(alternatesPath, 'x'.repeat(64 * 1024 + 1), 'utf8');
  await assert.rejects(
    () => probeGitWorktree(root),
    { code: 'GIT_METADATA_TOO_LARGE' },
  );
});
