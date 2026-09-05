import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { readFile, stat, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { authorizeExistingPath, revalidateAuthorizedPath } from '../core/path-guard.mjs';
import { createDeliveryCache, assertDeliveryCache, discardDeliveryCache } from '../core/delivery-cache.mjs';
import { remoteAuthArguments } from './remote-auth.mjs';
import { acquireDeliveryIndexLock, assertDeliveryIndexLock, releaseDeliveryIndexLock } from './delivery-index-lock.mjs';

const execFileAsync = promisify(execFile);

export const SAFE_GIT_PREFIX = [
  '--no-optional-locks',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'credential.helper=',
  '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
  '-c', 'core.longpaths=true',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.file.allow=always',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.ssh.allow=always',
  '-c', 'core.sshCommand=ssh',
  '-c', 'ssh.variant=ssh',
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.required=false',
];

export function safeGitEnvironment(extraEnv = {}) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GCM_INTERACTIVE = 'Never';
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined || value === null) {
      delete environment[key];
    } else {
      environment[key] = String(value);
    }
  }
  return environment;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export async function runGit(cwd, args, { env = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, acceptExitCodes = [0], raw = false } = {}) {
  try {
    const result = await execFileAsync('git', [...SAFE_GIT_PREFIX, ...await remoteAuthArguments(args), ...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      env: safeGitEnvironment(env),
    });
    return { exitCode: 0, stdout: raw ? result.stdout : result.stdout.trim() };
  } catch (error) {
    const exitCode = typeof error?.code === 'number' ? error.code : error?.status;
    if (acceptExitCodes.includes(exitCode)) {
      return {
        exitCode,
        stdout: raw ? (error.stdout ?? '') : (error.stdout ?? '').trim(),
        stderr: (error.stderr ?? '').trim(),
      };
    }
    if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      const bufErr = new Error('Git command output exceeded maximum safe buffer size');
      bufErr.code = 'GIT_BUFFER_LIMIT_EXCEEDED';
      throw bufErr;
    }
    throw error;
  }
}

export function isLocalPath(rawUrl) {
  if (rawUrl.startsWith('file://')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(rawUrl)) return true;
  if (rawUrl.startsWith('/') || rawUrl.startsWith('\\\\')) return true;
  if (rawUrl.startsWith('./') || rawUrl.startsWith('../') || rawUrl.startsWith('.\\') || rawUrl.startsWith('..\\')) return true;
  return existsSync(rawUrl);
}

export function validateRemoteUrlSecurity(url) {
  if (typeof url !== 'string' || !url.trim()) {
    const error = new Error('Remote URL is empty or invalid.');
    error.code = 'UNSAFE_REMOTE_URL';
    throw error;
  }
  const trimmed = url.trim();
  if (trimmed.startsWith('-') || /[\0\r\n]/.test(trimmed)
    || (!isLocalPath(trimmed) && !/^https:\/\//i.test(trimmed) && !/^ssh:\/\//i.test(trimmed)
      && !/^(git@)?[a-zA-Z0-9.-]+:[^/\\]/.test(trimmed))) {
    throw Object.assign(new Error('Unsupported remote transport'), { code: 'UNSAFE_REMOTE_URL' });
  }

  // Reject ext helper, remote-testgit, or custom protocol helper syntax
  if (/^[a-zA-Z0-9_-]+::/i.test(trimmed) || /^ext::/i.test(trimmed) || trimmed.includes('::')) {
    const error = new Error(`Remote URL uses unsafe protocol helper: ${trimmed}`);
    error.code = 'UNSAFE_REMOTE_URL';
    throw error;
  }

  // Reject credentials in http/https URLs
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.username || parsed.password) {
        const error = new Error('Remote URL contains embedded credentials.');
        error.code = 'CREDENTIALS_IN_REMOTE_URL';
        throw error;
      }
    } catch (e) {
      if (e.code === 'CREDENTIALS_IN_REMOTE_URL') throw e;
      const error = new Error(`Invalid HTTP/HTTPS remote URL: ${trimmed}`);
      error.code = 'UNSAFE_REMOTE_URL';
      throw error;
    }
  } else if (/^ssh:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.password) {
        const error = new Error('SSH remote URL contains embedded password.');
        error.code = 'CREDENTIALS_IN_REMOTE_URL';
        throw error;
      }
      if (parsed.username && parsed.username !== 'git') {
        const error = new Error('SSH remote URL contains unrecognized username.');
        error.code = 'CREDENTIALS_IN_REMOTE_URL';
        throw error;
      }
    } catch (e) {
      if (e.code === 'CREDENTIALS_IN_REMOTE_URL') throw e;
      const error = new Error(`Invalid SSH remote URL: ${trimmed}`);
      error.code = 'UNSAFE_REMOTE_URL';
      throw error;
    }
  } else if (trimmed.includes('@')) {
    // SCP-style syntax: git@host:path or user:pass@host:path
    const atIndex = trimmed.indexOf('@');
    const userPart = trimmed.slice(0, atIndex);
    if (userPart.includes(':')) {
      const error = new Error('Remote URL contains embedded credentials.');
      error.code = 'CREDENTIALS_IN_REMOTE_URL';
      throw error;
    }
    if (userPart !== 'git' && !isLocalPath(trimmed)) {
      const error = new Error('Remote URL contains unrecognized credentials.');
      error.code = 'CREDENTIALS_IN_REMOTE_URL';
      throw error;
    }
  }
}

