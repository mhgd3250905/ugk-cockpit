import os from 'node:os';
import path from 'node:path';

// `path.join(process.env.LOCALAPPDATA, ...)` throws a raw TypeError on any host
// without that variable, and the resulting stack tells the user nothing. The
// installer must either find a real per-user data directory or explain what to
// set, so `UGK_PLUGIN_OUTPUT_ROOT` is the documented escape hatch for managed
// environments where the platform location is unavailable.
export function resolvePluginOutputRoot(subdirectory, { env = process.env, platform = process.platform } = {}) {
  if (env.UGK_PLUGIN_OUTPUT_ROOT) {
    const override = env.UGK_PLUGIN_OUTPUT_ROOT;
    if (!path.isAbsolute(override)) {
      throw new Error('UGK_PLUGIN_OUTPUT_ROOT must be an absolute path.');
    }
    return path.resolve(override, subdirectory);
  }
  // Branch on the platform first: a non-Windows host (WSL, for example) can
  // inherit a LOCALAPPDATA value, and trusting it would point the output at a
  // Windows-style path.
  let base = null;
  if (platform === 'win32') base = env.LOCALAPPDATA ?? null;
  else if (platform === 'darwin') base = path.join(os.homedir(), 'Library', 'Application Support');
  else base = env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  if (!base) {
    throw new Error('LOCALAPPDATA is unavailable. Set UGK_PLUGIN_OUTPUT_ROOT to an absolute path.');
  }
  return path.join(base, 'UGK Cockpit', subdirectory);
}
