import { createHash } from 'node:crypto';
import { withImmediateTransaction } from './database.mjs';

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function requestDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export class CommandConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommandConflictError';
    this.code = 'COMMAND_CONFLICT';
  }
}

export function readCommand(db, commandId) {
  return db.prepare('SELECT * FROM commands WHERE id = ?').get(commandId);
}

export function beginCommand(db, { commandId, kind, request, runId = null }) {
  const digest = requestDigest(request);
  const requestJson = canonicalJson(request);
  const now = new Date().toISOString();

  return withImmediateTransaction(db, () => {
    const existing = readCommand(db, commandId);
    if (existing) {
      if (existing.request_digest !== digest || existing.kind !== kind) {
        throw new CommandConflictError(
          `Command ${commandId} was already used with a different request.`,
        );
      }
      return { command: existing, fresh: false };
    }

    db.prepare(`
      INSERT INTO commands (
        id, kind, request_digest, request_json, state, run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'received', ?, ?, ?)
    `).run(commandId, kind, digest, requestJson, runId, now, now);

    return { command: readCommand(db, commandId), fresh: true };
  });
}

export function parseCommandResponse(command) {
  return command?.response_json ? JSON.parse(command.response_json) : null;
}