export function normalizeRemoteIdentity(rawUrl, cwd = process.cwd()) {
  validateRemoteUrlSecurity(rawUrl);
  const trimmed = rawUrl.trim();

  // Local filesystem or file:// URL
  if (isLocalPath(trimmed)) {
    let localPath = trimmed;
    if (localPath.startsWith('file://')) {
      localPath = localPath.slice(7);
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(localPath)) {
        localPath = localPath.slice(1);
      }
    }
    const resolved = path.isAbsolute(localPath) ? localPath : path.resolve(cwd, localPath);
    let canonical = resolved;
    try {
      canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
    } catch {
      canonical = resolved;
    }
    let normalized = canonical.replace(/\\/g, '/');
    if (process.platform === 'win32') {
      normalized = normalized.toLowerCase();
    }
    normalized = normalized.replace(/\/+$/, '');
    return `file://${normalized}`;
  }

  // SCP-style SSH: [user@]host:path
  const scpMatch = /^(?:(?<user>[a-zA-Z0-9._-]+)@)?(?<host>[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|[a-zA-Z0-9.-]+):(?<repoPath>[^/\\].*)$/.exec(trimmed);
  if (scpMatch && !/^[a-zA-Z]:/.test(trimmed)) {
    const host = scpMatch.groups.host.toLowerCase();
    let repoPath = scpMatch.groups.repoPath.replace(/\\/g, '/');
    repoPath = repoPath.replace(/\.git\/?$/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (host === 'github.com') repoPath = repoPath.toLowerCase();
    return `${host}/${repoPath}`;
  }

  // URI format: https://, http://, ssh://, git://
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    let repoPath = parsed.pathname.replace(/\\/g, '/');
    repoPath = repoPath.replace(/\.git\/?$/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (host === 'github.com') repoPath = repoPath.toLowerCase();
    const port = parsed.port;
    const portSuffix = port && port !== '22' && port !== '443' && port !== '80' ? `:${port}` : '';
    return `${host}${portSuffix}/${repoPath}`;
  } catch {
    return trimmed.replace(/\.git\/?$/, '').toLowerCase();
  }
}

export function parseStatusZ(output) {
  const changes = [];
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const xy = token.slice(0, 2);
    const filePath = token.slice(3);
    let pairedPath;
    if (/[RC]/.test(xy)) {
      const oldPath = tokens[++i];
      if (!oldPath) throw Object.assign(new Error('Incomplete rename status'), { code: 'INVALID_DELIVERY_FILES' });
      if (xy.includes('R')) {
        pairedPath = oldPath.replace(/\\/g, '/');
        changes.push({ path: pairedPath, status: 'D', pairedPath: filePath.replace(/\\/g, '/') });
      }
    }
    changes.push({ path: filePath.replace(/\\/g, '/'), status: xy.trim() || xy, ...(pairedPath ? { pairedPath } : {}) });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export async function computeContentFingerprint(cwd, head, files = []) {
  const hasher = createHash('sha256');
  hasher.update(`HEAD:${head ?? 'EMPTY'}\n`);
  hasher.update((await runGit(cwd, ['ls-files', '--stage', '-z'], { raw: true })).stdout);
  let totalBytes = 0;
  const fileList = (Array.isArray(files) ? files : [])
    .map((item) => (typeof item === 'string' ? item : item?.path))
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'));
  const sorted = [...new Set(fileList)].sort((a, b) => a.localeCompare(b));
  for (const relPath of sorted) {
    hasher.update(`PATH:${relPath}\n`);
    if (isSensitivePath(relPath)) { hasher.update('EXCLUDED_SENSITIVE_PATH\n'); continue; }
    const fullPath = path.resolve(cwd, relPath);
    try {
      const stats = await lstat(fullPath);
      if (!stats.isFile()) throw Object.assign(new Error('Unsupported changed path'), { code: 'INVALID_DELIVERY_FILES' });
      const binding = authorizeExistingPath(fullPath, cwd);
      revalidateAuthorizedPath(binding);
      totalBytes += stats.size;
      if (stats.size > 32 * 1024 * 1024 || totalBytes > 128 * 1024 * 1024) {
        const isSingle = stats.size > 32 * 1024 * 1024;
        const limitBytes = isSingle ? 32 * 1024 * 1024 : 128 * 1024 * 1024;
        const actualBytes = isSingle ? stats.size : totalBytes;
        const error = new Error(isSingle
          ? `Selected file '${relPath}' exceeds safe size limit (32MiB)`
          : `Cumulative selected files exceed safe size limit (128MiB) at '${relPath}'`);
        error.code = 'DELIVERY_CONTENT_TOO_LARGE';
        error.details = {
          file: relPath,
          limitBytes,
          actualBytes,
        };
        throw error;
      }
      {
        const buf = await readFile(fullPath);
        revalidateAuthorizedPath(binding);
        const digest = createHash('sha256').update(buf).digest('hex');
        hasher.update(`MODE:${stats.mode} CONTENT:${digest}\n`);
      }
    } catch (error) {
      if (error.code === 'DELIVERY_CONTENT_TOO_LARGE' || error.code === 'INVALID_DELIVERY_FILES') throw error;
      if (error.code !== 'ENOENT') throw error;
      hasher.update('DELETED\n');
    }
  }
  return hasher.digest('hex');
}

export async function readDeliveryLocation(cwd, { files = null } = {}) {
  await checkUnsupportedFeatures(cwd);
  const [headRes, branchRes, statusRes, remotesListRes] = await Promise.all([
    runGit(cwd, ['rev-parse', '--verify', 'HEAD'], { acceptExitCodes: [0, 128] }),
    runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { acceptExitCodes: [0, 1] }),
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { raw: true }),
    runGit(cwd, ['remote'], { acceptExitCodes: [0] }),
  ]);

  const head = headRes.exitCode === 0 && headRes.stdout ? headRes.stdout : null;
  const branch = branchRes.exitCode === 0 && branchRes.stdout ? branchRes.stdout : null;
  const changes = parseStatusZ(statusRes.stdout);

  const remoteNames = remotesListRes.stdout
    ? remotesListRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [];

  const remotes = [];
  for (const name of remoteNames) {
    const urlRes = await runGit(cwd, ['config', '--get-all', `remote.${name}.url`], { acceptExitCodes: [0, 1] });
    const url = urlRes.stdout.trim();
    if (url) {
      validateRemoteUrlSecurity(url);
      const identity = normalizeRemoteIdentity(url, cwd);
      const push = await runGit(cwd, ['config', '--get-all', `remote.${name}.pushurl`], { acceptExitCodes: [0, 1] });
      if (push.stdout && push.stdout !== url) throw Object.assign(new Error('Separate push destination needs explicit reconciliation'), { code: 'REMOTE_IDENTITY_CHANGED' });
      const localPath = isLocalPath(url) ? (url.startsWith('file:') ? fileURLToPath(url) : path.resolve(cwd, url)) : null;
      if (localPath && !existsSync(localPath)) throw Object.assign(new Error('Local remote is unavailable'), { code: 'REMOTE_SOURCE_UNREACHABLE' });
      remotes.push({ name, url: localPath ? realpathSync(localPath) : url, identity });
    }
  }

  const fingerprint = await computeContentFingerprint(cwd, head, files ?? []);

  return {
    head,
    branch,
    changes,
    remotes,
    fingerprint,
  };
}

