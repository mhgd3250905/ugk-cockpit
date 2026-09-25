import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const mainJsx = readFileSync(path.join(repoRoot, 'web', 'src', 'main.jsx'), 'utf8');

// Settling a stranded lifecycle fence marks the development space `attention`
// (the Git effect happened, its business outcome did not). AGENTS.md requires
// every abnormal state to answer what happened and what to do next, so the space
// card must not render `attention` with the happy-path wording — that chain used
// to fall through to "可继续", hiding exactly the case the operator has to look at.
test('the space card explains an attention state instead of showing it as ready', () => {
  const lines = mainJsx.split(String.fromCharCode(10));
  const stateLine = lines.find((line) => line.includes('className="space-state">'));
  assert.ok(stateLine, 'the space state label line was not found');
  assert.match(stateLine, /space\.status === 'attention' \? '需要处理'/);
  assert.ok(stateLine.indexOf("'attention'") < stateLine.indexOf("'可继续'"),
    'attention must be matched before the fallthrough copy');

  const copyLine = lines.find((line) => line.includes("removed ? '本地副本已删除"));
  assert.ok(copyLine, 'the space copy line was not found');
  assert.match(copyLine, /workspace_lifecycle_abandoned/);
  assert.match(copyLine, /代码保持原样/);
});
