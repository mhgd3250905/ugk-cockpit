// Both public-wording maps (`PUBLIC_ERRORS` in the HTTP layer and
// `DELIVERY_ERROR_MESSAGES` in the delivery layer) fall back to generic text
// when a code is missing. That fallback is the right thing to send a client —
// an uncurated string must never reach a user — but silently, it also erases
// the only clue that a new failure mode was added without wording. Said out
// loud here, once per shape, and never echoing the value itself unless it is
// provably an internal constant name.
//
// Producer codes are not always strings: `git()` rethrows the raw execFile
// error, whose `code` is a numeric exit status (the delivery layer already
// branches on `typeof error.code === 'number'`), and Node errno strings such as
// `EACCES` appear the same way. Those shapes get a line naming the *kind*, not
// the value, because "uncurated" has to stay a fact about the code table and
// not an echo of whatever a child process printed.
const NOTED = new Set();
const CODE_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
// Node/fs errno names share the constant shape (`ENOENT`, `EACCES`, `EPERM`),
// but they are not a gap in the wording table — describing them as one sends
// the reader looking for a missing entry instead of a missing file.
const ERRNO_NAME = /^E[0-9A-Z]{2,9}$/;

// Deliberate limit, stated rather than implied: this warns **once per map per
// shape** for the life of the process. That is what keeps a hot fallback from
// flooding stderr, and it costs frequency information — a code seen 4 000 times
// looks the same as one seen once. `service.diagnostics` is the place that
// would have to grow a counter if this ever needs volumes, not this module.
// A caught error's `code` is not necessarily a product code. `git()` rethrows
// the raw execFile error, whose `code` is a numeric exit status, and Node errnos
// arrive the same way. Such a value must never be handed on as the public code:
// neither wording table can curate it, so the client silently gets the generic
// receipt while the command journal and `last_error_code` persist the garbage and
// replay it on every retry. Collapse to the caller's own family code and let
// `message` keep the diagnostic detail.
export function isProductErrorCode(value) {
  return typeof value === 'string' && CODE_NAME.test(value) && !ERRNO_NAME.test(value);
}

export function publicErrorCode(value, fallback) {
  if (isProductErrorCode(value)) return value;
  if (!isProductErrorCode(fallback)) {
    throw new TypeError('publicErrorCode fallback must itself be a product code.');
  }
  return fallback;
}

export function noteUncuratedErrorCode(mapName, code) {
  let shape;
  if (typeof code === 'string' && CODE_NAME.test(code) && !ERRNO_NAME.test(code)) shape = code;
  else if (typeof code === 'string' && ERRNO_NAME.test(code)) shape = `errno(${code})`;
  else if (typeof code === 'string') shape = 'lowercase-or-punctuated(string-code)';
  else if (typeof code === 'number') shape = 'child-process-exit-status(number-code)';
  // An absent code is not a gap in the wording table; saying so once per
  // response would turn every plain `new Error()` into a claimed table miss.
  else return false;
  const key = `${mapName}\0${shape}`;
  if (NOTED.has(key)) return false;
  NOTED.add(key);
  process.stderr.write(`[ugk-cockpit] uncurated error code "${shape}" in ${mapName}; response sent with generic wording\n`);
  return true;
}
