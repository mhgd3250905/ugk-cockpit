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

test('native picker returns null when user cancels or stdout is empty', async () => {
  const selected = await selectFolder({
    platform: 'win32',
    run: async () => ({ stdout: '   \r\n' }),
  });

  assert.equal(selected, null);
});

test('native picker timeout becomes an actionable public error', async () => {
  const timeout = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });

  await assert.rejects(selectFolder({
    platform: 'win32',
    run: async () => { throw timeout; },
  }), { code: 'FOLDER_PICKER_TIMEOUT' });
});

test('native picker rejects non-Windows platforms with actionable error', async () => {
  await assert.rejects(selectFolder({
    platform: 'linux',
    run: async () => ({ stdout: '' }),
  }), { code: 'FOLDER_PICKER_UNAVAILABLE' });
});

test('Windows helper uses native IFileOpenDialog with folder options, client GUID, and foreground owner', async () => {
  const helper = await readFile(helperUrl, 'utf8');

  // Verify legacy WinForms FolderBrowserDialog is removed
  assert.doesNotMatch(helper, /FolderBrowserDialog/i);

  // Verify modern COM IFileOpenDialog and folder picking options
  assert.match(helper, /IFileOpenDialog/);
  assert.match(helper, /FOS_PICKFOLDERS/);
  assert.match(helper, /FOS_FORCEFILESYSTEM/);
  assert.match(helper, /FOS_PATHMUSTEXIST/);

  // Verify stable client GUID and owner window binding
  assert.match(helper, /SetClientGuid/);
  assert.match(helper, /ClientGuid/);
  assert.match(helper, /\$owner\.TopMost = \$true/);
  assert.match(helper, /\$owner\.ShowInTaskbar = \$false/);
  assert.match(helper, /\[UgkCockpit\.Platform\.NativeFolderPicker\]::Show\(\$owner\.Handle\)/);
});

test('Windows helper uses encoding-safe Unicode escape sequences for localized dialog copy', async () => {
  const helper = await readFile(helperUrl, 'utf8');

  // Must not contain non-ASCII characters so Windows PowerShell 5.1 cannot mojibake without BOM
  assert.match(helper, /^[\x00-\x7F]*$/, 'Helper script must be pure ASCII to prevent PS5.1 mojibake');

  // Verify localized title and button labels use Unicode escapes
  assert.match(helper, /\\u9009\\u62E9\\u8981\\u6DFB\\u52A0\\u5230 UGK Cockpit \\u7684\\u9879\\u76EE\\u6587\\u4EF6\\u5939/);
  assert.match(helper, /\\u9009\\u62E9\\u6587\\u4EF6\\u5939/);
});
