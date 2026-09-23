// Boundary tests for the containment test in src/core/path-guard.mjs. The
// guard decides which folders the platform may read at all, so a name that
// merely starts with two dots must not be confused with leaving the root.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { authorizeExistingPath, PathScopeError } from '../src/core/path-guard.mjs';

function roots(t) {
  const base = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-path-guard-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const granted = path.join(base, 'granted');
  mkdirSync(granted, { recursive: true });
  writeFileSync(path.join(granted, 'README.md'), '# granted\n');
  return { granted, outside: path.join(base, 'outside') };
}

test('a child whose own name starts with two dots stays inside the grant', (t) => {
  const { granted } = roots(t);
  const dotted = path.join(granted, '..ugk');
  mkdirSync(dotted);
  const binding = authorizeExistingPath(dotted, granted);
  assert.equal(binding.candidateReal, realpathSync.native(dotted));
});

test('walking out of the grant is still refused', (t) => {
  const { granted, outside } = roots(t);
  mkdirSync(outside);
  assert.throws(() => authorizeExistingPath(outside, granted), (error) => {
    assert.ok(error instanceof PathScopeError);
    assert.equal(error.code, 'PATH_OUTSIDE_SCOPE');
    return true;
  });
  assert.throws(() => authorizeExistingPath(path.join(granted, '..', 'outside'), granted),
    { code: 'PATH_OUTSIDE_SCOPE' });
});

test('a dotted-name link inside the grant is inspected like any other link', (t) => {
  const { granted } = roots(t);
  // The target stays inside the grant on purpose: containment alone is not the
  // question here, because the platform refuses to walk through reparse points
  // at all. A name starting with two dots must not skip that inspection.
  const inner = path.join(granted, 'inner');
  mkdirSync(inner);
  writeFileSync(path.join(inner, 'secret.txt'), 'inside the grant, behind a link\n');
  const plain = path.join(granted, 'pointer');
  const dotted = path.join(granted, '..pointer');
  try {
    symlinkSync(inner, plain, 'dir');
    symlinkSync(inner, dotted, 'dir');
  } catch (error) {
    t.skip(`symlink creation is not permitted here (${error.code ?? error.message})`);
    return;
  }
  assert.throws(() => authorizeExistingPath(plain, granted), { code: 'REPARSE_POINT' });
  assert.throws(() => authorizeExistingPath(dotted, granted), { code: 'REPARSE_POINT' });
});
