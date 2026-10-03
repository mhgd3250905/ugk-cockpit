import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync, mkdtempSync, renameSync, rmSync, writeFileSync, readFileSync, openSync, closeSync, ftruncateSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject, worktreeIdFor } from '../src/core/projects.mjs';
import { registerDeliveryLocation } from '../src/core/delivery-sources.mjs';
import { prepareDelivery, submitDelivery } from '../src/core/delivery-service.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import { verifyReviewDelivery } from '../src/core/delivery-review.mjs';
import { readSubmission } from '../src/core/integrations.mjs';
import { readProjectContext } from '../src/core/projects.mjs';
import { appendProgressEvent } from '../src/core/assignments.mjs';
import { deliveryResponse } from '../src/core/delivery-messages.mjs';
import { discardDeliveryCache } from '../src/core/delivery-cache.mjs';

// Fixture git must observe the same config contract as the product
// (safeGitEnvironment strips system/global git config): a runner whose ambient
// core.autocrlf smudges checkouts leaves phantom modifications that only the
// product's no-config git can see, which showed up as the delivery change count
// being one too high. This file was missed by that isolation pass.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';

// POSIX 的系统临时目录（/tmp、/var）本身是符号链接；产品路径授权按契约拒绝
// 穿越链接的路径，夹具必须建立在真实路径下，否则授权在业务断言前就失败。
function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','pipe'] }).trim();
const TOKEN = 'delivery-test-token-xxxxxxxxxxxxxxxxxxxxxxxx';
async function fixture(t) {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-intake-test-'));
  const main = path.join(root, 'main');
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  git(root, ['init','--bare',remote]);
  git(root, ['init','-b','main',main]);
  for (const [key,value] of [['user.name','Test'],['user.email','test@example.invalid']]) git(main,['config',key,value]);
  writeFileSync(path.join(main,'README.md'),'seed\n');
  git(main,['add','.']); git(main,['commit','-m','seed']);
  git(main,['remote','add','origin',remote]); git(main,['push','origin','main']);
  git(root,['clone','-b','main',remote,source]); git(source,['switch','-c','feature/external']);
  for (const [key,value] of [['user.name','Test'],['user.email','test@example.invalid']]) git(source,['config',key,value]);
  const dbPath = path.join(root,'state.db');
  const db = openCockpitDatabase(dbPath);
  const registered = registerProject(db,{commandId:'register',name:'Fixture',authorizedRoot:main,observation:await probeGitWorktree(main)});
  const closers = [];
  t.after(async () => { for (const close of closers) await close(); db.close(); rmSync(root,{recursive:true,force:true}); });
  const register = async () => registerDeliveryLocation(db,{observation:await probeGitWorktree(source),authorizedRoot:source});
  const preflight = async (files, commandId='preflight') => {
    const registration = await register();
    return prepareDelivery(db,{commandId,sourceId:registration.id,...(files === undefined ? {} : {files})});
  };
  const submit = (preflightId, commandId='submit', options={}) => submitDelivery(db,{commandId,preflightId,summary:'完成外部分支任务',mcpWorkingDirectory:source},options);
  return {root,main,source,remote,dbPath,db,projectId:registered.projectId,preflight,submit,register,closers};
}

