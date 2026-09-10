import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject, worktreeIdFor } from '../src/core/projects.mjs';
import { createDevelopmentSpace, readDevelopmentSpace } from '../src/core/spaces.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import {
  readSubmissionAttempt,
  submitDevelopmentSpace,
} from '../src/core/submission-service.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { pushSubmissionBranch } from '../src/git/submit-ops.mjs';

const git = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function snapshot(observation) {
  return {
    head: observation.after.head,
    branch: observation.after.branch,
    indexFingerprint: observation.after.indexFingerprint,
    worktreeFingerprint: observation.after.worktreeFingerprint,
    repositoryIdentity: observation.repositoryIdentity,
    worktreeIdentity: observation.worktreeIdentity,
    headRelation: 'same',
    coherence: observation.coherence,
    observedAt: observation.observedAt,
  };
}

async function fixture(t, { withRemote = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-submit-'));
  const mainPath = path.join(root, 'main');
  const spacePath = path.join(root, 'space');
  const remotePath = path.join(root, 'remote.git');
  git(root, ['init', '--bare', remotePath]);
  git(root, ['init', '-b', 'main', mainPath]);
  git(mainPath, ['config', 'user.name', 'UGK Test']);
  git(mainPath, ['config', 'user.email', 'ugk@example.invalid']);
  writeFileSync(path.join(mainPath, 'README.md'), 'seed\n');
  git(mainPath, ['add', 'README.md']);
  git(mainPath, ['commit', '-m', 'seed']);
  if (withRemote) {
    git(mainPath, ['remote', 'add', 'origin', remotePath]);
    git(mainPath, ['push', '--set-upstream', 'origin', 'main']);
  }
  git(mainPath, ['worktree', 'add', '-b', 'cockpit/work/submit-test', spacePath, 'HEAD']);

  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const mainObservation = await probeGitWorktree(mainPath);
  const sourceObservation = await probeGitWorktree(spacePath);
  const registered = registerProject(db, {
    commandId: 'register-submit-project',
    name: 'Submit Project',
    observation: mainObservation,
    authorizedRoot: mainPath,
  });
  assert.equal(registered.ok, true);
  const sourceWorktreeId = worktreeIdFor(sourceObservation.worktreeIdentity);
  const createdSpace = createDevelopmentSpace(db, {
    commandId: 'create-submit-space',
    projectId: registered.projectId,
    name: 'Submit Space',
    branch: sourceObservation.after.branch,
    baseCommit: sourceObservation.after.head,
    worktreeId: sourceWorktreeId,
    canonicalPath: sourceObservation.canonicalPath,
    repositoryIdentity: sourceObservation.repositoryIdentity,
    worktreeIdentity: sourceObservation.worktreeIdentity,
  });
  assert.equal(createdSpace.ok, true);

  const sessionId = 'session-submit-test';
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO assignments (
      id, project_id, worktree_id, agent_id, task_id, scope_json,
      status, revision, session_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'Codex', 'Implement feature', '{"mode":"write"}',
      'active', 2, ?, ?, ?)
  `).run('assignment-submit-test', registered.projectId, sourceWorktreeId, sessionId, timestamp, timestamp);
  const started = startWriteRun(db, {
    commandId: 'start-submit-run',
    runId: sessionId,
    worktreeId: sourceWorktreeId,
    canonicalPath: sourceObservation.canonicalPath,
    repositoryIdentity: sourceObservation.repositoryIdentity,
    worktreeIdentity: sourceObservation.worktreeIdentity,
    agentClaim: 'Codex',
    goal: 'Implement feature',
    baseline: snapshot(sourceObservation),
  });
  assert.equal(started.ok, true);

  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    db,
    mainPath,
    spacePath,
    remotePath,
    projectId: registered.projectId,
    spaceId: createdSpace.spaceId,
    sourceWorktreeId,
    sessionId,
    baseHead: sourceObservation.after.head,
    branch: sourceObservation.after.branch,
  };
}

test('transfer freeze rechecks before stage, commit and push', async (t) => {
  for (const frozenAt of ['stage', 'commit', 'push']) {
    const f = await fixture(t);
    writeFileSync(path.join(f.spacePath, 'freeze.txt'), 'preserved\n');
    let frozen = false;
    let stages = 0;
    let commits = 0;
    let pushes = 0;
    const result = await submitDevelopmentSpace(f.db, {
      commandId: `freeze-${frozenAt}`, sessionId: f.sessionId, expectedRevision: 2, summary: '冻结边界',
    }, {
      assertSessionWrite() {
        if (frozen) throw Object.assign(new Error('frozen'), { code: 'CONVERSATION_BINDING_CONFLICT' });
      },
      ensureLocalCommitIdentity: async () => { frozen = frozenAt === 'stage'; return { name: 'Test', email: 'test@example.invalid' }; },
      stageAllChanges: async () => { stages += 1; frozen = frozenAt === 'commit'; },
      createSubmissionCommit: async () => { commits += 1; git(f.spacePath, ['add', '.']); git(f.spacePath, ['commit', '-m', `test\n\nUGK-Cockpit-Command: freeze-${frozenAt}`]); },
      faultInjector(point) { if (point === 'after_commit_before_persist' && frozenAt === 'push') frozen = true; },
      pushSubmissionBranch: async () => { pushes += 1; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONVERSATION_BINDING_CONFLICT');
    assert.equal(pushes, 0);
    if (frozenAt === 'stage') assert.equal(stages, 0);
    if (frozenAt !== 'push') { assert.equal(commits, 0); assert.equal(git(f.spacePath, ['rev-parse', 'HEAD']), f.baseHead); }
  }
});

test('dirty development space is committed, pushed, recorded, and replayed idempotently', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.spacePath, 'feature.txt'), 'done\n');
  const request = {
    commandId: 'submit-dirty-success',
    sessionId: f.sessionId,
    expectedRevision: 2,
    summary: '完成开发空间功能',
  };

  const result = await submitDevelopmentSpace(f.db, request);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.localSaved, true);
  assert.equal(result.pushed, true);
  assert.notEqual(result.sourceCommit, f.baseHead);
  assert.equal(git(f.remotePath, ['rev-parse', `refs/heads/${f.branch}`]), result.sourceCommit);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM submissions').get().count, 1);
  assert.equal(readDevelopmentSpace(f.db, f.spaceId).status, 'awaiting_review');
  assert.equal(readSubmissionAttempt(f.db, request.commandId).state, 'completed');

  const replay = await submitDevelopmentSpace(f.db, request);
  assert.deepEqual(replay, result);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM submissions').get().count, 1);
});

test('push failure preserves the local commit and same command resumes only the push', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.spacePath, 'retry.txt'), 'retry\n');
  let pushes = 0;
  const request = {
    commandId: 'submit-push-retry',
    sessionId: f.sessionId,
    expectedRevision: 2,
    summary: '保存后重试推送',
  };
  const first = await submitDevelopmentSpace(f.db, request, {
    pushSubmissionBranch: async () => {
      pushes += 1;
      const error = new Error('remote unavailable');
      error.code = 'REMOTE_UNAVAILABLE';
      throw error;
    },
  });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'PUSH_FAILED');
  assert.equal(first.localSaved, true);
  assert.equal(first.pushed, false);
  const savedHead = git(f.spacePath, ['rev-parse', 'HEAD']);

  const second = await submitDevelopmentSpace(f.db, request, {
    pushSubmissionBranch: async (...args) => {
      pushes += 1;
      return pushSubmissionBranch(...args);
    },
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(git(f.spacePath, ['rev-parse', 'HEAD']), savedHead);
  assert.equal(pushes, 2);
});

test('commit-side crash is recovered from deterministic trailer without a duplicate commit', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.spacePath, 'crash.txt'), 'crash recovery\n');
  const request = {
    commandId: 'submit-commit-crash',
    sessionId: f.sessionId,
    expectedRevision: 2,
    summary: '验证提交崩溃恢复',
  };
  const crash = new Error('simulated process crash');
  crash.simulateCrash = true;
  await assert.rejects(
    submitDevelopmentSpace(f.db, request, {
      faultInjector(point) {
        if (point === 'after_commit_before_persist') throw crash;
      },
    }),
    /simulated process crash/,
  );
  const committedHead = git(f.spacePath, ['rev-parse', 'HEAD']);
  assert.equal(readSubmissionAttempt(f.db, request.commandId).state, 'prepared');

  const recovered = await submitDevelopmentSpace(f.db, request);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.sourceCommit, committedHead);
  assert.equal(git(f.spacePath, ['rev-list', '--count', f.baseHead + '..HEAD']), '1');
});

test('missing remote fails before any local commit and no-change submit is rejected', async (t) => {
  const noRemote = await fixture(t, { withRemote: false });
  writeFileSync(path.join(noRemote.spacePath, 'local.txt'), 'local\n');
  const missing = await submitDevelopmentSpace(noRemote.db, {
    commandId: 'submit-no-remote',
    sessionId: noRemote.sessionId,
    expectedRevision: 2,
    summary: '没有远端',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PUSH_REMOTE_MISSING');
  assert.equal(git(noRemote.spacePath, ['rev-parse', 'HEAD']), noRemote.baseHead);

  const clean = await fixture(t);
  const unchanged = await submitDevelopmentSpace(clean.db, {
    commandId: 'submit-no-change',
    sessionId: clean.sessionId,
    expectedRevision: 2,
    summary: '没有变化',
  });
  assert.equal(unchanged.ok, false);
  assert.equal(unchanged.code, 'NO_CHANGES_TO_SUBMIT');
});

test('Git filters are rejected before staging or committing', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.spacePath, '.gitattributes'), '*.bin filter=lfs diff=lfs\n');
  writeFileSync(path.join(f.spacePath, 'asset.bin'), 'not-a-pointer\n');
  const result = await submitDevelopmentSpace(f.db, {
    commandId: 'submit-lfs-rejected',
    sessionId: f.sessionId,
    expectedRevision: 2,
    summary: '不支持的过滤器',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_FILTER_UNSUPPORTED');
  assert.equal(git(f.spacePath, ['rev-parse', 'HEAD']), f.baseHead);
  assert.match(git(f.spacePath, ['status', '--short']), /\.gitattributes/);
});

test('COMMIT_IDENTITY_MISSING is preserved by submitDevelopmentSpace without being masked', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.spacePath, 'change.txt'), 'content\n');
  const missingIdentityError = new Error('No identity');
  missingIdentityError.code = 'COMMIT_IDENTITY_MISSING';

  const result = await submitDevelopmentSpace(f.db, {
    commandId: 'submit-identity-missing',
    sessionId: f.sessionId,
    expectedRevision: 2,
    summary: 'missing identity test',
  }, {
    ensureLocalCommitIdentity: async () => {
      throw missingIdentityError;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'COMMIT_IDENTITY_MISSING');
  const attempt = readSubmissionAttempt(f.db, 'submit-identity-missing');
  assert.equal(attempt.lastErrorCode, 'COMMIT_IDENTITY_MISSING');
});

// 重试会执行与首次完全相同的提交与推送，因此归属必须在每次进入时重新证明：
// 已被接管或结束的会话，不能凭旧的 commandId 把改动推送到远端并登记送审。
async function abortedPushAttempt(t) {
  const f = await fixture(t);
  writeFileSync(path.join(f.spacePath, 'feature.txt'), 'done\n');
  const request = {
    commandId: 'submit-retry-ownership',
    sessionId: f.sessionId,
    expectedRevision: 2,
    summary: '重试归属边界',
  };
  const first = await submitDevelopmentSpace(f.db, request, {
    pushSubmissionBranch: async () => {
      throw Object.assign(new Error('network down'), { code: 'PUSH_FAILED' });
    },
  });
  assert.equal(first.ok, false);
  assert.equal(readSubmissionAttempt(f.db, request.commandId).state, 'local_saved');
  return { f, request };
}

test('a retry after the session was superseded cannot push or register a submission', async (t) => {
  const { f, request } = await abortedPushAttempt(t);
  // 另一次接管推进了 revision 并结束了原会话。
  f.db.prepare(`UPDATE runs SET lifecycle = 'superseded', revision = 7 WHERE id = ?`).run(f.sessionId);
  f.db.prepare(`UPDATE assignments SET revision = 7 WHERE session_id = ?`).run(f.sessionId);

  let pushes = 0;
  const retry = await submitDevelopmentSpace(f.db, request, {
    pushSubmissionBranch: async () => { pushes += 1; },
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.code, 'SESSION_NOT_ACTIVE');
  assert.equal(pushes, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM submissions').get().count, 0);
});

test('a retry is refused when another session now holds the write lease', async (t) => {
  const { f, request } = await abortedPushAttempt(t);
  const lease = f.db.prepare('SELECT * FROM write_leases WHERE worktree_id = ?').get(f.sourceWorktreeId);
  assert.ok(lease, 'fixture 应已为会话建立写租约');
  const timestamp = new Date().toISOString();
  f.db.prepare(`
    INSERT INTO runs (id, worktree_id, mode, lifecycle, health, revision, lease_generation,
                      agent_claim, goal, created_at)
    VALUES (?, ?, 'write', 'active', 'healthy', 2, ?, 'Other', 'Taken over', ?)
  `).run('session-other', f.sourceWorktreeId, (lease.generation ?? 0) + 1, timestamp);
  f.db.prepare('UPDATE write_leases SET run_id = ?, generation = ? WHERE worktree_id = ?')
    .run('session-other', (lease.generation ?? 0) + 1, f.sourceWorktreeId);

  let pushes = 0;
  const retry = await submitDevelopmentSpace(f.db, request, {
    pushSubmissionBranch: async () => { pushes += 1; },
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.code, 'SESSION_NOT_ACTIVE');
  assert.equal(pushes, 0);
});

test('a workspace without a write lease is not blocked by the ownership check', async (t) => {
  const { f, request } = await abortedPushAttempt(t);
  // 没有写租约行的历史工作副本不应被新增的租约校验挡住。
  f.db.prepare('DELETE FROM write_leases WHERE worktree_id = ?').run(f.sourceWorktreeId);

  const retry = await submitDevelopmentSpace(f.db, request, {
    pushSubmissionBranch: async () => {},
  });
  assert.equal(retry.ok, true, JSON.stringify(retry));
});

// 真实调用链验证：探针里的 `git status` 足以触发 clean 过滤器，因此送审必须在
// 探测之前就拒绝敌意仓库，而不是等到 rejectUnsupportedSubmitFeatures。
// 开发空间是主项目的链接工作副本，二者共享 common 目录的配置与属性来源。
test('a hostile repository is refused before the first probe of the real submit chain', async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'pwned-by-submit-probe.txt');
  writeFileSync(path.join(f.mainPath, '.git', 'info', 'attributes'), '* filter=evil\n');
  git(f.mainPath, ['config', '--local', 'filter.evil.clean',
    `node -e "require('fs').writeFileSync('${marker.split(path.sep).join('/')}','pwned')"`]);

  const result = await submitDevelopmentSpace(f.db, {
    commandId: 'submit-hostile-probe',
    sessionId: f.sessionId,
    expectedRevision: 2,
    summary: '敌意仓库探测前拦截',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_FILTER_UNSUPPORTED');
  assert.equal(existsSync(marker), false, '探测之前必须已经拒绝，过滤器不得被执行');
  assert.equal(readSubmissionAttempt(f.db, 'submit-hostile-probe'), null);
});

// 进展会推进 revision，这既不代表失权，也不能让恢复被永久判死：恢复路径以
// 持久归属（会话仍拥有 run、仍持写租约、attempt 记录的同会话）为准。
test('a retry still succeeds after the same owner recorded progress', async (t) => {
  const { f, request } = await abortedPushAttempt(t);
  // 同一会话记录一次 progress：assignment 与 run 的 revision 都前进。
  f.db.prepare('UPDATE assignments SET revision = 3 WHERE session_id = ?').run(f.sessionId);
  f.db.prepare("UPDATE runs SET revision = 3 WHERE id = ? AND lifecycle = 'active'").run(f.sessionId);

  let pushes = 0;
  const retry = await submitDevelopmentSpace(f.db, request, {
    pushSubmissionBranch: async () => { pushes += 1; },
  });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.pushed, true);
  assert.equal(pushes, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM submissions').get().count, 1);
});
