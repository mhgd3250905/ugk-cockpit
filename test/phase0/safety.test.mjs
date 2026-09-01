import assert from 'node:assert/strict';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { authorizeExistingPath, revalidateAuthorizedPath } from '../../src/core/path-guard.mjs';
import { acquireInstanceLock } from '../../src/core/single-instance.mjs';

test('path guard accepts a normal path inside the granted root', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = path.join(root, 'project');
  mkdirSync(child);
  const binding = authorizeExistingPath(child, root);
  assert.equal(revalidateAuthorizedPath(binding), binding.candidateReal);
});

test('path guard normalizes dot segments, case variants, and long paths', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-long-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let child = root;
  for (let index = 0; index < 12; index += 1) {
    child = path.join(child, `segment-${index}-${'x'.repeat(16)}`);
  }
  mkdirSync(child, { recursive: true });
  const withDotSegments = path.join(child, '..', path.basename(child));
  const binding = authorizeExistingPath(withDotSegments, root);
  assert.equal(revalidateAuthorizedPath(binding), binding.candidateReal);
  if (process.platform === 'win32') {
    const caseVariant = `${root[0].toLowerCase()}${root.slice(1)}`;
    assert.equal(authorizeExistingPath(child, caseVariant).candidateReal, binding.candidateReal);
  }
});

test('path guard rejects a path outside the granted root', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-root-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  assert.throws(() => authorizeExistingPath(outside, root), { code: 'PATH_OUTSIDE_SCOPE' });
});

test('path guard rejects a junction or symlink even when its target exists', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-link-root-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-link-target-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(path.join(outside, 'secret.txt'), 'fixture only');
  const link = path.join(root, 'jump');
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => authorizeExistingPath(link, root), { code: 'PATH_OUTSIDE_SCOPE' });
});

test('path guard rejects a selected root that is itself a junction or symlink', (t) => {
  const container = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-link-container-'));
  const target = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-link-selected-target-'));
  t.after(() => {
    rmSync(container, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
  const selectedLink = path.join(container, 'selected-link');
  symlinkSync(target, selectedLink, process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(
    () => authorizeExistingPath(selectedLink, selectedLink),
    { code: 'REPARSE_POINT' },
  );
});

test('path guard rejects a selected root below a junction or symlink ancestor', (t) => {
  const container = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-ancestor-link-container-'));
  const target = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-ancestor-link-target-'));
  t.after(() => {
    rmSync(container, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
  const targetChild = path.join(target, 'project');
  mkdirSync(targetChild);
  const ancestorLink = path.join(container, 'opened-link');
  symlinkSync(target, ancestorLink, process.platform === 'win32' ? 'junction' : 'dir');
  const selectedBelowLink = path.join(ancestorLink, 'project');

  assert.throws(
    () => authorizeExistingPath(selectedBelowLink, selectedBelowLink),
    { code: 'REPARSE_POINT' },
  );
});

test('only one live instance owns the lock and a stale lock is recoverable', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'service.lock');
  const first = acquireInstanceLock(lockPath);
  assert.throws(() => acquireInstanceLock(lockPath), { code: 'INSTANCE_ALREADY_RUNNING' });
  first.release();

  writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647 }), 'utf8');
  const recovered = acquireInstanceLock(lockPath);
  recovered.release();
});

test('an old owner cannot delete a replacement owner lock', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-lock-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'service.lock');
  const oldOwner = acquireInstanceLock(lockPath);
  unlinkSync(lockPath);
  const newOwner = acquireInstanceLock(lockPath);
  oldOwner.release();
  assert.throws(() => acquireInstanceLock(lockPath), { code: 'INSTANCE_ALREADY_RUNNING' });
  newOwner.release();
});

test('a partially written live lock cannot be stolen', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-lock-partial-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'service.lock');
  const partialOwner = openSync(lockPath, 'wx');
  writeFileSync(partialOwner, '{', 'utf8');
  assert.throws(() => acquireInstanceLock(lockPath), { code: 'INSTANCE_ALREADY_RUNNING' });
  closeSync(partialOwner);
});
