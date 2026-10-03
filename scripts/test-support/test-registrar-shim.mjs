// Stand-in for `node:test`, used only by the suite gate: it records what a file
// registers and runs nothing. The gate needs the runner's own answer to "does
// this file contain a test?", because a regular expression cannot tell a
// declaration from the same text inside a block comment — measured on this repo,
// an indented `test(` inside `/* ... */` satisfied the old pattern while the
// runner executed zero assertions from that file.
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
export const mock = { method: () => {}, fn: () => {}, getter: () => {}, timer: () => {} };

export default test;
