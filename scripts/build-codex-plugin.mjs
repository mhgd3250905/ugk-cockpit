import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function assertSameTree(left, right) {
  if (lstatSync(left).isSymbolicLink() || lstatSync(right).isSymbolicLink()) throw new Error('Plugin source must not be a symlink');
  const names = readdirSync(left).sort();
  if (JSON.stringify(names) !== JSON.stringify(readdirSync(right).sort())) throw new Error('Existing plugin source differs; refusing overwrite');
  for (const name of names) {
    const a = path.join(left, name), b = path.join(right, name);
    if (lstatSync(a).isSymbolicLink() || lstatSync(b).isSymbolicLink()) throw new Error('Plugin source must not be a symlink');
    if (lstatSync(a).isDirectory() && lstatSync(b).isDirectory()) assertSameTree(a, b);
    else if (!lstatSync(a).isFile() || !lstatSync(b).isFile() || !readFileSync(a).equals(readFileSync(b))) {
      throw new Error('Existing plugin source differs; refusing overwrite');
    }
  }
}

// Explicit inputs: never include working data, credentials, dependencies or Git state.
export function buildPluginPackage({ outputRoot, sourceRoot = repositoryRoot, host = 'codex' } = {}) {
  if (!outputRoot) throw new Error('outputRoot is required');
  if (!['codex', 'zcode'].includes(host)) throw new Error('Unsupported plugin host');
  const manifestPath = `.${host}-plugin/plugin.json`;
  const files = new Map();
  function collect(relative) {
    for (const entry of readdirSync(path.join(sourceRoot, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Plugin input must not be a symlink: ${name}`);
      if (entry.isDirectory()) collect(name);
      else if (entry.isFile()) files.set(name, readFileSync(path.join(sourceRoot, name)));
    }
  }
  collect('skills');
  collect('src/mcp');
  for (const name of ['VERSION', 'src/version.mjs', 'src/core/delivery-contract.mjs', 'src/core/submit-notes-contract.mjs', 'src/core/assignments-contract.mjs']) {
    files.set(name, readFileSync(path.join(sourceRoot, name)));
  }
  const manifest = JSON.parse(readFileSync(path.join(sourceRoot, 'packaging/ugk-cockpit', manifestPath), 'utf8'));
  manifest.version = files.get('VERSION').toString().trim();
  files.set('installed-location.json', Buffer.from(JSON.stringify({ repositoryRoot: path.resolve(sourceRoot), host }, null, 2)));
  const hash = createHash('sha256').update(process.execPath).update(path.resolve(outputRoot)).update(JSON.stringify(manifest));
  for (const [name, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update(content);
  const digest = hash.digest('hex').slice(0, 16);
  manifest.version += `+${host}.${digest}`;
  const marketplaceRoot = path.resolve(outputRoot);
  const pluginRoot = path.join(marketplaceRoot, 'plugins', 'ugk-cockpit');
  const runtimeRoot = path.join(marketplaceRoot, 'packages', digest, 'ugk-cockpit');
  files.set(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  // Absolute paths are generated on the installing machine, never shipped as user configuration.
  // Do not set cwd: the bridge must inherit the host's project working directory.
  files.set('.mcp.json', Buffer.from(JSON.stringify({ mcpServers: { 'ugk-cockpit': {
    ...(host === 'zcode' ? { type: 'stdio' } : {}),
    command: process.execPath, args: [path.join(runtimeRoot, 'src/mcp/main.mjs')],
  } } }, null, 2) + '\n'));
  for (const [name, content] of files) {
    const destination = path.join(runtimeRoot, name);
    if (existsSync(destination)) {
      if (!readFileSync(destination).equals(content)) throw new Error('Existing plugin package differs; refusing overwrite');
    } else {
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, content, { flag: 'wx' });
    }
  }
  const marketplaceFile = path.join(marketplaceRoot, host === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json');
  const marketplace = JSON.stringify({ name: 'ugk-cockpit-local', interface: { displayName: 'UGK Cockpit' }, plugins: [{
    name: 'ugk-cockpit', source: host === 'codex' ? { source: 'local', path: './plugins/ugk-cockpit' } : './plugins/ugk-cockpit',
    ...(host === 'codex' ? { policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' } : {}),
  }] }, null, 2) + '\n';
  if (existsSync(marketplaceFile)) {
    if (readFileSync(marketplaceFile, 'utf8') !== marketplace) throw new Error('Existing marketplace differs; refusing overwrite');
  } else {
    mkdirSync(path.dirname(marketplaceFile), { recursive: true });
    writeFileSync(marketplaceFile, marketplace, { flag: 'wx' });
  }
  // The marketplace source stays fixed across versions. Running bridges keep their
  // immutable runtime, even while Codex installs a new snapshot of this source.
  if (existsSync(pluginRoot)) {
    if (!existsSync(path.join(pluginRoot, manifestPath))) throw new Error('Existing plugin belongs to another host; refusing overwrite');
    const previous = JSON.parse(readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
    const entry = previous?.mcpServers?.['ugk-cockpit']?.args?.[0];
    const oldRuntime = typeof entry === 'string' ? path.resolve(path.dirname(entry), '../..') : '';
    const relative = path.relative(path.join(marketplaceRoot, 'packages'), oldRuntime).replaceAll('\\', '/');
    if (!/^[a-f0-9]{16}\/ugk-cockpit$/.test(relative)) throw new Error('Unrecognized plugin source; refusing overwrite');
    assertSameTree(pluginRoot, oldRuntime);
    if (oldRuntime === runtimeRoot) return { marketplaceRoot, pluginRoot, runtimeRoot, marketplaceFile, version: manifest.version };
  }
  mkdirSync(path.dirname(pluginRoot), { recursive: true });
  const suffix = randomUUID();
  const staged = path.join(marketplaceRoot, 'plugins', `.ugk-cockpit-${suffix}`);
  cpSync(runtimeRoot, staged, { recursive: true, errorOnExist: true, force: false });
  const backup = path.join(marketplaceRoot, 'plugins', `.previous-ugk-cockpit-${suffix}`);
  const hadSource = existsSync(pluginRoot);
  if (hadSource) renameSync(pluginRoot, backup);
  try { renameSync(staged, pluginRoot); }
  catch (error) { if (hadSource && !existsSync(pluginRoot)) renameSync(backup, pluginRoot); throw error; }
  return { marketplaceRoot, pluginRoot, runtimeRoot, marketplaceFile, version: manifest.version };
}

export function buildCodexPlugin(options = {}) { return buildPluginPackage({ ...options, host: 'codex' }); }

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(buildCodexPlugin({ outputRoot: process.argv[2] }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
