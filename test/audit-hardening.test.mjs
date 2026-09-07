// Regression coverage for the audit hardening round:
// - timeline read-model dedupe (adopted events, handoff/relay dual-run joins)
// - one-time adoption guard in appendProgressEvent
// - safe git remote names on push and ssh URL hostnames
// - MCP protocol fixes (id-bearing requests answered, bounded arrays, shutdown abort)
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { appendProgressEvent } from '../src/core/assignments.mjs';
import { readProjectTimeline } from '../src/core/timeline.mjs';
import { pushSubmissionBranch } from '../src/git/submit-ops.mjs';
import { pushIntegratedMain } from '../src/git/integration-ops.mjs';
import { assertSafeRemoteName } from '../src/git/probe.mjs';
import { validateRemoteUrlSecurity } from '../src/git/delivery-ops.mjs';
import { TOOLS, createMcpServer, dispatchMessage } from '../src/mcp/stdio-protocol.mjs';

const AT = '2026-09-08T00:00:00.000Z';

function createFixtureDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ugk-audit-hardening-'));
  const db = openCockpitDatabase(path.join(dir, 'cockpit.db'));
  db.prepare(`
    INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at)
    VALUES ('wt-main', 'C:/tmp/audit-main', 'repo-audit', 'fp-main', ?)
  `).run(AT);
  db.prepare(`
    INSERT INTO projects (id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at, repository_identity)
    VALUES ('proj-audit', 'Audit', 'development', 'wt-main', 'ready', 'r', ?, ?, ?, 'repo-audit')
  `).run(AT, AT, AT);
  return { dir, db };
}