// Reuse the intake fixture to exercise both the real HTTP renderer and the
// durable core review/merge requests. Source availability is controlled only by
// renaming a separate, script-owned local bare remote; the main remote stays up.
async function integrationFixture(t, options = {}) {
  const f = await fixture(t);
  const fork = path.join(f.root, 'fork.git');
  git(f.root, ['clone', '--bare', f.remote, fork]);
  git(f.source, ['remote', 'set-url', 'origin', fork]);
  git(f.source, ['remote', 'add', 'upstream', f.remote]);
  writeFileSync(path.join(f.source, 'feature.txt'), 'feature\n');
  const preflight = await f.preflight(['feature.txt']);
  assert.equal(preflight.ready, true, JSON.stringify(preflight));
  const submitted = await f.submit(preflight.preflightId);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(git(fork, ['rev-parse', 'refs/heads/feature/external']), submitted.sourceCommit);

  const observation = await probeGitWorktree(f.main);
  const sessionId = 'session-main';
  const worktreeId = worktreeIdFor(observation.worktreeIdentity);
  const createdAt = new Date().toISOString();
  f.db.prepare(`INSERT INTO assignments (
    id,project_id,worktree_id,agent_id,task_id,scope_json,status,revision,session_id,created_at,updated_at
  ) VALUES ('assignment-main',?,?,'Codex','review fixture','{"mode":"write"}','active',1,?,?,?)`)
    .run(f.projectId, worktreeId, sessionId, createdAt, createdAt);
  const started = startWriteRun(f.db, {
    commandId: 'start-main', runId: sessionId, worktreeId,
    canonicalPath: observation.canonicalPath, repositoryIdentity: observation.repositoryIdentity,
    worktreeIdentity: observation.worktreeIdentity, agentClaim: 'Codex', goal: 'review fixture',
    baseline: { ...observation.after, coherence: observation.coherence, observedAt: observation.observedAt },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const activated = appendProgressEvent(f.db, {
    sessionId, clientRequestId: 'activate-main', expectedRevision: 1, status: 'active', summary: 'review fixture',
  });
  assert.equal(activated.ok, true, JSON.stringify(activated));
  const service = await createCockpitHttpServer({ dbPath: f.dbPath, token: TOKEN, ...options });
  f.closers.push(() => service.close());
  const post = async (route, body) => {
    const response = await fetch(`http://${service.host}:${service.port}${route}`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const session = { sessionId, expectedRevision: activated.revision, submissionId: submitted.submissionId };
  const claimed = await post('/api/v1/mcp/integration/begin', {
    ...session, clientRequestId: 'begin', expectedSubmissionRevision: 0,
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const cache = readSubmission(f.db, submitted.submissionId).delivery.reviewCache;
  f.closers.push(() => discardDeliveryCache(cache));
  const reviewRequest = {
    ...session, claimId: claimed.body.claimId, expectedClaimRevision: claimed.body.claimRevision,
    verdict: 'approved', summary: 'fixture review', findings: [], checks: ['real local bare remote'],
  };
  const sourceAvailability = (available) => {
    const offline = path.join(f.root, 'fork-offline.git');
    for (const endpoint of [fork, offline]) {
      assert.equal(path.dirname(path.resolve(endpoint)), path.resolve(f.root));
    }
    renameSync(available ? offline : fork, available ? fork : offline);
  };
  return { ...f, fork, post, session, reviewRequest, submitted, sourceAvailability };
}

test('no-init independent clone is scoped, saved, pushed and deduplicated without a fake session', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.source,'feature.txt'),'feature\n');
  writeFileSync(path.join(f.source,'other.txt'),'not this task\n');
  git(f.source,['add','other.txt']);
  const discovery = await f.preflight();
  assert.equal(discovery.code,'DELIVERY_SCOPE_REQUIRED');
  assert.equal(discovery.changes.length,2);
  const [preflight, concurrentPreflight] = await Promise.all([f.preflight(['feature.txt'],'selected'), f.preflight(['feature.txt'],'selected')]);
  assert.deepEqual(concurrentPreflight, preflight);
  assert.equal(preflight.ready,true,JSON.stringify(preflight));
  assert.equal(git(f.source,['log','--format=%s','-1']),'seed');
  const [result, concurrentSubmit] = await Promise.all([f.submit(preflight.preflightId), f.submit(preflight.preflightId)]);
  assert.deepEqual(concurrentSubmit, result);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(git(f.remote,['rev-parse','refs/heads/feature/external']),result.sourceCommit);
  assert.equal(git(f.source,['diff','--cached','--name-only']),'other.txt');
  assert.equal(readFileSync(path.join(f.source,'other.txt'),'utf8'),'not this task\n');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n,0);
  assert.deepEqual(await f.submit(preflight.preflightId),result);
  const duplicate = await f.preflight([],'duplicate');
  assert.equal(duplicate.code,'DELIVERY_ALREADY_SUBMITTED',JSON.stringify(duplicate));
  assert.equal(duplicate.submissionId,result.submissionId);
  writeFileSync(path.join(f.source,'feature.txt'),'feature v2\n');
  const next = await f.preflight(['feature.txt'],'next');
  assert.equal(next.ready,true,JSON.stringify(next));
  const second = await f.submit(next.preflightId,'submit-next');
  assert.equal(second.ok,true,JSON.stringify(second));
  assert.equal(second.deliveryVersion,2);
  assert.equal(readSubmission(f.db,result.submissionId).status,'stale');
});

test('content changes with identical status and expired preflight stop before a commit', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.source,'README.md'),'one\n');
  const checked = await f.preflight(['README.md']);
  assert.equal(checked.ready,true,JSON.stringify(checked));
  writeFileSync(path.join(f.source,'README.md'),'two\n');
  const result = await f.submit(checked.preflightId);
  assert.equal(result.ok,false);
  assert.equal(result.localSaved,false);
  assert.equal(git(f.source,['log','--format=%s','-1']),'seed');
  const expired = await f.preflight(['README.md'],'expired');
  f.db.prepare('UPDATE delivery_preflights SET expires_at = 0 WHERE id = ?').run(expired.preflightId);
  assert.equal((await f.submit(expired.preflightId,'expire-submit')).code,'DELIVERY_PREFLIGHT_EXPIRED');
});

