// /work/begin checked the caller's chat ownership, then awaited the Git probe,
// then took the durable write lease without ever looking at the chat again.
// progress, finish and handoff all re-assert after their probe; begin did not,
// and startWriteRun itself never consults the conversation binding.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createServiceHandlers } from '../src/mcp/service-client.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const TOKEN = 'begin-recheck-test-token-that-is-long-enough-to-pass';

function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

async function createFixture(t, { duringProbe }) {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-begin-recheck-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# begin recheck fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', [
    '-c', 'user.name=UGK Test', '-c', 'user.email=ugk@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ], { cwd: root });

  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-begin-recheck', name: 'Begin recheck', authorizedRoot: root,
    observation: await probeGitWorktree(root),
  });
  assert.equal(project.ok, true, JSON.stringify(project));
  db.close();

  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    probe: (candidate, ...rest) => {
      duringProbe?.(dbPath);
      return probeGitWorktree(candidate, ...rest);
    },
  });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });

  const baseUrl = `http://${service.host}:${service.port}`;
  const created = await fetch(`${baseUrl}/api/v1/projects/${project.projectId}/assignments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'begin-recheck-assignment', agent: 'Codex', mode: 'handoff',
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const dispatchCode = (await created.json()).message.match(/dispatchCode: "([^"]+)"/)?.[1];
  assert.ok(dispatchCode, 'the assignment must hand out a dispatch code');

  const handlers = createServiceHandlers({
    token: TOKEN, baseUrl, workingDirectory: root, conversationIdentity: { host: 'codex', id: 'chat-a' },
  });
  const accepted = await handlers.ugk_work_accept({ dispatchCode, clientRequestId: 'begin-recheck-accept' });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const leases = () => {
    const check = new DatabaseSync(dbPath);
    try {
      return {
        leases: check.prepare('SELECT count(*) n FROM write_leases').get().n,
        sessions: check.prepare("SELECT count(*) n FROM assignments WHERE status = 'active'").get().n,
      };
    } finally { check.close(); }
  };
  return { handlers, sessionId: accepted.sessionId, revision: accepted.revision, leases };
}

test('a chat displaced during the Git probe cannot take the write lease', async (t) => {
  let armed = false;
  const fixture = await createFixture(t, {
    // The observation yields to the event loop; a takeover that lands inside
    // that window revokes this chat's binding before the lease would be taken.
    duringProbe: (dbPath) => {
      if (!armed) return;
      armed = false;
      const handle = new DatabaseSync(dbPath);
      handle.prepare('UPDATE conversation_bindings SET revoked = 1').run();
      handle.close();
    },
  });
  assert.deepEqual(fixture.leases(), { leases: 0, sessions: 0 });

  armed = true;
  // The bridge surfaces a refusal as a rejection, with the reason the service
  // answered in the thrown context.
  const thrown = await fixture.handlers.ugk_work_begin({
    sessionId: fixture.sessionId,
    clientRequestId: 'begin-recheck-attempt',
    expectedRevision: fixture.revision,
    task: '在探测窗口内被取代的聊天继续开工',
  }).then(() => null, (error) => error);
  assert.ok(thrown, 'a displaced chat must be refused, not handed the folder');
  assert.equal(thrown.code, 'CONVERSATION_BINDING_CONFLICT',
    `unexpected refusal: ${thrown?.code} ${thrown?.required_action}`);
  assert.equal(thrown.bindingReason, 'revoked');
  assert.deepEqual(fixture.leases(), { leases: 0, sessions: 0 },
    'a refused begin must not leave a write lease or active work on the worktree');
});

// The refusal reason has to survive the trip to the operator: the service answers
// from its own message catalogue keyed on the code, so a curated override is the
// only way `core.attributesFile` naming a directory stops being reported as
// "this repository configures filters, wait for platform support".
test('the attribute-source refusal reaches the client with its real reason', async (t) => {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-attrs-surface-'));
  const repo = path.join(root, 'code');
  execFileSync('git', ['init', '--quiet', '-b', 'main', repo], { windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'fixture@localhost'], { cwd: repo, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: repo, windowsHide: true });
  writeFileSync(path.join(repo, 'README.md'), '# surface fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, windowsHide: true });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repo, windowsHide: true });
  execFileSync('git', ['config', '--local', 'core.attributesFile', root], { cwd: repo, windowsHide: true });
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });

  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-attrs-surface', name: 'Attribute surface', authorizedRoot: repo,
    observation: await probeGitWorktree(repo),
  });
  assert.equal(project.ok, true, JSON.stringify(project));
  db.close();

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  try {
    const response = await fetch(`http://${service.host}:${service.port}/api/v1/projects/${project.projectId}/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'refresh-attrs-surface' }),
    });
    const body = await response.json();
    assert.equal(body.code, 'GIT_FILTER_UNSUPPORTED', JSON.stringify(body));
    assert.match(body.message, /core\.attributesFile|不是普通文件|仓库自身之外/,
      `the catalogue text alone was returned: ${body.message}`);
    assert.doesNotMatch(body.message, /包含 clean\/smudge\/process 过滤器/,
      'the repository configures no filter driver, so it must not be told that it does');
  } finally {
    await service.close();
  }
});
