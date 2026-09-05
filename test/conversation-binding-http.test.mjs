import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createServiceHandlers } from '../src/mcp/service-client.mjs';
import { createMcpServer } from '../src/mcp/stdio-protocol.mjs';
import { PassThrough } from 'node:stream';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';
import { resumeRelay } from '../src/core/relays.mjs';
import { conversationKey } from '../src/mcp/conversation-identity.mjs';

test('durable per-request conversations survive restarts, preserve legacy history and fence old chats', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-conversation-'));
  const token = 'conversation-test-service-token-'.padEnd(44, 'x');
  const dbPath = path.join(root, 'state.db');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  let db = openCockpitDatabase(dbPath);
  const project = registerProject(db, { commandId: 'register', name: 'Durable', authorizedRoot: root, observation: await probeGitWorktree(root) });
  db.close();
  let service = await createCockpitHttpServer({ dbPath, token });
  const fetchImpl = (url, options) => fetch(url, { ...options, headers: { ...options.headers, connection: 'close' } });
  const handlers = (id) => createServiceHandlers({ baseUrl: `http://127.0.0.1:${service.port}`, workingDirectory: root, fetchImpl,
    conversationIdentity: id ? { host: 'codex', id } : null });
  try {
    const assignment = await (await fetchImpl(`http://127.0.0.1:${service.port}/api/v1/projects/${project.projectId}/assignments`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientRequestId: 'assignment', agent: 'Codex', mode: 'init', task: 'Persist identity' }),
    })).json();
    const initialized = await handlers().ugk_work_init({ initCode: assignment.message.match(/initCode: "([^"]+)"/)[1],
      clientRequestId: 'init', currentTask: 'Persist identity', currentState: 'Existing run' });
    const port = service.port;
    await service.close();
    db = openCockpitDatabase(dbPath);
    // Model an existing alpha.35 database, with real projects/runs/history present.
    db.exec('DROP TABLE conversation_bindings; DELETE FROM schema_migrations WHERE version >= 22; PRAGMA user_version = 21;');
    const tables = ['projects', 'assignments', 'runs', 'write_leases', 'relays', 'progress_events', 'commands'];
    const snapshot = () => Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
    const before = snapshot();
    db.close();
    service = await createCockpitHttpServer({ dbPath, token, port });
    db = openCockpitDatabase(dbPath);
    assert.deepEqual(snapshot(), before);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 23);
    const first = handlers('original');
    let context = await first.ugk_work_context({});
    assert.equal(context.bindingStatus, 'unbound');
    await first.ugk_work_context({ confirmSessionId: context.sessionId, expectedRevision: context.revision });
    assert.deepEqual(snapshot(), before); // Binding migration never edits business records.
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_bindings').get().n, 1);
    await service.close();
    // Preserve an already-migrated v22 binding when upgrading its ownership key.
    const boundBefore = db.prepare('SELECT * FROM conversation_bindings').all();
    db.exec(`ALTER TABLE conversation_bindings RENAME TO binding_fixture;
      DROP INDEX conversation_binding_owner;
      CREATE TABLE conversation_bindings AS SELECT * FROM binding_fixture;
      DROP TABLE binding_fixture;
      CREATE UNIQUE INDEX conversation_binding_owner ON conversation_bindings(session_id) WHERE revoked = 0;
      DELETE FROM schema_migrations WHERE version = 23;
      PRAGMA user_version = 22;`);
    service = await createCockpitHttpServer({ dbPath, token, port });
    assert.deepEqual(db.prepare('SELECT * FROM conversation_bindings').all(), boundBefore);
    context = await handlers('original').ugk_work_context({});
    assert.equal(context.canContinue, true);
    assert.equal(context.bindingPersistence, 'durable');
    assert.equal(context.revision, initialized.revision);

    const standbyAssignment = await (await fetchImpl(`http://127.0.0.1:${service.port}/api/v1/projects/${project.projectId}/assignments`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientRequestId: 'standby-assignment', agent: 'Codex', mode: 'handoff', task: 'Wait for instructions' }),
    })).json();
    const standby = await handlers('standby').ugk_work_accept({
      dispatchCode: standbyAssignment.message.match(/dispatchCode: "([^"]+)"/)[1], clientRequestId: 'accept-standby',
    });
    assert.equal(standby.status, 'waiting_for_instruction');
    assert.equal((await handlers('standby').ugk_work_context({})).sessionId, standby.sessionId);
    assert.equal((await handlers('original').ugk_work_context({})).sessionId, initialized.sessionId);
    const anotherStandby = await (await fetchImpl(`http://127.0.0.1:${service.port}/api/v1/projects/${project.projectId}/assignments`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientRequestId: 'another-standby', agent: 'Codex', mode: 'handoff', task: 'Another task' }),
    })).json();
    const acceptedAgain = await handlers('standby').ugk_work_accept({
      dispatchCode: anotherStandby.message.match(/dispatchCode: "([^"]+)"/)[1], clientRequestId: 'accept-again',
    });
    assert.equal((await handlers('standby').ugk_work_context({})).sessionId, acceptedAgain.sessionId);
    assert.equal(db.prepare('SELECT count(*) n FROM conversation_bindings WHERE session_id = ?').get(standby.sessionId).n, 1);
    await assert.rejects(handlers().ugk_work_begin({ sessionId: standby.sessionId, expectedRevision: standby.revision,
      clientRequestId: 'cannot-downgrade-old-task', task: 'start' }), /CONVERSATION_BINDING_CONFLICT/);

    // Two conversations share one transport: metadata is isolated per request.
    const protocol = createMcpServer({ stdin: new PassThrough(), stdout: new PassThrough(), handlers: handlers() });
    const query = async (threadId) => {
      const result = await protocol.dispatchMessage({ jsonrpc: '2.0', id: threadId, method: 'tools/call',
        params: { name: 'ugk_work_context', arguments: {}, _meta: { threadId } } });
      return JSON.parse(result.result.content[0].text);
    };
    assert.equal((await query('original')).canContinue, true);
    assert.equal((await query('different')).canContinue, false);
    assert.equal((await query('original')).canContinue, true);
    protocol.close();
    const write = { sessionId: context.sessionId, expectedRevision: context.revision, clientRequestId: 'progress', status: 'working', summary: 'restart verified' };
    await assert.rejects(handlers('different').ugk_work_progress(write), /CONVERSATION_BINDING_CONFLICT/);
    await assert.rejects(handlers().ugk_work_progress(write), /CONVERSATION_BINDING_CONFLICT/);
    await assert.rejects(handlers('different').ugk_work_submit_preflight({
      sessionId: context.sessionId, expectedRevision: context.revision, clientRequestId: 'foreign-preflight',
    }));
    const progressed = await handlers('original').ugk_work_progress(write);
    assert.equal(progressed.revision, context.revision + 1);
    const relayArgs = { sessionId: context.sessionId, expectedRevision: progressed.revision, clientRequestId: 'relay',
      nextSessionFocus: 'Continue', summary: 'Restart verified', currentState: 'Trial', completedItems: [], pendingItems: [], decisions: [], artifactRefs: [], risks: [], suggestedSkills: [] };
    const prepared = await handlers('original').ugk_work_relay(relayArgs);
    assert.equal(prepared.relayPrepared, true);
    assert.equal((await handlers('original').ugk_work_relay(relayArgs)).continueCode, prepared.continueCode);
    const next = handlers('next');
    const resumeArgs = { continueCode: prepared.continueCode, clientRequestId: 'resume' };
    assert.throws(() => resumeRelay(db, {
      ...resumeArgs, conversationKey: conversationKey({ host: 'codex', id: 'next' }),
      projectId: project.projectId, worktreeId: initialized.worktreeId,
    }, { faultInjector: phase => { if (phase === 'resume.after_command_commit_before_transaction_commit') throw new Error('crash before commit'); } }), /crash before commit/);
    assert.equal(db.prepare('SELECT revision FROM runs WHERE id = ?').get(initialized.sessionId).revision, prepared.revision);
    assert.equal(db.prepare('SELECT conversation_key FROM conversation_bindings WHERE session_id = ? AND revoked = 0').get(initialized.sessionId).conversation_key,
      conversationKey({ host: 'codex', id: 'original' }));
    const resumed = await next.ugk_work_resume(resumeArgs);
    assert.equal(resumed.relayAccepted, true);
    assert.equal((await handlers('next').ugk_work_context({})).canContinue, true);
    const stale = await handlers('original').ugk_work_context({});
    assert.equal(stale.bindingStatus, 'stale');
    assert.equal(stale.requiresUserConfirmation, false);
    await assert.rejects(handlers('original').ugk_work_progress({ ...write, expectedRevision: resumed.revision, clientRequestId: 'stale' }), /CONVERSATION_BINDING_CONFLICT/);
    await assert.rejects(handlers('different').ugk_work_resume(resumeArgs));
    assert.equal((await next.ugk_work_resume(resumeArgs)).relayAccepted, true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_bindings WHERE revoked = 0 AND session_id = ?').get(initialized.sessionId).n, 1);
  } finally {
    db?.close();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
