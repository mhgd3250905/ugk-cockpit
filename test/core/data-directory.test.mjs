import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { resolveDataDirectory } from '../../src/core/data-directory.mjs';

test('an explicit --data-directory wins and must be absolute', () => {
  assert.equal(
    resolveDataDirectory({ argv: ['node', 'main.mjs', '--data-directory', '/tmp/isolated'], env: {}, platform: 'win32' }),
    path.resolve('/tmp/isolated'),
  );
  assert.throws(
    () => resolveDataDirectory({ argv: ['node', 'main.mjs', '--data-directory', 'relative'], env: {}, platform: 'win32' }),
    /absolute/,
  );
  assert.throws(
    () => resolveDataDirectory({ argv: ['node', 'main.mjs', '--data-directory'], env: {}, platform: 'win32' }),
    /absolute/,
  );
});

test('each platform falls back to its per-user data location', () => {
  assert.equal(
    resolveDataDirectory({ argv: [], env: { LOCALAPPDATA: 'C:/Users/x/AppData/Local' }, platform: 'win32' }),
    path.join('C:/Users/x/AppData/Local', 'UGK Cockpit'),
  );
  assert.throws(
    () => resolveDataDirectory({ argv: [], env: {}, platform: 'win32' }),
    /LOCALAPPDATA/,
  );
  assert.equal(
    resolveDataDirectory({ argv: [], env: {}, platform: 'darwin', homedir: () => '/Users/x' }),
    path.join('/Users/x', 'Library', 'Application Support', 'UGK Cockpit'),
  );
  assert.equal(
    resolveDataDirectory({ argv: [], env: { XDG_DATA_HOME: '/xdg-data' }, platform: 'linux' }),
    path.join('/xdg-data', 'UGK Cockpit'),
  );
  assert.equal(
    resolveDataDirectory({ argv: [], env: {}, platform: 'linux', homedir: () => '/home/x' }),
    path.join('/home/x', '.local', 'share', 'UGK Cockpit'),
  );
});
