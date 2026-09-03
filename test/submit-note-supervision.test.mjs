import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { acceptAssignment, createAssignment, recordProgress } from '../src/core/assignments.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import { createRelay, resumeRelay } from '../src/core/relays.mjs';
import { createSubmitNote, updateSubmitNote } from '../src/core/submit-notes.mjs';
import { readProjectTimeline } from '../src/core/timeline.mjs';

const git = (cwd, args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-note-supervision-'));
  const repo = path.join(root, 'repo');
  git(root, ['init', '-b', 'main', repo]);
  git(repo, ['config', 'user.name', 'Note Fixture']);
  git(repo, ['config', 'user.email', 'note@example.invalid']);
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'fixture']);
  const dbPath = path.join(root, 'state.db');
  let db = openCockpitDatabase(dbPath);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const observation = await probeGitWorktree(repo);
  const project = registerProject(db, { commandId: 'register', name: 'Fixture', authorizedRoot: repo, observation });
  return {
    repo, project, observation, get db() { return db; },
    reopen() { db.close(); db = openCockpitDatabase(dbPath); return db; },
  };
}

test('supervision: note response loss really commits, survives reopen and a moved HEAD', async (t) => {
  const f = await fixture(t);
  const request = { clientRequestId: 'lost-response', body: '  Original body\n', mcpWorkingDirectory: f.repo };
  await assert.rejects(createSubmitNote(f.db, request, { faultInjector(point) {
    if (point === 'submit_note.after_transaction_commit_before_return') throw new Error('response lost');
  } }), /response lost/);
  const stored = f.db.prepare('SELECT * FROM submit_notes').all();
  assert.equal(stored.length, 1, 'the transaction must have committed before the simulated loss');
  const source = JSON.parse(stored[0].source_json);
  git(f.repo, ['commit', '--allow-empty', '-m', 'later work']);
  assert.notEqual(git(f.repo, ['rev-parse', 'HEAD']), source.head);
  f.reopen();
  const retry = await createSubmitNote(f.db, request);
  assert.equal(retry.noteId, stored[0].id);
  assert.equal(retry.body, request.body);
  assert.deepEqual(retry.source, source);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM submit_notes').get().n, 1);
});

test('supervision: omitted remarks are stable request semantics even after later updates', async (t) => {
  const f = await fixture(t);
  const note = await createSubmitNote(f.db, { clientRequestId: 'create', body: 'note', mcpWorkingDirectory: f.repo });
  const base = { noteId: note.noteId, mcpWorkingDirectory: f.repo };
  await updateSubmitNote(f.db, { ...base, clientRequestId: 'handle', expectedRevision: 1, status: 'handled', handlingNote: 'original remark' });
  const archive = { ...base, clientRequestId: 'archive', expectedRevision: 2, status: 'archived' };
  const original = await updateSubmitNote(f.db, archive);
  assert.equal(original.handlingNote, 'original remark');
  await updateSubmitNote(f.db, { ...base, clientRequestId: 'new-remark', expectedRevision: 3, status: 'pending', handlingNote: 'later remark' });
  f.reopen();
  assert.deepEqual(await updateSubmitNote(f.db, archive), original);
  assert.equal(f.db.prepare('SELECT handling_note FROM submit_notes').get().handling_note, 'later remark');
  await assert.rejects(updateSubmitNote(f.db, { ...archive, handlingNote: '' }), { code: 'COMMAND_CONFLICT' });
});

test('supervision: an unrelated missing registered directory does not block a valid source', async (t) => {
  const valid = await fixture(t);
  const missing = await fixture(t);
  registerProject(valid.db, { commandId: 'register-other', name: 'Other project',
    authorizedRoot: missing.repo, observation: missing.observation });
  renameSync(missing.repo, `${missing.repo}-moved`);
  const note = await createSubmitNote(valid.db, { clientRequestId: 'unrelated-missing-source',
    body: 'From a valid project', mcpWorkingDirectory: valid.repo });
  assert.equal(note.projectId, valid.project.projectId);
});

