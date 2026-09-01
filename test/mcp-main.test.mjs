import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('stdio MCP initializes when the Cockpit API token file is outside the client sandbox', () => {
  const isolatedLocalAppData = mkdtempSync(path.join(os.tmpdir(), 'ugk-mcp-isolated-'));
  try {
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'isolated-client', version: '1.0.0' },
      },
    };
    const output = execFileSync(process.execPath, ['src/mcp/main.mjs'], {
      cwd: path.resolve('.'),
      env: { ...process.env, LOCALAPPDATA: isolatedLocalAppData },
      input: `${JSON.stringify(request)}\n`,
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    const response = JSON.parse(output.trim().split(/\r?\n/)[0]);
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, 'ugk-cockpit');
  } finally {
    rmSync(isolatedLocalAppData, { recursive: true, force: true });
  }
});
