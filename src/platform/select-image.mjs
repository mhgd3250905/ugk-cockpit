import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const WINDOWS_PICKER_SCRIPT = fileURLToPath(new URL('./windows-image-picker.ps1', import.meta.url));
// Same image scope as the Windows OpenFileDialog filter (png/jpg/jpeg/gif/webp).
const MACOS_IMAGE_SCRIPT = 'POSIX path of (choose file of type {"public.image"} with prompt "选择头像图片")';

function pickerError(code, message, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}

export async function selectImage({
  platform = process.platform,
  run = execFileAsync,
} = {}) {
  if (platform === 'darwin') {
    let result;
    try {
      result = await run('osascript', ['-e', MACOS_IMAGE_SCRIPT], { timeout: 120_000, maxBuffer: 64 * 1024 });
    } catch (error) {
      // osascript reports a user cancel as exit 1 with Apple error -128; like
      // the Windows helper's empty stdout, that is a cancelled pick, not a failure.
      const message = String(error?.stderr ?? error?.message ?? '');
      if (/-128\b/.test(message) || /User canceled/i.test(message)) return null;
      if (error?.killed || error?.code === 'ETIMEDOUT') {
        throw pickerError('IMAGE_PICKER_TIMEOUT', 'Native image picker did not return in time.', error);
      }
      throw pickerError('IMAGE_PICKER_UNAVAILABLE', 'Native image picker failed.', error);
    }
    const selected = result.stdout.trim().replace(/\/+$/, '');
    return selected || null;
  }

  if (platform !== 'win32') {
    const error = new Error('Native image selection is only implemented for Windows and macOS.');
    error.code = 'IMAGE_PICKER_UNAVAILABLE';
    throw error;
  }

  let stdout;
  try {
    ({ stdout } = await run(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', WINDOWS_PICKER_SCRIPT],
      { windowsHide: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 },
    ));
  } catch (error) {
    if (error?.killed || error?.code === 'ETIMEDOUT') {
      throw pickerError('IMAGE_PICKER_TIMEOUT', 'Native image picker did not return in time.', error);
    }
    throw pickerError('IMAGE_PICKER_UNAVAILABLE', 'Native image picker failed.', error);
  }

  const selected = stdout.trim();
  return selected || null;
}