export function isSensitivePath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const baseName = path.posix.basename(normalized);

  // .env files, except .env.example, .env.sample, .env.template, .env.test
  if (baseName === '.env' || (baseName.startsWith('.env.') && !/^\.env\.(example|sample|template|test)$/i.test(baseName))) {
    return true;
  }

  // Private keys and certificates
  if (/\.(pem|key|p12|pfx|keystore|jks)$/i.test(baseName)) {
    return true;
  }

  // SSH private keys
  if (/^id_(rsa|ed25519|ecdsa|dsa)($|\.)/i.test(baseName) && !baseName.endsWith('.pub')) {
    return true;
  }

  // Sensitive config files
  if (/^(\.npmrc|\.pypirc|\.netrc)$/i.test(baseName)) {
    return true;
  }

  return false;
}

export function chooseRemote(remotes, role = 'origin') {
  const origin = remotes.find((r) => r.name === 'origin');
  if (origin) return origin;
  if (remotes.length === 1) return remotes[0];
  const error = new Error(remotes.length === 0
    ? `No Git remote is configured for ${role}.`
    : `Multiple Git remotes are configured for ${role} and none is named origin.`);
  error.code = remotes.length === 0 ? 'PUSH_REMOTE_MISSING' : 'PUSH_REMOTE_AMBIGUOUS';
  throw error;
}

export async function checkUnfinishedGitOperations(cwd) {
  const gitDirRes = await runGit(cwd, ['rev-parse', '--git-dir']);
  const gitDir = path.resolve(cwd, gitDirRes.stdout);
  const indicators = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
  for (const item of indicators) {
    if (existsSync(path.join(gitDir, item))) {
      const error = new Error(`Unfinished Git operation detected (${item}). Complete or abort it before delivery.`);
      error.code = 'UNFINISHED_GIT_OPERATION';
      throw error;
    }
  }
}

export async function checkUnsupportedFeatures(cwd) {
  const [stagedEntries, localFilters, attrFilters] = await Promise.all([
    runGit(cwd, ['ls-files', '--stage'], { acceptExitCodes: [0, 1] }),
    runGit(cwd, ['config', '--local', '--get-regexp', '^filter\\..*\\.(clean|process)$'], { acceptExitCodes: [0, 1] }),
    runGit(cwd, ['grep', '--untracked', '-I', '-n', '-E', 'filter[[:space:]]*=', '--', '*.gitattributes'], { acceptExitCodes: [0, 1] }),
  ]);
  if (stagedEntries.stdout.split(/\r?\n/).some((line) => line.startsWith('160000 '))) {
    const error = new Error('Submodules are not supported by delivery inspection.');
    error.code = 'SUBMODULE_UNSUPPORTED';
    throw error;
  }
  if (localFilters.stdout || attrFilters.stdout) {
    const error = new Error('Git clean/process filters and attributes are not supported.');
    error.code = 'GIT_FILTER_UNSUPPORTED';
    throw error;
  }
  const redirects = await runGit(cwd, ['config', '--get-regexp', '^(url\\..*\\.(insteadof|pushinsteadof)|remote\\..*\\.(uploadpack|receivepack|proxy))$'], { acceptExitCodes: [0, 1] });
  if (redirects.stdout) throw Object.assign(new Error('Remote overrides are not supported'), { code: 'UNSAFE_REMOTE_URL' });
}

