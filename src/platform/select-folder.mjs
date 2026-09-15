import { spawn as defaultSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const WINDOWS_PICKER_SCRIPT = fileURLToPath(new URL('./windows-folder-picker.ps1', import.meta.url));

// Same localized title as the Windows IFileOpenDialog helper.
const MACOS_FOLDER_SCRIPT = 'POSIX path of (choose folder with prompt "选择要添加到 UGK Cockpit 的项目文件夹")';

function pickerError(code, message, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}

export class ResidentFolderPicker {
  constructor({
    platform = process.platform,
    spawn = defaultSpawn,
    scriptPath = WINDOWS_PICKER_SCRIPT,
  } = {}) {
    this._platform = platform;
    this._spawn = spawn;
    this._scriptPath = scriptPath;
    this._child = null;
    this._rl = null;
    this._readyPromise = null;
    this._pendingResolver = null;
    this._queue = Promise.resolve();
  }

  get isRunning() {
    return Boolean(this._child && !this._child.killed && this._child.exitCode === null);
  }

  _ensureWorker(timeout = 0) {
    // macOS opens one osascript process per pick (NSOpenPanel dies with it),
    // so there is no resident worker to keep alive.
    if (this._platform === 'darwin') return Promise.resolve();
    if (this._platform !== 'win32') {
      const error = new Error('Native folder selection is only implemented for Windows and macOS.');
      error.code = 'FOLDER_PICKER_UNAVAILABLE';
      throw error;
    }

    if (this._child && !this._child.killed && this._child.exitCode === null && this._readyPromise) {
      return this._readyPromise;
    }

    let resolveReady;
    let rejectReady;
    this._readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    // Worker startup must be bounded by the same selection timeout: a spawned
    // PowerShell that never prints its ready line and never exits would
    // otherwise leave every queued selection request pending forever.
    let readyTimer = null;
    const clearReadyTimer = () => {
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
    };

    try {
      const child = this._spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', this._scriptPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      this._child = child;

      const rl = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      this._rl = rl;

      let readyReceived = false;

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const message = JSON.parse(trimmed);
          if (!readyReceived) {
            if (message.ready || message.ok) {
              readyReceived = true;
              clearReadyTimer();
              resolveReady();
              return;
            }
          }
          if (this._pendingResolver) {
            const resolver = this._pendingResolver;
            this._pendingResolver = null;
            resolver.resolve(message);
          }
        } catch (parseError) {
          if (this._pendingResolver) {
            const resolver = this._pendingResolver;
            this._pendingResolver = null;
            resolver.reject(pickerError('FOLDER_PICKER_UNAVAILABLE', 'Native folder picker response malformed.', parseError));
          }
        }
      });

      const onExitOrError = (err) => {
        // A retired worker's exit can arrive long after it was killed (the OS
        // delivers it asynchronously). By then this picker may already be
        // serving from a fresh spawn: a stale event must not reject the new
        // pending request or kill the replacement worker, so it is dropped.
        if (this._child !== child) return;
        clearReadyTimer();
        if (!readyReceived) {
          rejectReady(pickerError('FOLDER_PICKER_UNAVAILABLE', 'Native folder picker failed to initialize.', err));
        }
        if (this._pendingResolver) {
          const resolver = this._pendingResolver;
          this._pendingResolver = null;
          resolver.reject(pickerError('FOLDER_PICKER_UNAVAILABLE', 'Native folder picker process terminated unexpectedly.', err));
        }
        this._cleanup();
      };

      child.on('error', onExitOrError);
      child.on('exit', (code, signal) => {
        onExitOrError(new Error(`Process exited with code ${code}, signal ${signal}`));
      });

      if (timeout > 0 && timeout < Infinity) {
        readyTimer = setTimeout(() => {
          if (readyReceived) return;
          const timeoutError = pickerError('FOLDER_PICKER_TIMEOUT', 'Native folder picker did not return in time.');
          rejectReady(timeoutError);
          // Kill the stuck worker; its exit handler re-enters the same cleanup
          // path, so later selection requests start from a fresh spawn.
          this._cleanup();
        }, timeout);
      }

    } catch (spawnError) {
      this._cleanup();
      throw pickerError('FOLDER_PICKER_UNAVAILABLE', 'Native folder picker failed to start.', spawnError);
    }

    return this._readyPromise;
  }

  // One osascript process per pick. A user cancel exits 1 with Apple error
  // -128 and maps to a cancelled result like the Windows helper's
  // `{"ok":true,"path":null}`; any other failure is unavailable, not a retry
  // hint, because e.g. a headless session will never grow a dialog.
  _selectMacOSFolder(timeout) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn('osascript', ['-e', MACOS_FOLDER_SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (spawnError) {
        reject(pickerError('FOLDER_PICKER_UNAVAILABLE', 'Native folder picker failed to start.', spawnError));
        return;
      }
      const stdout = [];
      const stderr = [];
      let timedOut = false;
      let settled = false;
      const settle = (action, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        action(value);
      };
      const timer = timeout > 0 && timeout < Infinity
        ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch {}
        }, timeout)
        : null;
      child.stdout?.on?.('data', (chunk) => stdout.push(chunk));
      child.stderr?.on?.('data', (chunk) => stderr.push(chunk));
      child.on('error', (err) => settle(reject, pickerError('FOLDER_PICKER_UNAVAILABLE', 'Native folder picker failed to start.', err)));
      // `close` fires after the stdio streams flush; `exit` can beat the data.
      child.on('close', (code, signal) => {
        if (timedOut || signal) {
          settle(reject, pickerError('FOLDER_PICKER_TIMEOUT', 'Native folder picker did not return in time.'));
          return;
        }
        const text = Buffer.concat(stdout).toString('utf8').trim();
        if (text) {
          // POSIX paths keep their trailing "/" only for the filesystem root.
          settle(resolve, text.replace(/\/+$/, '') || '/');
          return;
        }
        const errorText = Buffer.concat(stderr).toString('utf8');
        if (code === 0 || /-128\b/.test(errorText) || /User canceled/i.test(errorText)) {
          settle(resolve, null);
          return;
        }
        settle(reject, pickerError('FOLDER_PICKER_UNAVAILABLE', 'Native folder picker failed.', new Error(errorText.slice(0, 400))));
      });
    });
  }

  _cleanup() {
    if (this._rl) {
      try { this._rl.close(); } catch {}
      this._rl = null;
    }
    if (this._child) {
      try {
        if (!this._child.killed && this._child.exitCode === null) {
          this._child.kill();
        }
      } catch {}
      this._child = null;
    }
    this._readyPromise = null;
    this._pendingResolver = null;
  }

  async selectFolder({ timeout = 120_000 } = {}) {
    const runSelection = async () => {
      await this._ensureWorker(timeout);
      if (this._platform === 'darwin') return this._selectMacOSFolder(timeout);

      return new Promise((resolve, reject) => {
        let timer = null;
        if (timeout > 0 && timeout < Infinity) {
          timer = setTimeout(() => {
            if (this._pendingResolver === resolverEntry) {
              this._pendingResolver = null;
              this._cleanup();
              reject(pickerError('FOLDER_PICKER_TIMEOUT', 'Native folder picker did not return in time.'));
            }
          }, timeout);
        }

        const resolverEntry = {
          resolve: (msg) => {
            if (timer) clearTimeout(timer);
            if (msg.ok === false) {
              reject(pickerError('FOLDER_PICKER_UNAVAILABLE', msg.error || 'Native folder picker failed.'));
              return;
            }
            const selected = typeof msg.path === 'string' ? msg.path.trim() : null;
            resolve(selected || null);
          },
          reject: (err) => {
            if (timer) clearTimeout(timer);
            reject(err);
          },
        };

        this._pendingResolver = resolverEntry;

        try {
          this._child.stdin.write('{"action":"pick"}\n');
        } catch (writeError) {
          if (timer) clearTimeout(timer);
          this._pendingResolver = null;
          this._cleanup();
          reject(pickerError('FOLDER_PICKER_UNAVAILABLE', 'Failed to communicate with folder picker.', writeError));
        }
      });
    };

    const resultPromise = this._queue.then(runSelection, runSelection);
    this._queue = resultPromise.catch(() => {});
    return resultPromise;
  }

  async close() {
    if (this._child && !this._child.killed && this._child.exitCode === null) {
      try {
        this._child.stdin.write('{"action":"exit"}\n');
        this._child.stdin.end();
      } catch {}
    }
    this._cleanup();
  }
}

let defaultPickerInstance = null;

function getDefaultPicker() {
  if (!defaultPickerInstance) {
    defaultPickerInstance = new ResidentFolderPicker();
  }
  return defaultPickerInstance;
}

export async function selectFolder({
  platform = process.platform,
  spawn = defaultSpawn,
  timeout = 120_000,
  picker = null,
} = {}) {
  if (picker) {
    return picker.selectFolder({ timeout });
  }
  if (platform !== process.platform || spawn !== defaultSpawn) {
    const customPicker = new ResidentFolderPicker({ platform, spawn });
    try {
      return await customPicker.selectFolder({ timeout });
    } finally {
      await customPicker.close();
    }
  }
  return getDefaultPicker().selectFolder({ timeout });
}

export async function closeFolderPicker() {
  if (defaultPickerInstance) {
    const inst = defaultPickerInstance;
    defaultPickerInstance = null;
    await inst.close();
  }
}
