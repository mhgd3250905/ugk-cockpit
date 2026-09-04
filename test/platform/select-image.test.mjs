import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { selectImage } from '../../src/platform/select-image.mjs';

const helperUrl = new URL('../../src/platform/windows-image-picker.ps1', import.meta.url);

test('native image picker uses the dedicated interactive helper and returns the selected image', async () => {
  let invocation;
  const selected = await selectImage({
    platform: 'win32',
    run: async (file, args, options) => {
      invocation = { file, args, options };
      return { stdout: 'C:\\Pictures\\avatar.png\r\n' };
    },
  });

  assert.equal(selected, 'C:\\Pictures\\avatar.png');
  assert.equal(invocation.file, 'powershell.exe');
  assert.equal(invocation.args.at(-2), '-File');
  assert.match(invocation.args.at(-1), /windows-image-picker\.ps1$/i);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.timeout, 120_000);
});

test('native image picker returns null when user cancels or stdout is empty', async () => {
  const selected = await selectImage({
    platform: 'win32',
    run: async () => ({ stdout: '   \r\n' }),
  });

  assert.equal(selected, null);
});

test('native image picker timeout becomes an actionable public error', async () => {
  const timeout = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });

  await assert.rejects(selectImage({
    platform: 'win32',
    run: async () => { throw timeout; },
  }), { code: 'IMAGE_PICKER_TIMEOUT' });
});

test('native image picker rejects non-Windows platforms with actionable error', async () => {
  await assert.rejects(selectImage({
    platform: 'linux',
    run: async () => ({ stdout: '' }),
  }), { code: 'IMAGE_PICKER_UNAVAILABLE' });
});

test('Windows helper uses OpenFileDialog with image filter and foreground owner', async () => {
  const helper = await readFile(helperUrl, 'utf8');

  // Verify OpenFileDialog and owner configuration
  assert.match(helper, /OpenFileDialog/);
  assert.match(helper, /\$owner\.TopMost = \$true/);
  assert.match(helper, /\$owner\.ShowInTaskbar = \$false/);
  assert.match(helper, /\$dialog\.Filter = 'Image files \(\*\.png;\*\.jpg;\*\.jpeg;\*\.gif;\*\.webp\)\|\*\.png;\*\.jpg;\*\.jpeg;\*\.gif;\*\.webp'/);
  assert.match(helper, /\$dialog\.Multiselect = \$false/);
  assert.match(helper, /\$dialog\.CheckFileExists = \$true/);
  assert.match(helper, /\$dialog\.CheckPathExists = \$true/);
  assert.match(helper, /\$dialog\.DereferenceLinks = \$false/);
});

test('Windows helper uses pure ASCII to prevent PS5.1 mojibake without BOM', async () => {
  const helper = await readFile(helperUrl, 'utf8');

  // Must not contain non-ASCII characters so Windows PowerShell 5.1 cannot mojibake without BOM
  assert.match(helper, /^[\x00-\x7F]*$/, 'Helper script must be pure ASCII to prevent PS5.1 mojibake');
});
