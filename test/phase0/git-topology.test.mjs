import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function initializeRepository(directory, marker = 'fixture') {
  mkdirSync(directory, { recursive: true });
  git(directory, ['init', '-b', 'main']);
  git(directory, ['config', 'user.name', 'UGK Fixture']);
  git(directory, ['config', 'user.email', 'fixture@localhost']);
  writeFileSync(path.join(directory, 'README.md'), `${marker}\n`, 'utf8');
  git(directory, ['add', 'README.md']);
  git(directory, ['commit', '-m', `${marker} baseline`]);
}

test('multiple worktrees share one repository identity but keep distinct paths', async (t) => {
  const container = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-worktrees-'));
  t.after(() => rmSync(container, { recursive: true, force: true }));
  const main = path.join(container, 'main');
  const feature = path.join(container, 'feature');
  initializeRepository(main);
  git(main, ['worktree', 'add', '-b', 'feature', feature]);

  const mainProbe = await probeGitWorktree(main);
  const featureProbe = await probeGitWorktree(feature);
  assert.equal(mainProbe.repositoryCommonDir, featureProbe.repositoryCommonDir);
  assert.notEqual(mainProbe.canonicalPath, featureProbe.canonicalPath);
  assert.equal(featureProbe.after.branch, 'feature');
});

test('a nested repository remains a separate repository identity', async (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-nested-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  initializeRepository(parent, 'parent');
  const child = path.join(parent, 'packages', 'child');
  initializeRepository(child, 'child');

  const parentProbe = await probeGitWorktree(parent);
  const childProbe = await probeGitWorktree(child);
  assert.notEqual(parentProbe.repositoryCommonDir, childProbe.repositoryCommonDir);
  assert.equal(parentProbe.coherence, 'coherent');
  assert.equal(childProbe.coherence, 'coherent');
});

test('a submodule is observed without collapsing it into the parent repository', async (t) => {
  const container = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-submodule-'));
  t.after(() => rmSync(container, { recursive: true, force: true }));
  const source = path.join(container, 'source');
  const parent = path.join(container, 'parent');
  initializeRepository(source, 'submodule source');
  initializeRepository(parent, 'parent');
  git(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'modules/demo']);
  git(parent, ['commit', '-am', 'add local fixture submodule']);

  const parentProbe = await probeGitWorktree(parent);
  const submoduleProbe = await probeGitWorktree(path.join(parent, 'modules', 'demo'));
  assert.notEqual(parentProbe.repositoryCommonDir, submoduleProbe.repositoryCommonDir);
  assert.equal(parentProbe.coherence, 'coherent');
  assert.equal(submoduleProbe.coherence, 'coherent');
});

