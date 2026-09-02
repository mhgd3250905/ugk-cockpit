import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { VERSION } from '../../src/version.mjs';

test('VERSION, package metadata, and current product docs have one value', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  const packageLock = JSON.parse(
    readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'),
  );
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const phase1 = readFileSync(
    new URL('../../docs/PHASE1_VERTICAL_SLICE.md', import.meta.url),
    'utf8',
  );
  assert.equal(VERSION, packageJson.version);
  assert.equal(VERSION, packageLock.version);
  assert.equal(VERSION, packageLock.packages[''].version);
  const escapedVersion = VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(readme, new RegExp('## 当前版本\\s*\\n\\s*`' + escapedVersion + '`'));
  assert.match(phase1, new RegExp('- `' + escapedVersion + '`：'));
});
