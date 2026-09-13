import { homedir as defaultHome } from 'node:os';
import path from 'node:path';

// The service and the installers must agree on the default per-user data
// location, so these branches mirror scripts/plugin-output-root.mjs. An
// explicit `--data-directory` (used by the launchers) always wins.
export function resolveDataDirectory({
  argv = [],
  env = process.env,
  platform = process.platform,
  homedir = defaultHome,
} = {}) {
  const index = argv.indexOf('--data-directory');
  if (index !== -1) {
    const directory = argv[index + 1];
    if (!directory || !path.isAbsolute(directory)) throw new Error('--data-directory requires an absolute path.');
    return path.resolve(directory);
  }
  let base;
  if (platform === 'win32') {
    base = env.LOCALAPPDATA;
    if (!base) throw new Error('LOCALAPPDATA is unavailable. Pass --data-directory to choose the data location.');
  } else if (platform === 'darwin') {
    base = path.join(homedir(), 'Library', 'Application Support');
  } else {
    base = env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  }
  return path.join(base, 'UGK Cockpit');
}
