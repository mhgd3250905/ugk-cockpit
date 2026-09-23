// 接入指令即归属（declaredWorkspace 回退）：宿主桥进程无法解析工作目录时，
// 入口工具（context/init/resume/takeover）以代理声明的项目目录回退解析，
// 但声明必须落在已登记项目内、不得覆盖可解析的 cwd 事实，并与一次性指令
// 的项目比对。Codex/ZCode 行为不变。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';
import { TOOLS } from '../src/mcp/stdio-protocol.mjs';

function gitSync(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initGit(root) {
  mkdirSync(root, { recursive: true });
  gitSync(root, ['init', '-q']);
  gitSync(root, ['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return root;
}

function conversationHeader(chatId) {
  return {
    'x-ugk-conversation': Buffer.from(JSON.stringify({ host: 'zcode', id: chatId })).toString('base64url'),
  };
}

async function setupService(t, cleanup, container, pickerDir) {
  let pickerResponse = pickerDir;
  const apiToken = 'declared-workspace-fixture-token-00000000000';
  const dataRoot = path.join(container, 'data');
  const service = await createCockpitHttpServer({
    dbPath: path.join(dataRoot, 'cockpit.db'),
    token: apiToken,
    folderPicker: async () => pickerResponse,
    serveWebAsset: async ({ pathname, response, sessionToken }) => {
      if (pathname !== '/') return false;
      response.setHeader('set-cookie', `ugk_cockpit_session=${sessionToken}; HttpOnly; SameSite=Strict`);
      response.end('fixture');
      return true;
    },
  });
  cleanup.push(async () => { await service.close(); rmSync(dataRoot, { recursive: true, force: true }); });
  const base = `http://${service.host}:${service.port}`;
  const shell = await fetch(`${base}/`);
  await shell.text();
  const browserHeaders = {
    cookie: shell.headers.get('set-cookie'), origin: base,
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    'x-ugk-client-id': 'declared-workspace-browser',
  };
  const browserPost = (route, body) => fetch(`${base}${route}`, {
    method: 'POST', headers: browserHeaders, body: JSON.stringify(body),
  });
  const scoped = await (await fetch(`${base}/api/v1/mcp/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'ugk-cockpit-stdio' }),
  })).json();
  const mcpPost = (chatId, route, body) => fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${scoped.token}`,
      'content-type': 'application/json',
      ...conversationHeader(chatId),
    },
    body: JSON.stringify(body),
  });
  const setPicker = (dir) => { pickerResponse = dir; };
  return { base, browserPost, mcpPost, setPicker, withDb: (fn) => fn(service) };
}

async function registerProject(harness, dir, name) {
  harness.setPicker(dir);
  const selection = await (await harness.browserPost('/api/v1/folders/select', {})).json();
  const registered = await (await harness.browserPost('/api/v1/projects', {
    commandId: `register-${name}`, grantId: selection.grantId, name,
  })).json();
  assert.equal(registered.ok, true, JSON.stringify(registered));
  return registered;
}

test('entry tools fall back to declaredWorkspace when the bridge cwd is unusable', async (t) => {
  const cleanup = [];
  t.after(() => Promise.allSettled(cleanup.map(async (fn) => fn())));
  const container = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-declared-')));
  cleanup.push(() => rmSync(container, { recursive: true, force: true }));
  const repoA = initGit(path.join(container, 'alpha'));
  const repoB = initGit(path.join(container, 'beta'));
  const junkDir = path.join(container, 'host-install-dir'); // simulates the Antigravity daemon cwd
  mkdirSync(junkDir, { recursive: true });

  const harness = await setupService(t, cleanup, container, repoA);
  const projectA = await registerProject(harness, repoA, 'Alpha');
  const projectB = await registerProject(harness, repoB, 'Beta');

  // ---- init (adopt): the dispatch message carries the project directory hint.
  const dispatch = await (await harness.browserPost(`/api/v1/projects/${encodeURIComponent(projectA.projectId)}/assignments`, {
    clientRequestId: 'assign-a1', agent: 'ZCode', mode: 'init',
  })).json();
  assert.equal(dispatch.ok, true, JSON.stringify(dispatch));
  assert.match(dispatch.message, /项目目录：/);
  assert.ok(dispatch.message.includes(repoA.split(path.sep).join('/')) || dispatch.message.includes(repoA));
  const initCode = dispatch.message.match(/initCode: "([^"]+)"/)?.[1];
  assert.ok(initCode, 'dispatch message must expose the one-time init code');

  // junk cwd + no declaration → actionable guidance, nothing bound
  const bare = await harness.mcpPost('chat-init-1', '/api/v1/mcp/work/init', {
    initCode, clientRequestId: 'init-bare',
    currentTask: 'adopt', currentState: 'fixture', mcpWorkingDirectory: junkDir,
  });
  assert.equal(bare.status, 404);
  const bareBody = await bare.json();
  assert.equal(bareBody.code, 'PROJECT_NOT_FOUND');
  assert.match(bareBody.message, /declaredWorkspace/);

  // junk cwd + declaration for a DIFFERENT registered project → mismatch refused
  const wrongDecl = await harness.mcpPost('chat-init-2', '/api/v1/mcp/work/init', {
    initCode, clientRequestId: 'init-wrong',
    currentTask: 'adopt', currentState: 'fixture',
    mcpWorkingDirectory: junkDir, declaredWorkspace: repoB,
  });
  assert.equal(wrongDecl.status, 409);
  assert.equal((await wrongDecl.json()).code, 'DISPATCH_GRANT_BINDING_MISMATCH');

  // junk cwd + correct declaration → adopt succeeds
  const adopted = await harness.mcpPost('chat-init-3', '/api/v1/mcp/work/init', {
    initCode, clientRequestId: 'init-ok',
    currentTask: 'adopt', currentState: 'fixture',
    mcpWorkingDirectory: junkDir, declaredWorkspace: repoA,
  });
  const adoptedBody = await adopted.json();
  assert.equal(adopted.status, 200, JSON.stringify(adoptedBody));
  assert.equal(adoptedBody.ok, true);

  // ---- relay resume: the relay message carries the hint; declaration works.
  const sessionId = adoptedBody.sessionId;
  const relay = await (await harness.mcpPost('chat-init-3', '/api/v1/mcp/work/relay', {
    sessionId, clientRequestId: 'relay-1', expectedRevision: adoptedBody.revision,
    nextSessionFocus: 'continue', summary: 'hand off', currentState: 'fixture',
    completedItems: [], pendingItems: [], decisions: [], artifactRefs: [], risks: [], suggestedSkills: [],
  })).json();
  assert.equal(relay.ok, true, JSON.stringify(relay));
  assert.match(relay.continueMessage, /项目目录：/);

  const resumed = await harness.mcpPost('chat-relay-1', '/api/v1/mcp/work/resume', {
    continueCode: relay.continueCode, clientRequestId: 'resume-ok',
    mcpWorkingDirectory: junkDir, declaredWorkspace: repoA,
  });
  const resumedBody = await resumed.json();
  if (resumedBody.requiresUserConfirmation && resumedBody.confirmationRequestId) {
    const confirmed = await harness.mcpPost('chat-relay-1', '/api/v1/mcp/work/resume', {
      continueCode: relay.continueCode, clientRequestId: 'resume-ok-confirm',
      confirmationRequestId: resumedBody.confirmationRequestId,
      expectedRevision: resumedBody.revision,
      mcpWorkingDirectory: junkDir, declaredWorkspace: repoA,
    });
    assert.equal((await confirmed.json()).relayAccepted, true);
  } else {
    assert.equal(resumedBody.relayAccepted, true, JSON.stringify(resumedBody));
  }

  // ---- a resolvable cwd always wins over the declaration.
  const relay2 = await (await harness.mcpPost('chat-relay-1', '/api/v1/mcp/work/relay', {
    sessionId, clientRequestId: 'relay-2', expectedRevision: resumedBody.revision ?? adoptedBody.revision,
    nextSessionFocus: 'continue2', summary: 'hand off again', currentState: 'fixture',
    completedItems: [], pendingItems: [], decisions: [], artifactRefs: [], risks: [], suggestedSkills: [],
  })).json();
  assert.equal(relay2.ok, true, JSON.stringify(relay2));
  const overridden = await harness.mcpPost('chat-relay-2', '/api/v1/mcp/work/resume', {
    continueCode: relay2.continueCode, clientRequestId: 'resume-override',
    mcpWorkingDirectory: repoB, declaredWorkspace: repoA,
  });
  assert.equal(overridden.status, 409);
  assert.equal((await overridden.json()).code, 'RELAY_BINDING_MISMATCH');

  // ---- context: declaration rescues discovery on an unusable cwd.
  const ctx = await (await harness.mcpPost('chat-ctx-1', '/api/v1/mcp/work/context', {
    mcpWorkingDirectory: junkDir, declaredWorkspace: repoA,
  })).json();
  assert.equal(ctx.ok, true);
  const found = [ctx.projectId, ...(ctx.candidates ?? []).map((candidate) => candidate.projectId)];
  assert.ok(found.includes(projectA.projectId), JSON.stringify(found));

  const ctxJunk = await (await harness.mcpPost('chat-ctx-2', '/api/v1/mcp/work/context', {
    mcpWorkingDirectory: junkDir,
  })).json();
  assert.equal(ctxJunk.status, 'no_session');
  assert.deepEqual(ctxJunk.candidates, []);
  // The Beta project stays untouched by all declarations above.
  assert.equal(projectB.projectId !== projectA.projectId, true);
});

test('the stdio gate admits declaredWorkspace only on the four entry tools', () => {
  const entryTools = new Set(['ugk_work_context', 'ugk_work_init', 'ugk_work_resume', 'ugk_work_takeover']);
  for (const tool of TOOLS) {
    const hasField = Boolean(tool.inputSchema?.properties?.declaredWorkspace);
    assert.equal(hasField, entryTools.has(tool.name), `${tool.name} schema mismatch`);
    if (hasField) {
      assert.equal(tool.inputSchema.properties.declaredWorkspace.type, 'string');
    }
  }
});
