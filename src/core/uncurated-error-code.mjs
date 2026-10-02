// Both public-wording maps (`PUBLIC_ERRORS` in the HTTP layer and
// `DELIVERY_ERROR_MESSAGES` in the delivery layer) fall back to generic text
// when a code is missing. That fallback is the right thing to send a client —
// an uncurated string must never reach a user — but silently, it also erases
// the only clue that a new failure mode was added without wording. Said out
// loud, once per code, with just the code token echoed.
const NOTED = new Set();

export function noteUncuratedErrorCode(mapName, code) {
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) return false;
  const key = `${mapName}\0${code}`;
  if (NOTED.has(key)) return false;
  NOTED.add(key);
  process.stderr.write(`[ugk-cockpit] uncurated error code "${code}" in ${mapName}; response sent with generic wording\n`);
  return true;
}
