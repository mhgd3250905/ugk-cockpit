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

test('Cockpit skill packages expose the five approved user actions', () => {
  assert.deepEqual(COCKPIT_SKILL_NAMES, [
    'cockpit-init',
    'cockpit-progress',
    'cockpit-relay',
    'cockpit-closeout',
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
    ['cockpit-closeout', ['ugk_work_progress']],
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
  for (const name of ['cockpit-init', 'cockpit-relay', 'cockpit-closeout', 'cockpit-handoff']) {
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

test('completed handoff explicitly accompanies closeout without requiring a second skill invocation', () => {
  const instructions = readFileSync(
    path.join(repositoryRoot, 'skills', 'cockpit-handoff', 'SKILL.md'),
    'utf8',
  );
  assert.match(instructions, /用户明确要求/);
  assert.match(instructions, /功能完成|commit|上下文/);
  assert.match(instructions, /明确选择 `outcome: "completed"`/);
  assert.match(instructions, /同一手动 handoff 工作流/);
  assert.match(instructions, /该 `completed` 选择本身就是执行 closeout 前置的用户授权/);
  assert.match(instructions, /不要求用户额外再点名 `\$cockpit-closeout`/);
  assert.match(instructions, /当前 `HEAD` 仍有效/);
  assert.match(instructions, /`commit SHA`/);
  assert.match(instructions, /closeout 未完成/);
  assert.match(instructions, /`blocked` 或 `abandoned` 不要求 closeout/);
  assert.match(instructions, /不得以 `completed` 调用 `ugk_work_handoff`/);
  assert.match(instructions, /closeout 失败的原因/);
  assert.match(instructions, /普通完成、commit、测试或其他非终态动作隐式触发/);
  assert.doesNotMatch(instructions, /需要先显式调用 `\$cockpit-closeout`/);
});

test('cockpit-closeout is explicit, bounded, and records one non-terminal progress checkpoint', () => {
  const instructions = readFileSync(
    path.join(repositoryRoot, 'skills', 'cockpit-closeout', 'SKILL.md'),
    'utf8',
  );
  assert.match(instructions, /只能由用户显式调用/);
  assert.match(instructions, /明确选择 `outcome: "completed"` 的同一手动 handoff 工作流的伴随前置执行/);
  assert.match(instructions, /active.*Cockpit session/);
  assert.match(instructions, /可信 `sessionId` 和 `revision`/);
  assert.match(instructions, /本阶段基线、canonical 文档\/配置\/记录、收束范围和改动归属/);
  assert.match(instructions, /当前阶段 delta/);
  assert.match(instructions, /确定.*对齐问题/);
  assert.match(instructions, /必要验证/);
  assert.match(instructions, /commit SHA/);
  assert.match(instructions, /本阶段没有改动且当前 `HEAD` 已有仍有效的验证证据/);
  assert.match(instructions, /不得创建空提交/);
  assert.match(instructions, /secrets、凭据、API token/);
  assert.match(instructions, /ugk_work_progress/);
  assert.match(instructions, /"expectedRevision"/);
  assert.match(instructions, /"status": "working"/);
  assert.match(instructions, /`working` 或 `in_progress`/);
  assert.match(instructions, /调用一次/);
  assert.match(instructions, /closeout 唯一的 progress 记录/);
  assert.match(instructions, /不要因为 closeout 创建或复用的 commit 再额外触发通用 `\$cockpit-progress`/);
  assert.match(instructions, /同一 closeout commit 记录了可信进展/);
  assert.match(instructions, /直接复用该记录及其最新 `revision`/);
  assert.match(instructions, /不再调用 progress/);
  assert.match(instructions, /不要重复记录/);
  assert.match(instructions, /不得猜 revision/);
  assert.match(instructions, /当前已授权项目\/工作副本/);
  assert.doesNotMatch(instructions, /不把业务项目|不得.*业务项目.*范围/);
  assert.match(instructions, /不自动 relay 或 handoff/);
  assert.doesNotMatch(instructions, /ugk_work_handoff/);
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

  // Standard copy block, summary isolation, and non-empty field requirements
  assert.match(instructions, /text 代码块/);
  assert.match(instructions, /唯一事实源/);
  assert.match(instructions, /自行拼接/);
  assert.match(instructions, /摘要隔离/);
  assert.match(instructions, /严禁混入.*复制块/);
  assert.match(instructions, /缺任一字段不得宣告成功/);
  assert.match(instructions, /缺少必要字段不得声称/);

  // Prepare stays a lightweight, non-blocking summary and resume does no alignment check.
  assert.match(instructions, /准备模式只做轻量对齐摘要/);
  assert.match(instructions, /复用当前已知事实/);
  assert.match(instructions, /本阶段已经观察到的未对齐项/);
  assert.match(instructions, /扫描全仓、运行测试、修文档或创建 commit/);
  assert.match(instructions, /无论是否有未对齐项都不得阻塞 relay/);
  assert.match(instructions, /pendingItems.*risks.*nextSessionFocus/);
  assert.match(resumeSection, /不执行对齐检查/);
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
