// Prints one JSON line per test file: how many tests that file really
// registers. Executed by scripts/check-test-suite.mjs as a child process so a
// wedged import cannot hang the gate, and so the parent can name the file that
// never reported.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./test-registrar-hooks.mjs', import.meta.url));

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
  process.stdout.write(`${JSON.stringify({
    file,
    registrations: entries.length,
    executable: entries.filter((entry) => !entry.skipped).length,
    skipped: entries.filter((entry) => entry.skipped).length,
    error,
  })}\n`);
}
process.stdout.write(`${JSON.stringify({ summary: true, files: files.length })}\n`);
