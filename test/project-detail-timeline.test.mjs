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
    status: 'working',
    summary: '已完成数据聚合层设计',
    details: ['设计 timeline 模块接口', '支持 Git chips 证据'],
  });
  assert.equal(progressRes.status, 200);
  const progressJson = await progressRes.json();
  assert.equal(progressJson.ok, true);
  assert.equal(progressJson.summary, '已完成数据聚合层设计');
  assert.deepEqual(progressJson.details, ['设计 timeline 模块接口', '支持 Git chips 证据']);
  assert.equal(progressJson.git.branch, 'main');
  assert.ok(progressJson.git.head);

  // Verify client-forged fields and empty payload rejection on HTTP seam
  const forgedGitRes = await post(service, '/api/v1/mcp/work/progress', {
    sessionId: initJson.sessionId,
    clientRequestId: 'req-progress-forged-git',
    expectedRevision: progressJson.revision,
    status: 'working',
    summary: 'Attempt forging git branch',
    gitBranch: 'main-forged',
  });
  assert.equal(forgedGitRes.status, 400);

  const forgedPathRes = await post(service, '/api/v1/mcp/work/progress', {
    sessionId: initJson.sessionId,
    clientRequestId: 'req-progress-forged-path',
    expectedRevision: progressJson.revision,
    status: 'working',
    summary: 'Attempt forging path',
    path: root,
  });
  assert.equal(forgedPathRes.status, 400);

  const forgedProjectRes = await post(service, '/api/v1/mcp/work/progress', {
    sessionId: initJson.sessionId,
    clientRequestId: 'req-progress-forged-proj',
    expectedRevision: progressJson.revision,
    status: 'working',
    summary: 'Attempt forging projectId',
    projectId: registered.projectId,
  });
  assert.equal(forgedProjectRes.status, 400);

  const emptyProgressRes = await post(service, '/api/v1/mcp/work/progress', {
    sessionId: initJson.sessionId,
    clientRequestId: 'req-progress-empty',
    expectedRevision: progressJson.revision,
    status: 'working',
  });
  assert.equal(emptyProgressRes.status, 400);

  // Insert a historical long legacy note-only progress event
  const legacyLongNote = '这是一个非常非常长的历史遗留进度记录，用来测试时间线聚合时是否能够正确地截断为带有省略号的有界短摘要，并且完整保留原始长文本，同时确保历史遗留记录没有伪造的 Git 证据。';
  const legacyDb = openCockpitDatabase(dbPath);
  legacyDb.prepare(`
    INSERT INTO progress_events (
      id, assignment_id, session_id, client_request_id,
      expected_revision, revision, status, note, summary, details_json,
      git_head, git_branch, git_coherence, git_observed_at, created_at
    ) VALUES (
      'pe_legacy_long_1', (SELECT id FROM assignments WHERE session_id = ?), ?, 'req-legacy-long-1',
      1, 2, 'working', ?, NULL, '[]',
      NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z'
    )
  `).run(initJson.sessionId, initJson.sessionId, legacyLongNote);
  legacyDb.close();

  // Insert a historical legacy relay without Git evidence
  const insertRelayDb = openCockpitDatabase(dbPath);
  insertRelayDb.prepare(`
    INSERT INTO relays (
      id, sequence, assignment_id, project_id, worktree_id,
      session_id, run_id, client_request_id, expected_revision, revision,
      next_session_focus, summary, current_state,
      completed_items, pending_items, decisions,
      artifact_refs, risks, suggested_skills,
      git_head, git_branch, git_coherence, git_observed_at,
      code_hash, state, expires_at, created_at
    ) VALUES (
      'rel_legacy_null_1', 99, (SELECT id FROM assignments WHERE session_id = ?), ?, (SELECT worktree_id FROM projects WHERE id = ?),
      ?, NULL, 'req-legacy-relay-1', 1, 2,
      '历史遗留接力下一步', '历史遗留接力摘要', '历史遗留接力状态',
      '["遗留完成项"]', '["遗留待继续"]', '["遗留决定"]',
      '[]', '["遗留风险"]', '[]',
      NULL, NULL, NULL, NULL,
      'legacy-code-hash', 'expired', 1000, '2025-12-31T00:00:00.000Z'
    )
  `).run(initJson.sessionId, registered.projectId, registered.projectId, initJson.sessionId);
  insertRelayDb.close();

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

  // Verify relay item in timeline is active before resume and has server-collected Git evidence
  const detailBeforeResumeRes = await get(service, `/api/v1/projects/${registered.projectId}`);
  assert.equal(detailBeforeResumeRes.status, 200);
  const detailBeforeResume = await detailBeforeResumeRes.json();
  const activeRelayItem = detailBeforeResume.timeline.items.find((it) => it.id === relayJson.relayId);
  assert.ok(activeRelayItem);
  assert.equal(activeRelayItem.id, relayJson.relayId);
  assert.equal(activeRelayItem.state, 'active');
  assert.equal(activeRelayItem.acceptedAt, null);
  assert.ok(activeRelayItem.git);
  assert.equal(activeRelayItem.git.branch, 'main');
  assert.equal(activeRelayItem.git.coherence, 'coherent');

  // Resume relay in same worktree
  const resumeRes = await post(service, '/api/v1/mcp/work/resume', {
    continueCode: relayJson.continueCode,
    clientRequestId: 'req-resume-1',
    mcpWorkingDirectory: root,
  });
  assert.equal(resumeRes.status, 200);
  const resumeJson = await resumeRes.json();
  assert.equal(resumeJson.ok, true);
  assert.equal(resumeJson.relay.state, 'accepted');
  assert.ok(resumeJson.relay.acceptedAt);

  // Verify relay item in timeline is now accepted with exact acceptedAt
  const detailAfterResumeRes = await get(service, `/api/v1/projects/${registered.projectId}`);
  assert.equal(detailAfterResumeRes.status, 200);
  const detailAfterResume = await detailAfterResumeRes.json();
  const acceptedRelayItem = detailAfterResume.timeline.items.find((it) => it.id === relayJson.relayId);
  assert.ok(acceptedRelayItem);
  assert.equal(acceptedRelayItem.id, relayJson.relayId);
  assert.equal(acceptedRelayItem.state, 'accepted');
  assert.equal(acceptedRelayItem.acceptedAt, resumeJson.relay.acceptedAt);
  assert.ok(acceptedRelayItem.git);
  assert.equal(acceptedRelayItem.git.branch, 'main');
  assert.equal(acceptedRelayItem.git.coherence, 'coherent');

  // Step 5: Commit on main
  writeFileSync(path.join(root, 'TIMELINE.md'), '# Timeline Feature\n');
  execFileSync('git', ['add', 'TIMELINE.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=UGK Test', '-c', 'user.email=ugk@example.invalid', 'commit', '--quiet', '-m', 'feat: timeline ui'], { cwd: root });
  const newHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  // Step 6: Record handoff
  const handoffRes = await post(service, '/api/v1/mcp/work/handoff', {
    sessionId: initJson.sessionId,
    clientRequestId: 'req-handoff-1',
    expectedRevision: resumeJson.revision,
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
  assert.equal(detail.timeline.total, 6); // init + legacy progress + structured progress + relay + handoff + legacy relay

  const items = detail.timeline.items;
  // Reverse chronological order: newest first -> handoff, relay, structured progress, init, legacy progress, legacy relay
  assert.equal(items[0].kind, 'handoff');
  assert.equal(items[0].typeLabel, '阶段交接');
  assert.equal(items[0].agent, 'Codex');
  assert.equal(items[0].summary, '已完成时间线与大尺寸项目详情弹窗');
  assert.equal(items[0].git.branch, 'main');
  assert.equal(items[0].git.head, newHead);
  assert.equal(items[0].git.shortHead, newHead.slice(0, 7));
  assert.equal(items[0].git.coherence, 'coherent');
  assert.ok(items[0].git.observedAt);
  assert.equal(items[0].git.branchChanged, false);
  assert.deepEqual(items[0].completedItems, ['紧凑卡片', '详情 Dialog', '时间线动效']);
  assert.deepEqual(items[0].pendingItems, ['最终发布 readiness 检查']);
  assert.deepEqual(items[0].decisions, ['保持克制动效']);

  assert.equal(items[1].kind, 'relay');
  assert.equal(items[1].typeLabel, '聊天接力');
  assert.equal(items[1].summary, '后端 API 与时间线聚合已就绪');
  assert.equal(items[1].state, 'accepted');
  assert.equal(items[1].acceptedAt, resumeJson.relay.acceptedAt);
  assert.ok(items[1].git);
  assert.equal(items[1].git.branch, 'main');
  assert.equal(items[1].git.coherence, 'coherent');
  assert.ok(items[1].git.observedAt);
  assert.deepEqual(items[1].completedItems, ['timeline.mjs 模块', 'http-server 路由']);
  assert.deepEqual(items[1].pendingItems, ['main.jsx 弹窗重构']);
  assert.deepEqual(items[1].decisions, ['使用倒序展示']);

  assert.equal(items[2].kind, 'progress');
  assert.equal(items[2].typeLabel, '工作进展');
  assert.equal(items[2].summary, '已完成数据聚合层设计');
  assert.deepEqual(items[2].details, ['设计 timeline 模块接口', '支持 Git chips 证据']);
  assert.equal(items[2].isLegacyNote, false);
  assert.equal(items[2].git.branch, 'main');
  assert.ok(items[2].git.head);
  assert.equal(items[2].git.coherence, 'coherent');

  assert.equal(items[3].kind, 'init');
  assert.equal(items[3].typeLabel, '接入项目');
  assert.equal(items[3].summary, '开始接入，基线干净');
  assert.equal(items[3].git.branch, 'main');
  assert.ok(items[3].git.head);
  assert.equal(items[3].git.coherence, 'coherent');
  assert.ok(items[3].git.observedAt);

  assert.equal(items[4].kind, 'progress');
  assert.equal(items[4].typeLabel, '工作进展');
  assert.ok(items[4].summary.length <= 81);
  assert.ok(items[4].summary.endsWith('…'));
  assert.equal(items[4].note, legacyLongNote);
  assert.equal(items[4].isLegacyNote, true);
  assert.equal(items[4].git, null);

  assert.equal(items[5].kind, 'relay');
  assert.equal(items[5].id, 'rel_legacy_null_1');
  assert.equal(items[5].summary, '历史遗留接力摘要');
  assert.equal(items[5].git, null); // Legacy relay without git info does not guess
  assert.deepEqual(items[5].completedItems, ['遗留完成项']);
  assert.deepEqual(items[5].pendingItems, ['遗留待继续']);
  assert.deepEqual(items[5].decisions, ['遗留决定']);
  assert.deepEqual(items[5].risks, ['遗留风险']);

  // Step 8: Test pagination
  const pagedRes = await get(service, `/api/v1/projects/${registered.projectId}/timeline?limit=2&offset=0`);
  assert.equal(pagedRes.status, 200);
  const paged = await pagedRes.json();
  assert.equal(paged.total, 6);
  assert.equal(paged.items.length, 2);
  assert.equal(paged.hasMore, true);
  assert.equal(paged.items[0].kind, 'handoff');
  assert.equal(paged.items[1].kind, 'relay');
  assert.equal(paged.items[1].id, relayJson.relayId);

  const offsetRes = await get(service, `/api/v1/projects/${registered.projectId}/timeline?limit=2&offset=2`);
  assert.equal(offsetRes.status, 200);
  const offsetJson = await offsetRes.json();
  assert.equal(offsetJson.total, 6);
  assert.equal(offsetJson.items.length, 2);
  assert.equal(offsetJson.hasMore, true);
  assert.equal(offsetJson.items[0].kind, 'progress');
  assert.equal(offsetJson.items[0].summary, '已完成数据聚合层设计');
  assert.equal(offsetJson.items[1].kind, 'init');

  const finalPageRes = await get(service, `/api/v1/projects/${registered.projectId}/timeline?limit=2&offset=4`);
  assert.equal(finalPageRes.status, 200);
  const finalPageJson = await finalPageRes.json();
  assert.equal(finalPageJson.total, 6);
  assert.equal(finalPageJson.items.length, 2);
  assert.equal(finalPageJson.hasMore, false);
  assert.equal(finalPageJson.items[0].kind, 'progress');
  assert.equal(finalPageJson.items[0].isLegacyNote, true);
  assert.equal(finalPageJson.items[1].kind, 'relay');
  assert.equal(finalPageJson.items[1].id, 'rel_legacy_null_1');

  // Step 9: 404 on non-existent project
  const notFoundRes = await get(service, '/api/v1/projects/non-existent-id');
  assert.equal(notFoundRes.status, 404);
});
