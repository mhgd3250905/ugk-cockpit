import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { beginCommand, withCommandActor } from '../src/core/command-journal.mjs';
import { bindConversation, readConversationOwner } from '../src/core/conversation-bindings.mjs';
import { issueConversationTransfer, consumeConversationTransfer, cancelConversationTransfer, readTransferState } from '../src/core/conversation-transfers.mjs';
import { createRelay, resumeRelay } from '../src/core/relays.mjs';
import { createHandoff } from '../src/core/handoffs.mjs';

const options = { authorizationKey: 'test-only-persistent-secret', now: 1000000 };
const issue = { sessionId: 's', expectedRevision: 1, clientRequestId: 'issue' };
const consumer = { sessionId: 's', conversationKey: 'C', binding: { bindingKind: 'host', host: 'zcode', locator: 'chat-C' }, clientRequestId: 'consume' };

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-transfer-'));
  const dbPath = path.join(root, 'db.sqlite');
  const db = openCockpitDatabase(dbPath);
  db.exec(`INSERT INTO worktrees (id, canonical_path, repository_identity, created_at) VALUES ('w', '/fixture', 'r', 'now');
    INSERT INTO projects (id,name,stage,worktree_id,status,status_reason,last_observed_at,created_at,updated_at) VALUES ('p','fixture','development','w','active','','now','now','now');
    INSERT INTO assignments (id,project_id,worktree_id,agent_id,task_id,scope_json,status,revision,session_id,created_at,updated_at) VALUES ('a','p','w','agent','task','{}','active',1,'s','now','now');
    INSERT INTO runs (id,worktree_id,mode,lifecycle,health,revision,lease_generation,agent_claim,goal,created_at) VALUES ('s','w','write','active','healthy',1,0,'agent','goal','now');
    INSERT INTO write_leases (worktree_id,run_id,generation,acquired_at) VALUES ('w','s',0,'now');`);
  bindConversation(db, 'A3', { sessionId: 's', worktreeId: 'w', acceptedRevision: 1 }, { owner: { bindingKind: 'host', host: 'zcode', locator: 'chat-A3' } });
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, dbPath };
}

test('workbench authorization is persistent, secret-free, atomic and single-consumer', (t) => {
  const { db } = fixture(t);
  const issued = withCommandActor({ kind: 'user' }, () => issueConversationTransfer(db, issue, options));
  assert.equal(issued.revision, 2);
  assert.equal(readTransferState(db, 's', options).frozen, true);
  assert.equal(readConversationOwner(db, 's').conversationKey, 'A3');
  assert.deepEqual(issueConversationTransfer(db, issue, options), issued);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM commands').all()).includes(issued.transferCode));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM conversation_transfers').all()).includes(issued.transferCode));
  const request = { ...consumer, transferCode: issued.transferCode };
  const accepted = withCommandActor({ kind: 'ai', host: 'zcode', conversationId: 'chat-C' }, () => consumeConversationTransfer(db, request, options));
  assert.equal(accepted.revision, 3);
  assert.equal(readConversationOwner(db, 's').conversationKey, 'C');
  assert.equal(readTransferState(db, 's'), null);
  assert.deepEqual(consumeConversationTransfer(db, request, options), accepted);
  assert.equal(consumeConversationTransfer(db, { ...request, clientRequestId: 'other', conversationKey: 'B' }, options).ok, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM progress_events').get().n, 2);
  const nodes = db.prepare('SELECT * FROM work_session_nodes ORDER BY sequence').all();
  assert.deepEqual(nodes.map((node) => node.type), ['transfer_authorized', 'takeover']);
  assert.equal(nodes[1].predecessor_id, nodes[0].id);
  assert.equal(nodes[0].actor_kind, 'user');
  assert.equal(nodes[1].actor_kind, 'ai');
  assert.equal(nodes[1].actor_host, 'zcode');
  assert.equal(nodes[1].actor_conversation_id, 'chat-C');
  assert.equal(db.prepare("SELECT revoked FROM conversation_bindings WHERE conversation_key = 'A3'").get().revoked, 1);
  assert.equal(cancelConversationTransfer(db, { ...issue, expectedRevision: 3, clientRequestId: 'cancel', restorePreviousOwner: true }, options).ok, false);
});

