import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { readProjectDetail, readProjectTimeline } from '../src/core/timeline.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const TOKEN = 'project-detail-timeline-test-token-32chars';

async function post(service, pathname, body) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(service, pathname) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

test('project detail and timeline aggregate init, progress, relay, and handoff in reverse chronological order', async (t) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-detail-timeline-'));
  const root = path.join(tempDir, 'repo');
  mkdirSync(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# Fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=UGK Test', '-c', 'user.email=ugk@example.invalid', 'commit', '--quiet', '-m', 'initial commit'], { cwd: root });

  const dbPath = path.join(tempDir, 'cockpit.db');
  const observation = await probeGitWorktree(root);
  const db = openCockpitDatabase(dbPath);
  const registered = registerProject(db, {
    commandId: 'register-detail-fixture',
    name: 'Detail Fixture Project',
    authorizedRoot: root,
    observation,
  });
  db.close();

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  t.after(async () => {
    await service.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Step 1: Check fresh project detail
  const freshDetailRes = await get(service, `/api/v1/projects/${registered.projectId}`);
  assert.equal(freshDetailRes.status, 200);
  const freshDetail = await freshDetailRes.json();
  assert.equal(freshDetail.ok, true);
  assert.equal(freshDetail.project.name, 'Detail Fixture Project');
  assert.equal(freshDetail.project.git.branch, 'main');
  assert.ok(freshDetail.project.git.head);
  assert.equal(freshDetail.timeline.total, 0);
  assert.deepEqual(freshDetail.timeline.items, []);

  // Step 2: Init assignment and adopt
  const targetTask = '构建时间线详情弹窗';
  const assignRes = await post(service, `/api/v1/projects/${registered.projectId}/assignments`, {
    clientRequestId: 'req-assign-1',
    agent: 'Codex',
    mode: 'init',
    task: targetTask,
  });
  assert.equal(assignRes.status, 201);
  const assignJson = await assignRes.json();
  const initCode = assignJson.message.match(/initCode: "([^"]+)"/)?.[1];
  assert.ok(initCode);

  const initRes = await post(service, '/api/v1/mcp/work/init', {
    initCode,
    clientRequestId: 'req-init-1',
    currentTask: targetTask,
    currentState: '开始接入，基线干净',
    mcpWorkingDirectory: root,
  });
  assert.equal(initRes.status, 200);
  const initJson = await initRes.json();

  // Step 3: Record progress
  const progressRes = await post(service, '/api/v1/mcp/work/progress', {
    sessionId: initJson.sessionId,
    clientRequestId: 'req-progress-1',
    expectedRevision: initJson.revision,
    status: 'progress',
    note: '已完成数据聚合层设计',
  });
  assert.equal(progressRes.status, 200);
  const progressJson = await progressRes.json();

  // Step 4: Record conversation relay
  const relayRes = await post(service, '/api/v1/mcp/work/relay', {
    sessionId: initJson.sessionId,
    clientRequestId: 'req-relay-1',
    expectedRevision: progressJson.revision,
    nextSessionFocus: '继续实现前端弹窗组件',
    summary: '后端 API 与时间线聚合已就绪',
    currentState: 'API 联调通过',
    completedItems: ['timeline.mjs 模块', 'http-server 路由'],
    pendingItems: ['main.jsx 弹窗重构'],
    decisions: ['使用倒序展示'],
    artifactRefs: [],
    risks: [],
    suggestedSkills: [],
  });
  assert.equal(relayRes.status, 200);
  const relayJson = await relayRes.json();

  // Step 5: Commit on main
  writeFileSync(path.join(root, 'TIMELINE.md'), '# Timeline Feature\n');
  execFileSync('git', ['add', 'TIMELINE.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=UGK Test', '-c', 'user.email=ugk@example.invalid', 'commit', '--quiet', '-m', 'feat: timeline ui'], { cwd: root });
  const newHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  // Step 6: Record handoff
  const handoffRes = await post(service, '/api/v1/mcp/work/handoff', {
    sessionId: initJson.sessionId,
    clientRequestId: 'req-handoff-1',
    expectedRevision: relayJson.revision,
    outcome: 'completed',
    nextSessionFocus: '验证浏览器端动效',
    summary: '已完成时间线与大尺寸项目详情弹窗',
    currentState: '代码重构完成，测试通过',
    completedItems: ['紧凑卡片', '详情 Dialog', '时间线动效'],
    pendingItems: ['最终发布 readiness 检查'],
    decisions: ['保持克制动效'],
    artifactRefs: [],
    risks: [],
    suggestedSkills: [],
    acknowledgements: [`commit:${newHead}`, 'unattributed_changes'],
  });
  assert.equal(handoffRes.status, 200, await handoffRes.clone().text());

  // Step 7: Query project detail and verify timeline
  const detailRes = await get(service, `/api/v1/projects/${registered.projectId}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();

  assert.equal(detail.ok, true);
  assert.equal(detail.project.name, 'Detail Fixture Project');
  assert.equal(detail.timeline.total, 4); // init + progress + relay + handoff

  const items = detail.timeline.items;
  // Reverse chronological order: newest first -> handoff, relay, progress, init
  assert.equal(items[0].kind, 'handoff');
  assert.equal(items[0].typeLabel, '阶段交接');
  assert.equal(items[0].agent, 'Codex');
  assert.equal(items[0].summary, '已完成时间线与大尺寸项目详情弹窗');
  assert.equal(items[0].git.branch, 'main');
  assert.equal(items[0].git.head, newHead);
  assert.equal(items[0].git.shortHead, newHead.slice(0, 7));
  assert.equal(items[0].git.branchChanged, false);

  assert.equal(items[1].kind, 'relay');
  assert.equal(items[1].typeLabel, '聊天接力');
  assert.equal(items[1].summary, '后端 API 与时间线聚合已就绪');
  assert.equal(items[1].git, null); // relay does not fabricate git info

  assert.equal(items[2].kind, 'progress');
  assert.equal(items[2].typeLabel, '工作进展');
  assert.equal(items[2].summary, '已完成数据聚合层设计');
  assert.equal(items[2].git, null); // progress does not fabricate git info

  assert.equal(items[3].kind, 'init');
  assert.equal(items[3].typeLabel, '接入项目');
  assert.equal(items[3].summary, '开始接入，基线干净');
  assert.equal(items[3].git.branch, 'main');
  assert.ok(items[3].git.head);

  // Step 8: Test pagination
  const pagedRes = await get(service, `/api/v1/projects/${registered.projectId}/timeline?limit=2&offset=0`);
  assert.equal(pagedRes.status, 200);
  const paged = await pagedRes.json();
  assert.equal(paged.total, 4);
  assert.equal(paged.items.length, 2);
  assert.equal(paged.hasMore, true);
  assert.equal(paged.items[0].kind, 'handoff');
  assert.equal(paged.items[1].kind, 'relay');

  const offsetRes = await get(service, `/api/v1/projects/${registered.projectId}/timeline?limit=2&offset=2`);
  assert.equal(offsetRes.status, 200);
  const offsetJson = await offsetRes.json();
  assert.equal(offsetJson.items.length, 2);
  assert.equal(offsetJson.hasMore, false);
  assert.equal(offsetJson.items[0].kind, 'progress');
  assert.equal(offsetJson.items[1].kind, 'init');

  // Step 9: 404 on non-existent project
  const notFoundRes = await get(service, '/api/v1/projects/non-existent-id');
  assert.equal(notFoundRes.status, 404);
});
