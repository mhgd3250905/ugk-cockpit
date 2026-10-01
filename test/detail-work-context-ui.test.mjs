import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../web/src/main.jsx', import.meta.url), 'utf8');
const context = readFileSync(new URL('../web/src/work-context.jsx', import.meta.url), 'utf8');
const detailPage = source.slice(source.indexOf('function ProjectDetailPage('), source.indexOf('function DetailLoadingState('));
const detailContent = source.slice(source.indexOf('function ProjectDetailContent('), source.indexOf('function ConversationControlPanel('));

// These source contracts supplement browser checks and the conversation-control
// state tests. They guard component boundaries without snapshotting the design.
test('detail header opens the selected work context and supplies its actual focus-return trigger', () => {
  assert.match(detailPage, /workContextRef\s*=\s*useRef\(null\)/);
  assert.match(detailPage, /ref=\{sessionTriggerRef\}/);
  assert.match(detailPage, /workContextRef\.current\?\.openSessions\(sessionTriggerRef\.current\)/);
  assert.match(detailPage, /workContextRef=\{workContextRef\}/);
  assert.match(detailContent, /<WorkContext[\s\S]*?ref=\{workContextRef\}/);
  assert.match(detailContent, /context=\{selectedContext\}/);
  assert.match(detailContent, /worktreeId=\{selectedLane\?\.worktreeId \|\| selectedContext\?\.worktreeId\}/);
});

test('detail retains the original main tabs and lane-aware timeline interactions', () => {
  assert.match(detailContent, /useState\('timeline'\)/);
  for (const name of ['工作线', '工作说明', '开发空间']) assert.ok(detailContent.includes(name));
  assert.match(detailContent, /<TimelineLaneControls[\s\S]*?focusedLaneKey=\{focusedLaneKey\}[\s\S]*?onFocusLane=\{setFocusedLaneKey\}/);
  assert.match(detailContent, /<TimelineHistory[\s\S]*?entries=\{timelineEntries\}[\s\S]*?lanes=\{timelineLanes\}[\s\S]*?focusedLaneKey=\{focusedLaneKey\}[\s\S]*?onFocusLane=\{setFocusedLaneKey\}/);
  assert.match(detailContent, /timeline\.hasMore[\s\S]*?onClick=\{onLoadOlder\}[\s\S]*?disabled=\{loadingMore\}/);
  assert.match(detailContent, /加载更早记录/);
});

test('work information offers stable overview, session, and code sections', () => {
  for (const label of ['工作概况', '会话与接手', '代码记录']) assert.ok(context.includes(label), `missing ${label}`);
  assert.match(context, /role="tablist"/);
  assert.match(context, /role="tab"/);
  assert.match(context, /role="tabpanel"/);
  assert.match(context, /aria-selected=/);
  assert.match(context, /aria-controls=/);
  assert.match(context, /aria-labelledby=/);
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.ok(context.includes(`'${key}'`), `missing keyboard navigation ${key}`);
  assert.match(context, /tabIndex=\{activeTab === tab\.id \? 0 : -1\}/);
});

test('work information returns focus to the entry actually used and summary defaults to overview', () => {
  assert.match(context, /returnFocusRef\.current = triggerElement \|\| triggerRef\.current/);
  assert.match(context, /openSessions\(triggerElement\)\s*\{\s*openTab\('sessions', triggerElement\)/);
  assert.match(context, /onClick=\{\(event\) => openTab\('overview', event\.currentTarget\)\}/);
  assert.match(context, /finalFocus=\{returnFocusRef\}/);
});

test('switching information tabs hides session controls without unmounting a pending operation', () => {
  const sessionsPanel = context.match(/<section\b[^>]*id=\{`\$\{id\}-panel-sessions`\}[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(sessionsPanel, 'sessions tab panel must remain in the dialog tree');
  assert.match(sessionsPanel[0], /hidden=\{activeTab !== 'sessions'\}/);
  assert.match(sessionsPanel[1], /\{open && operations\}/);
  assert.doesNotMatch(sessionsPanel[1], /activeTab|selectTab/,
    'session operations may depend on dialog opening, but not tab selection');
  assert.match(detailContent, /\[conversationState\] = useState\(createConversationControlState\)/,
    'exact request bodies and late receipts must remain owned by the project detail');
});

test('recorded code provenance is distinct from the currently controllable session', () => {
  assert.match(context, /完整提交与记录来源/);
  assert.match(context, /记录关联会话 ID<\/dt><dd>\{context.sessionId\}/);
  assert.match(context, /记录 Revision<\/dt><dd>\{context.revision\}/);
  assert.match(context, /可能与“会话与接手”中的当前可操作会话不同/);
  assert.match(context, /代码状态为最近一次记录的结果，可能与当前本地文件不同/);
  assert.match(context, /会话接入不代表 AI 正在运行/);
});

test('work information never presents missing or incoherent code observations as a clean working copy', () => {
  const start = context.indexOf('function fileStatus(');
  assert.notEqual(start, -1, 'code observation formatter must remain explicit');
  const end = context.indexOf('\n}', start) + 2;
  const fileStatus = new Function(`${context.slice(start, end)}; return fileStatus;`)();
  assert.equal(fileStatus(undefined), '尚未记录');
  assert.equal(fileStatus({ available: false }), '未采集版本状态');
  assert.equal(fileStatus({ hasChanges: true }), '有本地改动');
  assert.equal(fileStatus({ hasChanges: false }), '尚未记录');
  assert.equal(fileStatus({ hasChanges: false, coherence: 'incoherent' }), '尚未记录');
  assert.equal(fileStatus({ hasChanges: false, coherence: 'coherent' }), '没有本地改动');
});
