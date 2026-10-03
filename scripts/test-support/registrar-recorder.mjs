// Stand-in for `node:test`, used only by the suite gate: it records what a file
// registers and runs nothing. The gate needs the runner's own answer to "does
// this file contain a test?", because a regular expression cannot tell a
// declaration from the same text inside a block comment — measured on this repo,
// an indented `test(` inside `/* ... */` satisfied the old pattern while the
// runner executed zero assertions from that file.
import * as realTest from 'node:test';

globalThis.__UGK_TEST_REGISTRATIONS__ ??= [];

const REG = globalThis.__UGK_TEST_REGISTRATIONS__;

function push(kind, name, skipped) {
  REG.push({
    kind,
    name: typeof name === 'string' ? name : String(name),
    skipped: skipped === true,
  });
}

function registrar(kind) {
  const register = (name, optionsOrBody, maybeBody) => {
    const options = typeof optionsOrBody === 'function' ? undefined : optionsOrBody;
    // `skip: '<reason>'` is how this repo skips by platform, so any truthy
    // `skip` counts as skipped rather than only the boolean `true`.
    void maybeBody;
    push(kind, name, Boolean(options?.skip ?? false) || Boolean(options?.todo ?? false));
    // Suites register their children when their callback runs, which is what the
    // real runner sees at import time. Without this a `describe` that kept its
    // header and lost its body would still look populated.
    if (kind === 'describe' && typeof optionsOrBody === 'function') optionsOrBody();
    return Promise.resolve();
  };
  register.skip = (name) => { push(kind, name, true); return Promise.resolve(); };
  register.todo = (name) => { push(kind, name, true); return Promise.resolve(); };
  register.only = (name) => { push(kind, name, false); return Promise.resolve(); };
  register.each = () => () => Promise.resolve();
  return register;
}

export const test = registrar('test');
export const describe = registrar('describe');
export const it = registrar('it');
export const before = () => Promise.resolve();
export const after = () => Promise.resolve();
export const beforeEach = () => Promise.resolve();
export const afterEach = () => Promise.resolve();
export const run = () => Promise.resolve();
// Named exports the real module has today (Node 24.15). A missing name is a
// false red on a legitimate future test file, so test/test-suite-gate.test.mjs
// compares this list against `node:test` itself instead of trusting it.
//
// Anything that *registers* a test has to be recorded here rather than passed
// through: handing back the live `suite`/`skip`/`only`/`todo` would let a real
// suite schedule and run in the counter process (defeating "runs nothing"), and a
// `suite()`-only file would report zero registrations — the exact false red this
// stand-in exists to avoid. Non-registering utilities (`mock`, `assert`,
// `snapshot`) are passed through: they cannot schedule a test. If one is ever
// driven from describe scope in a way that wedges an import, the counter's child
// timeout fails closed with "the counter stopped here" naming the file.
const registerAsSkipped = (name) => { push('test', name, true); return Promise.resolve(); };
export const skip = registerAsSkipped;
export const todo = registerAsSkipped;
export const only = registrar('test');
export const suite = describe;
export const snapshot = realTest.snapshot;
export const assert = realTest.assert;
export const mock = realTest.mock;
export const expectFailure = realTest.expectFailure;

export default test;
