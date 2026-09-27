// Gate self-check: `node --test` reports a file that runs zero tests as a pass,
// and a glob that matches nothing exits 0. Both turn a deleted or emptied test
// directory into a green gate, so the runner refuses them before the suite starts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
const targetDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)), target);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

const files = [];
try {
  (function walk(dir) {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        // Same discovery surface as `node --test` with no path arguments: it
        // walks the whole package, so the gate has to as well.
        if (SKIP_DIRS.has(entry)) continue;
        walk(full);
      } else if (entry.endsWith('.test.mjs')) {
        files.push(full);
      }
    }
  })(targetDir);
} catch (error) {
  console.error(`test suite gate: cannot read ${targetDir}: ${error.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`test suite gate: no *.test.mjs found under ${targetDir}`);
  process.exit(1);
}

const empties = files.filter((file) => {
  const source = readFileSync(file, 'utf8');
  // A declaration counts in statement position (indentation allowed, because a
  // comment or a JSDoc line has to start with a marker first): the earlier
  // substring matcher was satisfied by a comment that merely said `test(`.
  // test(), test.serial(), describe.only() and it.skip() all count.
  return !/^\s*(?:export\s+|await\s+)?(?:test|describe|it)(?:\.\w+)*\s*\(/m.test(source);
});
if (empties.length > 0) {
  console.error(`test suite gate: files declaring no test()/describe()/it():\n  ${empties.join('\n  ')}`);
  process.exit(1);
}

console.log(`test suite gate: ${files.length} test file(s) under ${target}, all declaring at least one test`);
