// setup:antigravity 安装器的契约：写入官方工作区插件、幂等、绝不覆盖外来插件，
// 并保留同文件内的其他 MCP 服务器条目。夹具只用临时目录与普通文件。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPluginFiles, installAntigravityPlugin } from '../scripts/setup-antigravity.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function tempProject(t, name) {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), `ugk-setup-ant-${name}-`)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('installs both plugin files with the project anchored as cwd', (t) => {
  const project = tempProject(t, 'install');
  const result = installAntigravityPlugin({ projectPath: project, repoRoot });
  assert.equal(result.ok, true, JSON.stringify(result));
  const manifest = JSON.parse(readFileSync(path.join(result.pluginDir, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'ugk-cockpit');
  const config = JSON.parse(readFileSync(path.join(result.pluginDir, 'mcp_config.json'), 'utf8'));
  const server = config.mcpServers['ugk-cockpit'];
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, [path.join(repoRoot, 'src', 'mcp', 'main.mjs').split(path.sep).join('/')]);
  assert.equal(server.cwd, project.split(path.sep).join('/'));
});

test('a second install is idempotent and preserves sibling MCP servers', (t) => {
  const project = tempProject(t, 'idempotent');
  assert.equal(installAntigravityPlugin({ projectPath: project, repoRoot }).ok, true);
  const configPath = path.join(project, '.agents', 'plugins', 'ugk-cockpit', 'mcp_config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.mcpServers['team-tool'] = { command: 'team-tool.exe', args: [] };
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const again = installAntigravityPlugin({ projectPath: project, repoRoot });
  assert.equal(again.ok, true);
  assert.deepEqual(again.preservedServers, ['team-tool']);
  const merged = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(merged.mcpServers['team-tool'].command, 'team-tool.exe');
  assert.equal(merged.mcpServers['ugk-cockpit'].cwd, project.split(path.sep).join('/'));
});

test('a foreign plugin in the target folder is never overwritten', (t) => {
  const project = tempProject(t, 'foreign');
  const pluginDir = path.join(project, '.agents', 'plugins', 'ugk-cockpit');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'someone-else' }));

  const refused = installAntigravityPlugin({ projectPath: project, repoRoot });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'FOREIGN_PLUGIN');
  assert.equal(JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')).name, 'someone-else');
  assert.ok(!existsSync(path.join(pluginDir, 'mcp_config.json')), 'refusal must not write a config for a foreign plugin');
});

test('an unreadable config is refused without --force and rebuilt with it', (t) => {
  const project = tempProject(t, 'unreadable');
  const pluginDir = path.join(project, '.agents', 'plugins', 'ugk-cockpit');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'ugk-cockpit' }));
  writeFileSync(path.join(pluginDir, 'mcp_config.json'), '{ not json');

  const refused = installAntigravityPlugin({ projectPath: project, repoRoot });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'UNREADABLE_CONFIG');

  const forced = installAntigravityPlugin({ projectPath: project, repoRoot, force: true });
  assert.equal(forced.ok, true);
  const config = JSON.parse(readFileSync(path.join(pluginDir, 'mcp_config.json'), 'utf8'));
  assert.equal(config.mcpServers['ugk-cockpit'].command, 'node');
});

test('missing, relative, and non-directory targets are rejected', (t) => {
  const project = tempProject(t, 'rejects');
  assert.equal(installAntigravityPlugin({ projectPath: path.join(project, 'missing'), repoRoot }).code, 'PROJECT_NOT_FOUND');
  assert.equal(installAntigravityPlugin({ projectPath: 'relative/path', repoRoot }).code, 'ABSOLUTE_PATH_REQUIRED');
  assert.equal(installAntigravityPlugin({ projectPath: path.join(project, 'file.txt'), repoRoot }).code, 'PROJECT_NOT_FOUND');
  writeFileSync(path.join(project, 'file.txt'), 'x');
});

test('CLI prints usage without a path and installs with one', (t) => {
  const project = tempProject(t, 'cli');
  const noArg = (() => {
    try {
      return {
        status: execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'setup-antigravity.mjs')], {
          encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        }),
        code: 0,
      };
    } catch (error) {
      return { status: error.stdout, code: error.status };
    }
  })();
  assert.equal(noArg.code, 1);
  assert.match(noArg.status, /setup:antigravity/);

  const output = execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'setup-antigravity.mjs'), project], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(output, /\[OK\] 已写入/);
  assert.match(output, /ugk_work_context/);
  assert.equal(JSON.parse(readFileSync(path.join(project, '.agents', 'plugins', 'ugk-cockpit', 'mcp_config.json'), 'utf8')).mcpServers['ugk-cockpit'].cwd,
    project.split(path.sep).join('/'));
});

test('buildPluginFiles emits stable, path-anchored content', () => {
  const files = buildPluginFiles({ repoRoot: 'E:/AII/ugk-cockpit', projectPath: 'E:/AII_Gemini/LSBK' });
  assert.equal(JSON.parse(files['plugin.json']).name, 'ugk-cockpit');
  const config = JSON.parse(files['mcp_config.json']);
  assert.equal(config.mcpServers['ugk-cockpit'].cwd, 'E:/AII_Gemini/LSBK');
  assert.deepEqual(config.mcpServers['ugk-cockpit'].args, ['E:/AII/ugk-cockpit/src/mcp/main.mjs']);
});
