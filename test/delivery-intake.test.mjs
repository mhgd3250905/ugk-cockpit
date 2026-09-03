import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, openSync, closeSync, ftruncateSync } from 'node:fs';
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

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','pipe'] }).trim();
const TOKEN = 'delivery-test-token-xxxxxxxxxxxxxxxxxxxxxxxx';
async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-intake-test-'));
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
