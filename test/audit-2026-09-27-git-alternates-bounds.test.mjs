// `objects/info/alternates` lines are repository content. The probe resolved
// each one with a bare realpath, so a dangling entry threw ENOENT out of every
// observation of that project, and an entry on an unmounted volume or an
// unreachable share never returned at all: the request stayed open forever, and
// graceful shutdown waits on open requests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { probeGitWorktree } from '../src/git/probe.mjs';

const tmpRoot = () => (process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir()));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repository(t) {
  const base = mkdtempSync(path.join(tmpRoot(), 'ugk-alternates-'));
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
  const info = path.join(repo, '.git', 'objects', 'info');
  mkdirSync(info, { recursive: true });
  return {
    base,
    repo,
    write: (contents) => writeFileSync(path.join(info, 'alternates'), contents),
    remove: () => rmSync(path.join(info, 'alternates'), { force: true }),
  };
}

test('a dangling alternate is dropped instead of breaking every observation', async (t) => {
  const { base, repo, write } = repository(t);
  const clean = await probeGitWorktree(repo);
  assert.equal(clean.objectDirectories.length, 1);

  write(`${path.join(base, 'no-longer-mounted').replaceAll('\\', '/')}\n`);
  const result = await probeGitWorktree(repo, { timeoutMs: 2_000 });
  assert.deepEqual(result.objectDirectories, clean.objectDirectories,
    'an object directory that cannot be located holds no objects to authorize');
  assert.equal(result.coherence, 'coherent');
});

test('an unreachable alternate refuses the observation inside one shared budget', async (t) => {
  const { repo, write } = repository(t);
  // TEST-NET-1 has no host to answer. Git itself cannot work with such an entry
  // either, so the honest contract is not "this succeeds" but "this returns,
  // with a reason": the observation must fail diagnosably inside its own budget
  // instead of parking a thread pool worker forever.
  // Platform note: POSIX resolves an unroutable //host path to ENOENT without
  // waiting, so only the Windows runner really exercises the timeout branch; the
  // assertions below hold either way.
  write(['//192.0.2.1/ugk-nope/objects', '//192.0.2.1/ugk-nope-two/objects'].join('\n') + '\n');
  const budgetMs = 1_000;
  const started = Date.now();
  const neverReturned = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('NEVER-RETURNED'), budgetMs * 8);
    timer.unref();
  });
  const outcome = await Promise.race([
    probeGitWorktree(repo, { timeoutMs: budgetMs })
      .then(() => 'resolved', (error) => error?.code ?? `other:${error?.code}`),
    neverReturned,
  ]);
  const elapsed = Date.now() - started;
  assert.notEqual(outcome, 'NEVER-RETURNED', 'the observation never settled');
  // Two unreachable entries share one budget: per-entry budgets would need 2x
  // or more, and the file may name up to 64 of them.
  assert.ok(elapsed < budgetMs * 3, `aggregate budget exceeded: ${elapsed}ms for a ${budgetMs}ms budget`);
  assert.ok(outcome === 'GIT_ALTERNATE_UNRESOLVED' || outcome === '128' || outcome === 'resolved',
    `unexpected answer ${JSON.stringify(outcome)}`);
});

test('a reachable alternate is still reported so path authorization can see it', async (t) => {
  const { base, repo, write, remove } = repository(t);
  const inside = path.join(base, 'shared-objects');
  mkdirSync(inside, { recursive: true });
  write(`${inside.replaceAll('\\', '/')}\n`);
  const result = await probeGitWorktree(repo);
  assert.ok(result.objectDirectories.some((item) => item.startsWith(inside)),
    `expected ${inside} in ${JSON.stringify(result.objectDirectories)}`);

  // An unreachable-but-named path is dropped, and the oversized metadata guard
  // that already existed keeps its verdict.
  remove();
  writeFileSync(path.join(repo, '.git', 'objects', 'info', 'alternates'), 'x'.repeat(64 * 1024 + 1));
  await assert.rejects(() => probeGitWorktree(repo), (error) => {
    assert.equal(error.code, 'GIT_METADATA_TOO_LARGE');
    return true;
  });
});
