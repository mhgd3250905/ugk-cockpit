import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createMcpStdioServer } from '../src/mcp/stdio-protocol.mjs';

// Node's readline treats U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH
// SEPARATOR) as line terminators, while JSON permits them raw inside strings
// and JSON.stringify does not escape them. One such character in a tool
// payload therefore splits a JSON-RPC request into two unparseable halves, and
// one in a service response splits the acknowledgement — so a write that
// already succeeded on the service side looks lost, and the host retries it.
// Frames must survive in both directions.
const LS = ' ';
const PS = ' ';

function harness() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks = [];
  stdout.on('data', (chunk) => chunks.push(chunk));
  return {
    stdin,
    stdout,
    stderr,
    raw: () => Buffer.concat(chunks).toString('utf8'),
  };
}

const frames = (raw) => raw.split('\n').filter((line) => line.trim() !== '');

test('an inbound U+2028 inside a tool argument stays one request and gets one response', async (t) => {
  const h = harness();
  let seen = null;
  createMcpStdioServer({
    stdin: h.stdin,
    stdout: h.stdout,
    stderr: h.stderr,
    handlers: {
      ugk_work_progress: async (args) => {
        seen = args;
        return { ok: true, revision: 1 };
      },
    },
    onShutdown: () => {},
  });
  t.after(() => { h.stdin.end(); h.stdout.destroy(); });

  const note = `第一段${LS}第二段`;
  const frame = `{"jsonrpc":"2.0","id":"ls-1","method":"tools/call","params":{"name":"ugk_work_progress","arguments":{"sessionId":"s","clientRequestId":"r","expectedRevision":1,"status":"working","note":${JSON.stringify(note)}}}}\n`;
  assert.ok(Buffer.from(frame, 'utf8').includes(Buffer.from(LS, 'utf8')),
    'the fixture must really put the raw separator on the wire');
  h.stdin.write(frame);
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(seen?.note, note, `the note must reach the handler intact, saw ${JSON.stringify(seen)}`);
  const lines = frames(h.raw());
  const paired = lines.map((line) => JSON.parse(line)).filter((message) => message.id === 'ls-1');
  assert.equal(paired.length, 1,
    `exactly one response for ls-1, got: ${JSON.stringify(lines.map((l) => l.slice(0, 60)))}`);
  assert.equal(paired[0].error, undefined, JSON.stringify(paired[0]));
});

test('an outbound U+2029 in a result does not split the response frame', async (t) => {
  const h = harness();
  createMcpStdioServer({
    stdin: h.stdin,
    stdout: h.stdout,
    stderr: h.stderr,
    handlers: {
      ugk_work_progress: async () => ({ ok: true, text: `回传${PS}文本` }),
    },
    onShutdown: () => {},
  });
  t.after(() => { h.stdin.end(); h.stdout.destroy(); });

  h.stdin.write(`{"jsonrpc":"2.0","id":"out-1","method":"tools/call","params":{"name":"ugk_work_progress","arguments":{"sessionId":"s","clientRequestId":"r","expectedRevision":1,"status":"working","note":"x"}}}\n`);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const raw = h.raw();
  assert.equal(raw.includes(LS), false, 'a raw LINE SEPARATOR must never reach the wire');
  assert.equal(raw.includes(PS), false, 'a raw PARAGRAPH SEPARATOR must never reach the wire');
  const lines = frames(raw);
  assert.equal(lines.length, 1, `one frame expected, got ${lines.length}: ${JSON.stringify(lines.map((l) => l.slice(0, 60)))}`);
  const message = JSON.parse(lines[0]);
  assert.equal(message.id, 'out-1');
  const payload = JSON.parse(message.result.content[0].text);
  assert.equal(payload.text, `回传${PS}文本`, 'the decoded value must still contain the separator');
});

// The separator is three bytes (E2 80 A8 / E2 80 A9) and a host may hand the
// bridge any chunk boundary. A carry-over that only recognises whole sequences
// silently drops the escape when a chunk ends mid-sequence, and the frame splits
// again — so the boundary cases are the ones that must be pinned.
test('a frame split on a separator byte boundary still arrives as one request', async (t) => {
  const note = `第一段${LS}第二段`;
  const frame = `{"jsonrpc":"2.0","id":"split-1","method":"tools/call","params":{"name":"ugk_work_progress","arguments":{"sessionId":"s","clientRequestId":"r","expectedRevision":1,"status":"working","note":${JSON.stringify(note)}}}}\n`;
  const bytes = Buffer.from(frame, 'utf8');
  const lsIndex = bytes.indexOf(Buffer.from(LS, 'utf8'));
  assert.ok(lsIndex > 0, 'the fixture frame must contain the raw separator');

  for (const offset of [1, 2]) {
    const h = harness();
    let seen = null;
    createMcpStdioServer({
      stdin: h.stdin,
      stdout: h.stdout,
      stderr: h.stderr,
      handlers: { ugk_work_progress: async (args) => { seen = args; return { ok: true, revision: 1 }; } },
      onShutdown: () => {},
    });
    t.after(() => { h.stdin.end(); h.stdout.destroy(); });

    const cut = lsIndex + offset;
    h.stdin.write(bytes.subarray(0, cut));
    h.stdin.write(bytes.subarray(cut));
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(seen?.note, note,
      `chunk ending after ${offset} separator byte(s) must not break framing`);
    const paired = frames(h.raw()).map((line) => JSON.parse(line)).filter((m) => m.id === 'split-1');
    assert.equal(paired.length, 1, `one response expected, saw ${JSON.stringify(frames(h.raw()))}`);
  }
});