test('timeline renders one init entry per assignment even with multiple adopted events', () => {
  const { dir, db } = createFixtureDb();
  try {
    db.prepare(`
      INSERT INTO assignments (id, project_id, worktree_id, agent_id, task_id, scope_json,
        status, revision, session_id, created_at, updated_at)
      VALUES ('asg-dup', 'proj-audit', 'wt-main', 'Codex', 'task', '{}',
        'active', 3, 'run-dup', ?, ?)
    `).run(AT, AT);
    db.prepare(`
      INSERT INTO progress_events (id, assignment_id, session_id, client_request_id,
        expected_revision, revision, status, note, created_at)
      VALUES ('pe-dup-1', 'asg-dup', 'run-dup', 'cr-1', 1, 2, 'adopted', 'first begin', ?)
    `).run(AT);
    db.prepare(`
      INSERT INTO progress_events (id, assignment_id, session_id, client_request_id,
        expected_revision, revision, status, note, created_at)
      VALUES ('pe-dup-2', 'asg-dup', 'run-dup', 'cr-2', 2, 3, 'adopted', 'second begin', ?)
    `).run(AT);

    const timeline = readProjectTimeline(db, 'proj-audit', { limit: 100 });
    const initEntries = timeline.items.filter((item) => item.id === 'init_asg-dup');
    assert.equal(initEntries.length, 1, 'duplicate adopted events must not duplicate the init entry');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('timeline renders one entry per handoff even when session and run both have final snapshots', () => {
  const { dir, db } = createFixtureDb();
  try {
    db.prepare(`
      INSERT INTO assignments (id, project_id, worktree_id, agent_id, task_id, scope_json,
        status, revision, session_id, created_at, updated_at)
      VALUES ('asg-h', 'proj-audit', 'wt-main', 'Codex', 'task', '{}',
        'active', 1, 'run-handoff-session', ?, ?)
    `).run(AT, AT);
    db.prepare(`
      INSERT INTO runs (id, worktree_id, mode, lifecycle, health, revision, lease_generation,
        agent_claim, goal, created_at, finished_at)
      VALUES ('run-handoff-session', 'wt-main', 'write', 'completed', 'healthy', 2, 1,
        'Codex', 'goal session', ?, ?)
    `).run(AT, AT);
    db.prepare(`
      INSERT INTO runs (id, worktree_id, mode, lifecycle, health, revision, lease_generation,
        agent_claim, goal, created_at, finished_at)
      VALUES ('run-handoff-final', 'wt-main', 'write', 'completed', 'healthy', 2, 1,
        'Codex', 'goal final', ?, ?)
    `).run(AT, AT);
    for (const runId of ['run-handoff-session', 'run-handoff-final']) {
      db.prepare(`
        INSERT INTO snapshots (id, run_id, phase, coherence, observed_at,
          repository_identity, worktree_identity, head_relation)
        VALUES (?, ?, 'final', 'coherent', ?, 'repo-audit', 'fp-main', 'same')
      `).run(`snap-${runId}`, runId, AT);
    }
    db.prepare(`
      INSERT INTO handoffs (id, sequence, assignment_id, project_id, worktree_id,
        session_id, run_id, client_request_id, expected_revision, revision,
        next_session_focus, summary, current_state, completed_items, pending_items,
        decisions, artifact_refs, risks, suggested_skills, body_markdown, created_at)
      VALUES ('h-dup', 1, 'asg-h', 'proj-audit', 'wt-main',
        'run-handoff-session', 'run-handoff-final', 'cr-handoff', 1, 1,
        'focus', 'summary', 'state', '[]', '[]', '[]', '[]', '[]', '[]', 'body', ?)
    `).run(AT);

    const timeline = readProjectTimeline(db, 'proj-audit', { limit: 100 });
    const handoffEntries = timeline.items.filter((item) => item.id === 'h-dup');
    assert.equal(handoffEntries.length, 1, 'dual final snapshots must not duplicate the handoff entry');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendProgressEvent records adoption exactly once per assignment', () => {
  const { dir, db } = createFixtureDb();
  try {
    db.prepare(`
      INSERT INTO assignments (id, project_id, worktree_id, agent_id, task_id, scope_json,
        status, revision, session_id, created_at, updated_at)
      VALUES ('asg-adopt', 'proj-audit', 'wt-main', 'Codex', 'task', '{}',
        'accepted', 1, 'run-adopt', ?, ?)
    `).run(AT, AT);
    db.prepare(`
      INSERT INTO runs (id, worktree_id, mode, lifecycle, health, revision, lease_generation,
        agent_claim, goal, created_at)
      VALUES ('run-adopt', 'wt-main', 'write', 'active', 'healthy', 1, 1, 'Codex', 'goal', ?)
    `).run(AT);

    const first = appendProgressEvent(db, {
      sessionId: 'run-adopt',
      clientRequestId: 'begin-1',
      expectedRevision: 1,
      status: 'adopted',
      note: 'first begin',
    });
    assert.equal(first.ok, true);

    const second = appendProgressEvent(db, {
      sessionId: 'run-adopt',
      clientRequestId: 'begin-2',
      expectedRevision: 2,
      status: 'adopted',
      note: 'second begin',
    });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'ASSIGNMENT_ALREADY_ACTIVE');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push helpers reject remote nicknames that parse as git options', async () => {
  assert.equal(assertSafeRemoteName('origin'), 'origin');
  assert.equal(assertSafeRemoteName('upstream_1.2-x'), 'upstream_1.2-x');
  assert.throws(() => assertSafeRemoteName('--repo=https://evil.example/x'), { code: 'UNSAFE_REMOTE_NAME' });
  assert.throws(() => assertSafeRemoteName('-upload-pack'), { code: 'UNSAFE_REMOTE_NAME' });
  assert.throws(() => assertSafeRemoteName(''), { code: 'UNSAFE_REMOTE_NAME' });

  // The push entry points must fail closed before any git invocation runs.
  await assert.rejects(
    pushSubmissionBranch(os.tmpdir(), { remote: '--repo=https://evil.example/x', branch: 'main' }),
    { code: 'UNSAFE_REMOTE_NAME' },
  );
  await assert.rejects(
    pushIntegratedMain(os.tmpdir(), { remote: '-receive-pack=x', branch: 'main' }),
    { code: 'UNSAFE_REMOTE_NAME' },
  );
});

test('remote URL validation rejects dash-leading ssh hostnames', () => {
  assert.throws(
    () => validateRemoteUrlSecurity('ssh://git@--oProxyCommand=calc/x'),
    { code: 'UNSAFE_REMOTE_URL' },
  );
  assert.throws(
    () => validateRemoteUrlSecurity('git@--evil.example:owner/repo.git'),
    { code: 'UNSAFE_REMOTE_URL' },
  );
  validateRemoteUrlSecurity('ssh://git@github.com/owner/repo.git');
  validateRemoteUrlSecurity('git@github.com:owner/repo.git');
});

test('requests carrying an id are answered even when the method name looks like a notification', async () => {
  const response = await dispatchMessage({
    jsonrpc: '2.0',
    id: 7,
    method: 'notifications/initialized',
  });
  assert.ok(response, 'a request with an id must receive a response');
  assert.equal(response.error.code, -32601);
  assert.equal(response.id, 7);
});

test('handoff and relay array arguments are bounded like progress details', async () => {
  const oversized = Array.from({ length: 9 }, (_, index) => `item-${index}`);
  const response = await dispatchMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'ugk_work_handoff',
      arguments: {
        sessionId: 'session-x',
        clientRequestId: 'cr-x',
        expectedRevision: 1,
        outcome: 'completed',
        summary: 'summary',
        nextSessionFocus: 'focus',
        currentState: 'state',
        completedItems: oversized,
        pendingItems: [], decisions: [], artifactRefs: [], risks: [], suggestedSkills: [],
      },
    },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /completedItems/);

  for (const tool of TOOLS) {
    const properties = tool.inputSchema?.properties ?? {};
    for (const [name, schema] of Object.entries(properties)) {
      if (schema?.type !== 'array') continue;
      if (name === 'files' || name === 'findings' || name === 'checks' || name === 'references') continue;
      assert.ok(schema.maxItems, `${tool.name}.${name} must declare maxItems`);
      assert.equal(schema.items?.maxLength, 500, `${tool.name}.${name} items must declare maxLength`);
    }
  }
});

test('closing the stdio server aborts in-flight service work', () => {
  let shutdownCalled = false;
  const input = new PassThrough();
  const sink = new Writable({ write(_chunk, _enc, done) { done(); } });
  const server = createMcpServer({
    stdin: input,
    stdout: sink,
    stderr: sink,
    onShutdown: () => { shutdownCalled = true; },
  });
  server.close();
  assert.equal(shutdownCalled, true);
});

test('shutdown signal aborts an in-flight service call', async () => {
  const { createServiceHandlers } = await import('../src/mcp/service-client.mjs');
  const controller = new AbortController();
  const observed = [];
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    shutdownSignal: controller.signal,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      observed.push(options.signal);
      // A real fetch rejects immediately when the signal is already aborted.
      if (options.signal.aborted) {
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        return;
      }
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      });
    }),
  });
  const pending = handlers.ugk_work_progress({
    sessionId: 'session-x',
    clientRequestId: 'cr-shutdown',
    expectedRevision: 1,
    status: 'working',
    note: 'note',
  });
  controller.abort();
  await assert.rejects(pending, { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].aborted, true);
});

test('structured writes keep the same-request-id retry contract when credential bootstrap fails', async () => {
  const { createServiceHandlers } = await import('../src/mcp/service-client.mjs');
  const handlers = createServiceHandlers({
    workingDirectory: 'E:\\fixture\\active-project',
    fetchImpl: async () => {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    },
  });
  const error = await handlers.ugk_submit_note_update({
    noteId: 'note-1',
    clientRequestId: 'cr-note-1',
    expectedRevision: 1,
    status: 'handled',
  }).then(
    (value) => value,
    (cause) => cause,
  );
  assert.equal(error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(error.retryable, true);
  assert.equal(error.transportFailure, true);
  assert.match(error.required_action, /完全相同的 clientRequestId/);
});
