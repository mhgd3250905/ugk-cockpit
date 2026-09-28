import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { remoteAuthArguments } from './remote-auth.mjs';

const execFileAsync = promisify(execFile);
const MAX_ALTERNATES_BYTES = 64 * 1024;
const MAX_ALTERNATE_DIRECTORIES = 64;

export const SAFE_GIT_PREFIX = [
  '--no-optional-locks',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'credential.helper=',
  '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
  '-c', 'core.longpaths=true',
  // Command-line -c overrides repo-local config for the SAME key, but git
  // resolves the specific protocol.<name>.allow before the generic
  // protocol.allow — so a hostile repository could otherwise self-authorize
  // helper transports (ext::) with one repo-local line and execute remote
  // URLs like `ext::cmd /c ...` on the next push. Deny every non-approved
  // transport explicitly; file/https/ssh stay allow-listed, mirroring the
  // URL policy that delivery-ops.mjs enforces.
  '-c', 'protocol.allow=never',
  '-c', 'protocol.file.allow=always',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.ssh.allow=always',
  '-c', 'protocol.ext.allow=never',
  '-c', 'protocol.git.allow=never',
  '-c', 'protocol.http.allow=never',
  '-c', 'protocol.ftp.allow=never',
  '-c', 'protocol.ftps.allow=never',
  '-c', 'core.sshCommand=ssh',
  '-c', 'ssh.variant=ssh',
  // `core.askPass` is the same family as core.sshCommand and core.hooksPath:
  // repository-local config that names a PROGRAM git will run. On an auth
  // challenge git resolves GIT_ASKPASS -> core.askPass -> SSH_ASKPASS and
  // executes the value through a shell even with GIT_TERMINAL_PROMPT=0
  // (measured: a repo-local askpass batch file ran during the product's own
  // ls-remote against a 401 endpoint). Pin it to git's default so no
  // repository can answer a credential challenge by running itself.
  '-c', 'core.askPass=',
  // `status.showUntrackedFiles` is only how git renders `status`, but the
  // product reads that output as a completeness decision, and git's own
  // `worktree remove` safety check consults it too (measured: with `no`,
  // removing a worktree deletes an untracked file that git would otherwise
  // have refused to touch). Pin the default so no repository can weaken either.
  '-c', 'status.showUntrackedFiles=normal',
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.required=false',
  // Second line of defence behind the transport check in repository-policy.mjs.
  // These three keys can redirect the connection, disable certificate
  // validation, or inject request headers into a push that carries the user's
  // real Git credentials, and a command-line -c overrides the same generic key
  // from any config file (measured: with the repo-local keys set the request
  // reached an untrusted-certificate endpoint and the injected header arrived;
  // with these resets the same request never left the process).
  //
  // The url-scoped spelling `http.<url>.<key>` is NOT covered here — git
  // resolves the most specific match and a generic -c loses to it (measured).
  // That spelling is why detection, not neutralisation, is the primary fix.
  '-c', 'http.proxy=',
  '-c', 'http.sslVerify=true',
  '-c', 'http.extraHeader=',
];

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Git remote nicknames may legally start with '-' (valid_remote_nick only
// rejects empty names, '.', '..' and names containing '/'). A crafted name
// such as `--repo=<url>` would otherwise be parsed as an option by
// `git push` and silently redirect the push destination.
const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Git keeps parsing options after positional arguments, so any token that may
// land in a revision position must be a full git object id and nothing else.
// 40 hex covers SHA-1 repositories, 64 hex SHA-256.
export const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function assertSafeRemoteName(remote) {
  if (typeof remote !== 'string' || !SAFE_REMOTE_NAME.test(remote)) {
    const error = new Error(`Remote name '${remote}' is not a safe git remote nickname.`);
    error.code = 'UNSAFE_REMOTE_NAME';
    throw error;
  }
  return remote;
}

export function safeGitEnvironment() {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  // GIT_* is gone with the filter above; SSH_ASKPASS is the next fallback in
  // git's askpass resolution chain and must not survive from the inherited
  // environment either (measured: an inherited SSH_ASKPASS executed during a
  // product ls-remote against a 401 endpoint before this strip existed).
  delete environment.SSH_ASKPASS;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GCM_INTERACTIVE = 'Never';
  return environment;
}

export async function git(cwd, args, {
  timeoutMs = 5_000,
  // 与 delivery-ops 的 runGit 上限对齐：大仓库的 ls-files/status 输出很容易
  // 超过 1MB 级别，超限必须是可诊断的专用错误而不是原始 libuv 错误。
  maxBuffer = 4 * 1024 * 1024,
  acceptExitCodes = [0],
  config = [],
  // `-z` 记录里的路径是原样字节：首/尾空格属于文件名本身，而 trim() 会把
  // `" lead/.gitattributes"` 的首空格吃掉，让调用方解析到一个不存在的路径。
  // 需要逐字节输出（分隔符记录、路径列表）的调用显式要求 raw。
  raw = false,
} = {}) {
  const configArgs = Array.isArray(config)
    ? config
    : Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${value}`]);
  try {
    const result = await execFileAsync('git', [...SAFE_GIT_PREFIX, ...await remoteAuthArguments(args), ...configArgs, ...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      env: safeGitEnvironment(),
    });
    return { exitCode: 0, stdout: raw ? result.stdout : result.stdout.trim() };
  } catch (error) {
    if (acceptExitCodes.includes(error?.code)) {
      return { exitCode: error.code, stdout: raw ? (error.stdout ?? '') : (error.stdout ?? '').trim() };
    }
    if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      const bufErr = new Error('Git command output exceeded maximum safe buffer size');
      bufErr.code = 'GIT_BUFFER_LIMIT_EXCEEDED';
      throw bufErr;
    }
    throw error;
  }
}

export async function gitText(cwd, args, options) {
  return (await git(cwd, args, options)).stdout;
}

// Synchronous twin of git(): only for pre-listen database migrations, where no
// event loop exists yet. remoteAuthArguments is async and exclusively serves
// fetch/push/ls-remote, so this read-only helper never needs it.
export function gitSync(cwd, args, {
  timeoutMs = 5_000,
  maxBuffer = 4 * 1024 * 1024,
  acceptExitCodes = [0],
  config = [],
  // Same meaning as in `git()`: keep every byte of `-z` records.
  raw = false,
} = {}) {
  const configArgs = Array.isArray(config)
    ? config
    : Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${value}`]);
  try {
    const stdout = execFileSync('git', [...SAFE_GIT_PREFIX, ...configArgs, ...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      env: safeGitEnvironment(),
    });
    return { exitCode: 0, stdout: raw ? stdout : stdout.trim() };
  } catch (error) {
    // execFileSync reports a non-zero exit through error.status; error.code
    // only carries spawn failures (ENOENT and friends).
    const exitCode = typeof error?.status === 'number' ? error.status : error?.code;
    if (acceptExitCodes.includes(exitCode)) {
      const bytes = (error.stdout ?? '').toString();
      return { exitCode, stdout: raw ? bytes : bytes.trim() };
    }
    throw error;
  }
}

