import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { selectFolder } from '../../src/platform/select-folder.mjs';

const helperUrl = new URL('../../src/platform/windows-folder-picker.ps1', import.meta.url);

test('native picker uses the dedicated interactive helper and returns the selected folder', async () => {
  let invocation;
  const selected = await selectFolder({
    platform: 'win32',
    run: async (file, args, options) => {
      invocation = { file, args, options };
      return { stdout: 'E:\\AII\\project\r\n' };
    },
  });

  assert.equal(selected, 'E:\\AII\\project');
  assert.equal(invocation.file, 'powershell.exe');
  assert.equal(invocation.args.at(-2), '-File');
  assert.match(invocation.args.at(-1), /windows-folder-picker\.ps1$/i);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.timeout, 120_000);
});

test('native picker timeout becomes an actionable public error', async () => {
  const timeout = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });

  await assert.rejects(selectFolder({
    platform: 'win32',
    run: async () => { throw timeout; },
  }), { code: 'FOLDER_PICKER_TIMEOUT' });
});

test('Windows helper owns and foregrounds the folder dialog', async () => {
  const helper = await readFile(helperUrl, 'utf8');

  assert.match(helper, /\$owner\.TopMost = \$true/);
  assert.match(helper, /\$owner\.ShowInTaskbar = \$false/);
  assert.match(helper, /\$dialog\.ShowDialog\(\$owner\)/);
});
