// Shared fixture support for every test that proves "Git never ran a
// repository-owned driver" by checking that a marker file was NOT created.
//
// Why this exists, measured on this machine (git 2.50.0.windows.2, Node 24.15):
// Git does not surface a repository driver's failure at all. A clean filter whose
// body is missing, exits non-zero, or cannot write its marker still leaves
// `git status` and `git add` at exit 0 with ordinary output; only
// `filter.<name>.required = true` makes Git report `external filter ... failed`
// (auditlogs/probe-exitcode.log). So "the marker is absent" — the shape every
// guard test in this family asserts — is equally satisfied by "the product refused
// before Git ran" and by "this host cannot produce the marker", and the second
// answer proves nothing. A driver must therefore be proven capable, in the very
// repository under test, before anything leans on its marker being absent.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// AGENTS.md asks every git probe for argv, an explicit cwd, a timeout and an
// output bound; that rule applies to fixture git too, because one hung filter
// child under `--test-concurrency=1` stops the whole gate.
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const MARKER_VISIBLE_TIMEOUT_MS = 2_000;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

export function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A repository with an identity set locally, so ambient git config is not needed. */
export function initFixtureRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'driver-control@example.invalid']);
  git(dir, ['config', 'user.name', 'Driver Control']);
  return dir;
}

// sh treats a single-quoted argument as literal, so only a `'` needs escaping;
// double quotes would let `$` and backticks expand inside a profile path.
function shellSingleQuote(value) {
  return `'${String(value).split("'").join(`'\\''`)}'`;
}

/**
 * A driver body that stays correct for hostile marker paths.
 *
 * Two rules, both from measurement rather than from theory:
 * * No external binary. The interpreter is addressed by absolute path, so the
 *   proof never depends on what happens to be first on PATH — the `touch` body
 *   this repository shipped failed to write its marker in 5 of 40 fixture builds
 *   here, which is what made main's CI intermittently red.
 * * The marker path is carried base64-encoded. Splicing a Windows temp path into
 *   a single-quoted JavaScript literal inside a double-quoted shell argument
 *   failed silently on a path containing an apostrophe, `$`, a backtick or a
 *   space: `git add` still reported success and no marker was written.
 *
 * A single command is NOT what makes Git notice a failure — it does not, unless
 * `filter.<name>.required = true` is set. Capability has to be proven by the
 * controls below, never inferred from an exit code.
 */
export function hostileDriverBody(markerPath) {
  if (typeof markerPath !== 'string' || markerPath.length === 0) {
    throw new Error('hostileDriverBody requires the marker path');
  }
  const encoded = Buffer.from(markerPath, 'utf8').toString('base64');
  return `${shellSingleQuote(process.execPath)} -e `
    + `"require('fs').writeFileSync(Buffer.from('${encoded}','base64').toString(),'pwned')"`;
}

// A body shaped the way this repository's fixtures used to be shaped: the marker
// step is one command in a chain and the chain ends with something that always
// succeeds, so the filter fabricates output while its real work failed. Used only
// by the control's own test.
export function maskedDriverBody(markerPath) {
  return `this-driver-body-does-not-exist ${shellSingleQuote(markerPath)}; printf x`;
}

function markerAppeared(marker) {
  const deadline = Date.now() + MARKER_VISIBLE_TIMEOUT_MS;
  for (;;) {
    if (existsSync(marker)) return true;
    if (Date.now() >= deadline) return false;
    sleepMs(20);
  }
}

function assertDriverMarkerProduced(marker) {
  if (!markerAppeared(marker)) {
    throw controlFailure(`the clean driver did not create its marker at ${marker}`);
  }
}

function removeQuietly(target) {
  // Retries because a just-exited filter child can keep the handle on Windows; a
  // leak is reported rather than swallowed, and it must never displace the
  // control's own error.
  try {
    rmSync(target, { force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    process.stderr.write(`hostile-driver control: could not remove ${target} (${error.code ?? error.message})\n`);
  }
}

/**
 * Ask Git, without running anything, which driver name a path resolves to, and
 * require that exact name.
 *
 * `filter.evil.clean = <body>` alone is inert: no command runs until an attribute
 * source binds `filter=evil` to a path. And a prefix comparison is not an
 * equality check — measured, a repository bound to `filter=evil2` satisfied
 * `report.includes('filter: evil')`, so the control that exists to rule out
 * vacuity passed for a different driver.
 */
export function assertDriverAttributeBound(repo, targetPath, expectedDriver) {
  const report = git(repo, ['check-attr', 'filter', '--', targetPath]);
  const line = report.split(/\r?\n/)
    .find((entry) => entry.startsWith(`${targetPath}: filter:`));
  if (!line) {
    throw controlFailure(
      `git check-attr returned no answer for ${targetPath} (output: ${report || '<empty>'})`,
    );
  }
  const resolved = /:\s*filter:\s*(.*)$/.exec(line)?.[1]?.trim();
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
 * The control file is staged only to force the filter and is un-staged and removed
 * again, so the repository handed to the product is the repository the fixture
 * describes; an undo that fails is itself a control failure, because leaving a
 * staged entry would change what the product then reads.
 */
export function assertCleanDriverRunsHere(repo, marker) {
  const controlFile = 'hostile-driver-control.txt';
  writeFileSync(path.join(repo, controlFile), 'control\n');
  rmSync(marker, { force: true });
  let failure = null;
  try {
    git(repo, ['add', '--', controlFile]);
    assertDriverMarkerProduced(marker);
  } catch (error) {
    failure = error;
  } finally {
    try {
      // `git reset` unstages and leaves the file in the working tree, so what has
      // to be proven is that nothing is staged any more; the file itself is
      // removed below.
      git(repo, ['reset', '-q', '--', controlFile]);
      if (git(repo, ['ls-files', '--', controlFile])) {
        failure ??= controlFailure(`the control file ${controlFile} is still staged after the undo`);
      }
    } catch (error) {
      failure ??= controlFailure(`unstaging the control file failed (${error.message})`);
    }
    removeQuietly(path.join(repo, controlFile));
    removeQuietly(marker);
  }
  if (failure) throw failure;
}
