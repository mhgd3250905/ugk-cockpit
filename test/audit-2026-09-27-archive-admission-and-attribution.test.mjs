// Two durable-ownership gaps found in the 2026-09-27 audit round:
//   1. the shared write-admission fence only learned a project was archived by
//      joining through development_spaces, and a project registered on its own
//      main location has no such row, so an archived project kept taking write
//      leases on the very folder the user archived (and it is hidden from the
//      dashboard, so nobody saw the work happening);
//   2. the helper that answers "which chat is working here" returned a revoked
//      binding, which is evidence of who used to work here.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { setProjectArchived } from '../src/core/manual-records.mjs';
import { checkWorkspaceWriteAdmission } from '../src/core/workspace-lifecycle.mjs';
import { createAssignment } from '../src/core/assignments.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import {
  bindConversation, readConversationBinding, readUnambiguousConversationBinding,
} from '../src/core/conversation-bindings.mjs';

const tmpRoot = () => (process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir()));

function workspace(t, name) {
  const root = mkdtempSync(path.join(tmpRoot(), 'ugk-archive-admission-'));
  t.after(() => {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {}
  });
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  t.after(() => { try { db.close(); } catch {} });
  const observation = {
    canonicalPath: `/fixture/${name}`, repositoryIdentity: `repo-${name}`, worktreeIdentity: `wt-${name}`,
    observedAt: '2026-09-27T00:00:00.000Z', coherence: 'coherent', after: { hasChanges: false },
  };
  const registered = registerProject(db, {
    commandId: `reg-${name}`, name, authorizedRoot: observation.canonicalPath, observation,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const worktreeId = db.prepare('SELECT worktree_id FROM projects WHERE id = ?')
    .get(registered.projectId).worktree_id;
  return { db, observation, projectId: registered.projectId, worktreeId };
}

test('an archived project cannot take a write lease on its main location', (t) => {
  const { db, observation, projectId, worktreeId } = workspace(t, 'main');
  assert.equal(db.prepare('SELECT count(*) n FROM development_spaces WHERE worktree_id = ?').get(worktreeId).n, 0,
    'a project registered on its own folder has no development space');

  const before = checkWorkspaceWriteAdmission(db, {
    worktreeId, repositoryIdentity: observation.repositoryIdentity, enforceObservation: false,
  });
  assert.equal(before.ok, true, JSON.stringify(before));

  const archiveRevision = db.prepare('SELECT archive_revision FROM projects WHERE id = ?').get(projectId).archive_revision;
  const archived = setProjectArchived(db, {
    commandId: 'arch-1', projectId, expectedRevision: archiveRevision, archived: true,
  });
  assert.equal(archived.ok, true, JSON.stringify(archived));

  const admission = checkWorkspaceWriteAdmission(db, {
    worktreeId, repositoryIdentity: observation.repositoryIdentity, enforceObservation: false,
  });
  assert.equal(admission.ok, false, 'archiving the project must stop new write leases on it');
  assert.equal(admission.code, 'PROJECT_ARCHIVED');
  assert.equal(admission.archivedAt, archived.archivedAt);

  // The fence is what every lease-taking path shares, so a run started straight
  // through it must not land a lease on the archived folder either.
  const run = startWriteRun(db, {
    commandId: 'run-arched', runId: 'session-arched', worktreeId,
    canonicalPath: observation.canonicalPath,
    repositoryIdentity: observation.repositoryIdentity, worktreeIdentity: observation.worktreeIdentity,
    agentClaim: 'codex', goal: 'archived', baseline: { head: 'abc' },
  });
  assert.equal(run.ok, false, JSON.stringify(run));
  assert.equal(run.code, 'PROJECT_ARCHIVED');
  assert.equal(db.prepare('SELECT count(*) n FROM write_leases').get().n, 0,
    'a rejected begin must not leave a lease behind');

  // Unarchiving restores the same worktree.
  const reopened = setProjectArchived(db, {
    commandId: 'arch-2', projectId, expectedRevision: archived.archiveRevision, archived: false,
  });
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(checkWorkspaceWriteAdmission(db, {
    worktreeId, repositoryIdentity: observation.repositoryIdentity, enforceObservation: false,
  }).ok, true);
});

test('a development space that is archived on its own still reports SPACE_ARCHIVED', (t) => {
  const { db, observation, projectId, worktreeId } = workspace(t, 'space');
  db.prepare(`
    INSERT INTO development_spaces (
      id, project_id, worktree_id, name, branch, base_commit, status, revision, created_at, updated_at
    ) VALUES ('space-1', ?, ?, 'space', 'cockpit/x', 'abc', 'archived', 1, ?, ?)
  `).run(projectId, worktreeId, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z');
  const admission = checkWorkspaceWriteAdmission(db, {
    worktreeId, repositoryIdentity: observation.repositoryIdentity, enforceObservation: false,
  });
  assert.equal(admission.ok, false);
  assert.equal(admission.code, 'SPACE_ARCHIVED');
});

test('the unambiguous binding is only ever a live binding', (t) => {
  const { db, observation, projectId, worktreeId } = workspace(t, 'binding');
  const assignment = createAssignment(db, {
    commandId: 'asg-b', projectId, agentId: 'antigravity', taskId: 'b', scope: { mode: 'standby' },
  }, { now: () => Date.parse('2026-09-27T00:00:00.000Z') });
  assert.equal(assignment.ok, true, JSON.stringify(assignment));
  const sessionId = 'session-b';
  db.prepare("UPDATE assignments SET session_id = ?, status = 'accepted', revision = 1 WHERE id = ?")
    .run(sessionId, assignment.assignmentId);

  const key = 'antigravity|chat-b';
  bindConversation(db, key, { sessionId, worktreeId, acceptedRevision: 1 }, {
    owner: { bindingKind: 'host', host: 'antigravity', locator: 'chat-b' },
  });
  assert.equal(readUnambiguousConversationBinding(db, key, worktreeId)?.sessionId, sessionId);

  // The chat is displaced: its binding is revoked, so nothing proves who is
  // working here now, and the answer must be null rather than the old name.
  db.prepare('UPDATE conversation_bindings SET revoked = 1 WHERE session_id = ?').run(sessionId);
  assert.equal(readUnambiguousConversationBinding(db, key, worktreeId), null,
    'AGENTS.md requires unattributed over guessing, and a revoked row proves the opposite');
  assert.equal(readConversationBinding(db, key, worktreeId)?.revoked, true,
    'the history reader still shows the revoked binding');
});

// The same key can hold one live binding and a newer revoked one — the chat took
// a second task and that session was later displaced. Answering from "the newest
// row for this key" would throw away the binding that is still provable.
test('a newer revoked row does not hide the live binding of the same chat', (t) => {
  const { db, projectId, worktreeId } = workspace(t, 'two-sessions');
  const first = createAssignment(db, {
    commandId: 'asg-live', projectId, agentId: 'antigravity', taskId: 'live', scope: { mode: 'standby' },
  }, { now: () => Date.parse('2026-09-27T00:00:00.000Z') });
  const second = createAssignment(db, {
    commandId: 'asg-gone', projectId, agentId: 'antigravity', taskId: 'gone', scope: { mode: 'standby' },
  }, { now: () => Date.parse('2026-09-27T00:00:00.000Z') });
  db.prepare("UPDATE assignments SET session_id = ?, status = 'accepted', revision = 1 WHERE id = ?")
    .run('session-live', first.assignmentId);
  db.prepare("UPDATE assignments SET session_id = ?, status = 'accepted', revision = 1 WHERE id = ?")
    .run('session-gone', second.assignmentId);

  const key = 'antigravity|chat-two';
  bindConversation(db, key, { sessionId: 'session-live', worktreeId, acceptedRevision: 1 }, {
    owner: { bindingKind: 'host', host: 'antigravity', locator: 'chat-two' },
  });
  bindConversation(db, key, { sessionId: 'session-gone', worktreeId, acceptedRevision: 1 }, {
    owner: { bindingKind: 'host', host: 'antigravity', locator: 'chat-two' },
  });
  // The displaced session is also the more recently bound one.
  db.prepare('UPDATE conversation_bindings SET revoked = 1, bound_at = ? WHERE session_id = ?')
    .run('2026-10-01T00:00:00.000Z', 'session-gone');

  const resolved = readUnambiguousConversationBinding(db, key, worktreeId);
  assert.equal(resolved?.sessionId, 'session-live', JSON.stringify(resolved));
  assert.equal(resolved?.revoked, false);
});
