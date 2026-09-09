import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupCodex } from './setup-codex.mjs';
import { COCKPIT_SKILL_NAMES } from './install-cockpit-skills.mjs';

export function resolveZcodeCli(env = process.env) {
  const explicit = env.ZCODE_CLI_PATH;
  const candidates = explicit ? [explicit] : (env.PATH ?? env.Path ?? '').split(path.delimiter)
    .flatMap((directory) => [path.join(directory, 'zcode.exe'), path.join(directory, 'zcode.cjs')]);
  if (!explicit && process.platform === 'win32') {
    try {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-Process -Name ZCode -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 16384 });
      const locations = [...new Set(output.trim().split(/\r?\n/).filter(Boolean))];
      if (locations.length === 1) candidates.push(path.join(path.dirname(locations[0]), 'resources/glm/zcode.cjs'));
    } catch { /* Explicit CLI path remains the fallback. */ }
  }
  let file = candidates.find((candidate) => path.isAbsolute(candidate) && existsSync(candidate));
  // A desktop ZCode.exe on PATH is not the CLI. Prefer its bundled CLI entry.
  if (file && path.extname(file).toLowerCase() === '.exe') {
    const bundled = path.join(path.dirname(file), 'resources/glm/zcode.cjs');
    if (existsSync(bundled)) file = bundled;
  }
  if (!file || !['.exe', '.cjs', '.js'].includes(path.extname(file).toLowerCase())) {
    throw new Error('Set ZCODE_CLI_PATH to the installed native ZCode CLI executable or zcode.cjs entry.');
  }
  return path.extname(file).toLowerCase() === '.exe' ? { file, args: [] } : { file: process.execPath, args: [file] };
}

// The native app-server speaks strict NDJSON request/response envelopes. Plugin requests do
// not require a chat/session or model call. Never surface raw stderr/config.
export function createZcodeClient({ cli = resolveZcodeCli(), env = process.env, cwd = process.cwd(), timeoutMs = 60_000 } = {}) {
  const child = spawn(cli.file, [...cli.args, 'app-server'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0, buffer = '', closed = false;
  function failAll() { closed = true; for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error('ZCode native plugin connection closed; pending operation outcomes are unknown.')); } pending.clear(); }
  child.on('error', failAll);
  child.on('exit', failAll);
  child.stdin.on('error', failAll);
  child.stderr.on('data', () => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) { failAll(); child.kill(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const value = pending.get(message.id);
      if (!value) continue;
      pending.delete(message.id); clearTimeout(value.timer);
      if (message.error) value.reject(new Error(`ZCode native plugin request failed (${message.error.code ?? 'unknown'}).`));
      else value.resolve(message.result);
    }
  });
  return {
    request(method, params) {
      if (closed || child.exitCode !== null) return Promise.reject(new Error('ZCode native plugin connection is unavailable.'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('ZCode plugin request timed out; outcome may be incomplete. Inspect the installed plugin before retrying.')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    close() { closed = true; failAll(); child.stdin.end(); child.kill(); },
  };
}

export function inspectZcodeLegacy({ home = process.env.HOME || process.env.USERPROFILE || os.homedir() } = {}) {
  const configFile = path.join(home, '.zcode/cli/config.json');
  let config = {};
  if (existsSync(configFile)) {
    try { config = JSON.parse(readFileSync(configFile, 'utf8')); }
    catch { throw new Error('ZCode user configuration is invalid; repair it before installing.'); }
  }
  const skills = COCKPIT_SKILL_NAMES.filter((name) => ['.zcode/skills', '.agents/skills']
    .some((directory) => existsSync(path.join(home, directory, name, 'SKILL.md'))));
  let servers = config.mcp?.servers ?? {};
  const fallback = path.join(home, '.agents/mcp.json');
  if (Object.keys(servers).length === 0 && existsSync(fallback)) {
    try { servers = JSON.parse(readFileSync(fallback, 'utf8')).mcpServers ?? {}; }
    catch { throw new Error('ZCode fallback MCP configuration is invalid; repair it before installing.'); }
  }
  const mcp = Object.keys(servers).some((name) => name === 'ugk-cockpit' || name === 'plugin:ugk-cockpit:ugk-cockpit');
  return { skills, mcp };
}

export async function setupZcode(options = {}, dependencies = {}) {
  const deps = { resolve: resolveZcodeCli, inspect: inspectZcodeLegacy, connect: createZcodeClient,
    service: (value = {}) => setupCodex({ startOnly: true, ...value }),
    build: async (value) => (await import('./build-zcode-plugin.mjs')).buildZcodePlugin(value),
    ...dependencies };
  if (options.startOnly) return deps.service({ dryRun: Boolean(options.dryRun) });
  const cli = deps.resolve();
  const legacy = deps.inspect();
  if (legacy.skills.length || legacy.mcp) return { status: 'migration_needed', standaloneSkills: legacy.skills,
    standaloneMcp: legacy.mcp, nextAction: 'Review and back up the existing standalone Cockpit installation before switching to the plugin. Existing configuration was not changed.' };
  await deps.service({ dryRun: true });
  if (options.dryRun) return { status: 'plan', steps: ['prepare plugin', 'verify service', 'register native ZCode marketplace and plugin', 'verify tools in current host'] };
  const bundle = await deps.build({ outputRoot: options.outputRoot ?? path.join(process.env.LOCALAPPDATA, 'UGK Cockpit', 'zcode-plugin-packages') });
  const service = await deps.service();
  const client = deps.connect({ cli });
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  const workspace = { workspacePath, workspaceKey: workspacePath };
  try {
    await client.request('plugins/marketplace/add', { workspace, source: bundle.marketplaceRoot });
    const installed = await client.request('plugins/install', { workspace, marketplace: 'ugk-cockpit-local', pluginName: 'ugk-cockpit', scope: 'user' });
    const plugin = installed.installedPlugins?.find((entry) => entry.id === 'ugk-cockpit@ugk-cockpit-local');
    if (!plugin || plugin.version !== bundle.version || plugin.enabled !== true) throw new Error('ZCode did not confirm the expected enabled plugin version.');
    const listed = await client.request('plugins/list', { workspace });
    const visible = listed.plugins?.find((entry) => entry.id === plugin.id);
    if (!visible || visible.enabled !== true || visible.version !== bundle.version || visible.skillCount !== COCKPIT_SKILL_NAMES.length
      || !visible.mcpServerNames?.includes('plugin:ugk-cockpit:ugk-cockpit')) throw new Error('ZCode did not expose all Cockpit skills and the plugin MCP server.');
    return { status: 'host_verification_pending', pluginInstalled: true, hostVerification: 'pending', serviceUrl: service?.serviceUrl,
      nextAction: 'Reconnect the ZCode task if needed, then call the Cockpit ugk_work_context tool with {}. Do not init an existing work session.' };
  } finally { client.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--dry-run', '--start-only'].includes(arg))) { console.error('Usage: node scripts/setup-zcode.mjs [--dry-run] [--start-only]'); process.exitCode = 1; }
  else try {
    const result = await setupZcode({ dryRun: args.includes('--dry-run'), startOnly: args.includes('--start-only') });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'migration_needed') process.exitCode = 2;
  }
  catch (error) { console.error(`Setup incomplete: ${error.message}`); process.exitCode = 1; }
}

