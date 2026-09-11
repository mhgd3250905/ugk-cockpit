import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// A positive probe result is cached for the process lifetime. A failure (git
// not on PATH yet, GCM mid-upgrade, transient exec error) is cached only for a
// short window: caching it forever turned one unlucky cold-start probe into
// credential-less pushes until the next service restart.
const NEGATIVE_CACHE_TTL_MS = 60_000;
let cached;
let cachedAt = 0;

async function probeCredentialManager(platform) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = await execFileAsync('git', ['--exec-path'], { cwd: process.env.SystemRoot ?? 'C:\\Windows',
    env, windowsHide: true, shell: false, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  const execPath = result.stdout.trim();
  if (!path.isAbsolute(execPath) || /["\r\n]/.test(execPath)) return null;
  const candidate = path.resolve(execPath, '../../bin/git-credential-manager.exe');
  return existsSync(candidate) ? candidate.replace(/\\/g, '/') : null;
}

// Reuse the host's installed Git for Windows credential manager, never a
// repository-provided helper or shell snippet. Credentials stay inside Git/GCM.
export async function remoteAuthArguments(args, platform = process.platform) {
  if (platform !== 'win32' || !args.some((arg) => ['fetch', 'push', 'ls-remote'].includes(arg))) return [];
  const now = Date.now();
  if (cached === undefined || (cached === null && now - cachedAt > NEGATIVE_CACHE_TTL_MS)) {
    cached = await probeCredentialManager(platform).catch(() => null);
    cachedAt = now;
  }
  return cached ? ['-c', `credential.helper="${cached}"`] : [];
}
