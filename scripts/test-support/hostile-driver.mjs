// Shared fixture support for every test that proves "Git never ran a
// repository-owned driver" by checking that a marker file was NOT created.
//
// Why this exists. Git reports success even when the driver cannot do its work:
// measured on this machine (git 2.50.0.windows.2, Node 24.15) a repository with
// `filter.evil.clean = <missing binary>; printf x` makes `git status` exit 0 and
// print an ordinary `M file.txt` record while the marker is never created. So an
// absence assertion is satisfied both by "the product refused before Git ran" and
// by "this host cannot produce the marker" — the second answer proves nothing.
// A driver body must therefore be proven capable before anything leans on it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// One command, the absolute interpreter path, and forward slashes.
//
// * A single command means the driver's own exit status is what Git sees; the
//   `cmd1; cmd2` shape reports cmd2's status and hides a failed marker write.
// * `process.execPath` removes the dependence on a separate binary being
//   reachable from the shell Git spawns: the `touch "<backslash path>"` body
//   this repository shipped failed to write its marker in 5 of 40 fixture
//   builds here (artifacts/probe-control.log), which is the same rate as the
//   intermittent CI failure it caused.
// * Forward slashes stay literal inside the shell's double quotes; the shipped
//   body relied on a Windows path with backslashes surviving that shell.
export function hostileDriverBody(markerPath) {
  if (typeof markerPath !== 'string' || markerPath.length === 0) {
    throw new Error('hostileDriverBody requires the marker path');
  }
  const target = markerPath.split(path.sep).join('/');
  return `"${process.execPath}" -e "require('fs').writeFileSync('${target}','pwned')"`;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'driver-control@example.invalid']);
  git(dir, ['config', 'user.name', 'Driver Control']);
  return dir;
}

function controlFailure(mode, marker, stderr) {
  const detail = String(stderr ?? '').split(/\r?\n/).filter(Boolean).slice(0, 2).join(' / ');
  const error = new Error(
    `hostile-driver control (${mode}): the marker was not created at ${marker}`
    + `${detail ? ` — git said: ${detail}` : ''}.`
    + ' Every "the filter must not have run" assertion that leans on this body would'
    + ' now pass whether or not the product refused, so the fixture cannot prove'
    + ' anything on this host and refuses to report a pass.',
  );
  error.code = 'HOSTILE_DRIVER_CONTROL_FAILED';
  return error;
}

/**
 * Ask Git, without running anything, whether a path in this repository really
 * resolves to the named driver. `filter.evil.clean = <body>` on its own is inert:
 * no command runs until an attribute source binds `filter=evil` to a path, so a
 * fixture that sets only the config is decorating itself with a driver that Git
 * will never invoke.
 */
export function assertDriverAttributeBound(repo, targetPath, expectedDriver) {
  const report = execFileSync('git', ['check-attr', 'filter', '--', targetPath], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (!report.includes(`filter: ${expectedDriver}`)) {
    const error = new Error(
      `hostile-driver control: ${targetPath} does not resolve to filter=${expectedDriver}`
      + ` (git said ${report.trim() || 'nothing'}). The driver body in this fixture can`
      + ' never run, so any "the filter must not have run" assertion about it is vacuous.',
    );
    error.code = 'HOSTILE_DRIVER_CONTROL_FAILED';
    throw error;
  }
  return report;
}

// A new file under an active clean attribute cannot be hashed without running
// the filter, so this exercises the body in the direction the guards refuse.
// `bodyFor` exists so a test can hand the control a body that is known not to
// write and check that the control notices; product-shaped callers omit it.
export function assertCleanDriverWrites(base, { bodyFor = hostileDriverBody } = {}) {
  const repo = initRepo(path.join(base, 'clean-driver-proof'));
  const marker = path.join(base, 'clean-driver-proof-marker.txt');
  try {
    writeFileSync(path.join(repo, '.gitattributes'), '*.proof filter=proof\n');
    git(repo, ['add', '.gitattributes']);
    git(repo, ['commit', '-qm', 'attributes']);
    git(repo, ['config', '--local', 'filter.proof.clean', bodyFor(marker)]);
    writeFileSync(path.join(repo, 'tracked.proof'), 'content\n');
    git(repo, ['add', 'tracked.proof']);
    if (!existsSync(marker)) throw controlFailure('clean', marker, '');
  } finally {
    rmSync(marker, { force: true });
    rmSync(path.join(base, 'clean-driver-proof'), { recursive: true, force: true });
  }
}

// A body shaped the way this file's fixtures used to be shaped: the marker step
// is one command in a chain, so the shell reports the last command's status and
// Git never learns the write failed. Used only by the control's own test.
export function maskedDriverBody(markerPath) {
  const quoted = process.platform === 'win32' ? `"${markerPath}"` : `'${markerPath}'`;
  return `this-driver-body-does-not-exist ${quoted}; printf x`;
}