export function validateDeliveryFiles(files, changes, sourcePath) {
  if (files === undefined || files === null) {
    return [];
  }
  if (!Array.isArray(files)) {
    const error = new Error('files must be an array');
    error.code = 'INVALID_DELIVERY_FILES';
    throw error;
  }
  const changePaths = new Set(changes.map((c) => c.path.replace(/\\/g, '/')));
  const seen = new Set();
  for (const item of changes) {
    if (item.pairedPath && files.includes(item.path) && !files.includes(item.pairedPath)) {
      throw Object.assign(new Error('Select both paths of a rename'), { code: 'INVALID_DELIVERY_FILES' });
    }
  }

  for (const file of files) {
    if (typeof file !== 'string' || !file.trim()) {
      const error = new Error('File path in files must be a non-empty string');
      error.code = 'INVALID_DELIVERY_FILES';
      throw error;
    }
    const normalized = file.replace(/\\/g, '/');
    if (path.isAbsolute(file) || /^[a-zA-Z]:/.test(file)) {
      const error = new Error(`Absolute paths are not allowed in files: ${file}`);
      error.code = 'INVALID_DELIVERY_FILES';
      throw error;
    }
    if (file.includes('..') || path.posix.normalize(normalized).startsWith('..')) {
      const error = new Error(`Path traversal is not allowed in files: ${file}`);
      error.code = 'INVALID_DELIVERY_FILES';
      throw error;
    }
    if (/[*?[\]:]/.test(file)) {
      const error = new Error(`Pathspec magic characters are not allowed in files: ${file}`);
      error.code = 'INVALID_DELIVERY_FILES';
      throw error;
    }
    if (seen.has(normalized)) {
      const error = new Error(`Duplicate file in files list: ${file}`);
      error.code = 'INVALID_DELIVERY_FILES';
      throw error;
    }
    seen.add(normalized);

    // Symlink escape check
    const fullPath = path.resolve(sourcePath, file);
    try {
      if (existsSync(fullPath)) {
        const canonicalFile = realpathSync(fullPath);
        const canonicalSource = realpathSync(sourcePath);
        const relative = path.relative(canonicalSource, canonicalFile);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          const error = new Error(`Symlink escapes working repository: ${file}`);
          error.code = 'INVALID_DELIVERY_FILES';
          throw error;
        }
      }
    } catch (e) {
      if (e.code === 'INVALID_DELIVERY_FILES') throw e;
    }

    if (!changePaths.has(normalized)) {
      const error = new Error(`File is not in working changes: ${file}`);
      error.code = 'INVALID_DELIVERY_FILES';
      throw error;
    }

    if (isSensitivePath(normalized)) {
      const error = new Error(`Suspected credential or sensitive path rejected: ${file}`);
      error.code = 'SENSITIVE_FILE_REJECTED';
      throw error;
    }
  }

  return [...seen];
}

export function parseConflictsFromMergeTree(output) {
  const tokens = output.split('\0');
  const paths = new Set();
  for (let index = 1; index < tokens.length && tokens[index]; index += 1) {
    const match = /^[0-7]{6} [a-f0-9]+ [123]\t([\s\S]+)$/.exec(tokens[index]);
    if (match) paths.add(match[1]);
  }
  return [...paths].sort();
}

export async function readCommitIdentity(cwd, { globalConfigPath = path.join(os.homedir(), '.gitconfig') } = {}) {
  const values = [];
  for (const key of ['user.name', 'user.email']) {
    let result = await runGit(cwd, ['config', '--local', '--get', key], { acceptExitCodes: [0, 1] });
    if (!result.stdout && existsSync(globalConfigPath)) {
      result = await runGit(cwd, ['config', '--file', globalConfigPath, '--no-includes', '--get', key], { acceptExitCodes: [0, 1] });
    }
    if (!result.stdout || /[\r\n\0]/.test(result.stdout)) throw Object.assign(new Error('Git author identity is not configured'), { code: 'COMMIT_IDENTITY_MISSING' });
    values.push(result.stdout);
  }
  return { GIT_AUTHOR_NAME: values[0], GIT_COMMITTER_NAME: values[0], GIT_AUTHOR_EMAIL: values[1], GIT_COMMITTER_EMAIL: values[1] };
}

async function fileMode(cwd, file) {
  const config = await runGit(cwd, ['config', '--get', 'core.filemode'], { acceptExitCodes: [0, 1] });
  if (config.stdout === 'false') {
    const entry = await runGit(cwd, ['ls-files', '--stage', '--', file]);
    if (/^100755 /.test(entry.stdout)) return '100755';
    return '100644';
  }
  return ((await stat(path.resolve(cwd, file))).mode & 0o111) ? '100755' : '100644';
}

