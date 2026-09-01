import assert from 'node:assert/strict';
import test from 'node:test';
import { selectFolder } from '../../src/platform/select-folder.mjs';

test('native picker returns the selected folder with a bounded timeout', async () => {
  let options;
  const selected = await selectFolder({
    platform: 'win32',
    run: async (_file, _args, receivedOptions) => {
      options = receivedOptions;
      return { stdout: 'E:\\AII\\project\r\n' };
    },
  });

  assert.equal(selected, 'E:\\AII\\project');
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 30_000);
});

test('native picker timeout becomes an actionable public error', async () => {
  const timeout = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });

  await assert.rejects(selectFolder({
    platform: 'win32',
    run: async () => { throw timeout; },
  }), { code: 'FOLDER_PICKER_TIMEOUT' });
});
