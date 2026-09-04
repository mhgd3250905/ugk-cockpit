import { spawn as defaultSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const WINDOWS_PICKER_SCRIPT = fileURLToPath(new URL('./windows-folder-picker.ps1', import.meta.url));

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

  _ensureWorker() {
    if (this._platform !== 'win32') {
      const error = new Error('Native folder selection is only implemented for Windows.');
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

    } catch (spawnError) {
      this._cleanup();
      throw pickerError('FOLDER_PICKER_UNAVAILABLE', 'Native folder picker failed to start.', spawnError);
    }

    return this._readyPromise;
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
      await this._ensureWorker();

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
