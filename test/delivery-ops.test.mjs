import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  inspectDelivery,
  normalizeRemoteIdentity,
  pushDelivery,
  readDeliveryLocation,
  saveDelivery,
  validateRemoteUrlSecurity,
  verifyDeliveryRemote,
  readCommitIdentity,
  parseConflictsFromMergeTree,
  parseStatusZ,
  validateDeliveryFiles,
} from '../src/git/delivery-ops.mjs';
import { createDeliveryCache, discardDeliveryCache } from '../src/core/delivery-cache.mjs';
import { remoteAuthArguments } from '../src/git/remote-auth.mjs';

test('rename scope requires both old and new paths; owned caches cannot delete other directories', async (t) => {
  const changes = parseStatusZ('R  new.txt\0old.txt\0');
  assert.throws(() => validateDeliveryFiles(['new.txt'], changes, os.tmpdir()), { code: 'INVALID_DELIVERY_FILES' });
  assert.deepEqual(validateDeliveryFiles(['old.txt','new.txt'], changes, os.tmpdir()), ['old.txt','new.txt']);
  const cache = createDeliveryCache();
  t.after(() => discardDeliveryCache(cache));
  assert.equal(discardDeliveryCache({ ...cache, cachePath: os.tmpdir() }), false);
  assert.equal(discardDeliveryCache({ ...cache, cacheOwner: 'wrong-owner' }), false);
  assert.equal(existsSync(cache.cachePath), true);
  assert.equal(discardDeliveryCache(cache), true);
  assert.deepEqual(await remoteAuthArguments(['status'], 'win32'), []);
  assert.deepEqual(await remoteAuthArguments(['push'], 'linux'), []);
  assert.notEqual(normalizeRemoteIdentity('ssh://git@example.com/Team/Repo.git'),
    normalizeRemoteIdentity('ssh://git@example.com/team/repo.git'));
});

function gitSync(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createDeliveryFixture(t, parent = os.tmpdir()) {
  const root = mkdtempSync(path.join(parent, 'ugk-deliv-test-'));
  t.after(() => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Ignore Windows file lock cleanup race
    }
  });

  const remoteGit = path.join(root, 'remote.git');
  const targetPath = path.join(root, 'target');
  const sourcePath = path.join(root, 'source');

  // 1. Bare remote
  gitSync(root, ['init', '--bare', remoteGit]);
  gitSync(remoteGit, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  // 2. Target repo (main)
  gitSync(root, ['init', '-b', 'main', targetPath]);
  gitSync(targetPath, ['config', 'user.name', 'Target Tester']);
  gitSync(targetPath, ['config', 'user.email', 'target@test.invalid']);
  writeFileSync(path.join(targetPath, 'README.md'), '# Main Repo\nInitial line\n');
  gitSync(targetPath, ['add', 'README.md']);
  gitSync(targetPath, ['commit', '-m', 'Initial commit']);
  gitSync(targetPath, ['remote', 'add', 'origin', remoteGit]);
  gitSync(targetPath, ['push', '-u', 'origin', 'main']);

  // 3. Source repo (clone)
  gitSync(root, ['clone', '-b', 'main', remoteGit, sourcePath]);
  gitSync(sourcePath, ['config', 'user.name', 'Source Tester']);
  gitSync(sourcePath, ['config', 'user.email', 'source@test.invalid']);
  gitSync(sourcePath, ['checkout', '-b', 'feature/task-1']);

  return { root, remoteGit, targetPath, sourcePath };
}

test('selected index-only differences reuse the existing commit instead of making an empty commit', async (t) => {
  const f = createDeliveryFixture(t);
  writeFileSync(path.join(f.sourcePath,'feature.txt'),'feature\n');
  gitSync(f.sourcePath,['add','feature.txt']); gitSync(f.sourcePath,['commit','-m','feature']);
  const head = gitSync(f.sourcePath,['rev-parse','HEAD']);
  const original = readFileSync(path.join(f.sourcePath,'README.md'));
  writeFileSync(path.join(f.sourcePath,'README.md'),'staged-only\n');
  gitSync(f.sourcePath,['add','README.md']);
  writeFileSync(path.join(f.sourcePath,'README.md'),original);
  const inspection = await inspectDelivery({ ...f, files:['README.md'] });
  t.after(() => discardDeliveryCache(inspection));
  const result = await saveDelivery({sourcePath:f.sourcePath,inspection,commandId:'index-only',summary:'保存现有成果'});
  assert.equal(result.sourceCommit,head);
  assert.equal(gitSync(f.sourcePath,['status','--porcelain']),'');
});

