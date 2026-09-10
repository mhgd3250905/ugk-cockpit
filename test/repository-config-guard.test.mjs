import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pushSubmissionBranch } from '../src/git/submit-ops.mjs';
import { fastForwardMain, pushIntegratedMain } from '../src/git/integration-ops.mjs';
import { checkUnsupportedFeatures } from '../src/git/delivery-ops.mjs';
import { createGitWorktree, generateStableBranchName } from '../src/git/workspace-ops.mjs';
import { assertRepositoryAllowed, findHostileRepositoryConfiguration } from '../src/git/repository-policy.mjs';

// POSIX 的系统临时目录本身可能是符号链接；产品路径授权按契约拒绝穿越链接
// 的路径，夹具必须建立在真实路径下。
function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

function gitSync(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// `git config --get-regexp` 无匹配时退出码为 1，execFileSync 会抛错。
function gitSyncQuiet(cwd, args) {
  try {
    return gitSync(cwd, args);
  } catch (error) {
    if (error.status === 1) return '';
    throw error;
  }
}

function slashes(value) {
  return value.split(path.sep).join('/');
}

// 过滤器命令在 Git for Windows 与 POSIX 上同样由 sh 执行，node 必然存在。
function markerCommand(marker) {
  return `node -e "require('fs').writeFileSync('${slashes(marker)}','pwned')"`;
}

function createFixture(t, prefix) {
  const base = mkdtempSync(path.join(fixtureTempRoot(), prefix));
  t.after(() => {
    try { rmSync(base, { recursive: true, force: true }); } catch {}
  });
  const repo = path.join(base, 'repo');
  const bare = path.join(base, 'remote.git');
  gitSync(base, ['init', '--bare', '-b', 'main', bare]);
  gitSync(base, ['init', '-b', 'main', repo]);
  gitSync(repo, ['config', 'user.email', 'ugk@example.invalid']);
  gitSync(repo, ['config', 'user.name', 'UGK Test']);
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  gitSync(repo, ['add', 'README.md']);
  gitSync(repo, ['commit', '--quiet', '-m', 'fixture']);
  gitSync(repo, ['remote', 'add', 'origin', bare]);
  return { base, repo, bare };
}

test('worktree creation refuses a repo-local smudge filter bound outside the working tree', async (t) => {
  const { base, repo } = createFixture(t, 'ugk-guard-worktree-');
  const marker = path.join(base, 'pwned-worktree.txt');
  gitSync(repo, ['config', '--local', 'filter.evil.smudge', markerCommand(marker)]);
  // `.git/info/attributes` is invisible to any working-tree `.gitattributes`
  // scan, which is exactly why detection must read every attribute source.
  writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');

  const head = gitSync(repo, ['rev-parse', 'HEAD']);
  await assert.rejects(
    () => createGitWorktree(repo, {
      targetPath: path.join(base, 'wt1'),
      branch: generateStableBranchName('project', 'command-1'),
      baseCommit: head,
    }),
    (error) => error.code === 'GIT_FILTER_UNSUPPORTED',
  );
  assert.equal(existsSync(marker), false,
    'worktree add must not check out files through a repo-local smudge filter');
});

test('worktree creation refuses a filter bound by core.attributesFile outside the repository', async (t) => {
  const { base, repo } = createFixture(t, 'ugk-guard-attrs-');
  const marker = path.join(base, 'pwned-attrs.txt');
  const attributesFile = path.join(base, 'hostile-attributes');
  writeFileSync(attributesFile, '* filter=evil\n');
  gitSync(repo, ['config', '--local', 'filter.evil.smudge', markerCommand(marker)]);
  gitSync(repo, ['config', '--local', 'core.attributesFile', attributesFile]);

  const head = gitSync(repo, ['rev-parse', 'HEAD']);
  await assert.rejects(
    () => createGitWorktree(repo, {
      targetPath: path.join(base, 'wt2'),
      branch: generateStableBranchName('project', 'command-2'),
      baseCommit: head,
    }),
    (error) => error.code === 'GIT_FILTER_UNSUPPORTED',
  );
  assert.equal(existsSync(marker), false,
    'core.attributesFile must be treated as an attribute source');
});

test('submit push refuses remote.*.receivepack without running it', async (t) => {
  const { base, repo } = createFixture(t, 'ugk-guard-submit-');
  const marker = path.join(base, 'pwned-submit.txt');
  gitSync(repo, ['checkout', '-q', '-b', 'cockpit/work/guardsubmit01']);
  gitSync(repo, ['config', '--local', 'remote.origin.receivepack', markerCommand(marker)]);

  await assert.rejects(
    () => pushSubmissionBranch(repo, { remote: 'origin', branch: 'cockpit/work/guardsubmit01' }),
    (error) => error.code === 'UNSAFE_REMOTE_URL',
  );
  assert.equal(existsSync(marker), false,
    'remote.*.receivepack is executed by git during transport and must be refused');
});

test('integration push refuses remote.*.receivepack without running it', async (t) => {
  const { base, repo } = createFixture(t, 'ugk-guard-integrate-');
  const marker = path.join(base, 'pwned-integrate.txt');
  gitSync(repo, ['checkout', '-q', '-b', 'cockpit/work/guardinteg001']);
  gitSync(repo, ['config', '--local', 'remote.origin.receivepack', markerCommand(marker)]);

  await assert.rejects(
    () => pushIntegratedMain(repo, { remote: 'origin', branch: 'cockpit/work/guardinteg001' }),
    (error) => error.code === 'UNSAFE_REMOTE_URL',
  );
  assert.equal(existsSync(marker), false,
    'integration push must apply the same repository policy as submission');
});

test('integration fast-forward refuses a repo-local smudge filter', async (t) => {
  const { base, repo } = createFixture(t, 'ugk-guard-ff-');
  const marker = path.join(base, 'pwned-ff.txt');
  writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');
  gitSync(repo, ['config', '--local', 'filter.evil.smudge', markerCommand(marker)]);
  const head = gitSync(repo, ['rev-parse', 'HEAD']);

  await assert.rejects(
    () => fastForwardMain(repo, head),
    (error) => error.code === 'GIT_FILTER_UNSUPPORTED',
  );
  assert.equal(existsSync(marker), false,
    'a fast-forward updates the working tree and must not run a smudge filter');
});

test('delivery inspection refuses a smudge-only filter configuration', async (t) => {
  const { repo } = createFixture(t, 'ugk-guard-delivery-');
  gitSync(repo, ['config', '--local', 'filter.evil.smudge', markerCommand(path.join(repo, 'never.txt'))]);
  await assert.rejects(
    () => checkUnsupportedFeatures(repo),
    (error) => error.code === 'GIT_FILTER_UNSUPPORTED',
  );
});

test('a clean repository still passes every repository policy gate', async (t) => {
  const { base, repo } = createFixture(t, 'ugk-guard-clean-');
  await checkUnsupportedFeatures(repo);
  const head = gitSync(repo, ['rev-parse', 'HEAD']);
  const created = await createGitWorktree(repo, {
    targetPath: path.join(base, 'wt-clean'),
    branch: generateStableBranchName('project', 'command-clean'),
    baseCommit: head,
  });
  assert.equal(created.ok, true);
  await pushSubmissionBranch(repo, { remote: 'origin', branch: 'main' });
});

test('benign gitattributes that only unset diff are not treated as hostile', async (t) => {
  const { repo } = createFixture(t, 'ugk-guard-benign-');
  // `-diff` / `[attr]binary -diff -merge -text` 是二进制与生成文件的常规写法，
  // 并不命名任何驱动，拒绝它们会让正常仓库无法接入。
  writeFileSync(path.join(repo, '.gitattributes'),
    '*.png -diff\n*.lock -diff linguist-generated\n[attr]binary -diff -merge -text\n');
  gitSync(repo, ['add', '.gitattributes']);
  assert.equal(await findHostileRepositoryConfiguration(repo), null);

  // 命名 diff 驱动但本地没有对应 command/textconv 时同样没有执行面。
  writeFileSync(path.join(repo, '.gitattributes'), '*.c diff=cpp\n');
  gitSync(repo, ['add', '.gitattributes']);
  assert.equal(await findHostileRepositoryConfiguration(repo), null);
});

test('a local diff driver command is refused because textconv executes it', async (t) => {
  const { base, repo } = createFixture(t, 'ugk-guard-textconv-');
  gitSync(repo, ['config', '--local', 'diff.evil.command', markerCommand(path.join(base, 'never.txt'))]);
  await assert.rejects(
    () => checkUnsupportedFeatures(repo),
    (error) => error.code === 'GIT_FILTER_UNSUPPORTED',
  );
});

test('attributes adopted through the common directory are detected from a linked worktree', async (t) => {
  const { base, repo } = createFixture(t, 'ugk-guard-linked-');
  const linked = path.join(base, 'linked');
  gitSync(repo, ['worktree', 'add', '-b', 'cockpit/work/linkedbranch', linked, 'HEAD']);
  // git 只采纳 common 目录的 info/attributes，链接副本自己的 admin 目录不算。
  // 守卫必须用 --git-common-dir 查到同一处，否则从链接副本发起的操作会漏检。
  writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');

  assert.equal(
    gitSync(linked, ['check-attr', 'filter', '--', 'README.md']).includes('evil'),
    true,
    'fixture 必须真的让链接副本采用该属性',
  );
  assert.deepEqual(await findHostileRepositoryConfiguration(linked), { kind: 'attributes' });
});

test('a driver hidden in an included config file is detected', async (t) => {
  const { repo } = createFixture(t, 'ugk-guard-include-');
  // include.path 默认不被 `--get-regexp` 展开，驱动可以完全藏在这里。
  const included = path.join(repo, 'hostile.config');
  writeFileSync(included, '[filter "evil"]\n\tsmudge = node -e ""\n');
  // include.path 相对路径由 git 按被包含文件所在目录解析，这里用绝对路径更稳妥。
  gitSync(repo, ['config', '--local', 'include.path', slashes(included)]);
  assert.ok(gitSyncQuiet(repo, ['config', '--get-regexp', '^filter\\.']).includes('filter.evil'),
    'fixture 必须让 git 真的读到被包含文件里的驱动');

  assert.deepEqual(await findHostileRepositoryConfiguration(repo), { kind: 'filter' });
});

test('a driver in the worktree-scoped config is detected', async (t) => {
  const { repo } = createFixture(t, 'ugk-guard-worktree-cfg-');
  gitSync(repo, ['config', 'extensions.worktreeConfig', 'true']);
  gitSync(repo, ['config', '--worktree', 'filter.wt.smudge', markerCommand(path.join(repo, 'never.txt'))]);

  // --local 永远看不到 config.worktree 的内容。
  assert.equal(gitSyncQuiet(repo, ['config', '--local', '--get-regexp', '^filter\\.']), '');
  assert.deepEqual(await findHostileRepositoryConfiguration(repo), { kind: 'filter' });
});

test('the guard runs before the first probe of a hostile main location', async (t) => {
  const { repo } = createFixture(t, 'ugk-guard-before-probe-');
  const marker = path.join(repo, 'pwned-by-probe.txt');
  writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');
  gitSync(repo, ['config', '--local', 'filter.evil.clean', markerCommand(marker)]);

  // 探针本身运行 `git status`，足以触发 clean 过滤器：闸门必须更早。
  await assert.rejects(
    () => assertRepositoryAllowed(repo),
    (error) => error.code === 'GIT_FILTER_UNSUPPORTED',
  );
  assert.equal(existsSync(marker), false, '探测之前必须已经拒绝');
});
