import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WINDOWS_PICKER = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择一个项目文件夹'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.SelectedPath
}
`;

function pickerError(code, message, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}

export async function selectFolder({
  platform = process.platform,
  run = execFileAsync,
} = {}) {
  if (platform !== 'win32') {
    const error = new Error('Native folder selection is only implemented for Windows.');
    error.code = 'FOLDER_PICKER_UNAVAILABLE';
    throw error;
  }
  let stdout;
  try {
    ({ stdout } = await run(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_PICKER],
      { windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 },
    ));
  } catch (error) {
    if (error?.killed || error?.code === 'ETIMEDOUT') {
      throw pickerError('FOLDER_PICKER_TIMEOUT', 'Native folder picker did not return in time.', error);
    }
    throw pickerError('FOLDER_PICKER_UNAVAILABLE', 'Native folder picker failed.', error);
  }
  const selected = stdout.trim();
  return selected || null;
}
