import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkUpdates } from '../skills/cockpit-update/scripts/check-updates.mjs';

function localVersion(t, version) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-update-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'VERSION');
  writeFileSync(file, `${version}\n`);
  return file;
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('update check selects the highest non-draft SemVer release and reports notes', async (t) => {
  const calls = [];
  const result = await checkUpdates({
    versionFile: localVersion(t, '0.1.0-alpha.9'),
    fetchImpl: async (...args) => {
      calls.push(args);
      return response([
        { tag_name: 'v0.1.0-alpha.2', prerelease: true, published_at: '2026-09-01T00:00:00Z', body: 'Older' },
        { tag_name: 'v0.1.0-alpha.10', prerelease: false, published_at: '2026-09-02T00:00:00Z', body: 'Latest notes' },
        { tag_name: 'v9.9.9', draft: true, prerelease: true, body: 'Draft must be ignored' },
        { tag_name: 'not-a-version', body: 'Invalid tag must be ignored' },
      ]);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.currentVersion, '0.1.0-alpha.9');
  assert.equal(result.latestVersion, '0.1.0-alpha.10');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.prerelease, true);
  assert.equal(result.notes, 'Latest notes');
  assert.equal(result.releaseUrl, 'https://github.com/mhgd3250905/ugk-cockpit/releases/tag/v0.1.0-alpha.10');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://api.github.com/repos/mhgd3250905/ugk-cockpit/releases?per_page=100');
  assert.equal(calls[0][1].headers.Accept, 'application/vnd.github+json');
});

test('update check reports when this installation is ahead of the latest release', async (t) => {
  const result = await checkUpdates({
    versionFile: localVersion(t, '0.1.0-alpha.10'),
    fetchImpl: async () => response([{ tag_name: 'v0.1.0-alpha.9', prerelease: true }]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.updateAvailable, false);
  assert.equal(result.currentAheadOfRelease, true);
});

test('update check handles an empty release list without claiming an update', async (t) => {
  const result = await checkUpdates({
    versionFile: localVersion(t, '0.1.0-alpha.9'),
    fetchImpl: async () => response([]),
  });

  assert.deepEqual(
    { ok: result.ok, latestVersion: result.latestVersion, updateAvailable: result.updateAvailable },
    { ok: true, latestVersion: null, updateAvailable: false },
  );
});

test('update check distinguishes network, rate-limit, and malformed-response failures', async (t) => {
  const versionFile = localVersion(t, '0.1.0-alpha.9');
  const network = await checkUpdates({ versionFile, fetchImpl: async () => { throw new Error('offline'); } });
  const limited = await checkUpdates({ versionFile, fetchImpl: async () => response(null, 403) });
  const malformed = await checkUpdates({ versionFile, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });

  assert.equal(network.code, 'NETWORK_UNAVAILABLE');
  assert.equal(limited.code, 'GITHUB_RATE_LIMITED');
  assert.equal(malformed.code, 'INVALID_GITHUB_RESPONSE');
});

test('update check rejects a local SemVer prerelease identifier with a leading zero', async (t) => {
  let requested = false;
  const result = await checkUpdates({
    versionFile: localVersion(t, '0.1.0-alpha.01'),
    fetchImpl: async () => { requested = true; return response([]); },
  });

  assert.equal(result.code, 'INVALID_LOCAL_VERSION');
  assert.equal(requested, false);
});
