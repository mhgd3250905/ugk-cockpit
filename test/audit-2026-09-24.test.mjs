import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject, worktreeIdFor } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import { appendProgressEvent } from '../src/core/assignments.mjs';
import { createDevelopmentSpace } from '../src/core/spaces.mjs';
import { submitDevelopmentSpace } from '../src/core/submission-service.mjs';
import {
  beginIntegrationReview,
  mergeApprovedSubmission,
  recordSessionIntegrationReview,
} from '../src/core/integration-service.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

// POSIX temp roots are themselves symlinks and path authorization refuses to
// follow them, so fixtures must live under the resolved root.
const tmpRoot = () => (process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir()));
const git = (cwd, args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const snapshot = (o) => ({
  head: o.after.head, branch: o.after.branch,
  indexFingerprint: o.after.indexFingerprint, worktreeFingerprint: o.after.worktreeFingerprint,
  repositoryIdentity: o.repositoryIdentity, worktreeIdentity: o.worktreeIdentity,
  headRelation: 'same', coherence: o.coherence, observedAt: o.observedAt,
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TOKEN = 'audit-2026-09-24-token-that-is-long-enough';

async function standbySession(t) {
  const root = mkdtempSync(path.join(tmpRoot(), 'ugk-audit-begin-'));
  git(root, ['init', '--quiet', '-b', 'main']);
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['-c', 'user.name=UGK Test', '-c', 'user.email=ugk@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const dbPath = path.join(root, 'cockpit.db');
  const observation = await probeGitWorktree(root);
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-audit-fixture', name: 'Audit fixture', authorizedRoot: root, observation,
  });
  db.close();
  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  const post = async (pathname, body) => {
    const response = await fetch(`http://${service.host}:${service.port}${pathname}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const created = await post(`/api/v1/projects/${project.projectId}/assignments`, {
    clientRequestId: 'create-standby', agent: 'Codex', mode: 'handoff', task: '',
  });
  const dispatchCode = created.json.message.match(/dispatchCode: "([^"]+)"/)?.[1];
  const accepted = await post('/api/v1/mcp/work/accept', { dispatchCode, clientRequestId: 'accept-standby' });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { post, dbPath, sessionId: accepted.json.sessionId, revision: accepted.json.revision };
}

test('a rejected work/begin leaves no write lease and no active Run behind', async (t) => {
  const { post, dbPath, sessionId } = await standbySession(t);

  // expectedRevision is supplied by the agent, so a stale value is ordinary
  // misuse. Before the precondition check ran first, this single request
  // created a Run and took the lease and then reported a bare conflict.
  const rejected = await post('/api/v1/mcp/work/begin', {
    sessionId, clientRequestId: 'begin-stale', expectedRevision: 999, task: 'stale revision work',
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json.code, 'ASSIGNMENT_REVISION_CONFLICT');

  const db = openCockpitDatabase(dbPath, { migrate: false });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM write_leases').get().n, 0,
      'a rejected begin must not leave a held write lease');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0,
      'a rejected begin must not leave an active Run');
    assert.equal(db.prepare('SELECT status FROM assignments WHERE session_id = ?').get(sessionId).status, 'accepted');
  } finally {
    db.close();
  }

  // The obvious recovery -- retrying with the revision actually held -- must
  // work, and must not be blocked by the lease the failed attempt used to take.
  const retry = await post('/api/v1/mcp/work/begin', {
    sessionId, clientRequestId: 'begin-corrected', expectedRevision: 1, task: 'real work',
  });
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  assert.equal(retry.json.status, 'active');

  const after = openCockpitDatabase(dbPath, { migrate: false });
  try {
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM write_leases').get().n, 1);
    assert.equal(after.prepare('SELECT status, revision FROM assignments WHERE session_id = ?').get(sessionId).status, 'active');
  } finally {
    after.close();
  }
});

test('work/begin does not consume an idempotency key it is going to reject', async (t) => {
  const { post, dbPath, sessionId } = await standbySession(t);

  const first = await post('/api/v1/mcp/work/begin', {
    sessionId, clientRequestId: 'begin-once', expectedRevision: 999, task: 'stale',
  });
  assert.equal(first.json.code, 'ASSIGNMENT_REVISION_CONFLICT');

  // Reusing the same clientRequestId with the corrected revision used to fail
  // with COMMAND_CONFLICT because the rejected attempt had already frozen the
  // stale intent under that key.
  const corrected = await post('/api/v1/mcp/work/begin', {
    sessionId, clientRequestId: 'begin-once', expectedRevision: 1, task: 'stale',
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.json));

  const db = openCockpitDatabase(dbPath, { migrate: false });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM write_leases').get().n, 1);
  } finally {
    db.close();
  }
});

async function approvedSubmission(t) {
  const container = mkdtempSync(path.join(tmpRoot(), 'ugk-audit-merge-'));
  const mainPath = path.join(container, 'main');
  const spacePath = path.join(container, 'space');
  const remotePath = path.join(container, 'remote.git');
  git(container, ['init', '--bare', remotePath]);
  git(container, ['init', '-b', 'main', mainPath]);
  git(mainPath, ['config', 'user.name', 'UGK Test']);
  git(mainPath, ['config', 'user.email', 'ugk@example.invalid']);
  writeFileSync(path.join(mainPath, 'README.md'), 'seed\n');
  git(mainPath, ['add', 'README.md']);
  git(mainPath, ['commit', '-m', 'seed']);
  git(mainPath, ['remote', 'add', 'origin', remotePath]);
  git(mainPath, ['push', '--set-upstream', 'origin', 'main']);
  git(mainPath, ['worktree', 'add', '-b', 'cockpit/work/audit', spacePath, 'HEAD']);

  const db = openCockpitDatabase(path.join(container, 'cockpit.db'));
  const main = await probeGitWorktree(mainPath);
  const space = await probeGitWorktree(spacePath);
  const project = registerProject(db, {
    commandId: 'register-audit-merge', name: 'Merge fixture', authorizedRoot: mainPath, observation: main,
  });
  const spaceRow = createDevelopmentSpace(db, {
    commandId: 'create-audit-space', projectId: project.projectId, name: 'dev',
    branch: space.after.branch, baseCommit: space.after.head, worktreeId: worktreeIdFor(space.worktreeIdentity),
    canonicalPath: space.canonicalPath, repositoryIdentity: space.repositoryIdentity,
    worktreeIdentity: space.worktreeIdentity,
  });
  const createdAt = new Date().toISOString();
  for (const [id, sid, wt, goal, o] of [
    ['assignment-audit-dev', 'session-audit-dev', worktreeIdFor(space.worktreeIdentity), 'impl', space],
    ['assignment-audit-main', 'session-audit-main', worktreeIdFor(main.worktreeIdentity), 'review', main],
  ]) {
    db.prepare(`
      INSERT INTO assignments (
        id, project_id, worktree_id, agent_id, task_id, scope_json,
        status, revision, session_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'Codex', ?, '{"mode":"write"}', 'active', 1, ?, ?, ?)
    `).run(id, project.projectId, wt, goal, sid, createdAt, createdAt);
    assert.equal(startWriteRun(db, {
      commandId: `start-${sid}`, runId: sid, worktreeId: wt, canonicalPath: o.canonicalPath,
      repositoryIdentity: o.repositoryIdentity, worktreeIdentity: o.worktreeIdentity,
      agentClaim: 'Codex', goal, baseline: snapshot(o),
    }).ok, true);
    assert.equal(appendProgressEvent(db, {
      sessionId: sid, clientRequestId: `activate-${sid}`, expectedRevision: 1, status: 'active', summary: goal,
    }).ok, true);
  }
  writeFileSync(path.join(spacePath, 'feature.txt'), 'ready\n');
  const submitted = await submitDevelopmentSpace(db, {
    commandId: 'submit-audit-feature', sessionId: 'session-audit-dev',
    expectedRevision: 2, summary: '完成功能',
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const begun = await beginIntegrationReview(db, {
    commandId: 'begin-audit-review', sessionId: 'session-audit-main',
    submissionId: submitted.submissionId, expectedRevision: 2, expectedSubmissionRevision: 0,
  });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const reviewed = await recordSessionIntegrationReview(db, {
    commandId: 'record-audit-review', sessionId: 'session-audit-main', submissionId: submitted.submissionId,
    claimId: begun.claimId, expectedRevision: 2, expectedClaimRevision: begun.claimRevision,
    verdict: 'approved', summary: '审核通过', findings: [], checks: ['tests passed'],
  });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  t.after(() => {
    db.close();
    rmSync(container, { recursive: true, force: true });
  });
  return { db, submissionId: submitted.submissionId, claimId: begun.claimId, reviewed };
}

test('concurrent replays of one merge command share a single driver', async (t) => {
  const f = await approvedSubmission(t);
  let entries = 0;
  let peakConcurrent = 0;
  const options = {
    fastForwardMain: async () => {
      entries += 1;
      peakConcurrent = Math.max(peakConcurrent, entries);
      await wait(120);
      entries -= 1;
      throw Object.assign(new Error('stubbed'), { code: 'STUB_STOPS_BEFORE_WRITE' });
    },
    pushIntegratedMain: async () => {},
  };
  const request = {
    commandId: 'concurrent-audit-merge', sessionId: 'session-audit-main', submissionId: f.submissionId,
    claimId: f.claimId, expectedRevision: 2, expectedSubmissionRevision: f.reviewed.submissionRevision,
    expectedClaimRevision: f.reviewed.claimRevision, summary: '并发合并',
  };

  // Both calls use the identical request id a losing client is told to reuse.
  const settled = await Promise.allSettled([
    mergeApprovedSubmission(f.db, request, options),
    mergeApprovedSubmission(f.db, request, options),
  ]);

  // Before the single-flight guard the second driver raced the
  // integration_attempts insert and threw a raw SQLite constraint error.
  for (const outcome of settled) {
    assert.equal(outcome.status, 'fulfilled', String(outcome.reason?.message));
    assert.equal(typeof outcome.value, 'object');
    assert.equal(outcome.value.ok, false);
    assert.equal(typeof outcome.value.code, 'string');
    assert.notEqual(outcome.value.code, undefined);
  }
  assert.equal(peakConcurrent, 1, 'only one driver may reach the durable merge');
  assert.equal(settled[0].value.code, settled[1].value.code, 'both callers see the same typed outcome');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM repository_locks').get().n, 0,
    'no repository lock is left stranded');
});

test('a merge aborts before any write if its repository lock is taken over', async (t) => {
  const f = await approvedSubmission(t);
  let fastForwarded = 0;
  let pushed = 0;
  const options = {
    lockTtlMs: 60_000,
    // The last override that runs before the fast-forward branch, so this is
    // where a lock lost during the preceding awaits has to be noticed.
    isCommitDescendant: async () => {
      f.db.prepare('UPDATE repository_locks SET holder = ?, lock_id = ?')
        .run('integrate:someone-elses-command', 'lock_stolen_by_another_holder');
      return true;
    },
    fastForwardMain: async () => { fastForwarded += 1; },
    pushIntegratedMain: async () => { pushed += 1; },
  };
  const result = await mergeApprovedSubmission(f.db, {
    commandId: 'lock-taken-over', sessionId: 'session-audit-main', submissionId: f.submissionId,
    claimId: f.claimId, expectedRevision: 2, expectedSubmissionRevision: f.reviewed.submissionRevision,
    expectedClaimRevision: f.reviewed.claimRevision, summary: '锁被接管',
  }, options);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'REPOSITORY_LOCKED');
  assert.equal(fastForwarded, 0, 'the main repository must not be written after the lock was lost');
  assert.equal(pushed, 0);
  assert.notEqual(result.localIntegrated, true, 'a merge that never fast-forwarded must not claim local integration');
  // The real holder's row survives the losing driver's release attempt.
  const row = f.db.prepare('SELECT holder FROM repository_locks').get();
  assert.equal(row?.holder, 'integrate:someone-elses-command');
  f.db.prepare('DELETE FROM repository_locks').run();
});

test('concurrent same id with a different body is refused without disturbing the driver', async (t) => {
  const f = await approvedSubmission(t);
  let started = 0;
  const base = {
    commandId: 'divergent-body', sessionId: 'session-audit-main', submissionId: f.submissionId,
    claimId: f.claimId, expectedRevision: 2, expectedSubmissionRevision: f.reviewed.submissionRevision,
    expectedClaimRevision: f.reviewed.claimRevision,
  };
  const slow = {
    lockTtlMs: 60_000,
    fastForwardMain: async () => {
      started += 1;
      // While this driver is in flight, a second caller arrives with the same
      // id but edited text: that is a different command, not a retry.
      const clash = await mergeApprovedSubmission(f.db, { ...base, summary: 'second body' }, {
        lockTtlMs: 60_000, fastForwardMain: async () => { started += 100; }, pushIntegratedMain: async () => {},
      });
      assert.equal(clash.ok, false);
      assert.equal(clash.code, 'COMMAND_CONFLICT');
      assert.equal(clash.retryable, false);
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw Object.assign(new Error('stubbed'), { code: 'STUB_STOPS_BEFORE_WRITE' });
    },
    pushIntegratedMain: async () => {},
  };
  const first = await mergeApprovedSubmission(f.db, { ...base, summary: 'first body' }, slow);
  assert.equal(first.ok, false);
  assert.equal(first.code, 'STUB_STOPS_BEFORE_WRITE', 'the in-flight driver ran to its own failure point');
  assert.equal(started, 1, 'the conflicting caller must never start a second driver');
});

test('a lock lost before the reviewed-delivery import stops that import', async (t) => {
  const f = await approvedSubmission(t);
  // The import branch only runs for a submission that carries a delivery, so
  // attach one. Nothing else about the row changes, so the frozen revisions the
  // merge re-checks still match.
  f.db.prepare("UPDATE submissions SET delivery_json = ? WHERE id = ?")
    .run(JSON.stringify({ sourceId: 'source-under-test' }), f.submissionId);

  let imports = 0;
  let stolen = false;
  const options = {
    lockTtlMs: 60_000,
    // probeMain runs before the import, which makes it the point where a lock
    // taken over during the earlier awaits has to be noticed.
    probe: async (target) => {
      if (!stolen) {
        stolen = true;
        f.db.prepare('UPDATE repository_locks SET holder = ?, lock_id = ?')
          .run('integrate:another-operation', 'lock_taken_over_before_import');
      }
      return probeGitWorktree(target);
    },
    importReviewedDelivery: async () => { imports += 1; },
    fastForwardMain: async () => {},
    pushIntegratedMain: async () => {},
  };
  const result = await mergeApprovedSubmission(f.db, {
    commandId: 'lock-before-import', sessionId: 'session-audit-main', submissionId: f.submissionId,
    claimId: f.claimId, expectedRevision: 2, expectedSubmissionRevision: f.reviewed.submissionRevision,
    expectedClaimRevision: f.reviewed.claimRevision, summary: '导入前丢锁',
  }, options);
  assert.equal(stolen, true, 'the merge must have reached the point after the first probe');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REPOSITORY_LOCKED');
  assert.equal(imports, 0, 'objects must not be fetched into a repository this driver no longer holds');
});

test('an unexpired lock is honoured when the caller injects a clock', async (t) => {
  const f = await approvedSubmission(t);
  let reached = 0;
  const options = {
    // A clock far behind wall time. Expiry must be judged against this clock:
    // comparing expires_at to Date.now() instead would report a lock that has
    // not expired and refuse a merge that is allowed to run.
    clock: () => 0,
    lockTtlMs: 60_000,
    fastForwardMain: async () => {
      reached += 1;
      throw Object.assign(new Error('stubbed'), { code: 'STUB_STOPS_BEFORE_WRITE' });
    },
    pushIntegratedMain: async () => {},
  };
  const result = await mergeApprovedSubmission(f.db, {
    commandId: 'injected-clock', sessionId: 'session-audit-main', submissionId: f.submissionId,
    claimId: f.claimId, expectedRevision: 2, expectedSubmissionRevision: f.reviewed.submissionRevision,
    expectedClaimRevision: f.reviewed.claimRevision, summary: '注入时钟',
  }, options);
  assert.equal(reached, 1, 'the lock is valid on the injected clock, so the merge may proceed');
  assert.equal(result.code, 'STUB_STOPS_BEFORE_WRITE');
  assert.notEqual(result.code, 'REPOSITORY_LOCKED');
});

test('a merge aborts before any write if its repository lock expires', async (t) => {
  const f = await approvedSubmission(t);
  let fastForwarded = 0;
  const options = {
    lockTtlMs: 1,
    // Make the expiry a fact rather than a race: the re-assert happens after
    // this step, so the one-millisecond ttl has certainly elapsed by then.
    isCommitDescendant: async () => {
      await wait(25);
      return true;
    },
    fastForwardMain: async () => { fastForwarded += 1; },
    pushIntegratedMain: async () => {},
  };
  const result = await mergeApprovedSubmission(f.db, {
    commandId: 'lock-expired', sessionId: 'session-audit-main', submissionId: f.submissionId,
    claimId: f.claimId, expectedRevision: 2, expectedSubmissionRevision: f.reviewed.submissionRevision,
    expectedClaimRevision: f.reviewed.claimRevision, summary: '锁已过期',
  }, options);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REPOSITORY_LOCKED');
  assert.equal(fastForwarded, 0);
});
