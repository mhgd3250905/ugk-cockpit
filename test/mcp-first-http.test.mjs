import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const TOKEN = 'mcp-first-test-token-that-is-long-enough';

async function post(service, pathname, body) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('existing Agent initializes the registered project, continues, and hands off', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-mcp-first-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=UGK Test', '-c', 'user.email=ugk@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const dbPath = path.join(root, 'cockpit.db');
  const observation = await probeGitWorktree(root);
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-mcp-fixture',
    name: 'MCP fixture',
    authorizedRoot: root,
    observation,
  });
  db.close();

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(path.join(root, 'WIP.md'), 'half-finished work\n');
  const explicitTarget = '验证 MCP init 闭环';
  const assignmentResponse = await post(
    service,
    `/api/v1/projects/${project.projectId}/assignments`,
    { clientRequestId: 'create-assignment-1', agent: 'Codex', mode: 'init', task: explicitTarget },
  );
  assert.equal(assignmentResponse.status, 201, await assignmentResponse.clone().text());
  const assignment = await assignmentResponse.json();
  const initCode = assignment.message.match(/initCode: "([^"]+)"/)?.[1];
  assert.ok(initCode);
  assert.equal(assignment.task, explicitTarget);
  assert.match(assignment.message, /\$cockpit-init/);
  assert.match(assignment.message, /\$cockpit-progress/);
  assert.match(assignment.message, /\$cockpit-relay/);
  assert.match(assignment.message, /\$cockpit-handoff/);
  assert.match(assignment.message, /只有用户明确要求结束/);
  assert.equal(assignment.message.includes('ugk_work_begin'), false);
  assert.equal(assignment.message.includes(`当前目标：${explicitTarget}`), true);
  assert.equal(assignment.message.includes(root), false);
  assert.equal(assignment.message.includes(TOKEN), false);
  const reissueResponse = await post(
    service,
    `/api/v1/projects/${project.projectId}/assignments/reissue`,
    { clientRequestId: 'reissue-assignment-1', mode: 'init', agent: 'ZCode' },
  );
  assert.equal(reissueResponse.status, 200, await reissueResponse.clone().text());
  const reissued = await reissueResponse.json();
  const reissuedInitCode = reissued.message.match(/initCode: "([^"]+)"/)?.[1];
  assert.equal(reissued.reissued, true);
  assert.equal(reissued.assignmentId, assignment.assignmentId);
  assert.equal(reissued.agent, 'ZCode');
  assert.ok(reissuedInitCode);
  assert.notEqual(reissuedInitCode, initCode);
  assert.equal(reissued.task, explicitTarget);
  assert.equal(reissued.message.includes(`当前目标：${explicitTarget}`), true);
  assert.equal(reissued.message.includes('ugk_work_begin'), false);
  const pendingDashboard = await (await fetch(
    `http://${service.host}:${service.port}/api/v1/dashboard`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  )).json();
  assert.equal(pendingDashboard.projects[0].statusReason, 'assignment_waiting');
  assert.equal(pendingDashboard.projects[0].activeRun, null);
  assert.equal(pendingDashboard.projects[0].pendingAssignment.mode, 'adopt');
  assert.equal(pendingDashboard.projects[0].pendingAssignment.agent, 'ZCode');
  assert.equal(pendingDashboard.projects[0].pendingAssignment.task, explicitTarget);

  const initResponse = await post(service, '/api/v1/mcp/work/init', {
    initCode: reissuedInitCode,
    clientRequestId: 'init-1',
    currentTask: explicitTarget,
    currentState: '核心功能完成一半，继续开发',
    mcpWorkingDirectory: root,
  });
  assert.equal(initResponse.status, 200, await initResponse.clone().text());
  const initialized = await initResponse.json();
  assert.equal(initialized.status, 'active');
  assert.equal(initialized.revision, 2);
  assert.equal(initialized.preexistingChangesPreserved, true);
  assert.equal(Object.hasOwn(initialized, 'latestHandoff'), true);
  assert.equal(initialized.latestHandoff, null);

  const progressResponse = await post(service, '/api/v1/mcp/work/progress', {
    sessionId: initialized.sessionId,
    clientRequestId: 'progress-1',
    expectedRevision: 2,
    status: 'working',
    note: '协议与状态机已经接通',
  });
  assert.equal(progressResponse.status, 200, await progressResponse.clone().text());
  const progress = await progressResponse.json();
  assert.equal(progress.revision, 3);

  const finishResponse = await post(service, '/api/v1/mcp/work/handoff', {
    sessionId: initialized.sessionId,
    clientRequestId: 'handoff-1',
    expectedRevision: 3,
    outcome: 'completed',
    nextSessionFocus: '等待用户安排下一项开发任务',
    summary: 'MCP 闭环通过',
    currentState: '交接工具、等待态和开始工作工具已经接通',
    completedItems: ['完成标准交接手册生成'],
    pendingItems: ['由用户体验工作台'],
    decisions: ['等待态不获取写入权限'],
    artifactRefs: ['src/core/handoffs.mjs'],
    risks: [],
    suggestedSkills: ['handoff'],
    acknowledgements: [],
  });
  assert.equal(finishResponse.status, 200, await finishResponse.clone().text());
  const finished = await finishResponse.json();
  assert.equal(finished.cockpitVerified, true);
  assert.equal(finished.revision, 4);

  const dashboardResponse = await fetch(
    `http://${service.host}:${service.port}/api/v1/dashboard`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  );
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.projects[0].activeWork, null);
  assert.equal(dashboard.projects[0].lastWork.summary, 'MCP 闭环通过');
  assert.equal(dashboard.projects[0].lastWork.nextStep, '等待用户安排下一项开发任务');
  assert.equal(dashboard.projects[0].lastHandoffManual.summary, 'MCP 闭环通过');

  const standbyResponse = await post(
    service,
    `/api/v1/projects/${project.projectId}/assignments`,
    { clientRequestId: 'create-assignment-2', agent: 'Codex', mode: 'handoff', task: '' },
  );
  assert.equal(standbyResponse.status, 201, await standbyResponse.clone().text());
  const standby = await standbyResponse.json();
  const standbyCode = standby.message.match(/dispatchCode: "([^"]+)"/)?.[1];
  assert.ok(standbyCode);

  const standbyAcceptResponse = await post(service, '/api/v1/mcp/work/accept', {
    dispatchCode: standbyCode,
    clientRequestId: 'accept-2',
  });
  assert.equal(standbyAcceptResponse.status, 200, await standbyAcceptResponse.clone().text());
  const waiting = await standbyAcceptResponse.json();
  assert.equal(waiting.status, 'waiting_for_instruction');
  assert.equal(waiting.revision, 1);
  assert.equal(waiting.latestHandoff.summary, 'MCP 闭环通过');
  assert.match(waiting.latestHandoff.bodyMarkdown, /# Handoff/);

  const waitingDashboard = await (await fetch(
    `http://${service.host}:${service.port}/api/v1/dashboard`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  )).json();
  assert.equal(waitingDashboard.projects[0].statusReason, 'agent_waiting');
  assert.equal(waitingDashboard.projects[0].activeRun, null);

  const beginResponse = await post(service, '/api/v1/mcp/work/begin', {
    sessionId: waiting.sessionId,
    clientRequestId: 'begin-2',
    expectedRevision: 1,
    task: '按用户的新安排开始开发',
  });
  assert.equal(beginResponse.status, 200, await beginResponse.clone().text());
  const begun = await beginResponse.json();
  assert.equal(begun.status, 'active');
  assert.equal(begun.task, '按用户的新安排开始开发');

  const verified = openCockpitDatabase(dbPath, { migrate: false });
  const storedHash = verified.prepare('SELECT code_hash FROM dispatch_grants').get().code_hash;
  assert.equal(storedHash.includes(initCode), false);
  assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM progress_events').get().count, 3);
  assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM handoffs').get().count, 1);
  verified.close();
});

