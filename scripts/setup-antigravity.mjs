import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Antigravity resolves projects through per-workspace workspace plugins, not
// through its global MCP registration (a global entry shares one daemon whose
// working directory is the host install folder, so no chat can be attributed
// to a project). This installer stamps the two-file workspace plugin into a
// target project; see docs/MCP_HOST_SUPPORT.md for the verified host shape.
const root = path.resolve(import.meta.dirname, '..');
const PLUGIN_DIR_NAME = 'ugk-cockpit';

export function buildPluginFiles({ repoRoot = root, projectPath }) {
  const entry = [path.join(repoRoot, 'src', 'mcp', 'main.mjs')].map((value) => value.split(path.sep).join('/'));
  return {
    'plugin.json': `${JSON.stringify({ name: PLUGIN_DIR_NAME }, null, 2)}\n`,
    'mcp_config.json': `${JSON.stringify({
      mcpServers: {
        [PLUGIN_DIR_NAME]: { command: 'node', args: entry, cwd: projectPath.split(path.sep).join('/') },
      },
    }, null, 2)}\n`,
  };
}

export function installAntigravityPlugin({ projectPath, repoRoot = root, force = false, exists = existsSync, stat = statSync, read = readFileSync, write = writeFileSync, mkdir = mkdirSync } = {}) {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
    return { ok: false, code: 'ABSOLUTE_PATH_REQUIRED', message: '请传入要接入 Antigravity 的项目绝对路径。' };
  }
  if (!exists(projectPath) || !stat(projectPath).isDirectory()) {
    return { ok: false, code: 'PROJECT_NOT_FOUND', message: `路径不存在或不是文件夹：${projectPath}` };
  }
  const pluginDir = path.join(projectPath, '.agents', 'plugins', PLUGIN_DIR_NAME);
  const manifestPath = path.join(pluginDir, 'plugin.json');
  const configPath = path.join(pluginDir, 'mcp_config.json');

  if (exists(manifestPath)) {
    let manifest = null;
    try { manifest = JSON.parse(read(manifestPath, 'utf8')); } catch { manifest = null; }
    if (manifest?.name !== PLUGIN_DIR_NAME) {
      // The folder name is ours but the manifest is not: another plugin owns
      // it. Never overwrite a foreign plugin; the user renames or removes it.
      return { ok: false, code: 'FOREIGN_PLUGIN', message: `${pluginDir} 已被名为「${manifest?.name ?? '未知'}」的其他插件占用，请先手动处理后再安装。` };
    }
  }

  let servers = {};
  if (exists(configPath)) {
    try {
      const parsed = JSON.parse(read(configPath, 'utf8'));
      servers = parsed.mcpServers ?? {};
    } catch {
      if (!force) {
        return { ok: false, code: 'UNREADABLE_CONFIG', message: `${configPath} 不是有效 JSON；确认无需保留后加 --force 重建。` };
      }
      servers = {};
    }
  }
  const files = buildPluginFiles({ repoRoot, projectPath });
  const desired = JSON.parse(files['mcp_config.json']);
  servers[PLUGIN_DIR_NAME] = desired.mcpServers[PLUGIN_DIR_NAME];

  mkdir(pluginDir, { recursive: true });
  write(manifestPath, files['plugin.json']);
  write(configPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  return {
    ok: true,
    pluginDir,
    manifestPath,
    configPath,
    preservedServers: Object.keys(servers).filter((name) => name !== PLUGIN_DIR_NAME),
    nextSteps: [
      '重启 Antigravity（或重开其聊天窗口）让插件被发现。',
      '在该项目的聊天里调用 ugk_work_context({}) 核对项目与绑定状态。',
    ],
  };
}

export function main(argv = process.argv.slice(2)) {
  const force = argv.includes('--force');
  const projectPath = argv.find((value) => !value.startsWith('--'));
  if (!projectPath) {
    process.stdout.write('用法：npm run setup:antigravity -- <项目绝对路径> [--force]\n为指定项目写入 Antigravity 工作区插件（.agents/plugins/ugk-cockpit/），让该项目内的聊天正确解析到本项目。\n');
    return 1;
  }
  const result = installAntigravityPlugin({ projectPath: path.resolve(projectPath), force });
  if (!result.ok) {
    process.stderr.write(`[ERROR] ${result.message}\n`);
    return 1;
  }
  process.stdout.write(`[OK] 已写入 ${result.manifestPath}\n[OK] 已写入 ${result.configPath}\n`);
  if (result.preservedServers.length > 0) {
    process.stdout.write(`[OK] 保留了插件内的其他 MCP 服务器：${result.preservedServers.join(', ')}\n`);
  }
  for (const step of result.nextSteps) process.stdout.write(`[NEXT] ${step}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exitCode = main();
}
