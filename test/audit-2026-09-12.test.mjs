import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { FolderGrantStore } from '../src/core/folder-grants.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const TOKEN = 'audit-2026-09-12-http-test-token-long-enough';

function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

function gitSync(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createCommitFixture(t, prefix) {
  const root = mkdtempSync(path.join(fixtureTempRoot(), prefix));
  t.after(() => {
    // Windows keeps handles briefly alive after child git processes exit;
    // retry so a slow release does not leak the fixture into the temp root.
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  });
  gitSync(root, ['init', '-b', 'main', root]);
  gitSync(root, ['config', 'user.email', 'ugk@example.invalid']);
  gitSync(root, ['config', 'user.name', 'UGK Test']);
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  gitSync(root, ['add', 'README.md']);
  gitSync(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
}

async function post(service, pathname, body) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function startInitializedSession(t, prefix) {
  const root = createCommitFixture(t, prefix);
  const dbPath = path.join(root, 'cockpit.db');
  const observation = await probeGitWorktree(root);
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: `register-${prefix}`,
    name: 'Audit fixture',
    authorizedRoot: root,
    observation,
  });
  db.close();

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  t.after(async () => {
    await service.close();
  });

  const assignmentResponse = await post(
    service,
    `/api/v1/projects/${project.projectId}/assignments`,
    { clientRequestId: `${prefix}-assignment`, agent: 'Codex', mode: 'init', task: 'audit fixture' },
  );
  assert.equal(assignmentResponse.status, 201, await assignmentResponse.clone().text());
  const assignment = await assignmentResponse.json();
  const initCode = assignment.message.match(/initCode: "([^\"]+)"/)?.[1];
  assert.ok(initCode);

  const initResponse = await post(service, '/api/v1/mcp/work/init', {
    initCode,
    clientRequestId: `${prefix}-init`,
    currentTask: 'audit fixture',
    currentState: '已接入',
    mcpWorkingDirectory: root,
  });
  assert.equal(initResponse.status, 200, await initResponse.clone().text());
  const initialized = await initResponse.json();

  return { root, dbPath, service, project, initialized };
}

test('work/finish is atomic: an assignment-side conflict rolls back the run terminal state', async (t) => {
  const { dbPath, service, initialized } = await startInitializedSession(t, 'ugk-audit-finish-atomic-');

  // Desynchronize the two revisions: the run CAS (checked first) still
  // matches, while the assignment CAS no longer does. Without the atomic
  // wrapper this leaves a finished run with a released lease and an active
  // assignment pointing at it.
  const db = openCockpitDatabase(dbPath);
  const run = db.prepare('SELECT revision FROM runs WHERE id = ?').get(initialized.sessionId);
  const assignment = db.prepare('SELECT id, revision FROM assignments WHERE session_id = ?')
    .get(initialized.sessionId);
  db.prepare('UPDATE assignments SET revision = ? WHERE id = ?')
    .run(run.revision + 1, assignment.id);
  db.close();

  const finishResponse = await post(service, '/api/v1/mcp/work/finish', {
    sessionId: initialized.sessionId,
    clientRequestId: 'audit-finish-atomic-attempt',
    expectedRevision: run.revision,
    outcome: 'completed',
    summary: '本轮工作完成',
    nextStep: '等待用户安排',
  });
  assert.equal(finishResponse.status, 409, await finishResponse.clone().text());
  const failed = await finishResponse.json();
  assert.equal(failed.code, 'ASSIGNMENT_REVISION_CONFLICT');

  // Nothing may leak through: run stays active, lease stays held, the
  // finish command leaves no committed receipt behind.
  const verify = openCockpitDatabase(dbPath);
  const runAfter = verify.prepare('SELECT lifecycle, revision FROM runs WHERE id = ?')
    .get(initialized.sessionId);
  assert.equal(runAfter.lifecycle, 'active');
  assert.equal(runAfter.revision, run.revision);
  const lease = verify.prepare('SELECT count(*) AS count FROM write_leases WHERE run_id = ?')
    .get(initialized.sessionId);
  assert.equal(lease.count, 1);
  const assignmentAfter = verify.prepare('SELECT status, revision FROM assignments WHERE session_id = ?')
    .get(initialized.sessionId);
  assert.equal(assignmentAfter.status, 'active');
  verify.close();

  // The desynchronized assignment revision must be repaired before a retry;
  // with the atomic rollback the original request shape now succeeds.
  const repair = openCockpitDatabase(dbPath);
  repair.prepare('UPDATE assignments SET revision = ? WHERE session_id = ?')
    .run(run.revision, initialized.sessionId);
  repair.close();
  const retryResponse = await post(service, '/api/v1/mcp/work/finish', {
    sessionId: initialized.sessionId,
    clientRequestId: 'audit-finish-atomic-retry',
    expectedRevision: run.revision,
    outcome: 'completed',
    summary: '本轮工作完成',
    nextStep: '等待用户安排',
  });
  assert.equal(retryResponse.status, 200, await retryResponse.clone().text());
  const retried = await retryResponse.json();
  assert.equal(retried.ok, true);
  assert.equal(retried.status, 'completed');
});