function snapshotRepo(dirPath) {
  const head = gitSync(dirPath, ['rev-parse', 'HEAD']);
  const index = gitSync(dirPath, ['ls-files', '--stage']);
  const status = gitSync(dirPath, ['status', '--porcelain=v1']);
  return { head, index, status };
}

test('remote identity normalizes https and ssh to same repo, and handles local paths', () => {
  const httpsIdentity = normalizeRemoteIdentity('https://github.com/my-org/My-Repo.git');
  const sshIdentity = normalizeRemoteIdentity('git@github.com:my-org/My-Repo.git');
  const sshUriIdentity = normalizeRemoteIdentity('ssh://git@github.com:22/my-org/my-repo.git');
  assert.equal(httpsIdentity, 'github.com/my-org/my-repo');
  assert.equal(sshIdentity, 'github.com/my-org/my-repo');
  assert.equal(sshUriIdentity, 'github.com/my-org/my-repo');

  // Local / file paths
  const local1 = normalizeRemoteIdentity('file:///C:/test/repo.git');
  const local2 = normalizeRemoteIdentity('C:\\test\\repo.git');
  if (process.platform === 'win32') {
    assert.equal(local1, local2);
    assert.notEqual(local1, normalizeRemoteIdentity('C:\\test\\repo'));
  }

  // Reject credentials in URLs
  assert.throws(() => validateRemoteUrlSecurity('https://token:secret@github.com/org/repo.git'), {
    code: 'CREDENTIALS_IN_REMOTE_URL',
  });
  assert.throws(() => validateRemoteUrlSecurity('https://mytoken@github.com/org/repo.git'), {
    code: 'CREDENTIALS_IN_REMOTE_URL',
  });
  assert.throws(() => validateRemoteUrlSecurity('ssh://git:password@github.com/org/repo.git'), {
    code: 'CREDENTIALS_IN_REMOTE_URL',
  });
  assert.throws(() => validateRemoteUrlSecurity('ext::sh -c "echo evil"'), {
    code: 'UNSAFE_REMOTE_URL',
  });
});

test('structured conflict paths exclude explanatory text and preserve whitespace', () => {
  const hash = 'a'.repeat(40);
  assert.deepEqual(parseConflictsFromMergeTree(`${hash}\0` + `100644 ${hash} 1\t file.txt \0` +
    `100644 ${hash} 2\t file.txt \0\0` + '1\0 file.txt \0CONFLICT (modify/delete)\0Deleted in another branch.\0'), [' file.txt ']);
  for (const url of ['ftp://host/repo','gopher://host/repo','ext::whoami','--upload-pack=evil']) {
    assert.throws(() => validateRemoteUrlSecurity(url), { code: 'UNSAFE_REMOTE_URL' });
  }
});

test('author fallback reads only explicit identity keys without global includes', async (t) => {
  const { root, sourcePath } = createDeliveryFixture(t);
  gitSync(sourcePath,['config','--unset','user.name']);
  gitSync(sourcePath,['config','--unset','user.email']);
  const globalConfigPath = path.join(root,'test-global-config');
  writeFileSync(globalConfigPath,'[user]\nname = Global Test\nemail = global@test.invalid\n[include]\npath = missing-include\n');
  const identity = await readCommitIdentity(sourcePath,{globalConfigPath});
  assert.equal(identity.GIT_COMMITTER_NAME,'Global Test');
  assert.equal(identity.GIT_AUTHOR_EMAIL,'global@test.invalid');
});