test('expiry remains frozen; explicit cancellation advances revision and restores only previous owner', (t) => {
  const { db } = fixture(t);
  const issued = issueConversationTransfer(db, { ...issue, targetHost: 'zcode', targetConversationId: 'chat-C' }, options);
  assert.equal(consumeConversationTransfer(db, { ...consumer, transferCode: issued.transferCode, binding: { ...consumer.binding, locator: 'chat-B' } }, options).code, 'CONVERSATION_TRANSFER_TARGET_MISMATCH');
  const expired = { ...options, now: issued.expiresAt };
  assert.equal(consumeConversationTransfer(db, { ...consumer, clientRequestId: 'expired', transferCode: issued.transferCode }, expired).code, 'CONVERSATION_TRANSFER_EXPIRED');
  assert.equal(readTransferState(db, 's', expired).frozen, true);
  assert.equal(readTransferState(db, 's', expired).expired, true);
  const cancel = { ...issue, expectedRevision: 2, clientRequestId: 'cancel', restorePreviousOwner: true };
  assert.equal(cancelConversationTransfer(db, cancel, expired).revision, 3);
  assert.deepEqual(db.prepare('SELECT type FROM work_session_nodes ORDER BY sequence').all().map((node) => node.type),
    ['transfer_authorized', 'transfer_cancelled']);
  assert.equal(readConversationOwner(db, 's').conversationKey, 'A3');
  assert.equal(readTransferState(db, 's'), null);
  assert.equal(cancelConversationTransfer(db, cancel, expired).revision, 3);
});

test('reissue invalidates old code and stale pages cannot transfer or cancel', (t) => {
  const { db } = fixture(t);
  const first = issueConversationTransfer(db, issue, options);
  assert.equal(issueConversationTransfer(db, { ...issue, clientRequestId: 'stale' }, options).code, 'CONVERSATION_TRANSFER_STALE');
  const second = issueConversationTransfer(db, { ...issue, expectedRevision: 2, clientRequestId: 'renew' }, options);
  assert.equal(second.revision, 3);
  assert.equal(consumeConversationTransfer(db, { ...consumer, transferCode: first.transferCode }, options).code, 'CONVERSATION_TRANSFER_INVALID');
  assert.equal(consumeConversationTransfer(db, { ...consumer, clientRequestId: 'new', transferCode: second.transferCode }, options).revision, 4);
});

test('transaction fault rolls back owner, event, revision and authorization consumption', (t) => {
  const { db } = fixture(t);
  const issued = issueConversationTransfer(db, issue, options);
  const request = { ...consumer, transferCode: issued.transferCode };
  assert.throws(() => consumeConversationTransfer(db, request, { ...options, faultInjector(point) { if (point === 'transfer.after_binding_transfer') throw new Error('fault'); } }), /fault/);
  assert.equal(readConversationOwner(db, 's').conversationKey, 'A3');
  assert.equal(readTransferState(db, 's').frozen, true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM progress_events').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM work_session_nodes').get().n, 1);
  assert.equal(consumeConversationTransfer(db, request, options).revision, 3);
});