test('project registration replay returns the frozen response even after the grant TTL', async (t) => {
  const root = createCommitFixture(t, 'ugk-audit-register-replay-');
  const dbPath = path.join(root, 'cockpit.db');
  const observation = await probeGitWorktree(root);

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  t.after(async () => {
    await service.close();
  });

  // Issue the folder grant directly: the interactive picker cannot run in a
  // test, and the registration route only needs a row that claim() accepts.
  const principalHash = createHash('sha256').update(TOKEN).digest('hex');
  const db = openCockpitDatabase(dbPath);
  const grants = new FolderGrantStore({ db });
  const grant = grants.issue({
    folderPath: root,
    canonicalPath: observation.canonicalPath,
    repositoryIdentity: observation.repositoryIdentity,
    worktreeIdentity: observation.worktreeIdentity,
  }, principalHash);
  db.close();

  const payload = {
    commandId: 'audit-register-replay-1',
    grantId: grant.grantId,
    name: 'Audit replay fixture',
    stage: 'development',
  };
  const first = await post(service, '/api/v1/projects', payload);
  assert.equal(first.status, 201, await first.clone().text());
  const registered = await first.json();
  assert.equal(registered.ok, true);

  // Age the grant past its TTL exactly like a retry that arrives after five
  // minutes. The command journal must win: the replay returns the frozen
  // registration response instead of FOLDER_GRANT_EXPIRED.
  const age = openCockpitDatabase(dbPath);
  age.prepare('UPDATE folder_grants SET expires_at = ? WHERE id = ?')
    .run(Date.now() - 1000, grant.grantId);
  age.close();

  const replay = await post(service, '/api/v1/projects', payload);
  assert.equal(replay.status, 200, await replay.clone().text());
  const replayed = await replay.json();
  assert.equal(replayed.ok, true);
  assert.equal(replayed.projectId, registered.projectId);
});

test('folder picker ready wait fails fast instead of parking the queue forever', async (t) => {
  const { ResidentFolderPicker } = await import('../src/platform/select-folder.mjs');
  const { PassThrough } = await import('node:stream');
  const { EventEmitter } = await import('node:events');

  // A worker that spawns but never prints `ready` and never exits must be
  // torn down by the ready deadline; the caller timeout only covers picking.
  function stuckSpawn() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.exitCode = null;
    return child;
  }

  const picker = new ResidentFolderPicker({ spawn: stuckSpawn, readyTimeoutMs: 100 });
  const started = Date.now();
  await assert.rejects(
    () => picker.selectFolder({ timeout: 60_000 }),
    (error) => error.code === 'FOLDER_PICKER_UNAVAILABLE',
    'ready wait must reject instead of settling never',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `ready wait rejected after ${elapsed}ms, expected ~100ms`);

  // The queue must recover: a follow-up selection goes through the same path.
  await assert.rejects(
    () => picker.selectFolder({ timeout: 60_000 }),
    (error) => error.code === 'FOLDER_PICKER_UNAVAILABLE',
  );
  await picker.close();
});

