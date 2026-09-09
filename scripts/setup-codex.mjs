import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { verifyServiceData } from './verify-service-data.mjs';
import { COCKPIT_SKILL_NAMES, defaultCodexSkillsRoot } from './install-cockpit-skills.mjs';

const root = path.resolve(import.meta.dirname, '..');
const serviceUrl = 'http://127.0.0.1:41737/';
const execute = promisify(execFile);

// Never execute a Windows .cmd shim through a shell. Use its installed JS entry
// or a native executable, with each argument passed separately.
export function resolveCommand(name, { env = process.env, platform = process.platform } = {}) {
  if (name === 'codex' && env.CODEX_CLI_PATH) {
    const native = env.CODEX_CLI_PATH;
    if (!path.isAbsolute(native) || !existsSync(native) || (platform === 'win32' && path.extname(native).toLowerCase() !== '.exe')) {
      throw new Error('CODEX_CLI_PATH must identify an existing absolute native Codex executable.');
    }
    return { file: native, prefix: [] };
  }
  const directories = [path.dirname(process.execPath), ...(env.PATH ?? env.Path ?? '').split(path.delimiter)];
  for (const directory of directories.filter(Boolean)) {
    const native = path.join(directory, platform === 'win32' ? `${name}.exe` : name);
    if (existsSync(native)) return { file: native, prefix: [] };
    const entry = name === 'codex' ? 'node_modules/@openai/codex/bin/codex.js'
      : name === 'npm' ? 'node_modules/npm/bin/npm-cli.js' : null;
    if (entry && existsSync(path.join(directory, entry))) {
      return { file: process.execPath, prefix: [path.join(directory, entry)] };
    }
  }
  throw new Error(`${name} is required. Install it and make it available on PATH, then retry.`);
}

async function run(name, args) {
  const command = resolveCommand(name);
  return execute(command.file, [...command.prefix, ...args], {
    cwd: root, windowsHide: true, timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
  });
}

export async function inspectLegacyInstallation({ execute = run, skillsRoot = defaultCodexSkillsRoot(),
  codexRoot = path.dirname(defaultCodexSkillsRoot()), read = (file) => readFileSync(file, 'utf8'),
} = {}) {
  const skills = COCKPIT_SKILL_NAMES.filter((name) => existsSync(path.join(skillsRoot, name, 'SKILL.md')));
  let mcp = false;
  try {
    const result = await execute('codex', ['mcp', 'get', 'ugk-cockpit', '--json']);
    mcp = true;
    const effective = JSON.parse(result.stdout);
    const listing = JSON.parse((await execute('codex', ['plugin', 'list', '--json'])).stdout);
    const managed = listing.installed?.find((plugin) => plugin.pluginId === 'ugk-cockpit@ugk-cockpit-local'
      && plugin.installed === true && plugin.enabled === true);
    if (managed && typeof managed.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(managed.version)) {
      try {
        const snapshot = JSON.parse(read(path.join(codexRoot, 'plugins/cache/ugk-cockpit-local/ugk-cockpit', managed.version, '.mcp.json')));
        const expected = snapshot.mcpServers?.['ugk-cockpit'];
        const actual = effective.transport;
        const normalize = (value) => ({ command: value.command, args: value.args ?? [], cwd: value.cwd ?? null,
          env: value.env ?? {}, env_vars: value.env_vars ?? [] });
        if (expected && actual?.type === 'stdio' && isDeepStrictEqual(normalize(expected), normalize(actual))) mcp = false;
      } catch {
        // Missing or invalid installed evidence cannot establish plugin provenance.
      }
    }
  } catch (error) {
    // Do not print MCP configuration or command output: it may contain credentials.
    if (!String(error.stderr ?? '').includes("No MCP server named 'ugk-cockpit' found")) {
      throw new Error('Codex configuration could not be inspected. Check CLI compatibility with the current Codex configuration before installing.');
    }
  }
  return { skills, mcp };
}

export function resolveDataDirectory() {
  const saved = path.join(root, '.data', 'service-directory.txt');
  if (existsSync(saved)) {
    const value = readFileSync(saved, 'utf8').trim();
    if (!path.isAbsolute(value)) throw new Error('Saved service data directory must be absolute.');
    return value;
  }
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required for the Windows service.');
  return path.join(process.env.LOCALAPPDATA, 'UGK Cockpit');
}

