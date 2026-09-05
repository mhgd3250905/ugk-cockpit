import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import {
  createSubmitNote,
  readSubmitNote,
  updateSubmitNote,
  listSubmitNotes,
  formatCopyInstruction,
  normalizeReferences,
} from '../src/core/submit-notes.mjs';
import { acceptAssignment, createAssignment } from '../src/core/assignments.mjs';
import { readSubmission } from '../src/core/integrations.mjs';
import { registerDeliveryLocation } from '../src/core/delivery-sources.mjs';
import { bindConversation } from '../src/core/conversation-bindings.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function createFixture(t, name = 'submit-notes') {
  const root = mkdtempSync(path.join(os.tmpdir(), `ugk-${name}-`));
  const mainDir = path.join(root, 'main');
  const auditDir = path.join(root, 'audit');

  git(root, ['init', '-b', 'main', mainDir]);
  git(mainDir, ['config', 'user.name', 'UGK Test']);
  git(mainDir, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(path.join(mainDir, 'README.md'), '# Main seed\n');
  git(mainDir, ['add', '.']);
  git(mainDir, ['commit', '-m', 'Initial seed']);
  const initialCommit = git(mainDir, ['rev-parse', 'HEAD']);

  // Create linked audit worktree of main
  git(mainDir, ['worktree', 'add', '-b', 'audit-review', auditDir, 'main']);

  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const observation = await probeGitWorktree(mainDir);
  const registered = registerProject(db, {
    commandId: 'reg-fixture',
    name: 'Fixture Project',
    authorizedRoot: mainDir,
    observation,
  });

  const auditObs = await probeGitWorktree(auditDir);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at)
    VALUES ('wt-audit', ?, ?, ?, ?)
  `).run(auditObs.canonicalPath, auditObs.repositoryIdentity, auditObs.worktreeIdentity ?? auditObs.fingerprint ?? 'fp', now);
  db.prepare(`
    INSERT INTO development_spaces (id, project_id, worktree_id, name, branch, base_commit, status, created_at, updated_at)
    VALUES ('space-audit', ?, 'wt-audit', 'Audit Space', 'audit-review', ?, 'active', ?, ?)
  `).run(registered.projectId, initialCommit, now, now);

  t.after(() => {
    try { db.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  return { root, mainDir, auditDir, db, projectId: registered.projectId, initialCommit };
}

test('audit worktree with zero diff and dirty files can submit note referencing external PR without git writes', async (t) => {
  const { auditDir, db, projectId, initialCommit } = await createFixture(t, 'audit-zero-diff');

  // Audit HEAD is identical to main
  const auditHeadBefore = git(auditDir, ['rev-parse', 'HEAD']);
  assert.equal(auditHeadBefore, initialCommit);

  // Create dirty uncommitted changes in audit worktree
  writeFileSync(path.join(auditDir, 'DIRTY.txt'), 'local audit scratchpad notes\n');

  // Snapshot database table row counts
  const countTable = (tbl) => db.prepare(`SELECT COUNT(*) AS c FROM ${tbl}`).get().c;
  const runsBefore = countTable('runs');
  const assignmentsBefore = countTable('assignments');
  const leasesBefore = countTable('write_leases');
  const spacesBefore = countTable('development_spaces');
  const relaysBefore = countTable('relays');

  const externalPrCommit = 'e9524af1234567890abcdef1234567890abcdef1';
  const result = await createSubmitNote(db, {
    clientRequestId: 'req-audit-1',
    body: 'Audit verified PR e9524af cleanly. No changes to transport.',
    title: 'Audit Review',
    references: [
      {
        type: 'pull_request',
        target: 'https://github.com/example/repo/pull/42',
        commit: externalPrCommit,
        title: 'Fix edge case in parser',
      },
    ],
    mcpWorkingDirectory: auditDir,
  });

  assert.equal(result.ok, true);
  assert.ok(result.noteId.startsWith('note_'));
  assert.equal(result.status, 'pending');
  assert.equal(result.revision, 1);
  assert.equal(result.projectId, projectId);
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].commit, externalPrCommit);

  // Source snapshot records audit HEAD independently of reference commit
  assert.equal(result.source.head, initialCommit);
  assert.equal(result.source.shortHead, initialCommit.slice(0, 7));
  assert.notEqual(result.source.head, externalPrCommit);

  // Git state was NOT modified: no commit, no branch change, dirty file still exists
  assert.equal(git(auditDir, ['rev-parse', 'HEAD']), auditHeadBefore);
  const status = git(auditDir, ['status', '--porcelain']);
  assert.match(status, /DIRTY\.txt/);

  // Message creation did not alter session, run, space, assignment, lease, relay
  assert.equal(countTable('runs'), runsBefore);
  assert.equal(countTable('assignments'), assignmentsBefore);
  assert.equal(countTable('write_leases'), leasesBefore);
  assert.equal(countTable('development_spaces'), spacesBefore);
  assert.equal(countTable('relays'), relaysBefore);
});

test('authorized directory without prior init can submit note, attribution is unattributed without verified binding', async (t) => {
  const { mainDir, db, projectId } = await createFixture(t, 'uninit-submit');

  // Add an active assignment to the project to test whether agent is guessed
  const createdAssignment = createAssignment(db, {
    commandId: 'create-active-assignment',
    assignmentId: 'assign-active-1',
    projectId,
    agentId: 'Codex-Secret-Agent',
    taskId: 'Active task',
    scope: { mode: 'write' },
    dispatchCode: 'dispatch-active-code',
  });
  const accepted = acceptAssignment(db, {
    dispatchCode: createdAssignment.dispatchCode,
    clientRequestId: 'accept-req-active',
    sessionId: 'session-active-1',
  });
  assert.equal(accepted.ok, true);

  // Submit note without bridgeBinding: must NOT guess Codex-Secret-Agent
  const resultUnattributed = await createSubmitNote(db, {
    clientRequestId: 'req-unattributed',
    body: 'A quick update from an uninitialized agent.',
    mcpWorkingDirectory: mainDir,
  });
  assert.equal(resultUnattributed.ok, true);
  assert.equal(resultUnattributed.source.attribution, 'unattributed');

  // Submit note with valid bridgeBinding: attribution is recorded
  const worktreeId = db.prepare('SELECT worktree_id FROM projects WHERE id = ?').get(projectId).worktree_id;
  const resultAttributed = await createSubmitNote(db, {
    clientRequestId: 'req-attributed',
    body: 'An update from verified session.',
    mcpWorkingDirectory: mainDir,
    bridgeBinding: {
      sessionId: 'session-active-1',
      worktreeId,
    },
  });
  assert.equal(resultAttributed.ok, true);
  assert.deepEqual(resultAttributed.source.attribution, {
    type: 'verified_session',
    agentId: 'Codex-Secret-Agent',
    sessionId: 'session-active-1',
  });

  const binding = { sessionId: 'session-active-1', worktreeId };
  bindConversation(db, 'original-chat', binding);
  const note = (clientRequestId, conversationKey, suppliedBinding) => createSubmitNote(db, {
    clientRequestId, body: 'Durable conversation attribution.', mcpWorkingDirectory: mainDir,
    ...(suppliedBinding ? { bridgeBinding: suppliedBinding } : {}),
  }, { conversationKey });
  assert.deepEqual((await note('durable', 'original-chat')).source.attribution, resultAttributed.source.attribution);
  assert.equal((await note('forged', 'other-chat', binding)).source.attribution, 'unattributed');
  assert.equal((await note('downgraded', null, binding)).source.attribution, 'unattributed');
  bindConversation(db, 'next-chat', binding, { transfer: true });
  assert.equal((await note('revoked', 'original-chat', binding)).source.attribution, 'unattributed');
  assert.deepEqual((await note('next-owner', 'next-chat')).source.attribution, resultAttributed.source.attribution);
});

test('unknown, ambiguous, and replaced repository directories are rejected', async (t) => {
  const { root, db, mainDir, projectId } = await createFixture(t, 'rejection-tests');

  // Unknown directory outside granted root
  const foreignDir = mkdtempSync(path.join(os.tmpdir(), 'ugk-foreign-'));
  t.after(() => rmSync(foreignDir, { recursive: true, force: true }));

  await assert.rejects(
    createSubmitNote(db, {
      clientRequestId: 'req-foreign',
      body: 'Should fail',
      mcpWorkingDirectory: foreignDir,
    }),
    (err) => {
      assert.equal(err.code, 'PROJECT_NOT_FOUND');
      return true;
    },
  );

  // Worktree repository identity changed
  const fakeRepoDir = mkdtempSync(path.join(os.tmpdir(), 'ugk-fake-repo-'));
  git(fakeRepoDir, ['init', '-b', 'main', fakeRepoDir]);
  t.after(() => rmSync(fakeRepoDir, { recursive: true, force: true }));

  // Mock resolveSource returning fakeRepoDir with main's registered repository_identity
  const mainWorktree = db.prepare('SELECT * FROM worktrees WHERE canonical_path = ?').get(mainDir);
  await assert.rejects(
    createSubmitNote(db, {
      clientRequestId: 'req-id-changed',
      body: 'Should detect identity change',
      mcpWorkingDirectory: mainDir,
    }, {
      resolveSource: async () => ({
        source_type: 'project',
        project_id: projectId,
        project_name: 'Project 1',
        worktree_id: 'wt-1',
        canonical_path: fakeRepoDir,
        repository_identity: 'genuine-identity-that-does-not-match-fakeRepoDir',
        authorized_root: fakeRepoDir,
      }),
    }),
    (err) => {
      assert.equal(err.code, 'WORKTREE_IDENTITY_CHANGED');
      return true;
    },
  );
});

test('persistence idempotency: same clientRequestId returns original receipt, different payload conflicts, new request preserves new note', async (t) => {
  const { mainDir, db, projectId } = await createFixture(t, 'idempotency-tests');

  const reqPayload = {
    clientRequestId: 'idempotent-req-1',
    body: 'Initial note body',
    title: 'Idempotency Note',
    references: [{ type: 'commit', target: 'abc123' }],
    mcpWorkingDirectory: mainDir,
  };

  const firstResult = await createSubmitNote(db, reqPayload);
  assert.equal(firstResult.ok, true);
  const noteId = firstResult.noteId;

  // Replaying with identical payload returns exact same note and receipt
  const secondResult = await createSubmitNote(db, reqPayload);
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.noteId, noteId);
  assert.equal(secondResult.receipt.receiptId, firstResult.receipt.receiptId);

  // Replaying with different payload returns COMMAND_CONFLICT
  await assert.rejects(
    createSubmitNote(db, {
      ...reqPayload,
      body: 'Tampered body with same clientRequestId',
    }),
    (err) => {
      assert.equal(err.code, 'COMMAND_CONFLICT');
      return true;
    },
  );

  // New clientRequestId with same body/commit creates a new note
  const thirdResult = await createSubmitNote(db, {
    ...reqPayload,
    clientRequestId: 'idempotent-req-2',
  });
  assert.equal(thirdResult.ok, true);
  assert.notEqual(thirdResult.noteId, noteId);

  const notes = listSubmitNotes(db, { projectId });
  assert.equal(notes.length, 2);
});

test('status update CAS, idempotency, and immutability trigger', async (t) => {
  const { mainDir, db, projectId } = await createFixture(t, 'update-cas-tests');

  const note = await createSubmitNote(db, {
    clientRequestId: 'update-test-1',
    body: 'Work in progress note',
    title: 'WIP Note',
    mcpWorkingDirectory: mainDir,
  });
  assert.equal(note.status, 'pending');
  assert.equal(note.revision, 1);

  // CAS failure when expectedRevision does not match
  await assert.rejects(
    updateSubmitNote(db, {
      noteId: note.noteId,
      clientRequestId: 'update-req-wrong-rev',
      expectedRevision: 99,
      status: 'handled',
      mcpWorkingDirectory: mainDir,
    }),
    (err) => {
      assert.equal(err.code, 'NOTE_REVISION_CONFLICT');
      return true;
    },
  );

  // Successful status update increments revision to 2
  const updated = await updateSubmitNote(db, {
    noteId: note.noteId,
    clientRequestId: 'update-req-success',
    expectedRevision: 1,
    status: 'handled',
    handlingNote: 'Checked and verified by maintainer.',
    mcpWorkingDirectory: mainDir,
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.status, 'handled');
  assert.equal(updated.revision, 2);
  assert.ok(updated.handledAt);

  // Idempotent retry of status update returns identical result
  const updateRetry = await updateSubmitNote(db, {
    noteId: note.noteId,
    clientRequestId: 'update-req-success',
    expectedRevision: 1,
    status: 'handled',
    handlingNote: 'Checked and verified by maintainer.',
    mcpWorkingDirectory: mainDir,
  });
  assert.equal(updateRetry.ok, true);
  assert.equal(updateRetry.revision, 2);

  // Verify immutability trigger prevents rewriting body directly
  assert.throws(
    () => {
      db.prepare('UPDATE submit_notes SET body = ? WHERE id = ?').run('hacked body', note.noteId);
    },
    /submit_notes content is immutable/i,
  );

  // Read note reflects latest status and handling note
  const readResult = await readSubmitNote(db, {
    noteId: note.noteId,
    mcpWorkingDirectory: mainDir,
  });
  assert.equal(readResult.note.status, 'handled');
  assert.equal(readResult.note.revision, 2);
  assert.equal(readResult.note.body, 'Work in progress note');
  assert.equal(readResult.note.handlingNote, 'Checked and verified by maintainer.');
  assert.match(readResult.copyText, /Checked and verified by maintainer/);
  assert.match(readResult.copyText, /建议下一步/);
  assert.doesNotMatch(readResult.copyText, /ugk_integration_/);
});

test('working tree changes do not alter or delete previous submit_notes, and noteId cannot be used by old integration', async (t) => {
  const { mainDir, db, projectId, initialCommit } = await createFixture(t, 'isolation-tests');

  const note = await createSubmitNote(db, {
    clientRequestId: 'isolate-req-1',
    body: 'Snapshot test note',
    references: [{ type: 'pr', target: 'https://example.com/pr/1' }],
    mcpWorkingDirectory: mainDir,
  });

  // Make a new commit in mainDir
  writeFileSync(path.join(mainDir, 'NEW_FILE.md'), 'new commit after note\n');
  git(mainDir, ['add', '.']);
  git(mainDir, ['commit', '-m', 'Commit after note']);
  const newCommit = git(mainDir, ['rev-parse', 'HEAD']);
  assert.notEqual(newCommit, initialCommit);

  // Read note back: source snapshot must STILL retain original initialCommit
  const readBack = await readSubmitNote(db, {
    noteId: note.noteId,
    mcpWorkingDirectory: mainDir,
  });
  assert.equal(readBack.note.source.head, initialCommit);
  assert.notEqual(readBack.note.source.head, newCommit);

  // NoteId cannot be used as submissionId by old integration
  const oldSubmissionLookup = readSubmission(db, note.noteId);
  assert.equal(oldSubmissionLookup, null);
});

test('subdirectory is accepted, sibling directory is rejected, and metadata escape is rejected', async (t) => {
  const { root, db, mainDir, projectId } = await createFixture(t, 'boundary-tests');

  // Subdirectory inside mainDir is accepted
  const subDir = path.join(mainDir, 'src', 'components');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(path.join(subDir, 'widget.js'), '// widget\n');
  const subNote = await createSubmitNote(db, {
    clientRequestId: 'req-subdir',
    body: 'From subdirectory',
    mcpWorkingDirectory: subDir,
  });
  assert.equal(subNote.ok, true);
  assert.equal(subNote.projectId, projectId);

  // Sibling directory outside canonical path is rejected even if inside same parent temp root
  const siblingDir = path.join(root, 'sibling-outside');
  mkdirSync(siblingDir, { recursive: true });
  await assert.rejects(
    createSubmitNote(db, {
      clientRequestId: 'req-sibling',
      body: 'From sibling',
      mcpWorkingDirectory: siblingDir,
    }),
    (err) => {
      assert.equal(err.code, 'PROJECT_NOT_FOUND');
      return true;
    },
  );

  // Metadata escape: git-common-dir or git-dir pointing outside authorized root is rejected
  const outsideGitDir = mkdtempSync(path.join(os.tmpdir(), 'ugk-outside-git-'));
  t.after(() => rmSync(outsideGitDir, { recursive: true, force: true }));
  await assert.rejects(
    createSubmitNote(db, {
      clientRequestId: 'req-meta-escape',
      body: 'Metadata escape attempt',
      mcpWorkingDirectory: mainDir,
    }, {
      gitText: async (cwd, args) => {
        if (args.includes('--git-common-dir')) {
          return outsideGitDir;
        }
        return git(cwd, args);
      },
    }),
    (err) => {
      assert.ok(['PATH_NOT_AUTHORIZED', 'WORKTREE_IDENTITY_CHANGED'].includes(err.code));
      return true;
    },
  );
});

test('attribution: relay generation mismatch, finished session, and worktree mismatch revert to unattributed', async (t) => {
  const { mainDir, db, projectId } = await createFixture(t, 'attribution-edge-cases');

  const createdAssignment = createAssignment(db, {
    commandId: 'create-active-assignment',
    assignmentId: 'assign-attr-1',
    projectId,
    agentId: 'Codex-Attr',
    taskId: 'Attribution task',
    scope: { mode: 'write' },
    dispatchCode: 'dispatch-attr-code',
  });
  const accepted = acceptAssignment(db, {
    dispatchCode: createdAssignment.dispatchCode,
    clientRequestId: 'accept-attr',
    sessionId: 'session-attr-1',
  });
  assert.equal(accepted.ok, true);

  const worktreeId = db.prepare('SELECT worktree_id FROM projects WHERE id = ?').get(projectId).worktree_id;

  // 1. Valid binding matches
  const res1 = await createSubmitNote(db, {
    clientRequestId: 'req-attr-valid',
    body: 'Valid binding note',
    mcpWorkingDirectory: mainDir,
    bridgeBinding: { sessionId: 'session-attr-1', worktreeId },
  });
  assert.equal(res1.source.attribution?.agentId, 'Codex-Attr');

  // 2. Insert accepted relay generation, but bridgeBinding has outdated generation (null)
  db.prepare(`
    INSERT INTO relays (
      id, sequence, assignment_id, project_id, worktree_id, session_id,
      client_request_id, expected_revision, revision, next_session_focus,
      summary, current_state, completed_items, pending_items, decisions,
      artifact_refs, risks, suggested_skills, code_hash, state, expires_at,
      created_at, accepted_at, accepted_revision
    ) VALUES (
      'relay-1', 1, 'assign-attr-1', ?, ?, 'session-attr-1',
      'client-req-relay-1', 1, 1, 'next focus',
      'summary', 'state', '[]', '[]', '[]',
      '[]', '[]', '[]', 'codehash123', 'accepted', 9999999999,
      ?, ?, 2
    )
  `).run(projectId, worktreeId, new Date().toISOString(), new Date().toISOString());

  const resOutdatedRelay = await createSubmitNote(db, {
    clientRequestId: 'req-attr-outdated-relay',
    body: 'Outdated relay note',
    mcpWorkingDirectory: mainDir,
    bridgeBinding: { sessionId: 'session-attr-1', worktreeId, relayId: null },
  });
  assert.equal(resOutdatedRelay.source.attribution, 'unattributed');

  // 3. Finished session lifecycle reverts to unattributed
  db.prepare(`
    INSERT INTO runs (id, worktree_id, mode, lifecycle, health, revision, lease_generation, agent_claim, goal, created_at)
    VALUES ('session-attr-1', ?, 'write', 'completed', 'healthy', 1, 1, 'Codex-Attr', 'Goal', ?)
  `).run(worktreeId, new Date().toISOString());

  const resFinished = await createSubmitNote(db, {
    clientRequestId: 'req-attr-finished',
    body: 'Finished session note',
    mcpWorkingDirectory: mainDir,
    bridgeBinding: { sessionId: 'session-attr-1', worktreeId, relayId: 'relay-1', relaySequence: 1, acceptedRevision: 2 },
  });
  assert.equal(resFinished.source.attribution, 'unattributed');

  // 4. Mismatched worktreeId reverts to unattributed
  const resWrongWt = await createSubmitNote(db, {
    clientRequestId: 'req-attr-wrong-wt',
    body: 'Wrong worktree note',
    mcpWorkingDirectory: mainDir,
    bridgeBinding: { sessionId: 'session-attr-1', worktreeId: 'wrong-worktree-id' },
  });
  assert.equal(resWrongWt.source.attribution, 'unattributed');
});

test('references validation rejects unknown keys, invalid fields, and aliases, body preserves untrimmed text', async (t) => {
  const { mainDir, db } = await createFixture(t, 'references-tests');

  // Non-array rejected
  assert.throws(() => normalizeReferences('not-an-array'), /must be an array/);
  // Over 20 items rejected
  assert.throws(() => normalizeReferences(Array.from({ length: 21 }, () => ({ target: 'a' }))), /cannot exceed 20/);
  // Non-object element rejected
  assert.throws(() => normalizeReferences(['string-not-allowed']), /must be an object/);
  // Missing target rejected
  assert.throws(() => normalizeReferences([{ type: 'pr' }]), /target must be a non-empty string/);
  // Exceeding target length (>1024) rejected
  assert.throws(() => normalizeReferences([{ target: 'x'.repeat(1025) }]), /exceeds maximum length/);
  // Exceeding type length (>64) rejected
  assert.throws(() => normalizeReferences([{ target: 't', type: 'x'.repeat(65) }]), /type must be a string up to 64/);
  // Exceeding commit length (>128) rejected
  assert.throws(() => normalizeReferences([{ target: 't', commit: 'x'.repeat(129) }]), /commit must be a string up to 128/);
  // Exceeding title length (>200) rejected
  assert.throws(() => normalizeReferences([{ target: 't', title: 'x'.repeat(201) }]), /title must be a string up to 200/);
  // Exceeding note length (>1000) rejected
  assert.throws(() => normalizeReferences([{ target: 't', note: 'x'.repeat(1001) }]), /note must be a string up to 1000/);
  // Unknown property or aliases rejected
  assert.throws(() => normalizeReferences([{ target: 't', ref: 'alias-not-allowed' }]), /unknown property: ref/);
  assert.throws(() => normalizeReferences([{ target: 't', summary: 'summary-alias-not-allowed' }]), /unknown property: summary/);

  // Body stores original untrimmed text
  const originalBody = '   Leading and trailing spaces preserved in body   \n';
  const note = await createSubmitNote(db, {
    clientRequestId: 'req-raw-body',
    body: originalBody,
    mcpWorkingDirectory: mainDir,
  });
  assert.equal(note.body, originalBody);
  const fetched = await readSubmitNote(db, { noteId: note.noteId, mcpWorkingDirectory: mainDir });
  assert.equal(fetched.note.body, originalBody);
});

test('recovery test: committed submit note with simulated response failure survives database reopen and replays receipt', async (t) => {
  const { mainDir, root, db } = await createFixture(t, 'recovery-fault-tests');
  const dbPath = path.join(root, 'cockpit.db');

  const countTable = (database, tbl) => database.prepare(`SELECT COUNT(*) AS c FROM ${tbl}`).get().c;
  const runsBefore = countTable(db, 'runs');
  const assignmentsBefore = countTable(db, 'assignments');
  const leasesBefore = countTable(db, 'write_leases');
  const spacesBefore = countTable(db, 'development_spaces');
  const relaysBefore = countTable(db, 'relays');

  const faultInjector = (hookPoint) => {
    if (hookPoint === 'submit_note.after_transaction_commit_before_return') {
      const err = new Error('SIMULATED_NETWORK_OR_CRASH_FAILURE');
      err.code = 'SIMULATED_FAILURE';
      throw err;
    }
  };

  const req = {
    clientRequestId: 'fault-inject-req-1',
    body: 'Note submitted before simulated crash',
    mcpWorkingDirectory: mainDir,
  };

  // The request throws due to faultInjector after transaction commit
  await assert.rejects(
    createSubmitNote(db, req, { faultInjector }),
    /SIMULATED_NETWORK_OR_CRASH_FAILURE/,
  );

  // Close db to simulate crash / process restart
  db.close();

  // Reopen db2
  const db2 = openCockpitDatabase(dbPath);
  try {
    // Note row has been persisted
    const row = db2.prepare('SELECT * FROM submit_notes WHERE body = ?').get(req.body);
    assert.ok(row);
    assert.equal(row.revision, 1);
    assert.equal(row.status, 'pending');

    // Retry with exact same clientRequestId
    const retryResult = await createSubmitNote(db2, req);
    assert.equal(retryResult.ok, true);
    assert.equal(retryResult.noteId, row.id);
    assert.equal(retryResult.receipt.commandId, row.command_id);

    // Exactly 1 submit note in table
    assert.equal(countTable(db2, 'submit_notes'), 1);

    // runs, assignments, leases, spaces, relays row counts are completely unchanged
    assert.equal(countTable(db2, 'runs'), runsBefore);
    assert.equal(countTable(db2, 'assignments'), assignmentsBefore);
    assert.equal(countTable(db2, 'write_leases'), leasesBefore);
    assert.equal(countTable(db2, 'development_spaces'), spacesBefore);
    assert.equal(countTable(db2, 'relays'), relaysBefore);
  } finally {
    db2.close();
  }
});
