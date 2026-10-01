// Shared fixture support for every test that proves "Git never ran a
// repository-owned driver" by checking that a marker file was NOT created.
//
// Why this exists. Git reports success even when the driver cannot do its work:
// measured on this machine (git 2.50.0.windows.2, Node 24.15), a repository whose
// `filter.evil.clean` is a chained body that cannot write its marker still makes
// `git status` exit 0 and print an ordinary `M file.txt` record. So an absence
// assertion is satisfied both by "the product refused before Git ran" and by
// "this host cannot produce the marker" — and the second answer proves nothing.
// A driver body must therefore be proven capable before anything leans on it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// sh treats a single-quoted argument as literal, so only a `'` needs escaping;
// double quotes would let `$` and backticks expand inside a profile path.
function shellSingleQuote(value) {
  return `'${String(value).split("'").join(`'\\''`)}'`;
}

/**
 * A driver body that stays correct for hostile marker paths.
 *
 * The interpreter is addressed absolutely (`process.execPath`) rather than as
 * `node`, so the proof does not depend on what happens to be first on PATH. The
 * marker path is carried base64-encoded: measured on this machine, the previous
 * shape — the path spliced into a single-quoted JavaScript literal inside a
 * double-quoted shell argument — failed silently on a temp path containing an
 * apostrophe, dollar sign and backtick (`git add` still succeeded, no marker was
 * written), which is the same masking this file exists to prevent.
 */
export function hostileDriverBody(markerPath) {
  if (typeof markerPath !== 'string' || markerPath.length === 0) {
    throw new Error('hostileDriverBody requires the marker path');
  }
  const encoded = Buffer.from(markerPath, 'utf8').toString('base64');
  return `${shellSingleQuote(process.execPath)} -e `
    + `"require('fs').writeFileSync(Buffer.from('${encoded}','base64').toString(),'pwned')"`;
}

export function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A repository with an identity set locally, so ambient git config is not needed. */
export function initFixtureRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'driver-control@example.invalid']);
  git(dir, ['config', 'user.name', 'Driver Control']);
  return dir;
}

function controlFailure(claim) {
  const error = new Error(
    `hostile-driver control: ${claim}.`
    + ' Every "the filter must not have run" assertion that leans on this fixture would'
    + ' now pass whether or not the product refused, so the fixture cannot prove'
    + ' anything on this host and refuses to report a pass.',
  );
  error.code = 'HOSTILE_DRIVER_CONTROL_FAILED';
  return error;
}

export function assertDriverMarkerProduced(marker, mode = 'clean') {
  if (!existsSync(marker)) {
    throw controlFailure(`${mode} driver did not create its marker at ${marker}`);
  }
  return marker;
}

/**
 * Ask Git, without running anything, which driver name a path resolves to, and
 * require that exact name.
 *
 * `filter.evil.clean = <body>` alone is inert: no command runs until an attribute
 * source binds `filter=evil` to a path. Comparing the answer by prefix would let
 * a repository bound to a *different, longer* driver name (measured:
 * `file.txt: filter: evil2` satisfies `includes('filter: evil')`) pass the very
 * control that exists to rule out vacuity.
 */
export function assertDriverAttributeBound(repo, targetPath, expectedDriver) {
  const report = git(repo, ['check-attr', 'filter', '--', targetPath]);
  const line = report.split(/\r?\n/)
    .find((entry) => entry.startsWith(`${targetPath}: filter:`));
  const resolved = line ? line.slice(line.indexOf('filter:') + 'filter:'.length).trim() : undefined;
  if (resolved !== expectedDriver) {
    throw controlFailure(
      `${targetPath} resolves to filter=${resolved ?? '<unset>'} in this repository, not filter=${expectedDriver}`,
    );
  }
  return resolved;
}

/**
 * Run the repository's own clean driver through the one trigger Git cannot skip:
 * hashing a brand-new file for `git add` has to pass it through the clean filter
 * to compute the blob at all. Whether a read-only `git status` re-cleans is a stat
 * cache decision and is measurably unreliable, so nothing in this family asserts
 * that.
 *
 * The staged control file is untracked before and after, so the repository the
 * product is shown is the repository the fixture described.
 */
export function assertCleanDriverRunsHere(repo, marker, { controlFile = 'hostile-driver-control.txt' } = {}) {
  writeFileSync(path.join(repo, controlFile), 'control\n');
  rmSync(marker, { force: true });
  try {
    git(repo, ['add', '--', controlFile]);
    assertDriverMarkerProduced(marker, 'clean');
  } finally {
    // Cleanup is allowed to fail without replacing the control's own error, but
    // it must not hide a leaked directory: Windows keeps recently spawned filter
    // children holding handles for a moment, hence the retries.
    try {
      git(repo, ['reset', '-q', '--', controlFile]);
    } catch {}
    rmSync(path.join(repo, controlFile), { force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(marker, { force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// A body shaped the way this repository's fixtures used to be shaped: the marker
// step is one command in a chain, so the shell reports the last command's status
// and Git never learns the write failed. Used only by the control's own test.
export function maskedDriverBody(markerPath) {
  return `this-driver-body-does-not-exist ${shellSingleQuote(markerPath)}; printf x`;
}