test('push failure recovers the same saved commit and preserves truthful partial state', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.source,'feature.txt'),'feature\n');
  const checked = await f.preflight(['feature.txt']);
  const failed = await f.submit(checked.preflightId,'push-retry',{push:async()=>{throw Object.assign(new Error('offline'),{code:'PUSH_OFFLINE'});}});
  assert.equal(failed.localSaved,true,JSON.stringify(failed)); assert.equal(failed.pushed,false);
  const saved = git(f.source,['rev-parse','HEAD']);
  const result = await f.submit(checked.preflightId,'push-retry');
  assert.equal(result.ok,true,JSON.stringify(result)); assert.equal(result.sourceCommit,saved);
  assert.equal(git(f.source,['rev-list','--count','HEAD']),'2');
});

test('credentials rejected after a real push preserve upload facts and resume the original delivery', async (t) => {
  const f = await fixture(t);
  const registration = await f.register();
  writeFileSync(path.join(f.source, 'feature.txt'), 'feature\n');
  git(f.source, ['remote', 'set-url', 'origin', 'https://user:fixture@example.invalid/repo.git']);
  const blockedPreflight = await prepareDelivery(f.db, {
    commandId: 'credentials-before-save', sourceId: registration.id, files: ['feature.txt'],
  });
  assert.equal(blockedPreflight.code, 'CREDENTIALS_IN_REMOTE_URL', JSON.stringify(blockedPreflight));
  assert.equal(blockedPreflight.localSaved, false);
  assert.equal(blockedPreflight.pushed, false);
  assert.match(deliveryResponse(blockedPreflight).required_action, /新的请求号重新预检/);
  assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/feature/external']), '');
  git(f.source, ['remote', 'set-url', 'origin', f.remote]);
  const checked = await f.preflight(['feature.txt'], 'credentials-preflight-fresh');
  assert.equal(checked.ready, true, JSON.stringify(checked));
  let actualRemoteCommit;
  const partial = await f.submit(checked.preflightId, 'credentials-after-push', {
    faultInjector(stage) {
      if (stage !== 'after_delivery_push') return;
      actualRemoteCommit = git(f.remote, ['rev-parse', 'refs/heads/feature/external']);
      assert.equal(actualRemoteCommit, git(f.source, ['rev-parse', 'HEAD']));
      // The validator rejects this fixture URL before any external connection.
      git(f.source, ['remote', 'set-url', 'origin', 'https://user:fixture@example.invalid/repo.git']);
    },
  });
  assert.equal(partial.code, 'CREDENTIALS_IN_REMOTE_URL', JSON.stringify(partial));
  assert.equal(partial.localSaved, true);
  assert.equal(partial.pushed, true);
  assert.equal(partial.sourceCommit, actualRemoteCommit);
  assert.equal(partial.retryable, true);
  assert.equal(partial.requiresNewPreflight, false);
  const rendered = deliveryResponse(partial);
  assert.match(rendered.impact, /代码已上传/);
  assert.match(rendered.required_action, /原请求恢复送审/);
  assert.doesNotMatch(rendered.required_action, /没有上传任何代码|新的请求号/);
  git(f.source, ['remote', 'set-url', 'origin', f.remote]);
  const recovered = await f.submit(checked.preflightId, 'credentials-after-push');
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.sourceCommit, actualRemoteCommit);
  assert.equal(git(f.remote, ['rev-parse', 'refs/heads/feature/external']), actualRemoteCommit);
  assert.equal(git(f.source, ['rev-list', '--count', 'HEAD']), '2');
});

