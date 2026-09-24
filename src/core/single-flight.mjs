import { canonicalJson } from './command-journal.mjs';

const inFlightByDb = new WeakMap();

/**
 * Serialise concurrent attempts at the same command id inside this process.
 *
 * A client that loses a response is told to retry with an identical request
 * id, so two in-flight drivers for one command are a supported outcome rather
 * than misuse. Without a gate they both run the same body: the durable writes
 * that key on command_id collide (a raw SQLite constraint error escaping as
 * an untyped failure), and a repository lock whose holder names the command
 * is renewed rather than denied, so the first driver to finish releases the
 * lock the second is still relying on.
 *
 * A retry with the same id and the same body joins the in-flight result. A
 * retry with the same id but a different body is a genuine conflict and is
 * refused without disturbing the driver already running.
 *
 * Scope is one database handle in one process. Callers must not treat this as
 * a cross-process lock; the durable command journal and repository locks are
 * what cover that.
 */
export function singleFlight(db, request, operation) {
  let active = inFlightByDb.get(db);
  if (!active) { active = new Map(); inFlightByDb.set(db, active); }
  const commandId = request?.commandId;
  // No idempotency key means nothing to de-duplicate on; every request would
  // otherwise collide on the same undefined key.
  if (typeof commandId !== 'string' || commandId === '') return Promise.resolve().then(operation);
  const digest = canonicalJson(request);
  // The digest covers the raw request, not the frozen intent the journal
  // stores, so two concurrent callers that differ only in a field the core
  // ignores are treated as a conflict rather than a replay. Refusing the extra
  // driver is the safe direction; the journal still answers genuine replays.
  const previous = active.get(commandId);
  if (previous) {
    return previous.digest === digest
      ? previous.promise
      : Promise.resolve({ ok: false, code: 'COMMAND_CONFLICT', retryable: false });
  }
  const promise = Promise.resolve().then(operation).finally(() => active.delete(commandId));
  active.set(commandId, { digest, promise });
  return promise;
}