async function probe() {
  let response;
  try {
    response = await fetch(new URL('health', serviceUrl), { signal: AbortSignal.timeout(3000) });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw new Error('Cannot verify the existing listener. Service was not replaced.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.status !== 'ok' || typeof body.version !== 'string') {
    throw new Error('Port 41737 has an unverified listener. Service was not replaced.');
  }
  if (body.version !== readFileSync(path.join(root, 'VERSION'), 'utf8').trim()) {
    throw new Error('The running Cockpit version differs from this installation. Review the service upgrade before installing this bridge; the existing service was not restarted.');
  }
  return true;
}

async function start(directory) {
  const logs = path.join(directory, 'logs');
  mkdirSync(logs, { recursive: true });
  const output = openSync(path.join(logs, 'setup-service.log'), 'a');
  const errors = openSync(path.join(logs, 'setup-service.err.log'), 'a');
  try {
    const child = spawn(process.execPath, [path.join(root, 'src/main.mjs'), '--data-directory', directory], {
      cwd: root, windowsHide: true, detached: true, stdio: ['ignore', output, errors],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { closeSync(output); closeSync(errors); }
}

export async function setupCodex(options = {}, dependencies = {}) {
  const deps = {
    platform: process.platform, version: process.versions.node, run, probe, start,
    dataDirectory: resolveDataDirectory,
    outputRoot: () => path.join(process.env.LOCALAPPDATA, 'UGK Cockpit', 'plugin-packages'),
    inspectLegacy: inspectLegacyInstallation,
    verify: verifyServiceData,
    webReady: () => existsSync(path.join(root, 'dist', 'web', 'index.html')),
    build: async (value) => (await import('./build-codex-plugin.mjs')).buildCodexPlugin(value),
    wait: () => new Promise((resolve) => setTimeout(resolve, 300)),
    ...dependencies,
  };
  const [major, minor] = deps.version.split('.').map(Number);
  if (major !== 24 || !Number.isInteger(minor) || minor < 15) throw new Error('Node.js >=24.15.0 <25 is required.');
  if (deps.platform !== 'win32') throw new Error('This installer currently supports Windows.');
  if (!options.startOnly) {
    await deps.run('git', ['--version']);
    await deps.run('codex', ['plugin', 'add', '--help']);
    await deps.run('codex', ['plugin', 'marketplace', 'add', '--help']);
    const legacy = await deps.inspectLegacy();
    if (legacy.mcp || legacy.skills.length) return {
      status: 'migration_needed', standaloneMcp: legacy.mcp, standaloneSkills: legacy.skills,
      nextAction: 'Review the existing standalone Cockpit installation before switching to the plugin. Back up the matching configuration and skills, then explicitly choose the plugin installation and remove only those duplicates. No existing files or configuration were changed.',
    };
  }
  const directory = deps.dataDirectory();
  const running = await deps.probe();
  if (running) await deps.verify(directory, serviceUrl);
  if (options.dryRun) return {
    status: 'plan', service: running ? 'reuse' : 'start', dataDirectory: directory,
    steps: options.startOnly ? ['start or reuse service and verify projects']
      : ['prepare plugin', 'start or reuse service and verify projects', 'register marketplace', 'install plugin', 'verify MCP in host'],
  };
  // Prepare the web assets before starting; never restart an existing service.
  if (!running && (!options.startOnly || !deps.webReady())) {
    await deps.run('npm', ['ci']);
    await deps.run('npm', ['run', 'build:web']);
  }
  const bundle = options.startOnly ? null : await deps.build({ outputRoot: options.outputRoot ?? deps.outputRoot() });
  if (!running) {
    await deps.start(directory);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await deps.probe()) { ready = true; break; }
      await deps.wait();
    }
    if (!ready) throw new Error('Service startup was not verified. Inspect setup-service logs; do not reset data.');
    await deps.verify(directory, serviceUrl);
  }
  if (options.startOnly) return { status: 'service_verified', serviceUrl, dataDirectory: directory };
  let installed;
  try {
    await deps.run('codex', ['plugin', 'marketplace', 'add', bundle.marketplaceRoot, '--json']);
    const result = await deps.run('codex', ['plugin', 'add', 'ugk-cockpit@ugk-cockpit-local', '--json']);
    installed = JSON.parse(result.stdout);
  } catch {
    throw new Error('Codex plugin registration did not complete. Inspect the configured marketplace and CLI compatibility, then retry; host verification remains pending.');
  }
  if (installed.pluginId !== 'ugk-cockpit@ugk-cockpit-local' || !bundle.version || installed.version !== bundle.version) {
    throw new Error('Codex did not confirm the expected Cockpit plugin version. Installation is not verified; inspect the marketplace registration before retrying.');
  }
  return {
    status: 'host_verification_pending', serviceUrl, dataDirectory: directory, pluginInstalled: true,
    hostVerification: 'pending',
    nextAction: 'Reconnect Codex or open a new task if necessary, then call ugk_work_context with {}. Installation is usable only after the host exposes and successfully calls the MCP tool. Do not init an existing session.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--dry-run', '--start-only'].includes(arg))) {
    console.error('Usage: node scripts/setup-codex.mjs [--dry-run] [--start-only]');
    process.exitCode = 1;
  } else {
    try {
      const result = await setupCodex({ dryRun: args.includes('--dry-run'), startOnly: args.includes('--start-only') });
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'migration_needed') process.exitCode = 2;
    }
    catch (error) { console.error(`Setup incomplete: ${error.message}`); process.exitCode = 1; }
  }
}