test('unknown and ambiguous projects are not guessed, and fork delivery keeps its own push destination', async (t) => {
  const f = await fixture(t);
  const fork = path.join(f.root, 'fork.git');
  git(f.root, ['clone','--bare',f.remote,fork]);
  git(f.source, ['remote','set-url','origin',fork]);
  await assert.rejects(f.register(), { code: 'PROJECT_NOT_FOUND' });
  git(f.source, ['remote','add','upstream',f.remote]);
  writeFileSync(path.join(f.source,'feature.txt'),'fork feature\n');
  const checked = await f.preflight(['feature.txt']);
  assert.equal(checked.ready,true,JSON.stringify(checked));
  const wrongCwd = await submitDelivery(f.db,{commandId:'wrong-cwd',preflightId:checked.preflightId,
    summary:'wrong cwd',mcpWorkingDirectory:f.main});
  assert.equal(wrongCwd.code,'DELIVERY_DIRECTORY_MISMATCH');
  const submitted = await f.submit(checked.preflightId);
  assert.equal(submitted.ok,true,JSON.stringify(submitted));
  assert.equal(git(fork,['rev-parse','refs/heads/feature/external']),submitted.sourceCommit);
  assert.equal(git(f.remote,['for-each-ref','--format=%(refname)','refs/heads/feature/external']),'');
  const mainCopy = path.join(f.root,'main-copy');
  git(f.root,['clone','-b','main',f.remote,mainCopy]);
  registerProject(f.db,{commandId:'register-copy',name:'Duplicate',authorizedRoot:mainCopy,observation:await probeGitWorktree(mainCopy)});
  await assert.rejects(f.register(), { code: 'DELIVERY_PROJECT_AMBIGUOUS' });
});

test('receipt and command complete atomically and replay survives subsequent remote updates', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.source,'feature.txt'),'feature\n');
  const checked = await f.preflight(['feature.txt']);
  const result = await f.submit(checked.preflightId,'receipt-crash',{
    faultInjector: async (stage) => { if (stage === 'after_delivery_receipt') throw new Error('lost response'); },
  });
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(f.db.prepare('SELECT state FROM commands WHERE id = ?').get('receipt-crash').state,'committed');
  writeFileSync(path.join(f.main,'later.txt'),'later\n');
  git(f.main,['add','later.txt']); git(f.main,['commit','-m','advance target']); git(f.main,['push','origin','main']);
  assert.deepEqual(await f.submit(checked.preflightId,'receipt-crash'),result);
});

test('target identity drift during upload recovery cannot redirect a prior delivery', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.source,'feature.txt'),'feature\n');
  const checked = await f.preflight(['feature.txt']);
  const partial = await f.submit(checked.preflightId,'target-identity',{
    push: async () => { throw Object.assign(new Error('offline'),{code:'PUSH_OFFLINE'}); },
  });
  assert.equal(partial.localSaved,true);
  const otherRemote = path.join(f.root,'other.git');
  git(f.root,['clone','--bare',f.remote,otherRemote]);
  git(f.main,['remote','set-url','origin',otherRemote]);
  const denied = await f.submit(checked.preflightId,'target-identity');
  assert.equal(denied.ok,false);
  assert.equal(denied.code,'DELIVERY_REMOTE_CHANGED');
  assert.equal(denied.requiresNewPreflight,true);
  assert.equal(git(f.source,['rev-parse','HEAD']),partial.sourceCommit);
});