test('real process termination preserves committed authorization and rolls back an interrupted transfer', (t) => {
  const { db, dbPath } = fixture(t);
  const issued = issueConversationTransfer(db, issue, options);
  const modules = Object.fromEntries(['database', 'conversation-transfers'].map((name) => [name, pathToFileURL(path.resolve(`src/core/${name}.mjs`)).href]));
  const code = `import {openCockpitDatabase} from ${JSON.stringify(modules.database)};
    import {consumeConversationTransfer} from ${JSON.stringify(modules['conversation-transfers'])};
    const db=openCockpitDatabase(${JSON.stringify(dbPath)});
    consumeConversationTransfer(db,${JSON.stringify({ ...consumer, transferCode: issued.transferCode })},
    {now:${options.now},faultInjector(point){if(point==='transfer.before_commit') process.exit(71)}});`;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' }), (error) => error.status === 71);
  assert.equal(readConversationOwner(db, 's').conversationKey, 'A3');
  assert.equal(db.prepare('SELECT count(*) AS n FROM work_session_nodes').get().n, 1);
  const inspect = `import {openCockpitDatabase} from ${JSON.stringify(modules.database)};
    import {issueConversationTransfer,consumeConversationTransfer} from ${JSON.stringify(modules['conversation-transfers'])};
    const db=openCockpitDatabase(${JSON.stringify(dbPath)});
    const result=issueConversationTransfer(db,${JSON.stringify(issue)},${JSON.stringify(options)});
    console.log(JSON.stringify(consumeConversationTransfer(db,{...${JSON.stringify(consumer)},transferCode:result.transferCode},${JSON.stringify(options)})));db.close();`;
  assert.equal(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', inspect], { encoding: 'utf8' })).revision, 3);
  assert.equal(readConversationOwner(db, 's').conversationKey, 'C');
});

test('v24 upgrade retains historical owners and receipts without backfilling invented identities', (t) => {
  const { db, dbPath } = fixture(t);
  db.exec(`INSERT INTO commands (id,kind,request_digest,request_json,state,response_json,created_at,updated_at)
    VALUES ('historic','old.operation','digest','{}','committed','{"revision":1}','then','then');`);
  const before = db.prepare('SELECT * FROM conversation_bindings').all();
  db.exec(`DROP TRIGGER work_session_node_on_commit;
    DROP TABLE work_session_nodes;
    DROP TABLE conversation_transfers;
    ALTER TABLE commands DROP COLUMN actor_host;
    ALTER TABLE commands DROP COLUMN actor_conversation_id;
    ALTER TABLE commands DROP COLUMN actor_kind;
    DELETE FROM schema_migrations WHERE version >= 25; PRAGMA user_version = 24;`);
  const upgraded = openCockpitDatabase(dbPath);
  upgraded.close();
  const reopened = openCockpitDatabase(dbPath);
  assert.deepEqual(reopened.prepare('SELECT * FROM conversation_bindings').all(), before);
  const receipt = reopened.prepare("SELECT response_json, actor_host, actor_conversation_id, actor_kind FROM commands WHERE id = 'historic'").get();
  assert.equal(receipt.response_json, '{"revision":1}');
  assert.equal(receipt.actor_host, null);
  assert.equal(receipt.actor_conversation_id, null);
  assert.equal(receipt.actor_kind, null);
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM conversation_transfers').get().n, 0);
  // Upgrade must not turn historical receipts into invented new actor nodes.
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM work_session_nodes').get().n, 0);
  reopened.close();
});

test('two real processes competing for one authorization produce one accepted node', async (t) => {
  const { db, dbPath } = fixture(t);
  const issued = issueConversationTransfer(db, issue, options);
  const databaseUrl = pathToFileURL(path.resolve('src/core/database.mjs')).href;
  const transferUrl = pathToFileURL(path.resolve('src/core/conversation-transfers.mjs')).href;
  const results = await Promise.all(['C', 'B'].map(async (key) => {
    const request = { ...consumer, transferCode: issued.transferCode, conversationKey: key,
      clientRequestId: key, binding: { ...consumer.binding, locator: `chat-${key}` } };
    const code = `import {openCockpitDatabase} from ${JSON.stringify(databaseUrl)};
      import {consumeConversationTransfer} from ${JSON.stringify(transferUrl)};
      const db=openCockpitDatabase(${JSON.stringify(dbPath)});
      console.log(JSON.stringify(consumeConversationTransfer(db,${JSON.stringify(request)},${JSON.stringify(options)})));db.close();`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code]);
    return JSON.parse(stdout);
  }));
  assert.equal(results.filter((result) => result.takeoverAccepted).length, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM progress_events').get().n, 2);
  assert.equal(db.prepare('SELECT revision FROM runs').get().revision, 3);
});

test('node index excludes confirmation offers, failed results and unrelated commands', (t) => {
  const { db } = fixture(t);
  const cases = [
    ['conversation.takeover', { ok: true, takeoverAccepted: false }],
    ['relay.resume', { ok: true, requiresUserConfirmation: true }],
    ['assignment.progress', { ok: false }],
    ['delivery.preflight', { ok: true }],
  ];
  cases.forEach(([kind, response], index) => {
    const commandId = `not-node-${index}`;
    beginCommand(db, { commandId, kind, request: {}, runId: 's' });
    db.prepare("UPDATE commands SET state = 'committed', response_json = ? WHERE id = ?").run(JSON.stringify(response), commandId);
  });
  assert.equal(db.prepare('SELECT count(*) AS n FROM work_session_nodes').get().n, 0);
});

