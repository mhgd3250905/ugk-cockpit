// Prints one JSON line per test file: how many tests that file really
// registers. Executed by scripts/check-test-suite.mjs as a child process so a
// wedged import cannot hang the gate, and so the parent can name the file that
// never reported.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./registrar-recorder-hooks.mjs', import.meta.url));

const files = process.argv.slice(2);
const registry = [];
globalThis.__UGK_TEST_REGISTRATIONS__ = registry;

for (const file of files) {
  const start = registry.length;
  let error = null;
  try {
    await import(pathToFileURL(file).href);
  } catch (caught) {
    error = `${caught?.code ?? caught?.name ?? 'Error'}: ${String(caught?.message ?? caught).slice(0, 200)}`;
  }
  const entries = registry.slice(start);
  // A `describe` is a container, not a check: counting the suite itself as one of
  // the file's tests would let a group that kept its header and lost its body
  // still look populated.
  const tests = entries.filter((entry) => entry.kind !== 'describe');
  process.stdout.write(`${JSON.stringify({
    file,
    registrations: tests.length,
    suites: entries.length - tests.length,
    executable: tests.filter((entry) => !entry.skipped).length,
    skipped: tests.filter((entry) => entry.skipped).length,
    error,
  })}\n`);
}
process.stdout.write(`${JSON.stringify({ summary: true, files: files.length })}\n`);