test('linked worktree and cross-volume save recover index after commit without changing unrelated staging', async (t) => {
  const alternateParent = path.join(process.cwd(),'.antigravity-help-me','fixtures');
  mkdirSync(alternateParent,{recursive:true});
  const { root, targetPath } = createDeliveryFixture(t,alternateParent);
  const sourcePath = path.join(root,'linked');
  gitSync(targetPath,['worktree','list','--porcelain']);
  assert.equal(gitSync(targetPath,['status','--short']),'');
  gitSync(targetPath,['worktree','add','-b','feature/linked',sourcePath,'HEAD']);
  writeFileSync(path.join(sourcePath,'feature.txt'),'feature\r\n');
  writeFileSync(path.join(sourcePath,'unrelated.txt'),'keep staged\n');
  gitSync(sourcePath,['add','unrelated.txt']);
  const inspection = await inspectDelivery({sourcePath,targetPath,files:['feature.txt']});
  t.after(()=>discardDeliveryCache(inspection));
  const request = {sourcePath,inspection,commandId:'cross-drive-crash',summary:'保存选中文件'};
  await assert.rejects(saveDelivery({...request,afterRefUpdate:()=>{throw new Error('simulated crash after ref update');}}),error=>error.localSaved===true);
  const saved = gitSync(sourcePath,['rev-parse','HEAD']);
  const recovered = await saveDelivery(request);
  assert.equal(recovered.sourceCommit,saved);
  assert.equal(gitSync(sourcePath,['diff','--cached','--name-only']),'unrelated.txt');
  assert.equal(gitSync(sourcePath,['status','--porcelain','--','feature.txt']),'');
});

test('readDeliveryLocation returns head, branch, changes and content fingerprint', async (t) => {
  const { sourcePath } = createDeliveryFixture(t);
  writeFileSync(path.join(sourcePath, 'file1.txt'), 'content 1\n');
  gitSync(sourcePath, ['add', 'file1.txt']);
  writeFileSync(path.join(sourcePath, 'file2.txt'), 'content 2\n');

  const loc = await readDeliveryLocation(sourcePath);
  assert.ok(loc.head);
  assert.equal(loc.branch, 'feature/task-1');
  assert.equal(loc.changes.length, 2);
  assert.ok(loc.remotes.some((r) => r.name === 'origin'));
  assert.match(loc.fingerprint, /^[0-9a-f]{64}$/);
});

test('源/目标HEAD/index/工作文件预检前后不变', async (t) => {
  const { sourcePath, targetPath } = createDeliveryFixture(t);

  // Add dirty working files in source
  writeFileSync(path.join(sourcePath, 'staged.txt'), 'staged\n');
  gitSync(sourcePath, ['add', 'staged.txt']);
  writeFileSync(path.join(sourcePath, 'unstaged.txt'), 'unstaged\n');

  const sourceBefore = snapshotRepo(sourcePath);
  const targetBefore = snapshotRepo(targetPath);

  const inspection = await inspectDelivery({
    sourcePath,
    targetPath,
    files: ['unstaged.txt'],
    targetBranch: 'main',
  });

  const sourceAfter = snapshotRepo(sourcePath);
  const targetAfter = snapshotRepo(targetPath);

  assert.deepEqual(sourceBefore, sourceAfter, 'Source HEAD, index, and worktree must be unchanged');
  assert.deepEqual(targetBefore, targetAfter, 'Target HEAD, index, and worktree must be unchanged');
  assert.ok(inspection.cachePath);
});

test('clean旧分支非ff但无冲突', async (t) => {
  const { sourcePath, targetPath } = createDeliveryFixture(t);

  // Target main advances with an independent file
  writeFileSync(path.join(targetPath, 'main_update.txt'), 'main update\n');
  gitSync(targetPath, ['add', 'main_update.txt']);
  gitSync(targetPath, ['commit', '-m', 'Main update']);
  gitSync(targetPath, ['push', 'origin', 'main']);

  // Source feature branch modifies a different file
  writeFileSync(path.join(sourcePath, 'feature_file.txt'), 'feature content\n');
  gitSync(sourcePath, ['add', 'feature_file.txt']);
  gitSync(sourcePath, ['commit', '-m', 'Feature commit']);

  const inspection = await inspectDelivery({
    sourcePath,
    targetPath,
    files: [],
    targetBranch: 'main',
  });

  assert.equal(inspection.relation, 'clean');
  assert.equal(inspection.fastForward, false);
  assert.deepEqual(inspection.conflicts, []);
});

