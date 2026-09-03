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
];

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
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

export async function git(cwd, args, { timeoutMs, maxBuffer, acceptExitCodes = [0], config = [] } = {}) {
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
  if (baselineHead === finalHead) return 'same';
  const result = await git(
    cwd,
    ['merge-base', '--is-ancestor', baselineHead, finalHead],
    { ...options, acceptExitCodes: [0, 1, 128] },
  );
  return result.exitCode === 0 ? 'descendant' : 'diverged';
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