test('stdio bridge answers ping while a slow tools/call is in flight', async (t) => {
  const { PassThrough } = await import('node:stream');
  const { createMcpServer } = await import('../src/mcp/stdio-protocol.mjs');

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const responses = [];
  stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) responses.push(JSON.parse(line));
    }
  });

  createMcpServer({
    stdin,
    stdout,
    stderr: new PassThrough(),
    handlers: {
      async ugk_work_context() {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return { ok: true, sessions: [] };
      },
    },
  });

  stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'ugk_work_context', arguments: {} },
  }) + '\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');

  const started = Date.now();
  while (Date.now() - started < 5000) {
    const pong = responses.find((message) => message.id === 2);
    if (pong) {
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 1000, `ping took ${elapsed}ms behind a 1500ms call; head-of-line blocking`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('ping was never answered');
});

test('probeGitWorktree inherits the wider git buffer for mid-size repositories', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const root = createCommitFixture(t, 'ugk-audit-probe-buffer-');

  // Bulk-load index entries instead of creating files: 26k entries push the
  // `ls-files --stage -z` output just past the old 2MB probe default.
  const hash = 'ab'.repeat(20);
  const lines = [];
  for (let i = 0; i < 26_000; i += 1) {
    lines.push(`100644 ${hash} 0\tbulk/generated/file-${String(i).padStart(6, '0')}.txt`);
  }
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: root, encoding: 'utf8', input: `${lines.join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lsFiles = execFileSync('git', ['ls-files', '--stage', '-z'], {
    cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.ok(lsFiles.length > 2 * 1024 * 1024, `fixture output only ${lsFiles.length} bytes`);

  const observation = await probeGitWorktree(root, { timeoutMs: 20_000 });
  assert.equal(observation.coherence, 'coherent');
});

test('anonymous MCP session burst evicts the oldest token, newest sessions survive', async (t) => {
  const root = createCommitFixture(t, 'ugk-audit-mcp-evict-');
  const service = await createCockpitHttpServer({
    dbPath: path.join(root, 'cockpit.db'), token: TOKEN,
  });
  t.after(async () => {
    await service.close();
  });

  const bootstrap = async () => {
    const response = await fetch(`http://${service.host}:${service.port}/api/v1/mcp/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client: 'ugk-cockpit-stdio' }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).token;
  };

  const first = await bootstrap();
  const tokens = [first];
  for (let i = 1; i < 65; i += 1) tokens.push(await bootstrap());

  // The session limit is 64: registering the 65th session must evict the
  // earliest one instead of leaving the burst in place.
  const probe = async (token) => fetch(`http://${service.host}:${service.port}/api/v1/mcp/work/context`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const evicted = await probe(first);
  assert.equal(evicted.status, 401, 'first session must have been evicted by the burst');
  const survivor = await probe(tokens[64]);
  assert.ok(survivor.status !== 401, `newest session must survive (got ${survivor.status})`);
});

test('launcher rejects quote characters in the data directory before spawning node', { skip: process.platform !== 'win32' && 'launcher validation runs Windows PowerShell' }, async (t) => {
  const { spawn } = await import('node:child_process');
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = await new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(repoRoot, 'scripts', 'launch-cockpit.ps1'),
      '-DataDirectory', 'C:\\temp" --evil-arg "injected',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderrText = '';
    child.stderr.on('data', (chunk) => { stderrText += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stderrText }));
  });
  assert.notEqual(result.code, 0, 'launcher must fail on a quote-bearing data directory');
  assert.match(result.stderrText, /quote or newline/i);
});