test('真实冲突', async (t) => {
  const { sourcePath, targetPath } = createDeliveryFixture(t);

  // Target main modifies README.md
  writeFileSync(path.join(targetPath, 'README.md'), '# Main Repo\nConflict from main\n');
  gitSync(targetPath, ['commit', '-am', 'Main conflicting commit']);
  gitSync(targetPath, ['push', 'origin', 'main']);

  // Source modifies same file with different content
  writeFileSync(path.join(sourcePath, 'README.md'), '# Main Repo\nConflict from feature\n');
  gitSync(sourcePath, ['commit', '-am', 'Feature conflicting commit']);

  const inspection = await inspectDelivery({
    sourcePath,
    targetPath,
    files: [],
    targetBranch: 'main',
  });

  assert.equal(inspection.relation, 'conflict');
  assert.ok(inspection.conflicts.includes('README.md'));
  assert.equal(inspection.fastForward, false);
});

test('未提交内容纳入冲突检查', async (t) => {
  const { sourcePath, targetPath } = createDeliveryFixture(t);

  // Target main modifies README.md
  writeFileSync(path.join(targetPath, 'README.md'), '# Main Repo\nTarget main edit\n');
  gitSync(targetPath, ['commit', '-am', 'Target main edit']);
  gitSync(targetPath, ['push', 'origin', 'main']);

  // Source modifies README.md in working directory WITHOUT committing
  writeFileSync(path.join(sourcePath, 'README.md'), '# Main Repo\nUncommitted source edit\n');

  const inspection = await inspectDelivery({
    sourcePath,
    targetPath,
    files: ['README.md'],
    targetBranch: 'main',
  });

  assert.equal(inspection.relation, 'conflict');
  assert.ok(inspection.conflicts.includes('README.md'));

  // Ensure source repository itself still has uncommitted change and wasn't committed
  const status = gitSync(sourcePath, ['status', '--porcelain=v1']);
  assert.ok(status.includes('README.md'));
});

test('范围外staged/unstaged保留', async (t) => {
  const { sourcePath, targetPath } = createDeliveryFixture(t);

  // 3 files:
  // 1. selected.txt (in delivery files)
  // 2. staged_other.txt (staged, not in delivery files)
  // 3. unstaged_other.txt (unstaged, not in delivery files)
  writeFileSync(path.join(sourcePath, 'selected.txt'), 'selected content\n');
  writeFileSync(path.join(sourcePath, 'staged_other.txt'), 'staged other\n');
  gitSync(sourcePath, ['add', 'staged_other.txt']);
  writeFileSync(path.join(sourcePath, 'unstaged_other.txt'), 'unstaged other\n');

  const inspection = await inspectDelivery({
    sourcePath,
    targetPath,
    files: ['selected.txt'],
    targetBranch: 'main',
  });

  const saved = await saveDelivery({
    sourcePath,
    inspection,
    commandId: 'cmd-scope-1',
    summary: 'Save selected file',
  });

  assert.ok(saved.localSaved);
  assert.ok(saved.sourceCommit);

  const statusAfter = gitSync(sourcePath, ['status', '--porcelain=v1']);
  assert.ok(statusAfter.includes('A  staged_other.txt'), 'staged_other.txt must remain staged');
  assert.ok(statusAfter.includes('?? unstaged_other.txt'), 'unstaged_other.txt must remain untracked');
  assert.ok(!statusAfter.includes('selected.txt'), 'selected.txt must be committed cleanly');

  // Verify committed tree contains selected.txt but neither other file
  const treeFiles = gitSync(sourcePath, ['ls-tree', '--name-only', 'HEAD']).split(/\r?\n/);
  assert.ok(treeFiles.includes('selected.txt'));
  assert.ok(!treeFiles.includes('staged_other.txt'));
  assert.ok(!treeFiles.includes('unstaged_other.txt'));
});

test('提交后恢复幂等', async (t) => {
  const { sourcePath, targetPath } = createDeliveryFixture(t);

  writeFileSync(path.join(sourcePath, 'feature.txt'), 'feature content\n');
  const inspection = await inspectDelivery({
    sourcePath,
    targetPath,
    files: ['feature.txt'],
    targetBranch: 'main',
  });

  const firstSave = await saveDelivery({
    sourcePath,
    inspection,
    commandId: 'cmd-idempotent-2',
    summary: 'Idempotent test',
  });

  // Second save with same commandId
  const secondSave = await saveDelivery({
    sourcePath,
    inspection,
    commandId: 'cmd-idempotent-2',
    summary: 'Idempotent test',
  });

  assert.equal(firstSave.sourceCommit, secondSave.sourceCommit);
  assert.equal(firstSave.localSaved, true);
  assert.equal(secondSave.localSaved, true);
});

