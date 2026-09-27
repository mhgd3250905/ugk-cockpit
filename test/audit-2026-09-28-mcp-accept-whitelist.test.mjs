// 第 30 轮审计（2026-09-28）：/api/v1/mcp/work/accept 必须有工具 schema 的键白名单。
// alpha.57 为 finish/handoff 补齐 rejectUnexpectedMcpFields 时，判据就是
// 「HTTP 面宽度必须等于工具 schema」：ugk_work_accept 的 schema 是
// additionalProperties:false、只有 dispatchCode+clientRequestId，stdio 门
// validateAcceptArgs 也照此拒绝；但同一请求体经 scoped/bearer 直连 HTTP 时，
// sessionId、commandId 与任意额外键原样进入核心——实测 sessionId 传 200,009
// 字符仍 200 接受并写入 assignments.session_id、dispatch_grants.accepted_session_id、
// commands.run_id，而此后所有出口按 SAFE_SESSION_ID_PATTERN（≤128）判它非法：
// 绑定报告与诊断里该会话静默变 null，等于调用方铸了一个平台无法寻址的会话。
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
import { TOOLS } from '../src/mcp/stdio-protocol.mjs';

process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';

const TOKEN = 'accept-whitelist-test-token-that-is-long-enough';

async function serviceFixture(t) {
  const root = mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir()), 'ugk-accept-wl-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=UGK Test', '-c', 'user.email=ugk@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const dbPath = path.join(root, 'cockpit.db');
  const observation = await probeGitWorktree(root);
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-accept-wl', name: 'Accept whitelist', authorizedRoot: root, observation,
  });
  db.close();
  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  const post = async (pathname, body) => {
    const response = await fetch(`http://${service.host}:${service.port}${pathname}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  const created = await post(`/api/v1/projects/${project.projectId}/assignments`, {
    clientRequestId: 'create-accept-wl', agent: 'Codex', mode: 'handoff', task: '',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const dispatchCode = created.json.message.match(/dispatchCode: "([^"]+)"/)?.[1];
  assert.ok(dispatchCode, created.json.message);
  return { post, dispatchCode, projectId: project.projectId };
}

test('the accept schema publishes exactly dispatchCode and clientRequestId', () => {
  const accept = TOOLS.find((tool) => tool.name === 'ugk_work_accept');
  assert.deepEqual(Object.keys(accept.inputSchema.properties).sort(), ['clientRequestId', 'dispatchCode']);
  assert.equal(accept.inputSchema.additionalProperties, false);
});

test('the accept route refuses the fields the tool schema refuses', async (t) => {
  const { post, dispatchCode } = await serviceFixture(t);
  // stdio 门对 sessionId 的回答是 Unexpected property；HTTP 面必须一致。
  const withSession = await post('/api/v1/mcp/work/accept', {
    dispatchCode, clientRequestId: 'wl-session', sessionId: 'session-direct',
  });
  assert.equal(withSession.status, 400, JSON.stringify(withSession.json));
  assert.equal(withSession.json.code, 'INVALID_REQUEST');

  const withCommandId = await post('/api/v1/mcp/work/accept', {
    dispatchCode, clientRequestId: 'wl-command', commandId: 'caller-picked-command',
  });
  assert.equal(withCommandId.status, 400, JSON.stringify(withCommandId.json));

  const withBogus = await post('/api/v1/mcp/work/accept', {
    dispatchCode, clientRequestId: 'wl-bogus', bogus: 1,
  });
  assert.equal(withBogus.status, 400, JSON.stringify(withBogus.json));

  // 200,009 字符的自铸会话 id：修复前 200 接受并持久化，出口净化后该会话
  // 在平台回执里不可寻址。
  const oversized = await post('/api/v1/mcp/work/accept', {
    dispatchCode, clientRequestId: 'wl-oversized', sessionId: `attacker-${'x'.repeat(200_009)}`,
  });
  assert.equal(oversized.status, 400, JSON.stringify(oversized.json));
  assert.equal(oversized.json.code, 'INVALID_REQUEST');
});

test('a schema-shaped accept still succeeds (protection)', async (t) => {
  const { post, dispatchCode } = await serviceFixture(t);
  const accepted = await post('/api/v1/mcp/work/accept', {
    dispatchCode, clientRequestId: 'wl-clean',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal(accepted.json.ok, true);
});
