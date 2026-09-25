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
  // `--data-directory` is already required to be absolute; the environment has
  // to meet the same bar. A relative `LOCALAPPDATA`/`XDG_DATA_HOME` resolves
  // against the current working directory, so the service silently opens a
  // *different* — usually empty — database every time the launcher runs it from
  // elsewhere. An empty project list next to real records on disk is the exact
  // failure AGENTS.md forbids reading as "the data is gone".
  if (!path.isAbsolute(base)) {
    const name = platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_DATA_HOME';
    throw new Error(`${name} must be an absolute path (got '${base}'). Pass --data-directory with an absolute path.`);
  }
  return path.join(base, 'UGK Cockpit');
}