test('main/detached拒绝', async (t) => {
  const { sourcePath, targetPath } = createDeliveryFixture(t);

  // Test source on main
  gitSync(sourcePath, ['checkout', 'main']);
  writeFileSync(path.join(sourcePath, 'temp.txt'), 'temp\n');
  await assert.rejects(
    () => inspectDelivery({ sourcePath, targetPath, files: ['temp.txt'], targetBranch: 'main' }),
    { code: 'SOURCE_BRANCH_MAIN' },
  );

  // Test source detached HEAD
  gitSync(sourcePath, ['checkout', '--detach']);
  await assert.rejects(
    () => inspectDelivery({ sourcePath, targetPath, files: ['temp.txt'], targetBranch: 'main' }),
    { code: 'SOURCE_BRANCH_DETACHED' },
  );
});

test('重复/已合入', async (t) => {
  const { sourcePath, targetPath } = createDeliveryFixture(t);

  // Feature branch has no net changes compared to main
  const inspection = await inspectDelivery({
    sourcePath,
    targetPath,
    files: [],
    targetBranch: 'main',
  });

  assert.equal(inspection.relation, 'already_integrated');
  assert.deepEqual(inspection.conflicts, []);
});

test('源远端领先/分叉', async (t) => {
  const { root, remoteGit, sourcePath, targetPath } = createDeliveryFixture(t);

  // First push current feature branch to remote
  gitSync(sourcePath, ['push', '-u', 'origin', 'feature/task-1']);

  // Second clone pushes an extra commit to feature/task-1
  const secondClone = path.join(root, 'secondClone');
  gitSync(root, ['clone', '-b', 'feature/task-1', remoteGit, secondClone]);
  gitSync(secondClone, ['config', 'user.name', 'Second Tester']);
  gitSync(secondClone, ['config', 'user.email', 'second@test.invalid']);
  writeFileSync(path.join(secondClone, 'extra.txt'), 'remote extra\n');
  gitSync(secondClone, ['add', 'extra.txt']);
  gitSync(secondClone, ['commit', '-m', 'Remote extra commit']);
  gitSync(secondClone, ['push', 'origin', 'feature/task-1']);

  // Source has not pulled remote commit: remote is ahead
  await assert.rejects(
    () => inspectDelivery({ sourcePath, targetPath, files: [], targetBranch: 'main' }),
    { code: 'REMOTE_SOURCE_AHEAD' },
  );
});

test('敏感文件', async (t) => {
  const { sourcePath, targetPath } = createDeliveryFixture(t);

  writeFileSync(path.join(sourcePath, '.env'), 'SECRET=123\n');
  writeFileSync(path.join(sourcePath, 'id_rsa'), 'PRIVATE KEY\n');
  writeFileSync(path.join(sourcePath, 'server.key'), 'KEY\n');

  await assert.rejects(
    () => inspectDelivery({ sourcePath, targetPath, files: ['.env'], targetBranch: 'main' }),
    { code: 'SENSITIVE_FILE_REJECTED' },
  );
  await assert.rejects(
    () => inspectDelivery({ sourcePath, targetPath, files: ['id_rsa'], targetBranch: 'main' }),
    { code: 'SENSITIVE_FILE_REJECTED' },
  );
  await assert.rejects(
    () => inspectDelivery({ sourcePath, targetPath, files: ['server.key'], targetBranch: 'main' }),
    { code: 'SENSITIVE_FILE_REJECTED' },
  );
});

test('内容变但status相同', async (t) => {
  const { sourcePath, targetPath } = createDeliveryFixture(t);

  writeFileSync(path.join(sourcePath, 'work.txt'), 'initial version\n');
  const inspection = await inspectDelivery({
    sourcePath,
    targetPath,
    files: ['work.txt'],
    targetBranch: 'main',
  });

  // Mutate file content while status remains modified
  writeFileSync(path.join(sourcePath, 'work.txt'), 'tampered version\n');

  await assert.rejects(
    () => saveDelivery({ sourcePath, inspection, commandId: 'cmd-tamper', summary: 'Tampered' }),
    { code: 'SOURCE_CONTENT_CHANGED' },
  );
});

