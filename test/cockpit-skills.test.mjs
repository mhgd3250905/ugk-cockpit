import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  COCKPIT_SKILL_NAMES,
  defaultCodexSkillsRoot,
  installCockpitSkills,
} from '../scripts/install-cockpit-skills.mjs';

const repositoryRoot = path.resolve('.');

test('Cockpit skill packages expose the three approved user actions', () => {
  assert.deepEqual(COCKPIT_SKILL_NAMES, [
    'cockpit-init',
    'cockpit-progress',
    'cockpit-handoff',
  ]);
  for (const name of COCKPIT_SKILL_NAMES) {
    assert.equal(existsSync(path.join(repositoryRoot, 'skills', name, 'SKILL.md')), true);
    assert.equal(existsSync(path.join(repositoryRoot, 'skills', name, 'agents', 'openai.yaml')), true);
  }
});

test('Cockpit skills map to the intended MCP tools without adding cockpit-start', () => {
  const expectedTools = new Map([
    ['cockpit-init', 'ugk_work_init'],
    ['cockpit-progress', 'ugk_work_progress'],
    ['cockpit-handoff', 'ugk_work_handoff'],
  ]);
  for (const [name, tool] of expectedTools) {
    const instructions = readFileSync(
      path.join(repositoryRoot, 'skills', name, 'SKILL.md'),
      'utf8',
    );
    assert.match(instructions, new RegExp(`\\b${tool}\\b`));
    assert.doesNotMatch(instructions, /cockpit-start|ugk_work_accept|ugk_work_begin/);
  }
});

test('skill installer copies packages and refuses an unapproved overwrite', () => {
  const targetRoot = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-skills-'));
  try {
    const installed = installCockpitSkills({ targetRoot });
    assert.deepEqual(installed.installed, COCKPIT_SKILL_NAMES);
    for (const name of COCKPIT_SKILL_NAMES) {
      assert.equal(existsSync(path.join(targetRoot, name, 'SKILL.md')), true);
    }
    assert.throws(
      () => installCockpitSkills({ targetRoot }),
      /Refusing to overwrite existing skills/,
    );
    assert.doesNotThrow(() => installCockpitSkills({ targetRoot, force: true }));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('default Codex target honors CODEX_HOME', () => {
  assert.equal(
    defaultCodexSkillsRoot({ env: { CODEX_HOME: 'E:\\isolated-codex' }, home: 'C:\\ignored' }),
    path.resolve('E:\\isolated-codex', 'skills'),
  );
});
