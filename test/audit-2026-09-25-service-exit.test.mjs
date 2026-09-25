import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tmpRoot = () => (process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir()));

// main.mjs documents its last-resort guards as "log what happened, then shut
// down through the normal path". Registering an unhandledRejection listener
// suppresses Node's default throw, so if the handler only logs, a service whose
// async work escaped the per-request catch-all keeps running in a half-broken
// state while still answering HTTP 200 — which AGENTS.md forbids reading as
// success.
test('an escaped unhandled rejection takes the service down through the normal stop path', async (t) => {
  const root = mkdtempSync(path.join(tmpRoot(), 'ugk-reject-exit-'));
  const dataDir = path.join(root, 'data');
  const injectPath = path.join(root, 'inject.mjs');
  writeFileSync(injectPath, `
setTimeout(() => {
  (async () => { throw new Error('fixture: async failure outside every handler'); })();
}, 400);
`, 'utf8');

  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });

  const child = spawn(process.execPath, [
    `--import=${pathToFileURL(injectPath).href}`,
    path.join(repoRoot, 'src', 'main.mjs'),
    '--data-directory', dataDir,
    '--port', String(port),
  ], { cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });

  let stderrText = '';
  child.stderr.on('data', (chunk) => { stderrText += chunk; });

  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 15_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ timedOut: false, code });
    });
  });

  assert.equal(outcome.timedOut, false,
    `the service must stop itself instead of serving a broken state; stderr:\n${stderrText}`);
  assert.equal(outcome.code, 1, `stderr:\n${stderrText}`);
  assert.match(stderrText, /unhandled rejection/, `stderr:\n${stderrText}`);
  assert.equal(existsSync(path.join(dataDir, 'service.lock')), false,
    'stop() must still release the instance lock');
  assert.ok(statSync(path.join(dataDir, 'cockpit.db')).size > 0,
    'the data directory stays intact for the next start');
});
