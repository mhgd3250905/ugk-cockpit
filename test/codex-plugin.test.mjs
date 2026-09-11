import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCodexPlugin } from '../scripts/build-codex-plugin.mjs';
import { COCKPIT_SKILL_NAMES } from '../scripts/install-cockpit-skills.mjs';

test('generated plugin initializes outside repository and contains all skills without local data', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'ugk plugin '));
  try {
    const result = buildCodexPlugin({ outputRoot: temporary });
    const config = JSON.parse(readFileSync(path.join(result.pluginRoot, '.mcp.json'))).mcpServers['ugk-cockpit'];
    assert.equal(config.cwd, undefined, 'host project cwd must not be replaced by the plugin location');
    for (const name of COCKPIT_SKILL_NAMES) assert.ok(existsSync(path.join(result.pluginRoot, 'skills', name, 'SKILL.md')));
    for (const name of ['.data', '.git', 'node_modules', 'api-token', 'src/main.mjs']) assert.equal(existsSync(path.join(result.pluginRoot, name)), false);
    const request = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'plugin-test', version: '1' },
    } };
    const output = execFileSync(config.command, config.args, {
      cwd: temporary, input: JSON.stringify(request) + '\n', encoding: 'utf8',
      timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    assert.equal(JSON.parse(output.trim()).result.serverInfo.name, 'ugk-cockpit');
    assert.deepEqual(buildCodexPlugin({ outputRoot: temporary }), result);
    writeFileSync(path.join(result.pluginRoot, 'VERSION'), 'modified');
    assert.throws(() => buildCodexPlugin({ outputRoot: temporary }), /refusing overwrite/);
    assert.equal(readFileSync(path.join(result.pluginRoot, 'VERSION'), 'utf8'), 'modified');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('changed package keeps marketplace stable and preserves the old running bridge', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'ugk-plugin-update-'));
  try {
    const sourceRoot = path.join(temporary, 'source');
    for (const name of ['skills', 'src/mcp', 'packaging', 'src/core/delivery-contract.mjs', 'src/core/submit-notes-contract.mjs', 'src/core/assignments-contract.mjs', 'src/version.mjs', 'VERSION']) {
      const destination = path.join(sourceRoot, name);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.resolve(name), destination, { recursive: true });
    }
    const outputRoot = path.join(temporary, 'marketplace');
    const first = buildCodexPlugin({ sourceRoot, outputRoot });
    const oldConfig = readFileSync(path.join(first.runtimeRoot, '.mcp.json'), 'utf8');
    const oldGuide = readFileSync(path.join(first.runtimeRoot, 'skills/cockpit/SKILL.md'), 'utf8');
    writeFileSync(path.join(sourceRoot, 'skills/cockpit/SKILL.md'), oldGuide + '\nUpdated fixture.\n');
    const second = buildCodexPlugin({ sourceRoot, outputRoot });
    assert.equal(first.marketplaceRoot, second.marketplaceRoot);
    assert.equal(first.pluginRoot, second.pluginRoot);
    assert.notEqual(first.version, second.version);
    assert.equal(readFileSync(path.join(first.runtimeRoot, '.mcp.json'), 'utf8'), oldConfig);
    assert.equal(readFileSync(path.join(first.runtimeRoot, 'skills/cockpit/SKILL.md'), 'utf8'), oldGuide);
    const installed = JSON.parse(readFileSync(path.join(second.pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
    assert.equal(installed.version, second.version);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
