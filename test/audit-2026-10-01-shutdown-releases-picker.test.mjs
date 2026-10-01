import { withDeadline } from '../scripts/test-support/deadline.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const TOKEN = 'a'.repeat(48);

// The native folder dialog is opened from inside a request handler, so the
// connection stays open for as long as the user is looking at it. close() waits
// for every connection to end BEFORE it runs the picker teardown that would end
// that request, which makes the teardown unreachable: shutdown blocks on exactly
// the handler the teardown exists to release.
test('关闭服务必须释放在飞的文件夹选择器，而不是等它自己结束', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-shutdown-picker-'));
  let releases = 0;
  let settlePicker;
  const hangingPicker = Object.assign(
    () => new Promise((resolve) => { settlePicker = () => resolve(path.join(root, 'nowhere')); }),
    { close: async () => { releases += 1; settlePicker?.(); } },
  );

  const service = await createCockpitHttpServer({
    dbPath: path.join(root, 'cockpit.db'),
    token: TOKEN,
    folderPicker: hangingPicker,
  });
  let closed = false;
  t.after(async () => {
    // Release the parked handler even when close() never reached the teardown, so
    // SQLite is closed before the directory is removed (Windows holds it open).
    try { await hangingPicker.close(); } catch {}
    if (!closed) await withDeadline(service.close(), 20_000, () => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // Fire the request and leave the connection open; the handler parks in the
  // picker until something releases it.
  const inflight = fetch(`http://${service.host}:${service.port}/api/v1/folders/select`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  }).catch(() => {});

  // Give the handler time to park inside the picker.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(releases, 0, 'the picker must still be open before shutdown is requested');

  const closedInTime = await withDeadline(
    service.close().then(() => ({ done: true })),
    8_000,
    () => ({ done: false }),
  );
  closed = closedInTime.done;

  assert.ok(releases >= 1,
    'shutdown never released the folder picker it is waiting on (close reached the teardown)');
  assert.equal(closedInTime.done, true,
    'close() did not return: the picker teardown is scheduled behind the connection drain '
    + 'that the open picker is blocking');
});

// Reverse control, green on the current main branch: releasing the picker early
// must not cut off a handler that is merely slow. The database stays open until
// the in-flight request has answered, which is the property the original ordering
// was written to protect.
test('反向对照：关闭不打断正在完成的请求，回执仍然送达', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-shutdown-drain-'));
  const slowPicker = () => new Promise((resolve) => {
    setTimeout(() => resolve(root), 400);
  });
  const service = await createCockpitHttpServer({
    dbPath: path.join(root, 'cockpit.db'),
    token: TOKEN,
    folderPicker: slowPicker,
  });
  t.after(async () => {
    // One hook, ordered: node:test runs t.after callbacks FIFO, so removing the
    // directory before SQLite is closed would hit an open handle on Windows.
    await withDeadline(closing, 20_000, () => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const inflight = fetch(`http://${service.host}:${service.port}/api/v1/folders/select`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const closing = service.close();

  const response = await withDeadline(inflight, 15_000, () => null);
  assert.ok(response, 'a request already in flight must not be abandoned by shutdown');
  // Reading only "a response arrived" is not enough: a handler answering from an
  // already-closed database fails with 400 and still produces a response.
  assert.equal(response.status, 200,
    `the draining handler must still be able to answer, got ${response.status}`);
  const payload = await response.json();
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.ok(typeof payload.grantId === 'string' && payload.grantId.length > 0,
    `the handler's own receipt must be intact, got ${JSON.stringify(payload)}`);
  await withDeadline(closing, 15_000, () => { throw new Error('close() never returned for a draining handler'); });
});

// A dialog that refuses to close must not put the hang back. The teardown error is
// tolerated so the database still closes, and the grace period force-closes whatever
// connection is left rather than waiting on it forever.
test('释放选择器抛错时关闭仍必须在宽限期后完成', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-shutdown-refuse-'));
  const refusingPicker = Object.assign(
    () => new Promise(() => {}),
    { close: async () => { throw new Error('native dialog refused to close'); } },
  );
  const service = await createCockpitHttpServer({
    dbPath: path.join(root, 'cockpit.db'),
    token: TOKEN,
    folderPicker: refusingPicker,
  });
  t.after(async () => {
    await withDeadline(service.close(), 30_000, () => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const inflight = fetch(`http://${service.host}:${service.port}/api/v1/folders/select`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 100));

  // The residual risk must be said out loud, not swallowed: a bounded drain means a
  // handler can still be running when the database closes.
  const written = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return originalWrite(chunk, ...rest); };
  let outcome;
  try {
    outcome = await withDeadline(
      service.close().then(() => ({ done: true })),
      20_000,
      () => ({ done: false }),
    );
  } finally {
    process.stderr.write = originalWrite;
  }
  await inflight;
  assert.equal(outcome.done, true,
    'close() never returned: a picker that refuses to release put the hang back');
  assert.ok(written.some((line) => /still running after the grace period/.test(line)),
    `the abandoned drain must be reported, stderr saw: ${JSON.stringify(written)}`);

  const probe = await withDeadline(
    fetch(`http://${service.host}:${service.port}/health`).then((r) => r.status).catch(() => 'refused'),
    5_000, () => 'timeout',
  );
  assert.equal(probe, 'refused', 'the port must be gone once shutdown has completed');
});
