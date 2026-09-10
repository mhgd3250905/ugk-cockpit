import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
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
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.required=false',
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
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GCM_INTERACTIVE = 'Never';
  return environment;
}

export async function git(cwd, args, {
  timeoutMs = 5_000,
  maxBuffer = 2 * 1024 * 1024,
  acceptExitCodes = [0],
  config = [],
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
    return { exitCode: 0, stdout: result.stdout.trim() };
  } catch (error) {
    if (acceptExitCodes.includes(error?.code)) {
      return { exitCode: error.code, stdout: (error.stdout ?? '').trim() };
    }
    throw error;
  }
}

export async function gitText(cwd, args, options) {
  return (await git(cwd, args, options)).stdout;
}

export async function fileIdentity(targetPath) {
  const details = await stat(targetPath, { bigint: true });
  const evidence = {
    device: details.dev.toString(),
    inode: details.ino.toString(),
    birthtimeNs: details.birthtimeNs.toString(),
  };
  return {
    evidence,
    fingerprint: digest(JSON.stringify(evidence)),
  };
}

async function resolveGitPath(cwd, value) {
  return realpath(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

async function resolveObjectDirectories(primaryObjectDirectory) {
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
  for (const line of entries) {
    const candidate = path.isAbsolute(line)
      ? line
      : path.resolve(primaryObjectDirectory, line);
    directories.push(await realpath(candidate));
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
    maxBuffer = 2 * 1024 * 1024,
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
  const objectDirectories = await resolveObjectDirectories(primaryObjectDirectory);
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
