import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { VERSION } from '../../src/version.mjs';

test('VERSION and package metadata have one value', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(VERSION, packageJson.version);
});