test('unknown active writer is never taken over; published clean source can be registered read-only', async (t) => {
  const f = await fixture(t);
  const source = await f.register();
  const observation = await probeGitWorktree(f.source);
  const run = startWriteRun(f.db,{commandId:'writer',runId:'other-writer',worktreeId:source.worktree_id,
    canonicalPath:f.source,repositoryIdentity:observation.repositoryIdentity,worktreeIdentity:observation.worktreeIdentity,
    agentClaim:'Other',goal:'Other work',baseline:{...observation.after,coherence:'coherent',observedAt:observation.observedAt}});
  assert.equal(run.ok,true);
  writeFileSync(path.join(f.source,'feature.txt'),'feature\n');
  const denied = await f.preflight(['feature.txt']);
  assert.equal(denied.code,'DELIVERY_WRITE_LEASE_CONFLICT',JSON.stringify(denied));
  git(f.source,['add','feature.txt']); git(f.source,['commit','-m','external author']); git(f.source,['push','origin','HEAD']);
  const checked = await f.preflight([],'published');
  assert.equal(checked.ready,true,JSON.stringify(checked));
  const result = await f.submit(checked.preflightId);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(f.db.prepare('SELECT run_id FROM write_leases WHERE worktree_id = ?').get(source.worktree_id).run_id,'other-writer');
});

test('conflicts require explicit confirmation and never become ready-to-merge tasks', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.main,'README.md'),'main changed\n'); git(f.main,['commit','-am','main change']); git(f.main,['push','origin','main']);
  writeFileSync(path.join(f.source,'README.md'),'source changed\n');
  const checked = await f.preflight(['README.md']);
  assert.equal(checked.relation,'conflict',JSON.stringify(checked));
  const denied = await f.submit(checked.preflightId);
  assert.equal(denied.code,'DELIVERY_CONFLICT_CONFIRMATION_REQUIRED');
  const accepted = await submitDelivery(f.db,{commandId:'conflict-confirmed',preflightId:checked.preflightId,
    summary:'先保存冲突成果',mcpWorkingDirectory:f.source,allowConflicts:true});
  assert.equal(accepted.ok,true,JSON.stringify(accepted)); assert.equal(accepted.status,'conflict');
});