test('supervision: a registered independent clone has a source timeline lane, never a merge edge', async (t) => {
  const main = await fixture(t);
  const audit = await fixture(t);
  const at = new Date().toISOString();
  main.db.prepare(`INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at)
    VALUES ('audit-source', ?, ?, ?, ?)`).run(audit.repo, audit.observation.repositoryIdentity, audit.observation.worktreeIdentity, at);
  main.db.prepare(`INSERT INTO delivery_sources (id, project_id, worktree_id, authorized_root,
    source_remote_identity, target_remote_identity, created_at) VALUES ('source', ?, 'audit-source', ?, 'fixture', 'fixture', ?)`)
    .run(main.project.projectId, audit.repo, at);
  const note = await createSubmitNote(main.db, { clientRequestId: 'audit-note', body: 'Independent review', mcpWorkingDirectory: audit.repo });
  const event = readProjectTimeline(main.db, main.project.projectId).items.find((item) => item.id === note.noteId);
  assert.equal(event.laneRole, 'delivery_source');
  assert.equal(event.worktreeId, 'audit-source');
  assert.match(event.laneLabel, /外部工作副本/);
  assert.equal(event.sourceLaneKey, undefined);
  assert.equal(event.integratedCommit, undefined);
});

test('supervision: submit leaves active workflow rows unchanged and progress/relay/resume still work', async (t) => {
  const f = await fixture(t);
  const assignment = createAssignment(f.db, { commandId: 'assign', assignmentId: 'assignment',
    projectId: f.project.projectId, agentId: 'Fixture Agent', taskId: 'continue task', scope: { mode: 'write' }, dispatchCode: 'fixture-dispatch' });
  const accepted = acceptAssignment(f.db, { dispatchCode: assignment.dispatchCode, clientRequestId: 'accept', sessionId: 'session' });
  assert.equal(accepted.ok, true);
  const worktreeId = f.db.prepare('SELECT worktree_id FROM projects WHERE id = ?').get(f.project.projectId).worktree_id;
  const started = startWriteRun(f.db, { commandId: 'start', runId: 'session', worktreeId,
    canonicalPath: f.repo, repositoryIdentity: f.observation.repositoryIdentity,
    worktreeIdentity: f.observation.worktreeIdentity, agentClaim: 'Fixture Agent', goal: 'continue task', baseline: f.observation });
  assert.equal(started.ok, true, JSON.stringify(started));
  const snapshot = () => Object.fromEntries(['runs', 'assignments', 'write_leases', 'development_spaces', 'relays', 'handoff_receipts']
    .map((table) => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]));
  const before = snapshot();
  const request = { clientRequestId: 'note', body: 'Still working', mcpWorkingDirectory: f.repo,
    bridgeBinding: { sessionId: 'session', worktreeId } };
  const note = await createSubmitNote(f.db, request);
  assert.equal(note.source.attribution.type, 'verified_session');
  await updateSubmitNote(f.db, { noteId: note.noteId, clientRequestId: 'handle', expectedRevision: 1,
    status: 'handled', mcpWorkingDirectory: f.repo });
  assert.deepEqual(snapshot(), before);
  const progress = recordProgress(f.db, { sessionId: 'session', clientRequestId: 'progress',
    expectedRevision: 1, status: 'working', note: 'Continue after submit' });
  assert.equal(progress.ok, true, JSON.stringify(progress));
  const relay = createRelay(f.db, { sessionId: 'session', clientRequestId: 'relay', expectedRevision: progress.revision,
    continueCode: 'fixture-continue', nextSessionFocus: 'continue', summary: 'working', currentState: 'active',
    completedItems: [], pendingItems: ['continue'], decisions: [], artifactRefs: [], risks: [], suggestedSkills: [] });
  assert.equal(relay.ok, true, JSON.stringify(relay));
  const resumed = resumeRelay(f.db, { continueCode: 'fixture-continue', clientRequestId: 'resume' });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const afterRelay = snapshot();
  const oldBridge = await createSubmitNote(f.db, { ...request, clientRequestId: 'old-bridge-note' });
  assert.equal(oldBridge.source.attribution, 'unattributed');
  assert.deepEqual(snapshot(), afterRelay);
});