test('handoff is atomic across manual, run, and assignment and retries idempotently', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-mcp-handoff-atomic-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', [
    '-c', 'user.name=UGK Test',
    '-c', 'user.email=ugk@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ], { cwd: root });
  const dbPath = path.join(root, 'cockpit.db');
  const observation = await probeGitWorktree(root);
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-mcp-atomic-fixture',
    name: 'MCP atomic fixture',
    authorizedRoot: root,
    observation,
  });
  db.close();

  let injectFailure = true;
  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    faultInjector(point) {
      if (injectFailure && point === 'finish.after_snapshot_insert') {
        injectFailure = false;
        throw new Error('injected handoff failure');
      }
    },
  });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  const assignmentResponse = await post(
    service,
    `/api/v1/projects/${project.projectId}/assignments`,
    { clientRequestId: 'create-atomic-assignment', agent: 'ZCode', mode: 'init', task: '' },
  );
  assert.equal(assignmentResponse.status, 201, await assignmentResponse.clone().text());
  const assignment = await assignmentResponse.json();
  const initCode = assignment.message.match(/initCode: "([^"]+)"/)?.[1];
  assert.ok(initCode);

  const initResponse = await post(service, '/api/v1/mcp/work/init', {
    initCode,
    clientRequestId: 'init-atomic',
    currentTask: '验证 handoff 原子性',
    currentState: '已接入，准备结束',
    mcpWorkingDirectory: root,
  });
  assert.equal(initResponse.status, 200, await initResponse.clone().text());
  const initialized = await initResponse.json();
  const progressResponse = await post(service, '/api/v1/mcp/work/progress', {
    sessionId: initialized.sessionId,
    clientRequestId: 'progress-atomic',
    expectedRevision: initialized.revision,
    status: 'working',
    note: '准备生成交接手册',
  });
  assert.equal(progressResponse.status, 200, await progressResponse.clone().text());
  const progress = await progressResponse.json();

  const handoffBody = {
    sessionId: initialized.sessionId,
    clientRequestId: 'handoff-atomic',
    expectedRevision: progress.revision,
    outcome: 'completed',
    nextSessionFocus: '等待下一项任务',
    summary: '原子性回归测试',
    currentState: '已完成',
    completedItems: ['验证事务边界'],
    pendingItems: [],
    decisions: [],
    artifactRefs: ['test/mcp-first-http.test.mjs'],
    risks: [],
    suggestedSkills: [],
    acknowledgements: [],
  };
  const invalidTerminalProgress = await post(service, '/api/v1/mcp/work/progress', {
    sessionId: initialized.sessionId,
    clientRequestId: 'progress-terminal-rejected',
    expectedRevision: progress.revision,
    status: 'completed',
    note: '结束应使用 handoff',
  });
  assert.equal(invalidTerminalProgress.status, 400, await invalidTerminalProgress.clone().text());
  // Simulate an older client that incorrectly used progress(status=completed)
  // before the handoff request arrived.  Handoff must reconcile this exact
  // terminal state, while preserving the revision fence.
  const legacyState = openCockpitDatabase(dbPath, { migrate: false });
  legacyState.prepare(`
    UPDATE assignments SET status = 'completed'
    WHERE session_id = ? AND revision = ?
  `).run(initialized.sessionId, progress.revision);
  legacyState.close();
  const failedResponse = await post(service, '/api/v1/mcp/work/handoff', handoffBody);
  assert.equal(failedResponse.status, 400, await failedResponse.clone().text());

  const afterFailure = openCockpitDatabase(dbPath, { migrate: false });
  assert.equal(afterFailure.prepare('SELECT count(*) AS count FROM handoffs').get().count, 0);
  assert.equal(afterFailure.prepare('SELECT count(*) AS count FROM handoff_receipts').get().count, 0);
  assert.equal(afterFailure.prepare('SELECT count(*) AS count FROM snapshots WHERE phase = \'final\'').get().count, 0);
  const failedRun = afterFailure
    .prepare('SELECT lifecycle, revision FROM runs WHERE id = ?')
    .get(initialized.sessionId);
  assert.equal(failedRun.lifecycle, 'active');
  assert.equal(failedRun.revision, progress.revision);
  const failedAssignment = afterFailure
    .prepare('SELECT status, revision FROM assignments WHERE session_id = ?')
    .get(initialized.sessionId);
  assert.equal(failedAssignment.status, 'completed');
  assert.equal(failedAssignment.revision, progress.revision);
  afterFailure.close();

  const firstSuccessResponse = await post(service, '/api/v1/mcp/work/handoff', handoffBody);
  assert.equal(firstSuccessResponse.status, 200, await firstSuccessResponse.clone().text());
  const firstSuccess = await firstSuccessResponse.json();
  assert.equal(firstSuccess.revision, progress.revision + 1);
  assert.equal(firstSuccess.cockpitVerified, true);

  const replayResponse = await post(service, '/api/v1/mcp/work/handoff', handoffBody);
  assert.equal(replayResponse.status, 200, await replayResponse.clone().text());
  assert.deepEqual(await replayResponse.json(), firstSuccess);

  const finalDb = openCockpitDatabase(dbPath, { migrate: false });
  assert.equal(finalDb.prepare('SELECT count(*) AS count FROM handoffs').get().count, 1);
  assert.equal(finalDb.prepare('SELECT count(*) AS count FROM handoff_receipts').get().count, 1);
  assert.equal(finalDb.prepare('SELECT count(*) AS count FROM snapshots WHERE phase = \'final\'').get().count, 1);
  assert.equal(finalDb.prepare('SELECT count(*) AS count FROM write_leases').get().count, 0);
  const finishedRun = finalDb
    .prepare('SELECT lifecycle, revision FROM runs WHERE id = ?')
    .get(initialized.sessionId);
  assert.equal(finishedRun.lifecycle, 'completed');
  assert.equal(finishedRun.revision, progress.revision + 1);
  const finishedAssignment = finalDb
    .prepare('SELECT status, revision FROM assignments WHERE session_id = ?')
    .get(initialized.sessionId);
  assert.equal(finishedAssignment.status, 'completed');
  assert.equal(finishedAssignment.revision, progress.revision + 1);
  finalDb.close();
});