test('HTTP late intake requires explicit picker authorization and copies a fixed-version main task', async (t) => {
  const f = await fixture(t);
  let picks = 0;
  const service = await createCockpitHttpServer({dbPath:f.dbPath,token:TOKEN,folderPicker:async()=>{picks++;return f.source;}});
  f.closers.push(()=>service.close());
  const post = async (endpoint,body) => (await fetch(`http://${service.host}:${service.port}${endpoint}`,{
    method:'POST',headers:{authorization:`Bearer ${TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body),
  })).json();
  writeFileSync(path.join(f.source,'feature.txt'),'feature\n');
  const body = {clientRequestId:'http-check',mcpWorkingDirectory:f.source,files:['feature.txt']};
  const unauthorized = await post('/api/v1/mcp/work/submit/preflight',body);
  assert.equal(unauthorized.code,'DELIVERY_FOLDER_REQUIRED'); assert.equal(picks,0);
  const checked = await post('/api/v1/mcp/work/submit/preflight',{...body,selectFolder:true});
  assert.equal(checked.ready,true,JSON.stringify(checked)); assert.equal(picks,1);
  const result = await post('/api/v1/mcp/work/submit',{preflightId:checked.preflightId,clientRequestId:'http-submit',
    summary:'HTTP 分支交付',mcpWorkingDirectory:f.source});
  assert.equal(result.ok,true,JSON.stringify(result));
  const detail = await (await fetch(`http://${service.host}:${service.port}/api/v1/projects/${f.projectId}`,{headers:{authorization:`Bearer ${TOKEN}`}})).json();
  assert.equal(detail.submissions.length,1);
  assert.ok(detail.submissions[0].reviewPrompt.includes(result.sourceCommit));
  assert.ok(detail.submissions[0].reviewPrompt.includes('明确要求合并'));
  assert.ok(!detail.submissions[0].reviewPrompt.includes(f.source));
});

test('remote target advancement invalidates review without disturbing dirty main', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.source,'feature.txt'),'feature\n');
  const checked = await f.preflight(['feature.txt']);
  const result = await f.submit(checked.preflightId);
  assert.equal(result.ok,true,JSON.stringify(result));
  writeFileSync(path.join(f.main,'local-only.txt'),'main work in progress\n');
  const review = await verifyReviewDelivery(readSubmission(f.db,result.submissionId),readProjectContext(f.db,f.projectId),{prepare:true});
  assert.ok(review.repository);
  assert.equal(readFileSync(path.join(f.main,'local-only.txt'),'utf8'),'main work in progress\n');
  git(f.main,['add','local-only.txt']); git(f.main,['commit','-m','advance main']); git(f.main,['push','origin','main']);
  await assert.rejects(verifyReviewDelivery(readSubmission(f.db,result.submissionId),readProjectContext(f.db,f.projectId)),{code:'TARGET_HEAD_STALE'});
});

test('intake succeeds when main has untracked files >128MiB; oversize selected file returns error details to client', async (t) => {
  const f = await fixture(t);

  // 1. Untracked file in main >128MiB (sparse file)
  const mainHuge = path.join(f.main, 'untracked_huge.bin');
  const fdMain = openSync(mainHuge, 'w');
  ftruncateSync(fdMain, 140 * 1024 * 1024);
  closeSync(fdMain);

  // 2. Commit a feature in source, and leave an unselected untracked file in source >128MiB
  const sourceHuge = path.join(f.source, 'source_huge.bin');
  const fdSource = openSync(sourceHuge, 'w');
  ftruncateSync(fdSource, 140 * 1024 * 1024);
  closeSync(fdSource);

  writeFileSync(path.join(f.source, 'feature.txt'), 'feature content\n');
  git(f.source, ['add', 'feature.txt']);
  git(f.source, ['commit', '-m', 'feat: add feature']);

  // Preflight with files: [] (submitted committed branch) must succeed despite main and source untracked >128MiB
  const preflightHead = await f.preflight([], 'preflight-head');
  assert.equal(preflightHead.ok, true, JSON.stringify(preflightHead));
  assert.equal(preflightHead.ready, true);

  const submitHead = await f.submit(preflightHead.preflightId, 'submit-head');
  assert.equal(submitHead.ok, true, JSON.stringify(submitHead));

  // 3. Selecting the oversize file returns DELIVERY_CONTENT_TOO_LARGE with structured details
  const preflightOversize = await f.preflight(['source_huge.bin'], 'preflight-oversize');
  assert.equal(preflightOversize.ok, false);
  assert.equal(preflightOversize.code, 'DELIVERY_CONTENT_TOO_LARGE');
  assert.equal(preflightOversize.details?.file, 'source_huge.bin');
  assert.equal(preflightOversize.details?.limitBytes, 32 * 1024 * 1024);
  assert.equal(preflightOversize.details?.actualBytes, 140 * 1024 * 1024);
});

test('a corrupt retained preflight row cannot wedge future preflights', async (t) => {
  const f = await fixture(t);
  const registration = await f.register();
  // 模拟外部损坏/遗留脏行：过期的 inspection_json 不是合法 JSON。
  const nowIso = new Date().toISOString();
  f.db.prepare(`INSERT INTO commands (id,kind,request_digest,request_json,state,created_at,updated_at)
    VALUES ('corrupt-cmd','delivery.preflight','x','{}','failed',?,?)`).run(nowIso, nowIso);
  f.db.prepare(`INSERT INTO delivery_preflights
    (id,command_id,source_id,session_id,session_revision,inspection_json,created_at,expires_at)
    VALUES ('corrupt-row','corrupt-cmd',?,NULL,NULL,'{not-json',?,?)`)
    .run(registration.id, nowIso, Date.now() - 1);

  writeFileSync(path.join(f.source, 'feature.txt'), 'feature\n');
  const result = await f.preflight(['feature.txt'], 'after-poison');
  assert.equal(result.ready, true, JSON.stringify(result));
  const submit = await f.submit(result.preflightId);
  assert.equal(submit.ok, true, JSON.stringify(submit));
});

test('HTTP review reference failure guides a new request while the original replays its fixed failure', async (t) => {
  const f = await integrationFixture(t);
  const request = { ...f.reviewRequest, clientRequestId: 'review-original' };
  f.sourceAvailability(false);
  const failed = await f.post('/api/v1/mcp/integration/review', request);
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.code, 'DELIVERY_REVIEW_REF_UNAVAILABLE');
  assert.match(failed.body.required_action, /新的 clientRequestId/);
  assert.doesNotMatch(failed.body.required_action, /同一个操作编号继续/);
  const command = f.db.prepare("SELECT id,state FROM commands WHERE kind = 'integration.review'").get();
  assert.equal(command.state, 'failed');
  f.sourceAvailability(true);
  const healthy = await verifyReviewDelivery(readSubmission(f.db, f.submitted.submissionId), readProjectContext(f.db, f.projectId));
  assert.equal(healthy.sourceHead, f.submitted.sourceCommit);
  const replay = await f.post('/api/v1/mcp/integration/review', request);
  assert.equal(replay.body.code, failed.body.code);
  assert.equal(replay.body.required_action, failed.body.required_action);
  assert.equal(f.db.prepare('SELECT state FROM commands WHERE id = ?').get(command.id).state, 'failed');
  const reviewed = await f.post('/api/v1/mcp/integration/review', { ...request, clientRequestId: 'review-fresh' });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.verdict, 'approved');
  assert.equal(f.db.prepare("SELECT state FROM commands WHERE kind = 'integration.review' AND id != ?").get(command.id).state, 'committed');
  assert.equal(git(f.main, ['rev-parse', 'HEAD']), f.submitted.targetHead);
});

