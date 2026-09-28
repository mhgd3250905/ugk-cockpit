import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { withDeadline, waitForChildMessage } from '../scripts/test-support/deadline.mjs';

for (const rejected of [false, true]) {
  test(`deadline cancels its timer after ${rejected ? 'rejection' : 'success'}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let expired = false;
    const error = new Error('operation failed');
    const result = withDeadline(rejected ? Promise.reject(error) : Promise.resolve(42), 140_000,
      () => { expired = true; });
    if (rejected) await assert.rejects(result, (value) => value === error);
    else assert.equal(await result, 42);
    t.mock.timers.tick(140_001);
    assert.equal(expired, false, 'a completed operation must not retain its deadline callback');
  });
}

test('deadline expires even when the operation never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = withDeadline(new Promise(() => {}), 4000);
  const assertion = assert.rejects(result, /Timed out after 4000ms/);
  t.mock.timers.tick(4000);
  await assertion;
});

for (const outcome of ['message', 'exit', 'error', 'timeout']) {
  test(`child message wait cleans listeners on ${outcome}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    const result = waitForChildMessage(child, (message) => message.inside, 4000);
    const assertion = outcome === 'message' ? result : assert.rejects(result);
    child.emit('message', { unrelated: true });
    if (outcome === 'message') child.emit('message', { inside: true });
    if (outcome === 'exit') child.emit('exit', 1);
    if (outcome === 'error') child.emit('error', new Error('spawn failed'));
    if (outcome === 'timeout') t.mock.timers.tick(4000);
    await assertion;
    for (const event of ['message', 'exit', 'error']) assert.equal(child.listenerCount(event), 0);
    t.mock.timers.tick(4001);
  });
}
