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

export async function selectFolder() {
  if (process.platform !== 'win32') {
    const error = new Error('Native folder selection is only implemented for Windows.');
    error.code = 'FOLDER_PICKER_UNAVAILABLE';
    throw error;
  }
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_PICKER],
    { windowsHide: true, encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 64 * 1024 },
  );
  const selected = stdout.trim();
  return selected || null;
}
