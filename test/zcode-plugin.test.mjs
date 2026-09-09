import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildZcodePlugin } from '../scripts/build-zcode-plugin.mjs';

test('ZCode package uses native manifests and a runnable strict stdio bridge outside the package', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'ugk zcode plugin '));
  try {
    const outputRoot = path.join(temporary, 'marketplace');
    const result = buildZcodePlugin({ outputRoot });
    const json = (relative) => JSON.parse(readFileSync(path.join(result.pluginRoot, relative), 'utf8'));
    const manifest = json('.zcode-plugin/plugin.json');
    assert.equal(manifest.name, 'ugk-cockpit');
    assert.equal(manifest.skills, './skills/');
    assert.equal(manifest.mcpServers, './.mcp.json');
    assert.equal(manifest.version, result.version);
    assert.match(manifest.version, /\+zcode\.[a-f0-9]{16}$/);
    assert.equal(existsSync(path.join(result.pluginRoot, '.codex-plugin')), false);
    assert.equal(result.marketplaceFile, path.join(outputRoot, '.claude-plugin', 'marketplace.json'));
    const marketplace = JSON.parse(readFileSync(result.marketplaceFile, 'utf8'));
    assert.equal(marketplace.name, 'ugk-cockpit-local');
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].source, './plugins/ugk-cockpit');
    assert.equal(path.resolve(outputRoot, marketplace.plugins[0].source), result.pluginRoot);
    assert.deepEqual(readdirSync(path.join(result.pluginRoot, 'skills')).sort(), [
      'cockpit', 'cockpit-closeout', 'cockpit-handoff', 'cockpit-init',
      'cockpit-progress', 'cockpit-relay', 'cockpit-submit',
    ]);
    for (const name of readdirSync(path.join(result.pluginRoot, 'skills'))) {
      assert.ok(existsSync(path.join(result.pluginRoot, 'skills', name, 'SKILL.md')));
    }
    const location = json('installed-location.json');
    assert.equal(location.host, 'zcode');
    assert.ok(path.isAbsolute(location.repositoryRoot));
    const mcp = json('.mcp.json');
    assert.deepEqual(Object.keys(mcp.mcpServers), ['ugk-cockpit']);
    const config = mcp.mcpServers['ugk-cockpit'];
    assert.deepEqual(Object.keys(config).sort(), ['args', 'command', 'type']);
    assert.equal(config.type, 'stdio');
    assert.equal(config.command, process.execPath);
    assert.deepEqual(config.args, [path.join(result.runtimeRoot, 'src/mcp/main.mjs')]);
    const projectCwd = path.join(temporary, 'independent project');
    mkdirSync(projectCwd);
    const output = execFileSync(config.command, config.args, {
      cwd: projectCwd, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'zcode-package-test', version: '1' },
      } }) + '\n',
    });
    const response = JSON.parse(output.trim());
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, 'ugk-cockpit');
    assert.deepEqual(buildZcodePlugin({ outputRoot }), result);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