export async function fileIdentity(targetPath) {
  const details = await stat(targetPath, { bigint: true });
  const evidence = {
    device: details.dev.toString(),
    inode: details.ino.toString(),
    birthtimeNs: details.birthtimeNs.toString(),
  };
  // The fingerprint deliberately excludes `device`: on macOS the APFS volume
  // device number drifts across reboots and OS updates (observed 16777231 →
  // 16777234) while inode and birthtime are untouched, which would misreport
  // an untouched working copy as replaced. inode+birthtimeNs already pinpoints
  // one directory entry per volume; path-anchored comparisons cover the rest.
  return {
    evidence,
    fingerprint: digest(JSON.stringify({
      inode: evidence.inode,
      birthtimeNs: evidence.birthtimeNs,
    })),
  };
}

async function resolveGitPath(cwd, value) {
  return realpath(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

// An alternate names a directory Git would consult for objects. Resolving it
// must not become an unbounded filesystem call: the entry comes from
// `.git/objects/info/alternates`, so repository content chooses the path, and a
// dangling entry used to throw a raw ENOENT out of every observation while a
// path on an unmounted volume or a dead share never returned at all — and
// graceful shutdown waits on open requests.
//
// One budget covers the **whole** pass, not each entry: the file may name up to
// 64 directories, so a per-entry budget would multiply into minutes. A missing
// entry is dropped because Git itself keeps working without it and it holds no
// objects to authorize; anything else — a read error or the budget running out
// — is reported as a refusal rather than silently narrowing the set that path
// authorization will later be asked to trust.
function alternateResolutionFailure() {
  const error = new Error('Git 指向的对象目录无法定位，已停止读取。');
  error.code = 'GIT_ALTERNATE_UNRESOLVED';
  return error;
}

async function resolveAlternate(candidate, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw alternateResolutionFailure();
  let timer;
  try {
    return await Promise.race([
      realpath(candidate),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(alternateResolutionFailure()), remaining);
        timer.unref();
      }),
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    if (error?.code === 'GIT_ALTERNATE_UNRESOLVED') throw error;
    throw alternateResolutionFailure();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveObjectDirectories(primaryObjectDirectory, { timeoutMs = 5_000 } = {}) {
  const directories = [primaryObjectDirectory];
  const alternatesFile = path.join(primaryObjectDirectory, 'info', 'alternates');
  if (!existsSync(alternatesFile)) return directories;
  const alternatesStat = await stat(alternatesFile);
  if (alternatesStat.size > MAX_ALTERNATES_BYTES) {
    const error = new Error('Git alternates metadata exceeds the safe read limit.');
    error.code = 'GIT_METADATA_TOO_LARGE';
    throw error;
  }
  const content = await readFile(alternatesFile, 'utf8');
  const entries = content.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (entries.length > MAX_ALTERNATE_DIRECTORIES) {
    const error = new Error('Git alternates metadata contains too many object directories.');
    error.code = 'GIT_METADATA_TOO_LARGE';
    throw error;
  }
  // One budget for the whole list, evaluated as an absolute deadline.
  const deadlineAt = Date.now() + timeoutMs;
  for (const line of entries) {
    const candidate = path.isAbsolute(line)
      ? line
      : path.resolve(primaryObjectDirectory, line);
    const resolved = await resolveAlternate(candidate, deadlineAt);
    if (resolved) directories.push(resolved);
  }
  return [...new Set(directories)];
}

async function observe(cwd, options) {
  const [head, branch, indexState, worktreeState, dirtyState] = await Promise.all([
    gitText(cwd, ['rev-parse', '--verify', 'HEAD'], options),
    gitText(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], options).catch(() => ''),
    gitText(cwd, ['ls-files', '--stage', '-z'], options),
    gitText(cwd, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal'], options),
    gitText(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], options),
  ]);
  return {
    head,
    branch: branch || null,
    indexFingerprint: digest(indexState),
    worktreeFingerprint: digest(worktreeState),
    statusBytes: Buffer.byteLength(worktreeState),
    hasChanges: dirtyState.length > 0,
  };
}

async function headRelation(cwd, baselineHead, finalHead, options) {
  if (!baselineHead) return 'unknown';
  // baselineHead sits in a revision position of merge-base; a non object id
  // (e.g. an option-looking token) must never reach git. Report the honest
  // 'unknown' instead of guessing a topology answer.
  if (!GIT_OBJECT_ID_PATTERN.test(baselineHead)) return 'unknown';
  if (baselineHead === finalHead) return 'same';
  // Only 0 (ancestor) and 1 (not an ancestor) answer the topology question.
  // Exit 128 means git could not read the history at all (a replaced or
  // shallow repository); reporting that as 'diverged' would persist a factual
  // claim the probe cannot back. Keep the probe alive so identity checks can
  // still raise their precise errors, and let completion stay blocked on the
  // honest 'unknown'.
  const result = await git(
    cwd,
    ['merge-base', '--is-ancestor', baselineHead, finalHead],
    { ...options, acceptExitCodes: [0, 1, 128] },
  );
  if (result.exitCode === 0) return 'descendant';
  if (result.exitCode === 1) return 'diverged';
  return 'unknown';
}

export async function probeGitWorktree(
  worktreePath,
  {
    timeoutMs = 5_000,
    // 与 git() 的默认上限一致：观察通道的 ls-files/status 输出在大仓库上
    // 很容易超过 2MB，上限口径必须和错误映射一起对齐。
    maxBuffer = 4 * 1024 * 1024,
    onBetweenObservations,
    expectedBaselineHead = null,
  } = {},
) {
  const requestedPath = await realpath(worktreePath);
  const options = { timeoutMs, maxBuffer };
  const worktreeRootValue = await gitText(
    requestedPath,
    ['rev-parse', '--show-toplevel'],
    options,
  );
  const canonicalPath = await resolveGitPath(requestedPath, worktreeRootValue);
  const sameWorktreeRoot = process.platform === 'win32'
    ? canonicalPath.toLowerCase() === requestedPath.toLowerCase()
    : canonicalPath === requestedPath;
  if (!sameWorktreeRoot) {
    const error = new Error('Git 指向了所选文件夹之外的工作目录，已停止读取。');
    error.code = 'PATH_NOT_AUTHORIZED';
    throw error;
  }
  const [commonDirValue, gitDirValue, objectDirectoryValue, indexPathValue] = await Promise.all([
    gitText(requestedPath, ['rev-parse', '--git-common-dir'], options),
    gitText(requestedPath, ['rev-parse', '--git-dir'], options),
    gitText(requestedPath, ['rev-parse', '--git-path', 'objects'], options),
    gitText(requestedPath, ['rev-parse', '--git-path', 'index'], options),
  ]);
  const repositoryCommonDir = await resolveGitPath(requestedPath, commonDirValue);
  const gitDirectory = await resolveGitPath(requestedPath, gitDirValue);
  const primaryObjectDirectory = await resolveGitPath(requestedPath, objectDirectoryValue);
  const indexPath = await resolveGitPath(requestedPath, indexPathValue);
  const objectDirectories = await resolveObjectDirectories(primaryObjectDirectory, options);
  const [repositoryIdentity, worktreeIdentity] = await Promise.all([
    fileIdentity(repositoryCommonDir),
    fileIdentity(canonicalPath),
  ]);

  const before = await observe(requestedPath, options);
  if (onBetweenObservations) await onBetweenObservations();
  const after = await observe(requestedPath, options);
  const coherence = (
    before.head === after.head
    && before.branch === after.branch
    && before.indexFingerprint === after.indexFingerprint
    && before.worktreeFingerprint === after.worktreeFingerprint
  ) ? 'coherent' : 'incoherent';

  return {
    canonicalPath,
    repositoryCommonDir,
    gitDirectory,
    indexPath,
    objectDirectories,
    repositoryIdentity: repositoryIdentity.fingerprint,
    repositoryIdentityEvidence: repositoryIdentity.evidence,
    worktreeIdentity: worktreeIdentity.fingerprint,
    worktreeIdentityEvidence: worktreeIdentity.evidence,
    observedAt: new Date().toISOString(),
    coherence,
    headRelation: await headRelation(requestedPath, expectedBaselineHead, after.head, options),
    before,
    after,
  };
}