test('目标前进', async (t) => {
  const { sourcePath, targetPath } = createDeliveryFixture(t);

  writeFileSync(path.join(sourcePath, 'feature.txt'), 'feature\n');
  const inspection = await inspectDelivery({
    sourcePath,
    targetPath,
    files: ['feature.txt'],
    targetBranch: 'main',
  });

  const saved = await saveDelivery({
    sourcePath,
    inspection,
    commandId: 'cmd-target-advance',
    summary: 'Target advance feature',
  });

  await pushDelivery({
    sourcePath,
    inspection,
    sourceCommit: saved.sourceCommit,
  });

  // Target main pushes a new commit
  writeFileSync(path.join(targetPath, 'main_adv.txt'), 'advanced\n');
  gitSync(targetPath, ['add', 'main_adv.txt']);
  gitSync(targetPath, ['commit', '-m', 'Main advanced']);
  gitSync(targetPath, ['push', 'origin', 'main']);

  // verifyDeliveryRemote should detect that remote target HEAD has changed
  await assert.rejects(
    () => verifyDeliveryRemote({ sourcePath, inspection, sourceCommit: saved.sourceCommit }),
    { code: 'REMOTE_TARGET_CHANGED' },
  );
});

test('pushDelivery and verifyDeliveryRemote succeed and tolerate local main dirty changes', async (t) => {
  const { sourcePath, targetPath } = createDeliveryFixture(t);

  writeFileSync(path.join(sourcePath, 'delivery.txt'), 'delivery content\n');
  const inspection = await inspectDelivery({
    sourcePath,
    targetPath,
    files: ['delivery.txt'],
    targetBranch: 'main',
  });

  const saved = await saveDelivery({
    sourcePath,
    inspection,
    commandId: 'cmd-push-test',
    summary: 'Push test',
  });

  const pushed = await pushDelivery({
    sourcePath,
    inspection,
    sourceCommit: saved.sourceCommit,
  });
  assert.equal(pushed.pushed, true);

  // Calling pushDelivery again reuses remote
  const pushedAgain = await pushDelivery({
    sourcePath,
    inspection,
    sourceCommit: saved.sourceCommit,
  });
  assert.equal(pushedAgain.pushed, true);

  // Remote verification succeeds
  const verified = await verifyDeliveryRemote({
    sourcePath,
    inspection,
    sourceCommit: saved.sourceCommit,
  });
  assert.equal(verified.ok, true);

  // Dirty uncommitted changes on target local main do NOT block delivery verification
  writeFileSync(path.join(targetPath, 'local_dirty.txt'), 'dirty on main\n');
  const verifiedWithDirtyMain = await verifyDeliveryRemote({
    sourcePath,
    inspection,
    sourceCommit: saved.sourceCommit,
  });
  assert.equal(verifiedWithDirtyMain.ok, true);
});

test('files parameter rejects invalid inputs, traversal, pathspec magic, and non-change paths', async (t) => {
  const { sourcePath, targetPath } = createDeliveryFixture(t);
  writeFileSync(path.join(sourcePath, 'valid.txt'), 'valid\n');

  await assert.rejects(
    () => inspectDelivery({ sourcePath, targetPath, files: ['../outside.txt'], targetBranch: 'main' }),
    { code: 'INVALID_DELIVERY_FILES' },
  );
  await assert.rejects(
    () => inspectDelivery({ sourcePath, targetPath, files: ['*magic.txt'], targetBranch: 'main' }),
    { code: 'INVALID_DELIVERY_FILES' },
  );
  await assert.rejects(
    () => inspectDelivery({ sourcePath, targetPath, files: ['nonexistent.txt'], targetBranch: 'main' }),
    { code: 'INVALID_DELIVERY_FILES' },
  );
  await assert.rejects(
    () => inspectDelivery({ sourcePath, targetPath, files: [path.resolve(sourcePath, 'valid.txt')], targetBranch: 'main' }),
    { code: 'INVALID_DELIVERY_FILES' },
  );
});
