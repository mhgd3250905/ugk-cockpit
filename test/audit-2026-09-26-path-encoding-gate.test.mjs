// Audit round 2026-09-26, finding 2 (P1, security gate fails open).
//
// The repository-configuration gate enumerates attribute files with
// `git ls-files ... -- '*.gitattributes'`. Without `-z`, git C-style quotes
// every path whose name is not plain ASCII (`core.quotePath` defaults to true),
// so `测试/.gitattributes` comes back as `"\346\265\213\350\257\225/.gitattributes"`.
// That resolves to a file that does not exist, the read reports ENOENT, and the
// candidate is skipped — the same repository is refused or accepted depending on
// the byte encoding of a directory name, and a repository that ships rules under
// a non-ASCII path is never examined at all.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  findHostileRepositoryConfiguration,
  findHostileRepositoryConfigurationSync,
  assertRepositoryAllowed,
} from '../src/git/repository-policy.mjs';
import { safeGitEnvironment, SAFE_GIT_PREFIX } from '../src/git/probe.mjs';

const execFileAsync = promisify(execFile);

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

async function repositoryWithAttributes(directoryName, contents) {
  const base = process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(base, 'ugk-attributes-encoding-'));
  const repo = path.join(root, 'work');
  mkdirSync(repo, { recursive: true });
  await git(repo, ['init', '-q', '-b', 'main']);
  const sub = path.join(repo, directoryName);
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, '.gitattributes'), contents);
  writeFileSync(path.join(sub, 'payload.bin'), 'payload\n');
  await git(repo, ['add', '--', '.']);
  return { root, repo };
}

const cleanup = (t, root) => t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

const LFS_RULE = '*.bin filter=lfs diff=lfs merge=lfs -text\n';

test('an attribute rule is found under an ASCII path', async (t) => {
  const { root, repo } = await repositoryWithAttributes('sub', LFS_RULE);
  cleanup(t, root);
  assert.deepEqual(await findHostileRepositoryConfiguration(repo), { kind: 'attributes' });
  assert.deepEqual(findHostileRepositoryConfigurationSync(repo), { kind: 'attributes' });
  await assert.rejects(() => assertRepositoryAllowed(repo), (error) => {
    assert.equal(error.code, 'GIT_FILTER_UNSUPPORTED');
    return true;
  });
});

test('the same rule is found under a non-ASCII path', async (t) => {
  const { root, repo } = await repositoryWithAttributes('测试目录', LFS_RULE);
  cleanup(t, root);

  // Guard the premise: git itself applies the rule, so the file is live.
  assert.match(
    await git(repo, ['check-attr', 'filter', '--', '测试目录/payload.bin']),
    /filter: lfs/u,
    'git stopped resolving the attribute file, so the fixture no longer proves anything',
  );

  assert.deepEqual(await findHostileRepositoryConfiguration(repo), { kind: 'attributes' });
  assert.deepEqual(findHostileRepositoryConfigurationSync(repo), { kind: 'attributes' });
});

test('a rule under a path with spaces and apostrophes is still found', async (t) => {
  const { root, repo } = await repositoryWithAttributes("a 'b' 目录", LFS_RULE);
  cleanup(t, root);
  assert.deepEqual(await findHostileRepositoryConfiguration(repo), { kind: 'attributes' });
});

test('a benign attribute file under a non-ASCII path stays allowed', async (t) => {
  const { root, repo } = await repositoryWithAttributes('测试目录', '*.txt text\n*.bin -diff\n');
  cleanup(t, root);
  assert.equal(await findHostileRepositoryConfiguration(repo), null);
  assert.equal(findHostileRepositoryConfigurationSync(repo), null);
  await assertRepositoryAllowed(repo);
});

test('a rule under a path whose name starts with a space is still found', async (t) => {
  // `-z` prints raw paths, so this space belongs to the directory name — and the
  // surrounding stdout trim that every other probe relies on eats it from the
  // first record, resolving to a file that does not exist.
  const { root, repo } = await repositoryWithAttributes(' lead', LFS_RULE);
  cleanup(t, root);
  assert.match(
    await git(repo, ['check-attr', 'filter', '--', ' lead/payload.bin']),
    /filter: lfs/u,
    'git stopped resolving the attribute file, so the fixture no longer proves anything',
  );
  assert.deepEqual(await findHostileRepositoryConfiguration(repo), { kind: 'attributes' });
  assert.deepEqual(findHostileRepositoryConfigurationSync(repo), { kind: 'attributes' });
});

test('a nested and a deep attribute path are both examined', async (t) => {
  const base = process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(base, 'ugk-attributes-nested-'));
  const repo = path.join(root, 'work');
  mkdirSync(repo, { recursive: true });
  await git(repo, ['init', '-q', '-b', 'main']);
  const deep = path.join(repo, '数据', '内层', '更内');
  mkdirSync(deep, { recursive: true });
  writeFileSync(path.join(deep, '.gitattributes'), '*.dat filter=my-driver\n');
  await git(repo, ['add', '--', '.']);
  cleanup(t, root);

  assert.deepEqual(await findHostileRepositoryConfiguration(repo), { kind: 'attributes' });
});
