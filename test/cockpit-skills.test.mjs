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

test('Cockpit skill packages expose the four approved user actions', () => {
  assert.deepEqual(COCKPIT_SKILL_NAMES, [
    'cockpit-init',
    'cockpit-progress',
    'cockpit-relay',
    'cockpit-handoff',
  ]);
  for (const name of COCKPIT_SKILL_NAMES) {
    assert.equal(existsSync(path.join(repositoryRoot, 'skills', name, 'SKILL.md')), true);
    assert.equal(existsSync(path.join(repositoryRoot, 'skills', name, 'agents', 'openai.yaml')), true);
  }
});

test('Cockpit skills map to the intended MCP tools without adding cockpit-start', () => {
  const expectedTools = new Map([
    ['cockpit-init', ['ugk_work_init']],
    ['cockpit-progress', ['ugk_work_progress']],
    ['cockpit-relay', ['ugk_work_relay', 'ugk_work_resume']],
    ['cockpit-handoff', ['ugk_work_handoff']],
  ]);
  for (const [name, tools] of expectedTools) {
    const instructions = readFileSync(
      path.join(repositoryRoot, 'skills', name, 'SKILL.md'),
      'utf8',
    );
    for (const tool of tools) assert.match(instructions, new RegExp(`\\b${tool}\\b`));
    assert.doesNotMatch(instructions, /cockpit-start|ugk_work_accept|ugk_work_begin/);
  }
});

test('only progress may be selected implicitly', () => {
  for (const name of ['cockpit-init', 'cockpit-relay', 'cockpit-handoff']) {
    const metadata = readFileSync(
      path.join(repositoryRoot, 'skills', name, 'agents', 'openai.yaml'),
      'utf8',
    );
    assert.match(metadata, /allow_implicit_invocation:\s*false/, name);
  }
  const progressMetadata = readFileSync(
    path.join(repositoryRoot, 'skills', 'cockpit-progress', 'agents', 'openai.yaml'),
    'utf8',
  );
  assert.match(progressMetadata, /allow_implicit_invocation:\s*true/);
});

test('terminal handoff cannot be inferred from normal completion', () => {
  const instructions = readFileSync(
    path.join(repositoryRoot, 'skills', 'cockpit-handoff', 'SKILL.md'),
    'utf8',
  );
  assert.match(instructions, /用户明确要求/);
  assert.match(instructions, /功能完成|commit|上下文/);
});

test('progress stays non-terminal and cannot implicitly trigger relay or handoff', () => {
  const instructions = readFileSync(
    path.join(repositoryRoot, 'skills', 'cockpit-progress', 'SKILL.md'),
    'utf8',
  );
  assert.match(instructions, /只有用户明确要求结束.*cockpit-handoff/i);
  assert.match(instructions, /只有用户明确要求换聊天.*cockpit-relay/i);
  assert.match(instructions, /功能完成、commit、测试通过或上下文堆积/);
});

test('cockpit-relay defines two explicit modes and precise success reporting criteria', () => {
  const instructions = readFileSync(
    path.join(repositoryRoot, 'skills', 'cockpit-relay', 'SKILL.md'),
    'utf8',
  );
  assert.match(instructions, /ugk_work_relay/);
  assert.match(instructions, /ugk_work_resume/);
  assert.match(instructions, /relayPrepared:\s*true/);
  assert.match(instructions, /awaiting_resume/);
  assert.match(instructions, /continueMessage/);
  assert.match(instructions, /continueCode/);
  assert.match(instructions, /relayAccepted:\s*true/);
  assert.match(instructions, /active/);
  assert.match(instructions, /sessionId/);
  assert.match(instructions, /revision/);
  assert.doesNotMatch(instructions, /cockpit-start|ugk_work_accept|ugk_work_begin/);

  // Relay prepare payload contract
  for (const field of [
    'sessionId',
    'clientRequestId',
    'expectedRevision',
    'nextSessionFocus',
    'summary',
    'currentState',
    'completedItems',
    'pendingItems',
    'decisions',
    'artifactRefs',
    'risks',
    'suggestedSkills',
  ]) {
    assert.match(instructions, new RegExp(`"${field}"`));
  }
  assert.doesNotMatch(instructions, /"reason"|"nextTask"/);

  // Relay resume payload contract (only continueCode and clientRequestId)
  const resumeSection = instructions.split(/## 模式二：恢复接力/)[1] || '';
  assert.match(resumeSection, /"continueCode"/);
  assert.match(resumeSection, /"clientRequestId"/);
  assert.doesNotMatch(resumeSection, /"currentTask"|"currentState"|"expectedRevision"/);

  // Non-terminal lifecycle and boundary rules
  assert.match(instructions, /停止继续修改/);
  assert.match(instructions, /不结束.*阶段/);
  assert.match(instructions, /不重新 init/);
  assert.match(instructions, /不自动 handoff/);
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
