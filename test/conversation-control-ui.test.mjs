import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../web/src/main.jsx', import.meta.url), 'utf8');
const panel = source.slice(source.indexOf('function ConversationControlPanel('), source.indexOf('function SessionDiagnosticsPanel('));
const detailFormatterSource = source.slice(source.indexOf('function timelineDetailText('), source.indexOf('function timelineTimestamp('));
const timelineDetailText = new Function(`${detailFormatterSource}; return timelineDetailText;`)();

test('timeline renders transfer actor payloads as meaningful strings instead of React object children', () => {
  assert.equal(timelineDetailText({ nodeType: 'conversation.transfer.issue', actor: { type: 'user' } }), '用户授权转交，等待新聊天接手 · 项目所有者');
  assert.equal(timelineDetailText({ nodeType: 'conversation.transfer.consume', actor: { type: 'ai', platform: 'zcode', conversationId: 'sess_C' } }), '新聊天已接手 · zcode / sess_C');
  assert.equal(timelineDetailText({ nodeType: 'conversation.transfer.cancel', actor: { type: 'user' } }), '取消转交并恢复原聊天 · 项目所有者');
  assert.equal(timelineDetailText('原有文字进展'), '原有文字进展');
  assert.equal(timelineDetailText({ summary: '其他结构化进展' }), '其他结构化进展');
  assert.equal(typeof timelineDetailText({ actor: {}, nested: {} }), 'string');
  assert.equal((source.match(/\{timelineDetailText\(detail\)\}/g) || []).length, 3);
});

test('conversation control scopes chains to selected work line with explicit user transfer confirmation', () => {
  assert.match(source, /operations=\{<ConversationControlPanel projectId=\{project.id\} worktreeId=/);
  assert.match(panel, /chain.worktreeId === worktreeId/);
  assert.match(panel, /历史已结束会话/);
  assert.match(panel, /chain\.latestNode/);
  assert.match(panel, /owner\.conversationLocator/);
  assert.match(panel, /确认冻结并签发授权/);
  assert.match(panel, /确认恢复原聊天/);
  assert.match(panel, /restorePreviousOwner: true/);
  assert.match(panel, /expectedRevision: chain.revision/);
  assert.match(panel, /10 分钟有效，超时仍保持待处理/);
  assert.match(panel, /const actionable = \['active', 'awaiting_resume'\].includes\(chain.status\)/);
});

test('expired historical authorization receipts never render an empty or reusable code', () => {
  assert.match(panel, /const hasCurrentAuthorization = request.action === 'transfer' && Boolean\(result.transferCode\)/);
  assert.match(panel, /setIssued\(hasCurrentAuthorization \? result : null\)/);
  assert.match(panel, /statusLabels\[result.currentStatus\]/);
  assert.match(panel, /历史请求已处理/);
  assert.match(panel, /await onRefresh\(\)/);
});

test('transfer requests reuse a retained idempotent body and keep authorization secrets out of browser storage', () => {
  assert.match(panel, /if \(!retry\) \{/);
  assert.match(panel, /clientRequestId: crypto.randomUUID\(\)/);
  assert.match(panel, /const request = pendingRequest.current/);
  assert.match(panel, /body: JSON.stringify\(request.body\)/);
  assert.match(panel, /submit\(true\)/);
  assert.match(panel, /await navigator.clipboard.writeText\(value\);\s*setCopied\(label\)/);
  assert.doesNotMatch(panel, /localStorage|sessionStorage|console\./);
  assert.match(panel, /error.impact/);
  assert.match(panel, /error.required_action/);
});