export async function inspectDelivery({ sourcePath, targetPath, files, targetBranch = 'main' }) {
  const [sourceLocation, targetLocation] = await Promise.all([
    readDeliveryLocation(sourcePath),
    readDeliveryLocation(targetPath),
  ]);

  if (!sourceLocation.branch) {
    const error = new Error('Cannot submit from detached HEAD.');
    error.code = 'SOURCE_BRANCH_DETACHED';
    throw error;
  }
  if (sourceLocation.branch === targetBranch) {
    const error = new Error(`Cannot submit from target branch '${targetBranch}'.`);
    error.code = 'SOURCE_BRANCH_MAIN';
    throw error;
  }

  const targetRemote = chooseRemote(targetLocation.remotes, 'target');
  const sourceRemote = chooseRemote(sourceLocation.remotes, 'source');

  await checkUnfinishedGitOperations(sourcePath);
  await checkUnsupportedFeatures(sourcePath);

  const validatedFiles = validateDeliveryFiles(files, sourceLocation.changes, sourcePath);
  if (validatedFiles.length) await readCommitIdentity(sourcePath);
  const fingerprint = await computeContentFingerprint(sourcePath, sourceLocation.head, validatedFiles);

  // Setup temporary cache bare git repository
  const cache = createDeliveryCache();
  const { cachePath } = cache;
  try {
  await runGit(cachePath, ['init', '--bare']);

  // Set alternates to point to sourcePath and targetPath objects
  const [sourceObjDirRes, targetObjDirRes] = await Promise.all([
    runGit(sourcePath, ['rev-parse', '--git-path', 'objects']),
    runGit(targetPath, ['rev-parse', '--git-path', 'objects']),
  ]);
  const sourceObjDir = path.resolve(sourcePath, sourceObjDirRes.stdout);
  const targetObjDir = path.resolve(targetPath, targetObjDirRes.stdout);

  const alternatesFile = path.join(cachePath, 'objects', 'info', 'alternates');
  const alternatesDir = path.dirname(alternatesFile);
  if (!existsSync(alternatesDir)) mkdirSync(alternatesDir, { recursive: true });
  const alternatesContent = `${sourceObjDir.replace(/\\/g, '/')}\n${targetObjDir.replace(/\\/g, '/')}\n`;
  writeFileSync(alternatesFile, alternatesContent, 'utf8');

  // Fetch targetBranch from targetRemote.url
  let targetHead;
  try {
    const lsTargetRes = await runGit(sourcePath, ['ls-remote', targetRemote.url, `refs/heads/${targetBranch}`]);
    if (!lsTargetRes.stdout) {
      const error = new Error(`Target branch '${targetBranch}' not found on remote ${targetRemote.url}`);
      error.code = 'REMOTE_BRANCH_NOT_FOUND';
      throw error;
    }
    targetHead = lsTargetRes.stdout.split(/\s+/)[0];
    await runGit(cachePath, ['fetch', targetRemote.url, `refs/heads/${targetBranch}:refs/heads/target`]);
    if ((await runGit(cachePath, ['rev-parse', 'refs/heads/target'])).stdout !== targetHead) {
      throw Object.assign(new Error('Remote target changed during inspection'), { code: 'REMOTE_TARGET_CHANGED' });
    }
  } catch (err) {
    if (err.code === 'REMOTE_BRANCH_NOT_FOUND') throw err;
    const error = new Error(`Remote target is unreachable: ${err.message}`);
    error.code = 'REMOTE_TARGET_UNREACHABLE';
    throw error;
  }

  // Fetch / check remote source branch
  let remoteSourceHead = null;
  let published = false;
  try {
    const lsSourceRes = await runGit(sourcePath, ['ls-remote', sourceRemote.url, `refs/heads/${sourceLocation.branch}`]);
    if (lsSourceRes.stdout) {
      remoteSourceHead = lsSourceRes.stdout.split(/\s+/)[0];
      await runGit(cachePath, ['fetch', sourceRemote.url, `refs/heads/${sourceLocation.branch}:refs/heads/remote_source`], { acceptExitCodes: [0] });
      if ((await runGit(cachePath, ['rev-parse', 'refs/heads/remote_source'])).stdout !== remoteSourceHead) {
        throw Object.assign(new Error('Remote source changed during inspection'), { code: 'REMOTE_SOURCE_MISMATCH' });
      }
    }
  } catch (err) {
    const error = new Error(`Remote source is unreachable: ${err.message}`);
    error.code = 'REMOTE_SOURCE_UNREACHABLE';
    throw error;
  }

  // Check remote source ahead / diverged
  if (remoteSourceHead) {
    const isLocalAhead = await runGit(cachePath, ['merge-base', '--is-ancestor', remoteSourceHead, sourceLocation.head], { acceptExitCodes: [0, 1, 128] });
    if (isLocalAhead.exitCode !== 0) {
      const isRemoteAhead = await runGit(cachePath, ['merge-base', '--is-ancestor', sourceLocation.head, remoteSourceHead], { acceptExitCodes: [0, 1, 128] });
      if (isRemoteAhead.exitCode === 0) {
        const error = new Error('Remote source branch is ahead of local branch.');
        error.code = 'REMOTE_SOURCE_AHEAD';
        throw error;
      } else {
        const error = new Error('Remote source branch has diverged from local branch.');
        error.code = 'REMOTE_SOURCE_DIVERGED';
        throw error;
      }
    }
  }

  // Check common ancestor between source head and target head
  const commonAncestorRes = await runGit(cachePath, ['merge-base', targetHead, sourceLocation.head], { acceptExitCodes: [0, 1] });
  if (commonAncestorRes.exitCode !== 0 || !commonAncestorRes.stdout) {
    const error = new Error('Source branch and target branch have no common ancestor.');
    error.code = 'NO_COMMON_ANCESTOR';
    throw error;
  }

  // Create candidate tree and candidate commit in cachePath
  let candidateTree;
  let candidateCommit;
  const tempIndex = path.join(cachePath, 'temp_idx');
  const cacheEnv = { GIT_INDEX_FILE: tempIndex };

  if (validatedFiles.length === 0) {
    const headTreeRes = await runGit(cachePath, ['rev-parse', `${sourceLocation.head}^{tree}`]);
    candidateTree = headTreeRes.stdout;
    candidateCommit = sourceLocation.head;
  } else {
    await runGit(cachePath, ['read-tree', sourceLocation.head], { env: cacheEnv });

    for (const file of validatedFiles) {
      const fullPath = path.resolve(sourcePath, file);
      if (existsSync(fullPath)) {
        const hashRes = await runGit(sourcePath, ['hash-object', '-w', '--path', file, fullPath], { env: { GIT_OBJECT_DIRECTORY: path.join(cachePath, 'objects') } });
        const blobSha = hashRes.stdout;
        const mode = await fileMode(sourcePath, file);
        await runGit(cachePath, ['update-index', '--add', '--cacheinfo', `${mode},${blobSha},${file}`], { env: cacheEnv });
      } else {
        await runGit(cachePath, ['update-index', '--force-remove', '--', file], { env: cacheEnv });
      }
    }

    const treeRes = await runGit(cachePath, ['write-tree'], { env: cacheEnv });
    candidateTree = treeRes.stdout;

    const commitRes = await runGit(cachePath, [
      'commit-tree', candidateTree, '-p', sourceLocation.head, '-m', 'Temporary candidate commit for inspection',
    ], {
      env: {
        GIT_AUTHOR_NAME: 'UGK Inspector',
        GIT_AUTHOR_EMAIL: 'inspector@ugk.invalid',
        GIT_COMMITTER_NAME: 'UGK Inspector',
        GIT_COMMITTER_EMAIL: 'inspector@ugk.invalid',
      },
    });
    candidateCommit = commitRes.stdout;
  }

  // Set refs in cachePath
  await runGit(cachePath, ['update-ref', 'refs/heads/source', candidateCommit]);
  await runGit(cachePath, ['update-ref', 'refs/heads/target', targetHead]);

  if (remoteSourceHead && remoteSourceHead === candidateCommit) {
    published = true;
  }

  // Perform merge-tree
  const mergeTreeRes = await runGit(cachePath, [
    'merge-tree', '--write-tree', '-z', 'refs/heads/target', 'refs/heads/source',
  ], { acceptExitCodes: [0, 1], raw: true });

  let relation;
  let conflicts = [];
  let fastForward = false;

  if (mergeTreeRes.exitCode === 1) {
    relation = 'conflict';
    conflicts = parseConflictsFromMergeTree(mergeTreeRes.stdout);
    fastForward = false;
  } else {
    const mergeResultTree = mergeTreeRes.stdout.split(/[\0\r\n]/)[0].trim();
    const targetTreeRes = await runGit(cachePath, ['rev-parse', `${targetHead}^{tree}`]);
    const targetTree = targetTreeRes.stdout;

    const isSourceAncestorOfTarget = await runGit(cachePath, ['merge-base', '--is-ancestor', candidateCommit, targetHead], { acceptExitCodes: [0, 1] });

    if (candidateCommit === targetHead || isSourceAncestorOfTarget.exitCode === 0 || mergeResultTree === targetTree) {
      relation = 'already_integrated';
      conflicts = [];
      const ffCheck = await runGit(cachePath, ['merge-base', '--is-ancestor', targetHead, candidateCommit], { acceptExitCodes: [0, 1] });
      fastForward = candidateCommit === targetHead || ffCheck.exitCode === 0;
    } else {
      relation = 'clean';
      conflicts = [];
      const ffCheck = await runGit(cachePath, ['merge-base', '--is-ancestor', targetHead, candidateCommit], { acceptExitCodes: [0, 1] });
      fastForward = ffCheck.exitCode === 0;
    }
  }

  const inspection = {
    head: sourceLocation.head,
    branch: sourceLocation.branch,
    files: validatedFiles,
    fingerprint,
    candidateTree,
    sourceRemote,
    targetRemote,
    targetBranch,
    targetHead,
    remoteSourceHead,
    relation,
    conflicts,
    fastForward,
    published,
    cachePath,
    cacheOwner: cache.cacheOwner,
    indexEntries: (await runGit(sourcePath, ['ls-files', '--stage', '-z'], { raw: true })).stdout,
  };

  return JSON.parse(JSON.stringify(inspection));
  } catch (error) { discardDeliveryCache(cache); throw error; }
}

