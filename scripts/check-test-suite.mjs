// Gate self-check: `node --test` reports a file that runs zero tests as a pass,
// and a glob that matches nothing exits 0. Both turn a deleted or emptied test
// directory into a green gate, so the runner refuses them before the suite starts.
//
// Two things are checked, and each is answered by the real engine rather than by
// a pattern that hopes to be one:
//   * WHICH files count — the shapes `node --test` actually discovers, measured
//     on Node 24.15 in a scratch tree with this package's `type: module`.
//   * WHETHER each registers something — by importing the file with `node:test`
//     replaced by a recording stand-in (scripts/test-support/), which runs no
//     test body. The previous check here was a regular expression over source
//     text, and it was satisfied by an indented `test(` inside a `/* ... */`
//     block: measured on this repo, such a file passed the gate while the
//     runner executed zero assertions from it.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/check-test-suite.mjs <test-directory>');
  process.exit(2);
}
// Resolve against this repository, not the caller's working directory: node
// treats a script whose `test` command starts with `node --test` as the test
// runner and fires `pretest` even for a bare `node --test <file>`, which can
// land here from any directory.
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const targetDir = path.resolve(repoRoot, target);

const SKIP_DIRS = new Set(['node_modules']);
// Measured against Node 24.15's own discovery (`node --test` with no paths, in a
// scratch tree carrying this package's `type: module`): it runs `*.test.mjs`,
// `*.test.js`, `*_test.mjs`, `*-test.mjs`, `test-*.mjs`, and every module under a
// directory named `test`. Measured as NOT executed: `*.test.cjs`, `*.spec.mjs`,
// `*-tests.mjs` (plural). It also descends into `dist`/coverage, skips dot
// directories such as `.data`, skips node_modules, and does not follow directory
// links. Deliberately listed only as far as measured: a new shape has to be
// measured here first, because widening on a hunch red-fails on helper files.
// The earlier version listed `.test.mjs` alone while claiming to mirror discovery,
// and two helpers named `test-registrar-*.mjs` were consequently executed by the
// runner as zero-test passes that the gate never saw.
const TEST_SUFFIXES = ['.test.mjs', '.test.js', '_test.mjs', '-test.mjs'];
const TEST_PREFIX = /^test-.+\.(?:mjs|js)$/;

function isRunnerDiscovered(full, insideTestDir) {
  const name = path.basename(full);
  if (insideTestDir) return /\.(?:mjs|js)$/.test(name);
  return TEST_SUFFIXES.some((suffix) => name.endsWith(suffix)) || TEST_PREFIX.test(name);
}

const files = [];
try {
  (function walk(dir, insideTestDir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full, insideTestDir || entry.name === 'test');
      } else if (entry.isFile() && isRunnerDiscovered(full, insideTestDir)) {
        files.push(full);
      }
    }
  })(targetDir, path.basename(targetDir) === 'test');
} catch (error) {
  console.error(`test suite gate: cannot read the test tree: ${error.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`test suite gate: no runner-discovered test file found under ${targetDir}`
    + ' — a renamed or emptied test directory is not a passing gate.');
  process.exit(1);
}

const counter = path.join(repoRoot, 'scripts', 'test-support', 'count-registrations.mjs');
const child = spawnSync(process.execPath, [counter, ...files], {
  encoding: 'utf8', windowsHide: true, timeout: 120_000, cwd: repoRoot,
});
if (child.error) {
  console.error(`test suite gate: could not run the registration counter: ${child.error.message}`);
  process.exit(1);
}

const reported = new Map();
let sawSummary = false;
for (const line of String(child.stdout ?? '').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let entry;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    // The counter prints one JSON object per line; anything else means a test
    // file wrote to stdout while importing, which is its own reportable fact.
    console.error(`test suite gate: unexpected output from the registration counter: ${trimmed.slice(0, 160)}`);
    continue;
  }
  if (entry.summary) { sawSummary = true; continue; }
  reported.set(path.resolve(entry.file), entry);
}

const problems = [];
for (const file of files) {
  const entry = reported.get(file);
  if (!entry) {
    problems.push(`${path.relative(repoRoot, file)}: never reported — the counter stopped here`
      + ` (exit ${child.status ?? 'null'}${child.signal ? `/signal ${child.signal}` : ''});`
      + ' a module that hangs or exits while importing registers nothing anybody can run.');
    continue;
  }
  if (entry.error) {
    problems.push(`${path.relative(repoRoot, file)}: cannot be imported (${entry.error})`);
  } else if (entry.registrations === 0) {
    problems.push(`${path.relative(repoRoot, file)}: registers 0 tests — its assertions never run`
      + ' (an emptied file, a body inside a block comment, or registration over an empty list'
      + ' all look like this; the runner counts such a file as one pass).');
  }
}

if (problems.length > 0) {
  console.error(`test suite gate: ${problems.length} of ${files.length} test file(s) are not executable tests:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

const skipped = [...reported.values()].reduce((sum, entry) => sum + entry.skipped, 0);
const executable = [...reported.values()].reduce((sum, entry) => sum + entry.executable, 0);
// Stated rather than implied: a file whose only registrations are skipped still
// passes here on purpose. Platform skips are written as `test(name, { skip })`,
// which the runner reports as skipped, and a gate that red-failed on them would
// be deleted rather than fixed. The count is printed so "all skipped" stays visible.
console.log(`test suite gate: ${files.length} test file(s) under ${target}, `
  + `${executable} executable registration(s), ${skipped} skipped-by-annotation`);
