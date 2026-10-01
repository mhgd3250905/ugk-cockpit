import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { agentPlatformPresentation } from '../web/src/agent-platform.mjs';

test('known platform labels use bundled official source assets', () => {
  assert.deepEqual(agentPlatformPresentation('Codex'), { label: 'Codex', logo: '/assets/agent-openai.png' });
  assert.deepEqual(agentPlatformPresentation(' ZCode '), { label: 'ZCode', logo: '/assets/agent-zcode.png' });
  assert.equal(agentPlatformPresentation('CODEX').logo, '/assets/agent-openai.png');
});

test('unknown or missing platform preserves honesty without borrowing another logo', () => {
  assert.deepEqual(agentPlatformPresentation('custom agent'), { label: 'custom agent', logo: null });
  for (const value of [null, undefined, '', '  ', {}]) {
    assert.deepEqual(agentPlatformPresentation(value), { label: '平台未记录', logo: null });
  }
  assert.equal(agentPlatformPresentation('Codex-like').logo, null);
});

test('platform images are local PNGs on flat paths allowed by the asset server', () => {
  for (const agent of ['Codex', 'ZCode']) {
    const { logo } = agentPlatformPresentation(agent);
    assert.match(logo, /^\/assets\/[a-zA-Z0-9._-]+$/);
    const bytes = readFileSync(new URL(`../web/public${logo}`, import.meta.url));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
});
