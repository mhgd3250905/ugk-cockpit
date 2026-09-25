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

// Fixture git observes the same configuration contract as the product, so an
// ambient core.autocrlf cannot create phantom changes only the fixture sees.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';

const tmpRoot = () => (process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir()));
const TOKEN = 'audit-2026-09-25-mcp-body-token-long-enough';

async function session(t) {
  const root = mkdtempSync(path.join(tmpRoot(), 'ugk-mcp-body-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=UGK Test', '-c', 'user.email=ugk@example.invalid',
    'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const dbPath = path.join(root, 'cockpit.db');
  const observation = await probeGitWorktree(root);
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-mcp-body-fixture',
    name: 'MCP body fixture',
    authorizedRoot: root,
    observation,
  });
  db.close();

  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    serveWebAsset: async ({ pathname, response, sessionToken }) => {
      if (pathname !== '/') return false;
      response.setHeader('set-cookie', `ugk_cockpit_session=${sessionToken}; HttpOnly; SameSite=Strict`);
      response.end('fixture');
      return true;
    },
  });
  const cleanup = async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  };
  t.after(cleanup);

  const base = `http://${service.host}:${service.port}`;
  const shell = await fetch(`${base}/`);
  await shell.text();
  const browserHeaders = {
    cookie: shell.headers.get('set-cookie'),
    origin: base,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'x-ugk-client-id': 'mcp-body-browser',
  };

  const post = async (pathname, body) => {
    const response = await fetch(`http://${service.host}:${service.port}${pathname}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  };

  const created = await post(`/api/v1/projects/${project.projectId}/assignments`, {
    clientRequestId: 'create-1', agent: 'Codex', mode: 'init', task: '验证 MCP 请求体边界',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const initCode = created.json.message.match(/initCode: "([^"]+)"/)?.[1];
  assert.ok(initCode);
  const initialized = await post('/api/v1/mcp/work/init', {
    initCode,
    clientRequestId: 'init-1',
    currentTask: '验证 MCP 请求体边界',
    currentState: '夹具已就绪',
    mcpWorkingDirectory: root,
  });
  assert.equal(initialized.status, 200, JSON.stringify(initialized.json));
  return {
    service, post, root, dbPath, base, browserHeaders,
    projectId: project.projectId,
    sessionId: initialized.json.sessionId,
    revision: initialized.json.revision,
  };
}

const finishBody = (s, extra = {}) => ({
  sessionId: s.sessionId,
  clientRequestId: 'finish-1',
  expectedRevision: s.revision,
  outcome: 'completed',
  summary: '工作完成',
  nextStep: '等待用户安排下一项',
  acknowledgements: [],
  ...extra,
});

const handoffBody = (s, extra = {}) => ({
  sessionId: s.sessionId,
  clientRequestId: 'handoff-1',
  expectedRevision: s.revision,
  outcome: 'completed',
  nextSessionFocus: '等待用户安排',
  summary: '交接',
  currentState: '已完成',
  completedItems: ['完成夹具'],
  pendingItems: [],
  decisions: [],
  artifactRefs: [],
  risks: [],
  suggestedSkills: [],
  acknowledgements: [],
  ...extra,
});

// The core reads `request.status`, `request.note`, `request.handoffId` and
// `request.commandId`; those are recovery fields for internal callers, not
// inputs a model may set. Every other MCP gateway whitelists its keys, so an
// unlisted field here is a contract gap rather than a tolerated extension.
test('work/finish refuses fields the finish contract does not declare', async (t) => {
  const s = await session(t);

  const injected = await s.post('/api/v1/mcp/work/finish',
    finishBody(s, { status: 'cancelled', note: 'N'.repeat(200_000), bogusField: 1 }));
  assert.equal(injected.status, 400, JSON.stringify(injected.json));
  assert.equal(injected.json.code, 'INVALID_REQUEST');

  // The session and its code are untouched by a rejected request.
  const clean = await s.post('/api/v1/mcp/work/finish', finishBody(s));
  assert.equal(clean.status, 200, JSON.stringify(clean.json));
  assert.equal(['completed', 'blocked', 'abandoned'].includes(clean.json.status), true,
    `terminal status must stay inside the published enum, got ${clean.json.status}`);

  const db = openCockpitDatabase(s.dbPath, { migrate: false });
  try {
    const note = db.prepare(
      'SELECT length(note) AS size FROM progress_events ORDER BY created_at DESC, id DESC LIMIT 1',
    ).get();
    assert.ok(note.size <= 4000, `the stored note must respect the documented budget, got ${note.size}`);
  } finally {
    db.close();
  }
});

test('work/handoff refuses fields the handoff contract does not declare', async (t) => {
  const s = await session(t);
  const injected = await s.post('/api/v1/mcp/work/handoff',
    handoffBody(s, { handoffId: 'handoff-chosen-by-the-caller' }));
  assert.equal(injected.status, 400, JSON.stringify(injected.json));
  assert.equal(injected.json.code, 'INVALID_REQUEST');

  const clean = await s.post('/api/v1/mcp/work/handoff', handoffBody(s));
  assert.equal(clean.status, 200, JSON.stringify(clean.json));
  assert.ok(clean.json.handoffId);
});

// Relay list fields may carry structured items, but the documented budget is
// 4000 characters per item; an object item used to bypass it entirely and the
// stored handoff body is echoed back by the dashboard on every poll.
test('relay list items are bounded whether they are strings or objects', async (t) => {
  const s = await session(t);
  const huge = {
    sessionId: s.sessionId,
    clientRequestId: 'relay-1',
    expectedRevision: s.revision,
    nextSessionFocus: '继续',
    summary: '接力',
    currentState: '进行中',
    completedItems: [{ blob: 'x'.repeat(200_000) }],
    pendingItems: [],
    decisions: [],
    artifactRefs: [],
    risks: [],
    suggestedSkills: [],
  };
  const oversized = await s.post('/api/v1/mcp/work/relay', huge);
  assert.equal(oversized.status, 400, JSON.stringify(oversized.json));
  assert.equal(oversized.json.code, 'INVALID_REQUEST');

  const small = await s.post('/api/v1/mcp/work/relay', {
    ...huge,
    clientRequestId: 'relay-2',
    completedItems: [{ label: '已完成', detail: '夹具' }],
  });
  assert.equal(small.status, 200, JSON.stringify(small.json));
});

// The conversation-control console discloses host and conversation locators in
// plain text. Those are the credentials alpha.52 masks from everyone but the
// holder, so the console is for the browser that shows it to the user.
test('the conversation-control console is readable only by the browser session', async (t) => {
  const s = await session(t);
  const route = `/api/v1/projects/${s.projectId}/conversation-control`;

  const asBearer = await fetch(`${s.base}${route}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(asBearer.status, 401, JSON.stringify(await asBearer.json()));

  const asBrowser = await fetch(`${s.base}${route}`, { headers: s.browserHeaders });
  assert.equal(asBrowser.status, 200, await asBrowser.clone().text());
  const body = await asBrowser.json();
  assert.equal(body.ok, true);
  assert.equal(body.chains.length, 1);
  assert.equal(body.chains[0].sessionId, s.sessionId);
});
