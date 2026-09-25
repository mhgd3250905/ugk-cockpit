import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { acceptAssignment, createAssignment } from '../src/core/assignments.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import { bindConversation } from '../src/core/conversation-bindings.mjs';
import { createSubmitNote } from '../src/core/submit-notes.mjs';

const tmpRoot = () => (process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir()));
const attributionType = (note) => (typeof note.source.attribution === 'string'
  ? note.source.attribution
  : note.source.attribution?.type);

const git = (cwd, args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

// One chat can hold more than one live binding on the same code location: the
// binding table is keyed on (conversation, worktree, session), and a session
// that never ran still keeps a row. Submit-note attribution used to read
// "the newest binding for this chat and folder", which picks a session by
// recency — exactly the guessing AGENTS.md forbids.
test('submit-note attribution refuses to guess between two live bindings of one chat', async (t) => {
  const root = mkdtempSync(path.join(tmpRoot(), 'ugk-attribution-'));
  const mainDir = path.join(root, 'main');
  mkdirSync(mainDir, { recursive: true });
  git(mainDir, ['init', '-b', 'main']);
  writeFileSync(path.join(mainDir, 'README.md'), '# attribution fixture\n');
  git(mainDir, ['add', 'README.md']);
  git(mainDir, ['-c', 'user.name=UGK Test', '-c', 'user.email=ugk@example.invalid',
    'commit', '--quiet', '-m', 'fixture']);

  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  t.after(() => {
    try { db.close(); } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });

  const observation = await probeGitWorktree(mainDir);
  const project = registerProject(db, {
    commandId: 'reg-attribution', name: 'Attribution fixture',
    authorizedRoot: mainDir, observation,
  });
  assert.equal(project.ok, true, JSON.stringify(project));
  const worktreeId = db.prepare('SELECT worktree_id FROM projects WHERE id = ?')
    .get(project.projectId).worktree_id;

  const writer = createAssignment(db, {
    commandId: 'create-writer', projectId: project.projectId, agentId: 'Codex',
    taskId: '真正在写的会话', scope: { mode: 'write' }, dispatchCode: 'dispatch-writer',
  });
  const acceptedWriter = acceptAssignment(db, {
    dispatchCode: 'dispatch-writer', clientRequestId: 'accept-writer', sessionId: 'session-writer',
  });
  assert.equal(acceptedWriter.ok, true, JSON.stringify(acceptedWriter));

  const idle = createAssignment(db, {
    commandId: 'create-idle', projectId: project.projectId, agentId: 'Antigravity',
    taskId: '从未开工的会话', scope: { mode: 'read' }, dispatchCode: 'dispatch-idle',
  });
  const acceptedIdle = acceptAssignment(db, {
    dispatchCode: 'dispatch-idle', clientRequestId: 'accept-idle', sessionId: 'session-idle',
  });
  // Either outcome is informative: a rejected second accept means the state is
  // unreachable through the product, and the test below still pins behaviour.
  process.stdout.write(`second accept: ${acceptedIdle.ok} ${acceptedIdle.code ?? ''}\n`);

  const run = startWriteRun(db, {
    commandId: 'run-writer',
    // The managed flow names the run after the session it belongs to; the
    // lease is what lets a chat with two bindings still be attributed.
    runId: 'session-writer',
    worktreeId,
    canonicalPath: observation.canonicalPath,
    repositoryIdentity: observation.repositoryIdentity,
    worktreeIdentity: observation.worktreeIdentity,
    agentClaim: 'claim-writer',
    goal: '真正在写',
    baseline: {
      head: observation.after.head, branch: observation.after.branch,
      indexFingerprint: observation.after.indexFingerprint,
      worktreeFingerprint: observation.after.worktreeFingerprint,
      repositoryIdentity: observation.repositoryIdentity,
      worktreeIdentity: observation.worktreeIdentity,
      coherence: observation.coherence, observedAt: observation.observedAt,
    },
  });
  assert.equal(run.ok, true, JSON.stringify(run));

  const conversationKey = 'conversation:codex/chat-attr-1';
  bindConversation(db, conversationKey, { sessionId: 'session-writer', worktreeId });
  if (acceptedIdle.ok) {
    bindConversation(db, conversationKey, { sessionId: 'session-idle', worktreeId });
  }
  const liveBindings = db.prepare(
    'SELECT session_id FROM conversation_bindings WHERE conversation_key = ? AND worktree_id = ? AND revoked = 0',
  ).all(conversationKey, worktreeId).map((row) => row.session_id);
  assert.equal(liveBindings.length, 2, `fixture must hold two live bindings, got ${liveBindings}`);

  // Narrowing is allowed only when a durable fact picks one of them: here the
  // write lease names the session that may have touched this code.
  const leased = await createSubmitNote(db, {
    clientRequestId: 'note-leased',
    body: '这一轮的改动归属谁？',
    mcpWorkingDirectory: mainDir,
  }, { conversationKey });
  assert.equal(leased.ok, true, JSON.stringify(leased));
  assert.equal(leased.source.attribution?.sessionId, 'session-writer',
    `attribution must follow the write lease, got ${JSON.stringify(leased.source.attribution)}`);

  // Without that evidence the chat stays ambiguous and the note is honest about
  // it, rather than crediting whichever binding happens to be newest.
  db.prepare('DELETE FROM write_leases WHERE worktree_id = ?').run(worktreeId);
  const ambiguous = await createSubmitNote(db, {
    clientRequestId: 'note-ambiguous',
    body: '没有写入租约时不能猜 Agent。',
    mcpWorkingDirectory: mainDir,
  }, { conversationKey });
  assert.equal(ambiguous.ok, true, JSON.stringify(ambiguous));
  assert.equal(attributionType(ambiguous), 'unattributed',
    `an ambiguous chat must stay unattributed, got ${JSON.stringify(ambiguous.source.attribution)}`);
});
