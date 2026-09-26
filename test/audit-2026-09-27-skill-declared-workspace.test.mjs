// 第 29 轮审计（2026-09-27）：Skill 文本不得禁止协议与工作台指令都要求的参数。
// `ugk_work_init` 的 schema 定义了可选 `declaredWorkspace`（专供桥接进程拿不到工作
// 目录的宿主），操作台复制的接入指令也明确要求把它作为「项目目录」传入；但
// `$cockpit-init` 的文本写着「输入只包含上面的四个字段；不要自行传……路径」。
// 遵守 Skill 的 Agent 会拒绝这个唯一能让全局桥宿主定位项目的参数，于是永远停在
// 「没有可识别的工作目录」。alpha.51 的核心能力因此被一行文案关掉。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { TOOLS } from '../src/mcp/stdio-protocol.mjs';

const skillPath = path.join(import.meta.dirname, '..', 'skills', 'cockpit-init', 'SKILL.md');

test('the init schema really offers declaredWorkspace as the access instruction claims', () => {
  const init = TOOLS.find((tool) => tool.name === 'ugk_work_init');
  assert.ok(init, 'ugk_work_init 必须存在');
  assert.ok(
    Object.hasOwn(init.inputSchema.properties, 'declaredWorkspace'),
    '缺陷前提：schema 确实提供 declaredWorkspace',
  );
  assert.deepEqual(init.inputSchema.required, ['initCode', 'clientRequestId', 'currentTask', 'currentState']);
});

test('the init skill permits declaredWorkspace and keeps forbidding everything else', () => {
  const text = readFileSync(skillPath, 'utf8');
  assert.match(
    text,
    /declaredWorkspace/,
    '$cockpit-init 必须告知何时可以传 declaredWorkspace，否则全局桥宿主无法接入',
  );
  // 反向界：不得顺势放松对其它路径/标识参数的禁令。
  assert.match(text, /不要自行传 `mcpWorkingDirectory`/, 'stdio 侧仍不得自行传工作目录参数');
  assert.match(text, /worktreeId|项目标识/, '仍要禁止自行拼装项目标识');
});

test('no skill sentence restricts the init input to a fixed field list that omits declaredWorkspace', () => {
  const text = readFileSync(skillPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('只包含')) continue;
    assert.match(
      line,
      /declaredWorkspace/,
      `限定输入范围的那句话必须把 declaredWorkspace 列为例外: ${line}`,
    );
  }
});
