import assert from 'node:assert/strict';
import test from 'node:test';
import { selectOpenExplorerFolder } from '../../src/platform/select-open-folder.mjs';

test('returns the only open Explorer folder', async () => {
  const selected = await selectOpenExplorerFolder({
    platform: 'win32',
    run: async () => ({ stdout: '["E:\\\\AII\\\\project"]' }),
  });

  assert.equal(selected, 'E:\\AII\\project');
});

test('requires one unambiguous Explorer folder', async () => {
  await assert.rejects(selectOpenExplorerFolder({
    platform: 'win32',
    run: async () => ({ stdout: '[]' }),
  }), { code: 'OPEN_FOLDER_NOT_FOUND' });

  await assert.rejects(selectOpenExplorerFolder({
    platform: 'win32',
    run: async () => ({ stdout: '["E:\\\\one","E:\\\\two"]' }),
  }), { code: 'OPEN_FOLDER_AMBIGUOUS' });
});
