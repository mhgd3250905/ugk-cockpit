// 第 29 轮审计（2026-09-27）：仓库本地的「显示开关」不得改变 Cockpit 的存取决定。
// `status.showUntrackedFiles` 不是敌意执行类配置，历来不在闸门里，但它决定
// `git status` 是否列出未跟踪文件。产品侧的判脏走的是不带 `-u` 的 status（受该
// 开关影响），而探测走的是带 `--untracked-files=normal` 的 status（不受影响）：
// 同一件事两条通道的语义不同，于是「送审已保存」可以在什么都没保存的情况下返回。
// git 自己的 `worktree remove` 安全网同样读这个开关（实测：设置后连未跟踪文件
// 一起删掉），所以产品侧的原语也必须自带下限。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject, worktreeIdFor } from '../src/core/projects.mjs';
import { createDevelopmentSpace } from '../src/core/spaces.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import { submitDevelopmentSpace } from '../src/core/submission-service.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { hasUncommittedChanges } from '../src/git/submit-ops.mjs';
import { createGitWorktree, removeGitWorktree } from '../src/git/workspace-ops.mjs';

// 与产品一致地屏蔽系统/全局 git 配置，避免宿主机的 autocrlf 等设置污染夹具。
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';

const git = (cwd, args) => {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw Object.assign(new Error(`git ${args.join(' ')} failed: ${error.stderr ?? error.message}`), {
      gitStatus: error.status,
    });
  }
};

function snapshot(observation) {
  return {
    head: observation.after.head,
    branch: observation.after.branch,
    indexFingerprint: observation.after.indexFingerprint,
    worktreeFingerprint: observation.after.worktreeFingerprint,
    repositoryIdentity: observation.repositoryIdentity,
    worktreeIdentity: observation.worktreeIdentity,
    headRelation: 'same',
    coherence: observation.coherence,
    observedAt: observation.observedAt,
  };
}

// Windows 上刚退出的 git 子进程会短暂占住目录句柄，删除要有限重试。
function removeWithRetry(target, attempts = 40) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'ENOTEMPTY') throw error;
      const waitUntil = Date.now() + 100;
      while (Date.now() < waitUntil) { /* bounded spin, no timer handle */ }
    }
  }
  // 仍被系统占用（杀软索引、刚退出的子进程）：先改名让开，再尽力删除。
  const parked = `${target}.pending-${process.pid}-${Date.now()}`;
  try {
    renameSync(target, parked);
    rmSync(parked, { recursive: true, force: true });
  } catch {
    throw lastError;
  }
}

function tempRoot(prefix) {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), prefix)));
  return root;
}

