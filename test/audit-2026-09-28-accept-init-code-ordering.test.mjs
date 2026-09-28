import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';

function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

const TOKEN = 'accept-ordering-test-token-that-is-long-enough';

async function post(service, pathname, body) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function fixture(t) {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-cockpit-accept-order-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=UGK Test', '-c', 'user.email=ugk@example.invalid',
    'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const dbPath = path.join(root, 'cockpit.db');
  const observation = await probeGitWorktree(root);
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-accept-order',
    name: 'Accept ordering fixture',
    authorizedRoot: root,
    observation,
  });
  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  // One hook, ordered: close the service, then its database, then the folder.
  t.after(async () => {
    await service.close();
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, db, service, project };
}

async function createAssignment(service, projectId, body) {
  const response = await post(service, `/api/v1/projects/${projectId}/assignments`, body);
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

async function initWork(f, initCode, clientRequestId) {
  return post(f.service, '/api/v1/mcp/work/init', {
    initCode,
    clientRequestId,
    currentTask: '接管既有改动',
    currentState: '核心文件改到一半',
    mcpWorkingDirectory: f.root,
  });
}

// work/init refuses a non-adopt dispatch code before it touches anything;
// work/accept used to run acceptAssignment first and refuse afterwards.
test('用 work/accept 消费 init 派发码：拒绝必须发生在持久化之前，代码仍然可用', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.root, 'WIP.md'), 'half-finished work\n');
  const assignment = await createAssignment(f.service, f.project.projectId, {
    clientRequestId: 'create-init-1', agent: 'Codex', mode: 'init', task: '接管既有改动',
  });
  const initCode = assignment.message.match(/initCode: "([^"]+)"/)?.[1];
  assert.ok(initCode, assignment.message);

  const refused = await post(f.service, '/api/v1/mcp/work/accept', {
    dispatchCode: initCode, clientRequestId: 'wrong-tool-1',
  });
  assert.equal(refused.status, 400, await refused.clone().text());
  const refusal = await refused.json();
  assert.equal(refusal.code, 'INVALID_REQUEST');

  // The refusal says nothing was changed; read the durable rows before doing
  // anything else with the code.
  const untouched = f.db.prepare('SELECT status, session_id, revision FROM assignments WHERE id = ?')
    .get(assignment.assignmentId);
  assert.equal(untouched.status, 'pending', JSON.stringify(untouched));
  assert.equal(untouched.revision, 0, JSON.stringify(untouched));

  // The code is still usable through the route that owns it.
  const started = await initWork(f, initCode, 'right-tool-1');
  const body = await started.json();
  assert.equal(started.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));

  const row = f.db.prepare('SELECT status, revision FROM assignments WHERE id = ?')
    .get(assignment.assignmentId);
  // accept (0 -> 1) then the write run (1 -> 2), both from work/init alone.
  assert.equal(row.status, 'active', JSON.stringify(row));
  assert.equal(row.revision, 2, JSON.stringify(row));
});

// Reverse boundary: the routes this ordering must not break.
test('反向界：standby 派发码仍由 work/accept 正常接手', async (t) => {
  const f = await fixture(t);
  const standby = await createAssignment(f.service, f.project.projectId, {
    clientRequestId: 'create-handoff-1', agent: 'ZCode', mode: 'handoff', task: '先读交接',
  });
  const standbyCode = standby.message.match(/dispatchCode: "([^"]+)"/)?.[1];
  assert.ok(standbyCode, standby.message);
  const accepted = await post(f.service, '/api/v1/mcp/work/accept', {
    dispatchCode: standbyCode, clientRequestId: 'accept-handoff-1',
  });
  const acceptedBody = await accepted.json();
  assert.equal(accepted.status, 200, JSON.stringify(acceptedBody));
  assert.equal(acceptedBody.status, 'waiting_for_instruction');
});

test('反向界：init 派发码仍由 work/init 正常开工', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.root, 'WIP2.md'), 'second half-finished change\n');
  const init = await createAssignment(f.service, f.project.projectId, {
    clientRequestId: 'create-init-2', agent: 'Codex', mode: 'init', task: '接管第二个工作区',
  });
  const initCode = init.message.match(/initCode: "([^"]+)"/)?.[1];
  const viaInit = await initWork(f, initCode, 'init-direct-2');
  const viaInitBody = await viaInit.json();
  assert.equal(viaInit.status, 200, JSON.stringify(viaInitBody));
  assert.equal(viaInitBody.ok, true);
});
