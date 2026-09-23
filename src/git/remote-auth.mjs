import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let managerPath;

// Reuse the host's installed Git for Windows credential manager, never a
// repository-provided helper or shell snippet. Credentials stay inside Git/GCM.
//
// git resolves a credential.helper value that is not an absolute path as
// `git-credential-<value>`, and it runs whatever it does resolve through a
// shell. The default Git for Windows location is `C:/Program Files/Git/...`,
// so neither of the obvious shapes works:
//
//   credential.helper="D:/.../git-credential-manager.exe"
//     -> the leading quote means the value is not a path at all, so git looks
//        for a helper named `credential-"D:/..."` and reports
//        "'credential-D:/...' is not a git command". The helper never runs,
//        and because SAFE_GIT_PREFIX already emptied the helper list, every
//        authenticated HTTPS fetch/push/ls-remote then fails with
//        "could not read Username" while the caller is told it is a network
//        problem.
//   credential.helper=D:/Program Files/.../git-credential-manager.exe
//     -> git runs it as a shell command line, which splits at the space.
//
// The form git documents for "run this exact executable" is the `!` shell
// prefix with the path shell-quoted; that launches Git Credential Manager
// for both spaced and unquoted install paths.
const SHELL_SAFE_PATH = /^[A-Za-z0-9_ .+\-:@/\\]+$/;

async function detectCredentialManager() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = await execFileAsync('git', ['--exec-path'], {
    cwd: process.env.SystemRoot ?? 'C:\\Windows',
    env,
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
  });
  const execPath = result.stdout.trim();
  if (!path.isAbsolute(execPath) || /["\r\n]/.test(execPath)) return null;
  const candidate = path.resolve(execPath, '../../bin/git-credential-manager.exe');
  if (!existsSync(candidate)) return null;
  const normalised = candidate.replace(/\\/g, '/');
  // Anything outside the allowlist is refused rather than interpolated into a
  // shell command line, so an unexpected install path cannot inject.
  return SHELL_SAFE_PATH.test(normalised) ? normalised : null;
}

export async function remoteAuthArguments(args, platform = process.platform) {
  if (platform !== 'win32' || !args.some((arg) => ['fetch', 'push', 'ls-remote'].includes(arg))) return [];
  if (!managerPath) {
    const probe = detectCredentialManager();
    managerPath = probe;
    // Only a successful detection is memoised. Caching a miss for the life of
    // the process would turn one transient failure -- git --exec-path timing
    // out, or the helper not being installed yet -- into permanently disabled
    // authentication with nothing recorded about it.
    probe.then((value) => { if (!value) managerPath = null; }, () => { managerPath = null; });
  }
  const manager = await managerPath;
  return manager ? ['-c', `credential.helper=!"${manager}"`] : [];
}
