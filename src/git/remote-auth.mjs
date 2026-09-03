import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let managerPath;

// Reuse the host's installed Git for Windows credential manager, never a
// repository-provided helper or shell snippet. Credentials stay inside Git/GCM.
export async function remoteAuthArguments(args, platform = process.platform) {
  if (platform !== 'win32' || !args.some((arg) => ['fetch', 'push', 'ls-remote'].includes(arg))) return [];
  managerPath ??= (async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    const result = await execFileAsync('git', ['--exec-path'], { cwd: process.env.SystemRoot ?? 'C:\\Windows',
      env, windowsHide: true, shell: false, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
    const execPath = result.stdout.trim();
    if (!path.isAbsolute(execPath) || /["\r\n]/.test(execPath)) return null;
    const candidate = path.resolve(execPath, '../../bin/git-credential-manager.exe');
    return existsSync(candidate) ? candidate.replace(/\\/g, '/') : null;
  })().catch(() => null);
  const manager = await managerPath;
  return manager ? ['-c', `credential.helper="${manager}"`] : [];
}
