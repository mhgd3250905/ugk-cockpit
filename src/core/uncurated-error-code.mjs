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

export function noteUncuratedErrorCode(mapName, code) {
  let shape;
  if (typeof code === 'string' && CODE_NAME.test(code)) shape = code;
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