test('old issue replay never re-exposes consumed, cancelled, superseded or expired codes', (t) => {
  const { db } = fixture(t);
  const first = issueConversationTransfer(db, issue, options);
  const expiredReplay = issueConversationTransfer(db, issue, { ...options, now: first.expiresAt });
  assert.equal(expiredReplay.currentStatus, 'expired');
  assert.equal(expiredReplay.transferCode, undefined);
  const secondRequest = { ...issue, expectedRevision: 2, clientRequestId: 'second' };
  issueConversationTransfer(db, secondRequest, options);
  assert.equal(issueConversationTransfer(db, issue, options).currentStatus, 'superseded');
  assert.equal(issueConversationTransfer(db, issue, options).transferCode, undefined);
  cancelConversationTransfer(db, { ...issue, expectedRevision: 3, clientRequestId: 'cancel-second', restorePreviousOwner: true }, options);
  assert.equal(issueConversationTransfer(db, secondRequest, options).currentStatus, 'cancelled');
  assert.equal(issueConversationTransfer(db, secondRequest, options).transferCode, undefined);
  const thirdRequest = { ...issue, expectedRevision: 4, clientRequestId: 'third' };
  const third = issueConversationTransfer(db, thirdRequest, options);
  consumeConversationTransfer(db, { ...consumer, transferCode: third.transferCode }, options);
  assert.equal(issueConversationTransfer(db, thirdRequest, options).currentStatus, 'consumed');
  assert.equal(issueConversationTransfer(db, thirdRequest, options).transferCode, undefined);
});

const relayContent = {
  nextSessionFocus: '继续', summary: '当前成果', currentState: '已完成一部分', completedItems: ['第一步'],
  pendingItems: ['第二步'], decisions: ['保留'], artifactRefs: [], risks: [], suggestedSkills: [],
};

test('workbench authorization supersedes waiting Relay and cancellation never revives its code', (t) => {
  const { db } = fixture(t);
  const relay = createRelay(db, { ...relayContent, sessionId: 's', expectedRevision: 1,
    clientRequestId: 'relay-before-transfer', continueCode: 'fixture-relay-code-long-enough' }, options);
  assert.equal(relay.ok, true, JSON.stringify(relay));
  const issued = issueConversationTransfer(db, { ...issue, expectedRevision: relay.revision }, options);
  assert.equal(issued.ok, true, JSON.stringify(issued));
  assert.equal(db.prepare('SELECT state FROM relays').get().state, 'expired');
  cancelConversationTransfer(db, { ...issue, expectedRevision: issued.revision, clientRequestId: 'cancel-relay-transfer', restorePreviousOwner: true }, options);
  const result = resumeRelay(db, { continueCode: 'fixture-relay-code-long-enough', clientRequestId: 'old-relay-consume', conversationKey: 'C' }, options);
  assert.equal(result.ok, false);
  assert.equal(readConversationOwner(db, 's').conversationKey, 'A3');
});

test('handoff plus assignment completion indexes one node for the same operation', (t) => {
  const { db } = fixture(t);
  const handoff = createHandoff(db, { ...relayContent, sessionId: 's', expectedRevision: 1, clientRequestId: 'handoff-one' });
  assert.equal(handoff.ok, true, JSON.stringify(handoff));
  beginCommand(db, { commandId: 'complete-handoff', kind: 'assignment.complete', runId: 's', request: { clientRequestId: 'handoff-one' } });
  db.prepare("UPDATE commands SET state = 'committed', response_json = '{\"ok\":true}' WHERE id = 'complete-handoff'").run();
  assert.equal(db.prepare('SELECT count(*) AS n FROM work_session_nodes').get().n, 1);
  assert.equal(db.prepare('SELECT type FROM work_session_nodes').get().type, 'handoff');
});