test('HTTP merge reference failure preserves a prior local fast-forward and guides the original request', async (t) => {
  let fastForwards = 0;
  const f = await integrationFixture(t, {
    faultInjector(stage) {
      if (stage !== 'after_fast_forward_before_persist') return;
      fastForwards++;
      if (fastForwards === 1) throw new Error('fixture interruption before persistence');
    },
  });
  const reviewed = await f.post('/api/v1/mcp/integration/review', { ...f.reviewRequest, clientRequestId: 'review' });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const request = {
    ...f.session, claimId: reviewed.body.claimId,
    expectedClaimRevision: reviewed.body.claimRevision,
    expectedSubmissionRevision: reviewed.body.submissionRevision,
    clientRequestId: 'merge-original', summary: 'merge fixture',
  };
  await f.post('/api/v1/mcp/integration/merge', request);
  assert.equal(git(f.main, ['rev-parse', 'HEAD']), f.submitted.sourceCommit);
  assert.equal(git(f.remote, ['rev-parse', 'refs/heads/main']), f.submitted.targetHead);
  assert.equal(f.db.prepare('SELECT state FROM integration_attempts').get().state, 'prepared');
  f.sourceAvailability(false);
  const failed = await f.post('/api/v1/mcp/integration/merge', request);
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.code, 'DELIVERY_REVIEW_REF_UNAVAILABLE');
  assert.match(failed.body.impact, /主项目分支可能已经前进/);
  assert.doesNotMatch(failed.body.impact, /没有修改任何项目的代码/);
  assert.match(failed.body.required_action, /同一个操作编号继续/);
  assert.doesNotMatch(failed.body.required_action, /新的 clientRequestId/);
  f.sourceAvailability(true);
  const recovered = await f.post('/api/v1/mcp/integration/merge', request);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.pushed, true);
  assert.equal(fastForwards, 1);
  assert.equal(git(f.main, ['rev-parse', 'HEAD']), f.submitted.sourceCommit);
  assert.equal(git(f.remote, ['rev-parse', 'refs/heads/main']), f.submitted.sourceCommit);
});