export async function saveDelivery({ sourcePath, inspection, commandId, summary, beforeWrite = () => {}, afterRefUpdate = () => {} }) {
  let current = await readDeliveryLocation(sourcePath, { files: inspection.files });
  if (current.branch !== inspection.branch) throw Object.assign(new Error('Source branch changed'), { code: 'BRANCH_MISMATCH' });
  let recoveredCommit = null;
  if (current.head !== inspection.head) {
    const metadata = (await runGit(sourcePath, ['log', '-1', '--format=%P%x00%T%x00%B', current.head])).stdout.split('\0');
    if (metadata[0] !== inspection.head || metadata[1] !== inspection.candidateTree
      || !metadata.slice(2).join('\0').split(/\r?\n/).some((line) => line === `UGK-Cockpit-Command: ${commandId}`)) {
      throw Object.assign(new Error('Source commit changed'), { code: 'HEAD_MOVED' });
    }
    recoveredCommit = current.head;
  } else if (current.fingerprint !== inspection.fingerprint) {
    throw Object.assign(new Error('Source contents changed'), { code: 'SOURCE_CONTENT_CHANGED' });
  }
  if (!inspection.files.length) return { sourceCommit: current.head, localSaved: true };
  const indexPath = path.resolve(sourcePath, (await runGit(sourcePath, ['rev-parse', '--git-path', 'index'])).stdout);
  const temporary = mkdtempSync(path.join(path.dirname(indexPath), 'ugk-delivery-save-'));
  const temporaryIndex = path.join(temporary, 'index');
  const env = { GIT_INDEX_FILE: temporaryIndex, GIT_LITERAL_PATHSPECS: '1' };
  let indexLock;
  let savedCommit = recoveredCommit;
  try {
    indexLock = acquireDeliveryIndexLock(indexPath, commandId);
    current = await readDeliveryLocation(sourcePath, { files: inspection.files });
    if (current.branch !== inspection.branch || current.head !== (recoveredCommit ?? inspection.head)) {
      throw Object.assign(new Error('Source moved before saving'), { code: 'HEAD_MOVED' });
    }
    if (!recoveredCommit && current.fingerprint !== inspection.fingerprint) {
      throw Object.assign(new Error('Source changed before saving'), { code: 'SOURCE_CONTENT_CHANGED' });
    }
    if (!recoveredCommit) {
      assertDeliveryCache(inspection);
      await runGit(sourcePath, ['fetch', '--no-tags', '--no-write-fetch-head', '--', inspection.cachePath, 'refs/heads/source']);
      const cachedTree = (await runGit(inspection.cachePath, ['rev-parse', 'refs/heads/source^{tree}'])).stdout;
      if (cachedTree !== inspection.candidateTree) throw Object.assign(new Error('Inspection objects changed'), { code: 'TREE_MISMATCH' });
    }
    const currentEntries = (await runGit(sourcePath, ['ls-files', '--stage', '-z'], { raw: true })).stdout;
    const treeEntries = (await runGit(sourcePath, ['ls-tree', '-r', '-z', inspection.candidateTree, '--', ...inspection.files], { raw: true, env: { GIT_LITERAL_PATHSPECS: '1' } })).stdout;
    const blobs = new Map(treeEntries.split('\0').filter(Boolean).map((entry) => {
      const tab = entry.indexOf('\t');
      const [mode, type, hash] = entry.slice(0, tab).split(' ');
      if (type !== 'blob' || !['100644','100755'].includes(mode)) throw Object.assign(new Error('Unsupported candidate entry'), { code: 'INVALID_DELIVERY_FILES' });
      return [entry.slice(tab + 1), { mode, hash }];
    }));
    const selectedEntries = (entries) => entries.split('\0').filter((entry) => inspection.files.includes(entry.slice(entry.indexOf('\t') + 1))).sort().join('\0');
    const beforeSelected = selectedEntries(inspection.indexEntries ?? '');
    const afterSelected = [...blobs].map(([file, blob]) => `${blob.mode} ${blob.hash} 0\t${file}`).sort().join('\0');
    if (recoveredCommit && ![beforeSelected, afterSelected].includes(selectedEntries(currentEntries))) {
      throw Object.assign(new Error('Selected index entries changed after commit; not overwriting them'), { code: 'DELIVERY_INDEX_CHANGED' });
    }
    copyFileSync(indexPath, temporaryIndex);
    for (const file of inspection.files) {
      const blob = blobs.get(file);
      if (blob) await runGit(sourcePath, ['update-index', '--add', '--cacheinfo', `${blob.mode},${blob.hash},${file}`], { env });
      else await runGit(sourcePath, ['update-index', '--force-remove', '--', file], { env });
    }
    if (!recoveredCommit) {
      const finalCheck = await readDeliveryLocation(sourcePath, { files: inspection.files });
      if (finalCheck.fingerprint !== inspection.fingerprint || finalCheck.branch !== inspection.branch) {
        throw Object.assign(new Error('Source changed while preparing commit'), { code: 'SOURCE_CONTENT_CHANGED' });
      }
      const headTree = (await runGit(sourcePath, ['rev-parse', `${inspection.head}^{tree}`])).stdout;
      if (headTree === inspection.candidateTree) {
        beforeWrite();
        savedCommit = inspection.head;
      } else {
        const identity = await readCommitIdentity(sourcePath);
        const commit = (await runGit(sourcePath, ['commit-tree', inspection.candidateTree, '-p', inspection.head,
          '-m', summary.trim(), '-m', `UGK-Cockpit-Command: ${commandId}`], { env: identity })).stdout;
        beforeWrite();
        assertDeliveryIndexLock(indexLock);
        await runGit(sourcePath, ['update-ref', `refs/heads/${inspection.branch}`, commit, inspection.head]);
        savedCommit = commit;
        await afterRefUpdate();
      }
    }
    assertDeliveryIndexLock(indexLock);
    renameSync(temporaryIndex, indexPath);
    return { sourceCommit: savedCommit, localSaved: true };
  } catch (error) {
    if (savedCommit) { error.localSaved = true; error.sourceCommit = savedCommit; }
    if (error.code === 'EEXIST') error.code = 'DELIVERY_INDEX_LOCKED';
    throw error;
  } finally {
    if (indexLock !== undefined) releaseDeliveryIndexLock(indexLock);
    rmSync(temporary, { recursive: true, force: true });
  }
}


