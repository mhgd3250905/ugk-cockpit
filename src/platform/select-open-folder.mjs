import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WINDOWS_OPEN_FOLDERS = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject Shell.Application
$paths = @(
  foreach ($window in $shell.Windows()) {
    try {
      $executable = [System.IO.Path]::GetFileName([string]$window.FullName)
      if ($executable -ieq 'explorer.exe') {
        $candidate = [string]$window.Document.Folder.Self.Path
        if ($candidate -and [System.IO.Directory]::Exists($candidate)) {
          $candidate
        }
      }
    } catch {
      # Ignore transient or non-filesystem Explorer windows.
    }
  }
) | Sort-Object -Unique
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -Compress -InputObject @($paths)
`;

function selectionError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export async function selectOpenExplorerFolder({
  platform = process.platform,
  run = execFileAsync,
} = {}) {
  if (platform !== 'win32') {
    throw selectionError('OPEN_FOLDER_UNAVAILABLE', 'Explorer folder discovery is only available on Windows.');
  }

  let stdout;
  try {
    ({ stdout } = await run(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_OPEN_FOLDERS],
      { windowsHide: true, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 },
    ));
  } catch (error) {
    throw selectionError('OPEN_FOLDER_UNAVAILABLE', 'Could not read open Explorer folders.', error);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim() || '[]');
  } catch {
    throw selectionError('OPEN_FOLDER_UNAVAILABLE', 'Explorer returned an invalid folder list.');
  }
  const paths = [...new Set((Array.isArray(parsed) ? parsed : [parsed])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim()))];

  if (paths.length === 0) {
    throw selectionError('OPEN_FOLDER_NOT_FOUND', 'No open Explorer folder was found.');
  }
  if (paths.length > 1) {
    throw selectionError('OPEN_FOLDER_AMBIGUOUS', 'More than one Explorer folder is open.');
  }
  return paths[0];
}
