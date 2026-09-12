import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import '../src/core/exec-guard.mjs';

const execFileAsync = promisify(execFile);

test('exec guard removes the parent cwd from executable resolution on Windows', async (t) => {
  if (process.platform !== 'win32') {
    assert.equal(process.env.NoDefaultCurrentDirectoryInExePath, undefined);
    return;
  }
  assert.equal(process.env.NoDefaultCurrentDirectoryInExePath, '1');

  // Plant a decoy git.exe (hostname copy) in the process cwd. With the guard
  // active, execFile('git') must resolve through PATH to the real git instead
  // of executing the decoy.
  const dir = mkdtempSync(path.join(tmpdir(), 'ugk-exec-guard-'));
  t.after(() => process.chdir(import.meta.dirname));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  copyFileSync(path.join(process.env.SystemRoot, 'System32', 'hostname.exe'), path.join(dir, 'git.exe'));
  process.chdir(dir);

  const { stdout } = await execFileAsync('git', ['--version'], { timeout: 10_000 });
  assert.match(stdout, /^git version/, 'planted git.exe in cwd must not be executed');
});