test('development space MCP init, progress, relay, and resume workflows bind correctly', async (t) => {
  const container = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-space-mcp-'));
  const root = path.join(container, 'main-repo');
  const spaceFolder = path.join(container, 'space-worktree');
  const remotePath = path.join(container, 'remote.git');
  execFileSync('git', ['init', '--bare', '--quiet', remotePath]);
  execFileSync('git', ['init', '-b', 'main', '--quiet', root]);
  writeFileSync(path.join(root, 'README.md'), '# Main Repo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=UGK Test', '-c', 'user.email=ugk@example.invalid', 'commit', '--quiet', '-m', 'initial commit'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'UGK Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'ugk@example.invalid'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: root });
  execFileSync('git', ['push', '--set-upstream', 'origin', 'main'], { cwd: root });
  const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  mkdirSync(spaceFolder, { recursive: true });

  const dbPath = path.join(container, 'cockpit.db');
  let currentSelectedFolder = null;
  const folderPicker = async () => currentSelectedFolder;

  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [root, spaceFolder],
    folderPicker,
    createGitWorktree: async (repoPath, { targetPath, branch, baseCommit }) => {
      execFileSync('git', ['worktree', 'add', '-b', branch, targetPath, baseCommit], {
        cwd: repoPath,
        windowsHide: true,
        stdio: 'pipe',
      });
      return { ok: true, targetPath, branch, baseCommit };
    },
  });
  t.after(async () => {
    await service.close();
    rmSync(container, { recursive: true, force: true });
  });

  // 1. Register main project
  currentSelectedFolder = root;
  const selectProjRes = await (await post(service, '/api/v1/folders/select', {})).json();
  assert.equal(selectProjRes.ok, true);
  const regProjRes = await (await post(service, '/api/v1/projects', {
    commandId: 'reg-space-mcp-proj',
    grantId: selectProjRes.grantId,
    name: 'Space MCP Project',
  })).json();
  assert.equal(regProjRes.ok, true);
  const projectId = regProjRes.projectId;

  // 2. Select empty folder for development space
  currentSelectedFolder = spaceFolder;
  const selectEmptyRes = await (await post(service, '/api/v1/folders/select-empty', {})).json();
  assert.equal(selectEmptyRes.ok, true);
  assert.equal(selectEmptyRes.cancelled, false);
  const emptyGrantId = selectEmptyRes.grantId;

  // 3. Create development space
  const createSpaceRes = await (await post(service, `/api/v1/projects/${projectId}/spaces`, {
    commandId: 'create-space-mcp-cmd',
    grantId: emptyGrantId,
    expectedBaseHead: headCommit,
    name: 'space-feature-mcp',
  })).json();
  assert.equal(createSpaceRes.ok, true);
  const spaceId = createSpaceRes.spaceId;
  const spaceWorktreeId = createSpaceRes.worktreeId;
  assert.ok(spaceId);
  assert.ok(spaceWorktreeId);

  // 4. Create assignment targeting the space
  const createAssignRes = await post(service, `/api/v1/projects/${projectId}/assignments`, {
    clientRequestId: 'space-assign-req-1',
    agent: 'Antigravity',
    mode: 'init',
    task: '开发空间任务',
    spaceId,
  });
  assert.equal(createAssignRes.status, 201);
  const assignResult = await createAssignRes.json();
  assert.equal(assignResult.ok, true);
  assert.equal(assignResult.spaceId, spaceId);
  assert.equal(assignResult.worktreeId, spaceWorktreeId);

  // 5. Reissue assignment with spaceId
  const reissueRes = await post(service, `/api/v1/projects/${projectId}/assignments/reissue`, {
    clientRequestId: 'space-reissue-req-1',
    agent: 'Antigravity',
    spaceId,
  });
  assert.equal(reissueRes.status, 200);
  const reissued = await reissueRes.json();
  assert.equal(reissued.ok, true);
  assert.equal(reissued.spaceId, spaceId);
  assert.equal(reissued.worktreeId, spaceWorktreeId);

  const match = reissued.message.match(/initCode: "([^"]+)"/);
  assert.ok(match);
  const initCode = match[1];

  // 6. Attempting MCP init from wrong working directory (main repo root instead of spaceFolder) -> rejected
  const mismatchInitRes = await post(service, '/api/v1/mcp/work/init', {
    initCode,
    clientRequestId: 'mcp-init-wrong-dir',
    currentTask: '开发空间任务',
    currentState: '开始工作',
    mcpWorkingDirectory: root,
  });
  assert.equal(mismatchInitRes.status, 409);
  const mismatchErr = await mismatchInitRes.json();
  assert.equal(mismatchErr.code, 'DISPATCH_GRANT_BINDING_MISMATCH');

  // 7. MCP init from correct spaceFolder -> succeeds
  const successInitRes = await post(service, '/api/v1/mcp/work/init', {
    initCode,
    clientRequestId: 'mcp-init-correct-dir',
    currentTask: '开发空间任务',
    currentState: '空间环境就绪，开始工作',
    mcpWorkingDirectory: spaceFolder,
  });
  assert.equal(successInitRes.status, 200, await successInitRes.clone().text());
  const initialized = await successInitRes.json();
  assert.equal(initialized.status, 'active');
  assert.equal(initialized.revision, 2);
  const sessionId = initialized.sessionId;

  // 8. MCP progress in development space
  const progressRes = await post(service, '/api/v1/mcp/work/progress', {
    sessionId,
    clientRequestId: 'space-prog-1',
    expectedRevision: 2,
    status: 'working',
    summary: '开发空间进展汇报',
    details: ['在开发空间工作副本修改文件'],
  });
  assert.equal(progressRes.status, 200);
  const progress = await progressRes.json();
  assert.equal(progress.revision, 3);

  // 9. MCP relay in development space
  const relayRes = await post(service, '/api/v1/mcp/work/relay', {
    sessionId,
    clientRequestId: 'space-relay-1',
    expectedRevision: 3,
    nextSessionFocus: '下一条会话继续空间开发',
    summary: '空间阶段总结',
    currentState: '就绪',
    completedItems: ['已完成第一阶段'],
    pendingItems: ['准备第二阶段'],
    decisions: ['保持独立分支'],
    artifactRefs: [],
    risks: [],
    suggestedSkills: [],
  });
  assert.equal(relayRes.status, 200);
  const relay = await relayRes.json();
  assert.ok(relay.continueCode);

  // 10. MCP resume from spaceFolder
  const resumeRes = await post(service, '/api/v1/mcp/work/resume', {
    continueCode: relay.continueCode,
    clientRequestId: 'space-resume-1',
    mcpWorkingDirectory: spaceFolder,
  });
  assert.equal(resumeRes.status, 200);
  const resumed = await resumeRes.json();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.worktreeId, spaceWorktreeId);

  // 11. Explicit submit saves all changes, pushes the managed branch, and creates main review work
  writeFileSync(path.join(spaceFolder, 'feature.txt'), 'ready for review\n');
  const submitRes = await post(service, '/api/v1/mcp/work/submit', {
    sessionId,
    clientRequestId: 'space-submit-1',
    expectedRevision: resumed.revision,
    summary: '完成开发空间功能',
  });
  assert.equal(submitRes.status, 200, await submitRes.clone().text());
  const submitted = await submitRes.json();
  assert.equal(submitted.ok, true);
  assert.equal(submitted.localSaved, true);
  assert.equal(submitted.pushed, true);
  assert.ok(submitted.submissionId);
  assert.equal(
    execFileSync('git', ['rev-parse', `refs/heads/${createSpaceRes.branch}`], {
      cwd: remotePath, encoding: 'utf8',
    }).trim(),
    submitted.sourceCommit,
  );

  const submitReplay = await post(service, '/api/v1/mcp/work/submit', {
    sessionId,
    clientRequestId: 'space-submit-1',
    expectedRevision: resumed.revision,
    summary: '完成开发空间功能',
  });
  assert.deepEqual(await submitReplay.json(), submitted);

  // 12. Verify main worktree assignments still work independently
  const mainAssignRes = await post(service, `/api/v1/projects/${projectId}/assignments`, {
    clientRequestId: 'main-assign-req-1',
    agent: 'ZCode',
    mode: 'init',
    task: '主分支独立任务',
  });
  assert.equal(mainAssignRes.status, 201);
  const mainAssign = await mainAssignRes.json();
  assert.equal(mainAssign.spaceId, null);
  assert.equal(mainAssign.canonicalPath, root);

  const mainReissueRes = await post(service, `/api/v1/projects/${projectId}/assignments/reissue`, {
    clientRequestId: 'main-reissue-req-1',
    agent: 'ZCode',
  });
  assert.equal(mainReissueRes.status, 200);
  const mainReissued = await mainReissueRes.json();
  assert.equal(mainReissued.spaceId, null);
  assert.equal(mainReissued.worktreeId, mainAssign.worktreeId);

  const mainMatch = mainReissued.message.match(/initCode: "([^"]+)"/);
  assert.ok(mainMatch);
  const mainInitCode = mainMatch[1];

  const mainInitRes = await post(service, '/api/v1/mcp/work/init', {
    initCode: mainInitCode,
    clientRequestId: 'main-mcp-init',
    currentTask: '主分支独立任务',
    currentState: '主分支开始',
    mcpWorkingDirectory: root,
  });
  assert.equal(mainInitRes.status, 200);
  const mainInitialized = await mainInitRes.json();
  assert.equal(mainInitialized.status, 'active');
  assert.notEqual(mainInitialized.sessionId, sessionId);
});