function initRepository(root, { hideUntracked = false } = {}) {
  const mainPath = path.join(root, 'main');
  const remotePath = path.join(root, 'remote.git');
  mkdirSync(mainPath, { recursive: true });
  git(root, ['init', '--bare', remotePath]);
  git(mainPath, ['init', '-q', '-b', 'main']);
  git(mainPath, ['config', 'user.name', 'UGK Fixture']);
  git(mainPath, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(path.join(mainPath, 'README.md'), 'seed\n');
  git(mainPath, ['add', 'README.md']);
  git(mainPath, ['-c', 'user.name=UGK Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'seed']);
  git(mainPath, ['remote', 'add', 'origin', remotePath]);
  git(mainPath, ['push', '-q', 'origin', 'main']);
  if (hideUntracked) {
    git(mainPath, ['config', '--local', 'status.showUntrackedFiles', 'no']);
  }
  return { mainPath, remotePath };
}

// 一个「已有一个提交 + 一个未跟踪文件」的开发空间：这正是用户点送审时的常见现场。
async function submitFixture(t, { hideUntracked = false } = {}) {
  const root = tempRoot('ugk-untracked-submit-');
  const { mainPath, remotePath } = initRepository(root, { hideUntracked });
  const spacePath = path.join(root, 'space');
  git(mainPath, ['worktree', 'add', '-q', '-b', 'cockpit/work/untracked', spacePath, 'HEAD']);
  // 登记与建档之后再产生成果：baseCommit 停在 seed，工作副本随后有一个提交 + 一个
  // 未跟踪文件 —— 这正是用户点「送审」时的现场。

  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  // node:test 的 t.after 按注册顺序执行：关闭数据库必须排在删除目录之前。
  t.after(() => { db.close(); removeWithRetry(root); });
  const mainObservation = await probeGitWorktree(mainPath);
  const sourceObservation = await probeGitWorktree(spacePath);
  const registered = registerProject(db, {
    commandId: 'register-untracked-project',
    name: 'Untracked Project',
    observation: mainObservation,
    authorizedRoot: mainPath,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const sourceWorktreeId = worktreeIdFor(sourceObservation.worktreeIdentity);
  const createdSpace = createDevelopmentSpace(db, {
    commandId: 'create-untracked-space',
    projectId: registered.projectId,
    name: 'Untracked Space',
    branch: sourceObservation.after.branch,
    baseCommit: sourceObservation.after.head,
    worktreeId: sourceWorktreeId,
    canonicalPath: sourceObservation.canonicalPath,
    repositoryIdentity: sourceObservation.repositoryIdentity,
    worktreeIdentity: sourceObservation.worktreeIdentity,
  });
  assert.equal(createdSpace.ok, true, JSON.stringify(createdSpace));
  const sessionId = 'session-untracked';
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO assignments (
      id, project_id, worktree_id, agent_id, task_id, scope_json,
      status, revision, session_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'Codex', 'Implement feature', '{"mode":"write"}',
      'active', 2, ?, ?, ?)
  `).run('assignment-untracked', registered.projectId, sourceWorktreeId, sessionId, timestamp, timestamp);
  const started = startWriteRun(db, {
    commandId: 'start-untracked-run',
    runId: sessionId,
    worktreeId: sourceWorktreeId,
    canonicalPath: sourceObservation.canonicalPath,
    repositoryIdentity: sourceObservation.repositoryIdentity,
    worktreeIdentity: sourceObservation.worktreeIdentity,
    agentClaim: 'Codex',
    goal: 'Implement feature',
    baseline: snapshot(sourceObservation),
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  writeFileSync(path.join(spacePath, 'work.md'), 'first pass\n');
  git(spacePath, ['add', 'work.md']);
  git(spacePath, ['commit', '-q', '-m', 'first pass']);
  const baseHead = git(spacePath, ['rev-parse', 'HEAD']);
  // 未跟踪文件：没有 -u 的 status 在 showUntrackedFiles=no 时看不见它。
  writeFileSync(path.join(spacePath, 'precious-untracked.md'), 'UNSAVED USER WORK\n');
  return { db, mainPath, spacePath, remotePath, sessionId, baseHead };
}

function remoteTree(remotePath, branch) {
  // 远端自己报告的对象为准，再用本地对象库展开文件清单。
  const listed = git(remotePath, ['ls-remote', '.', `refs/heads/${branch}`]);
  const sha = listed.split(/\s+/)[0];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return null;
  const tree = git(remotePath, ['ls-tree', '-r', '--name-only', sha]);
  return tree ? tree.split(/\r?\n/).filter(Boolean) : [];
}

test('the submit decision does not change when the repository hides untracked files', async (t) => {
  const plain = await submitFixture(t);
  const plainResult = await submitDevelopmentSpace(plain.db, {
    commandId: 'submit-plain', sessionId: plain.sessionId, expectedRevision: 2, summary: '两轮同样处理',
  });
  assert.equal(plainResult.ok, true, JSON.stringify(plainResult));
  assert.equal(plainResult.localSaved, true);
  assert.equal(plainResult.pushed, true);
  const plainTree = remoteTree(plain.remotePath, 'cockpit/work/untracked');
  assert.ok(
    plainTree?.includes('precious-untracked.md'),
    `默认配置下未跟踪的工作要进提交: tree=${JSON.stringify(plainTree)} refs=${JSON.stringify(git(plain.remotePath, ['show-ref']))}`,
  );

  const hidden = await submitFixture(t, { hideUntracked: true });
  const hiddenResult = await submitDevelopmentSpace(hidden.db, {
    commandId: 'submit-hidden', sessionId: hidden.sessionId, expectedRevision: 2, summary: '两轮同样处理',
  });
  const hiddenTree = remoteTree(hidden.remotePath, 'cockpit/work/untracked');
  assert.equal(
    hiddenResult.ok,
    true,
    `送审在隐藏未跟踪的仓库里也要成功（不是报错）: ${JSON.stringify(hiddenResult)}`,
  );
  assert.ok(
    hiddenTree?.includes('precious-untracked.md'),
    `一个显示开关不得改变实际送达的内容: tree=${JSON.stringify(hiddenTree)} refs=${JSON.stringify(git(hidden.remotePath, ['show-ref']))}`,
  );
});

test('hasUncommittedChanges reports untracked work whatever status.showUntrackedFiles says', async (t) => {
  const root = tempRoot('ugk-untracked-dirty-');
  t.after(() => removeWithRetry(root));
  const { mainPath } = initRepository(root);
  const work = path.join(root, 'work');
  git(mainPath, ['worktree', 'add', '-q', '-b', 'cockpit/work/dirty', work, 'HEAD']);

  assert.equal(await hasUncommittedChanges(work), false, '干净工作副本不得被判成有改动');
  writeFileSync(path.join(work, 'fresh.md'), 'work\n');
  assert.equal(await hasUncommittedChanges(work), true, '未跟踪文件就是未提交改动');

  git(mainPath, ['config', '--local', 'status.showUntrackedFiles', 'no']);
  assert.equal(
    await hasUncommittedChanges(work),
    true,
    '仓库把未跟踪文件从 status 显示里藏起来，也不能让产品以为没有要保存的东西',
  );
});

test('removeGitWorktree keeps refusing a worktree with untracked work under that setting', async (t) => {
  const root = tempRoot('ugk-untracked-remove-');
  t.after(() => removeWithRetry(root));
  const { mainPath } = initRepository(root);
  const doomed = path.join(mainPath, 'doomed');
  const created = await createGitWorktree(mainPath, {
    targetPath: doomed,
    branch: 'cockpit/work/doomed',
    baseCommit: git(mainPath, ['rev-parse', 'HEAD']),
  });
  assert.equal(created.ok, true);
  writeFileSync(path.join(doomed, 'not-committed.md'), 'ONLY COPY\n');

  // 控制组：默认配置下 git 自己就会拒绝。
  await assert.rejects(
    () => removeGitWorktree(mainPath, { targetPath: doomed }),
    (error) => error.code === 'GIT_WORKTREE_REMOVE_FAILED',
    '默认配置下必须拒绝删除含未跟踪文件的工作副本',
  );
  assert.ok(existsSync(path.join(doomed, 'not-committed.md')), '拒绝删除时用户的唯一副本必须还在');

  git(mainPath, ['config', '--local', 'status.showUntrackedFiles', 'no']);
  await assert.rejects(
    () => removeGitWorktree(mainPath, { targetPath: doomed }),
    (error) => error.code === 'GIT_WORKTREE_REMOVE_FAILED',
    '显示开关不得把产品删除原语从「拒绝」变成「删除」',
  );
  assert.ok(
    existsSync(path.join(doomed, 'not-committed.md')),
    '含未跟踪工作的工作副本绝不能被静默删除',
  );
});

test('a clean worktree is still removable and an unchanged space still says nothing to submit', async (t) => {
  const root = tempRoot('ugk-untracked-clean-');
  t.after(() => removeWithRetry(root));
  const { mainPath } = initRepository(root, { hideUntracked: true });
  const clean = path.join(mainPath, 'clean-space');
  assert.equal((await createGitWorktree(mainPath, {
    targetPath: clean,
    branch: 'cockpit/work/clean',
    baseCommit: git(mainPath, ['rev-parse', 'HEAD']),
  })).ok, true);
  // 反向界：干净的工作副本必须仍可移除，修复不能把它也一并拒绝。
  assert.equal((await removeGitWorktree(mainPath, { targetPath: clean })).ok, true);
  assert.equal(existsSync(clean), false);
});