export async function pushDelivery({ sourcePath, inspection, sourceCommit, beforeWrite = () => {} }) {
  const current = await readDeliveryLocation(sourcePath);
  const remote = current.remotes.find((item) => item.name === inspection.sourceRemote.name);
  if (!remote || remote.identity !== inspection.sourceRemote.identity || remote.url !== inspection.sourceRemote.url) {
    throw Object.assign(new Error('Push destination changed'), { code: 'REMOTE_IDENTITY_CHANGED' });
  }
  if (current.head !== sourceCommit) {
    const error = new Error(`Current HEAD (${current.head}) does not match sourceCommit (${sourceCommit})`);
    error.code = 'SOURCE_COMMIT_MISMATCH';
    throw error;
  }
  if (current.branch !== inspection.branch) {
    const error = new Error(`Current branch (${current.branch}) does not match inspection branch (${inspection.branch})`);
    error.code = 'BRANCH_MISMATCH';
    throw error;
  }

  try {
    const lsRes = await runGit(sourcePath, ['ls-remote', inspection.sourceRemote.url, `refs/heads/${inspection.branch}`]);
    const remoteSha = lsRes.stdout ? lsRes.stdout.split(/\s+/)[0] : null;
    if (remoteSha === sourceCommit) {
      return { pushed: true };
    }
  } catch (err) {
    const error = new Error(`Remote source is unreachable: ${err.message}`);
    error.code = 'REMOTE_SOURCE_UNREACHABLE';
    throw error;
  }

  beforeWrite();
  try { await runGit(sourcePath, ['push', '--', inspection.sourceRemote.url, `${sourceCommit}:refs/heads/${inspection.branch}`]); }
  catch (cause) { throw Object.assign(new Error('Normal push could not be confirmed', { cause }), { code: 'DELIVERY_PUSH_FAILED' }); }

  return { pushed: true };
}

