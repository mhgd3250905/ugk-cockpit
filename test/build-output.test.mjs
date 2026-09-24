import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'vite';
import viteConfig from '../vite.config.js';

// The workbench reads its assets from dist/web while it runs, and both
// launchers build before they stop the existing service. Vite clears the output
// directory at renderStart — before a single file is written — so with
// emptyOutDir a build that fails halfway leaves the live console with no assets
// at all: the next refresh is a blank page, and the old bundle is gone.

const tmpRoot = () => (process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir()));

function shadowProject(t) {
  const root = mkdtempSync(path.join(tmpRoot(), 'ugk-vite-out-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, 'index.html'),
    '<!doctype html><html><body><script type="module" src="/m.js"></script></body></html>');
  writeFileSync(path.join(src, 'm.js'), 'console.log("cockpit");\n');
  return { root, src, out: path.join(root, 'dist', 'web') };
}

const failingPlugin = {
  name: 'audit-fail-after-empty',
  renderChunk() {
    throw new Error('simulated compile failure after the output directory was cleared');
  },
};

test('a failed web build leaves the serving output directory intact', async (t) => {
  const { src, out } = shadowProject(t);
  await build({
    root: src,
    logLevel: 'silent',
    build: { outDir: out, emptyOutDir: viteConfig.build.emptyOutDir, minify: false },
  });
  const before = readdirSync(out).sort();
  assert.deepEqual(before, ['assets', 'index.html'], 'the shadow project must produce a real bundle');

  await assert.rejects(() => build({
    root: src,
    logLevel: 'silent',
    build: { outDir: out, emptyOutDir: viteConfig.build.emptyOutDir, minify: false },
    plugins: [failingPlugin],
  }));

  assert.deepEqual(readdirSync(out).sort(), before,
    'a build that fails after clearing the output must not leave the running workbench without assets');
});
