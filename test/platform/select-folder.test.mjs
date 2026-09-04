import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ResidentFolderPicker, selectFolder } from '../../src/platform/select-folder.mjs';

const helperUrl = new URL('../../src/platform/windows-folder-picker.ps1', import.meta.url);

function createMockChildProcess({ autoReady = true, onInput } = {}) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.exitCode = null;

  proc.kill = () => {
    proc.killed = true;
    proc.exitCode = 1;
    proc.emit('exit', 1, 'SIGTERM');
  };

  if (autoReady) {
    queueMicrotask(() => {
      proc.stdout.write('{"ok":true,"ready":true}\n');
    });
  }

  proc.stdin.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    if (onInput) onInput(text, proc);
  });

  return proc;
}

test('resident picker uses the dedicated interactive helper and returns the selected folder', async () => {
  let spawnInvocation;
  let sentInput = '';

  const mockSpawn = (file, args, options) => {
    spawnInvocation = { file, args, options };
    return createMockChildProcess({
      onInput: (text, proc) => {
        sentInput += text;
        if (text.includes('pick')) {
          proc.stdout.write('{"ok":true,"path":"E:\\\\AII\\\\project"}\n');
        }
      },
    });
  };

  const picker = new ResidentFolderPicker({ platform: 'win32', spawn: mockSpawn });
  const selected = await picker.selectFolder();
  await picker.close();

  assert.equal(selected, 'E:\\AII\\project');
  assert.equal(spawnInvocation.file, 'powershell.exe');
  assert.equal(spawnInvocation.args.at(-2), '-File');
  assert.match(spawnInvocation.args.at(-1), /windows-folder-picker\.ps1$/i);
  assert.equal(spawnInvocation.options.windowsHide, true);
  assert.deepEqual(spawnInvocation.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.match(sentInput, /"action":"pick"/);
});
test('resident picker returns null when user cancels', async () => {
  const mockSpawn = () => createMockChildProcess({
    onInput: (text, proc) => {
      if (text.includes('pick')) {
        proc.stdout.write('{"ok":true,"path":null}\n');
      }
    },
  });

  const picker = new ResidentFolderPicker({ platform: 'win32', spawn: mockSpawn });
  const selected = await picker.selectFolder();
  await picker.close();

  assert.equal(selected, null);
});

test('resident picker reuses the active STA worker across multiple picks without respawning', async () => {
  let spawnCount = 0;
  let pickCount = 0;

  const mockSpawn = () => {
    spawnCount += 1;
    return createMockChildProcess({
      onInput: (text, proc) => {
        if (text.includes('pick')) {
          pickCount += 1;
          proc.stdout.write(`{"ok":true,"path":"E:\\\\AII\\\\project-${pickCount}"}\n`);
        }
      },
    });
  };

  const picker = new ResidentFolderPicker({ platform: 'win32', spawn: mockSpawn });

  const first = await picker.selectFolder();
  const second = await picker.selectFolder();
  const third = await picker.selectFolder();
  await picker.close();

  assert.equal(first, 'E:\\AII\\project-1');
  assert.equal(second, 'E:\\AII\\project-2');
  assert.equal(third, 'E:\\AII\\project-3');
  assert.equal(spawnCount, 1, 'Should reuse the single resident worker process across all picks');
  assert.equal(pickCount, 3);
});

test('resident picker serializes concurrent calls safely without collisions', async () => {
  let activePicks = 0;
  let maxConcurrent = 0;

  const mockSpawn = () => createMockChildProcess({
    onInput: (text, proc) => {
      if (text.includes('pick')) {
        activePicks += 1;
        if (activePicks > maxConcurrent) maxConcurrent = activePicks;
        setTimeout(() => {
          activePicks -= 1;
          proc.stdout.write('{"ok":true,"path":"E:\\\\AII\\\\queued"}\n');
        }, 10);
      }
    },
  });

  const picker = new ResidentFolderPicker({ platform: 'win32', spawn: mockSpawn });

  const [res1, res2] = await Promise.all([
    picker.selectFolder(),
    picker.selectFolder(),
  ]);
  await picker.close();

  assert.equal(res1, 'E:\\AII\\queued');
  assert.equal(res2, 'E:\\AII\\queued');
  assert.equal(maxConcurrent, 1, 'Picks must be serialized sequentially');
});

test('resident picker recovers automatically from worker process crash', async () => {
  let spawnCount = 0;
  let activeProc = null;

  const mockSpawn = () => {
    spawnCount += 1;
    activeProc = createMockChildProcess({
      onInput: (text, proc) => {
        if (text.includes('pick')) {
          if (spawnCount === 1) {
            // Crash on first run
            proc.emit('exit', 1, 'SIGKILL');
          } else {
            proc.stdout.write('{"ok":true,"path":"E:\\\\AII\\\\recovered"}\n');
          }
        }
      },
    });
    return activeProc;
  };

  const picker = new ResidentFolderPicker({ platform: 'win32', spawn: mockSpawn });

  // First pick fails due to crash
  await assert.rejects(picker.selectFolder(), { code: 'FOLDER_PICKER_UNAVAILABLE' });

  // Second pick automatically starts a fresh worker and succeeds
  const recovered = await picker.selectFolder();
  await picker.close();

  assert.equal(recovered, 'E:\\AII\\recovered');
  assert.equal(spawnCount, 2, 'Should spawn a new worker after crash');
});

test('resident picker timeout kills worker and rejects with FOLDER_PICKER_TIMEOUT', async () => {
  let killed = false;

  const mockSpawn = () => {
    const proc = createMockChildProcess({
      onInput: () => {
        // Do nothing, simulate hanging dialog
      },
    });
    const origKill = proc.kill;
    proc.kill = () => {
      killed = true;
      origKill();
    };
    return proc;
  };

  const picker = new ResidentFolderPicker({ platform: 'win32', spawn: mockSpawn });

  await assert.rejects(
    picker.selectFolder({ timeout: 20 }),
    { code: 'FOLDER_PICKER_TIMEOUT' },
  );

  assert.equal(killed, true, 'Worker should be killed upon timeout');
  await picker.close();
});

test('resident picker rejects non-Windows platforms with actionable error', async () => {
  let spawned = false;
  const mockSpawn = () => {
    spawned = true;
    return createMockChildProcess();
  };

  const picker = new ResidentFolderPicker({ platform: 'linux', spawn: mockSpawn });
  await assert.rejects(picker.selectFolder(), { code: 'FOLDER_PICKER_UNAVAILABLE' });
  assert.equal(spawned, false, 'Must not spawn on non-Windows platform');
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