export async function verifyDeliveryRemote({ sourcePath, inspection, sourceCommit }) {
  const current = await readDeliveryLocation(sourcePath);
  const currentSourceRemote = current.remotes.find((r) => r.name === inspection.sourceRemote.name)
    ?? (current.remotes.length === 1 ? current.remotes[0] : null);

  if (!currentSourceRemote || currentSourceRemote.identity !== inspection.sourceRemote.identity) {
    const error = new Error('Remote source identity has changed since inspection');
    error.code = 'REMOTE_IDENTITY_CHANGED';
    throw error;
  }

  let latestSourceSha;
  try {
    const lsSource = await runGit(sourcePath, ['ls-remote', currentSourceRemote.url, `refs/heads/${inspection.branch}`]);
    latestSourceSha = lsSource.stdout ? lsSource.stdout.split(/\s+/)[0] : null;
  } catch (err) {
    const error = new Error(`Remote source is unreachable: ${err.message}`);
    error.code = 'REMOTE_SOURCE_UNREACHABLE';
    throw error;
  }

  if (latestSourceSha !== sourceCommit) {
    const error = new Error(`Remote source branch SHA (${latestSourceSha}) does not match expected sourceCommit (${sourceCommit})`);
    error.code = 'REMOTE_SOURCE_MISMATCH';
    throw error;
  }

  let latestTargetSha;
  try {
    const lsTarget = await runGit(sourcePath, ['ls-remote', inspection.targetRemote.url, `refs/heads/${inspection.targetBranch}`]);
    latestTargetSha = lsTarget.stdout ? lsTarget.stdout.split(/\s+/)[0] : null;
  } catch (err) {
    const error = new Error(`Remote target is unreachable: ${err.message}`);
    error.code = 'REMOTE_TARGET_UNREACHABLE';
    throw error;
  }

  if (latestTargetSha !== inspection.targetHead) {
    const error = new Error(`Remote target branch has changed from ${inspection.targetHead} to ${latestTargetSha}`);
    error.code = 'REMOTE_TARGET_CHANGED';
    throw error;
  }

  return { ok: true };
}
