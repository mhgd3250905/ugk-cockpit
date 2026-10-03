// Loader hook: hand every `node:test` import to the recording shim, so a test
// file can be asked "what do you actually register?" without executing it.
// The shim itself must keep the real builtin (it imports nothing, but the guard
// makes the redirect non-recursive by construction).
const SHIM = new URL('./test-registrar-shim.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:test' && context.parentURL !== SHIM) {
    return { url: SHIM, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
