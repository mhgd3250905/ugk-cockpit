import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { git } from '../src/git/probe.mjs';

test('git() maps stdio maxBuffer overflow to the diagnosable GIT_BUFFER_LIMIT_EXCEEDED code', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-probe-buffer-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const gitSync = (args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  gitSync(['init', '-b', 'main']);
  gitSync(['config', 'user.name', 'Probe']);
  gitSync(['config', 'user.email', 'probe@localhost']);
  writeFileSync(path.join(root, 'long-output.txt'), 'x'.repeat(4096));
  gitSync(['add', '.']);
  gitSync(['commit', '-m', 'first']);

  await assert.rejects(
    git(root, ['show', 'HEAD', '--stat'], { maxBuffer: 64 }),
    { code: 'GIT_BUFFER_LIMIT_EXCEEDED' },
  );
});
