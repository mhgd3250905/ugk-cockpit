import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { VERSION } from '../version.mjs';

const MAX_LOG_BYTES = 256 * 1024;
const MAX_READ_BYTES = MAX_LOG_BYTES + 4 * 1024;
const MAX_ROTATED_FILES = 3;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_DIAGNOSTIC_ID = /^diag_[A-Za-z0-9_-]{16,64}$/;
const IDENTITY_SOURCES = new Set([
  'host_metadata',
  'connection_handle',
  'legacy_token',
  'anonymous_bridge',
  'none',
]);
const CREDENTIAL_EVENTS = new Set([
  'issued',
  'resumed',
  'refresh_rejected',
  'none',
]);
const RESULTS = new Set([
  'success',
  'rejected',
  'uncertain',
  'transport_error',
]);

function safeString(value, pattern = SAFE_ID) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function safeCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value) ? value : null;
}

function safeTime(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeEvent(event = {}) {
  const result = RESULTS.has(event.result) ? event.result : 'success';
  const entry = {
    time: safeTime(event.time) ?? new Date().toISOString(),
    version: VERSION,
    operation: safeString(event.operation, /^[a-z][a-z0-9_.-]{1,63}$/) ?? 'unknown',
    diagnosticId: safeString(event.diagnosticId, SAFE_DIAGNOSTIC_ID),
    result,
    identitySource: IDENTITY_SOURCES.has(event.identitySource) ? event.identitySource : 'none',
    identityRecognized: event.identityRecognized === true,
    anonymousBridgeStart: event.anonymousBridgeStart === true,
    credentialEvent: CREDENTIAL_EVENTS.has(event.credentialEvent) ? event.credentialEvent : 'none',
  };
  const sessionId = safeString(event.sessionId);
  if (sessionId) entry.sessionId = sessionId;
  if (Number.isInteger(event.revision) && event.revision >= 0) entry.revision = event.revision;
  const bindingReason = safeString(event.bindingReason, /^[a-z][a-z0-9_.-]{1,79}$/);
  if (bindingReason) entry.bindingReason = bindingReason;
  const code = safeCode(event.code);
  if (code) entry.code = code;
  return entry;
}

function diagnosticLogPaths(directory, fileName) {
  const logPath = path.join(directory ?? '', fileName);
  return [logPath, `${logPath}.1`, `${logPath}.2`, `${logPath}.3`];
}

/**
 * Read only the redacted records associated with sessions already known to a
 * project. The caller supplies the session ids from the durable database;
 * request data never supplies a file path or an arbitrary session selector.
 */
export function readRecentSessionDiagnostics({
  directory,
  fileName = 'mcp-diagnostics.log',
  sessionIds = [],
  limit = 30,
} = {}) {
  const allowedSessions = new Set(sessionIds
    .map((value) => safeString(value))
    .filter(Boolean));
  if (!directory || allowedSessions.size === 0) return [];

  const boundedLimit = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 30));
  const entries = [];
  for (const logPath of diagnosticLogPaths(directory, fileName).reverse()) {
    let content;
    try {
      if (statSync(logPath).size > MAX_READ_BYTES) continue;
      content = readFileSync(logPath, { encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (!line || line.length > 8192) continue;
      try {
        const raw = JSON.parse(line);
        if (!raw || !allowedSessions.has(raw.sessionId)) continue;
        entries.push(normalizeEvent(raw));
      } catch {
        // A partial line from a crash or rotation is not a business error.
      }
    }
  }

  entries.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return entries.slice(0, boundedLimit);
}

function rotate(logPath) {
  const size = existsSync(logPath) ? statSync(logPath).size : 0;
  if (size <= MAX_LOG_BYTES) return true;
  for (let index = MAX_ROTATED_FILES - 1; index >= 1; index -= 1) {
    const source = `${logPath}.${index}`;
    const target = `${logPath}.${index + 1}`;
    if (!existsSync(source)) continue;
    try {
      if (existsSync(target)) unlinkSync(target);
      renameSync(source, target);
    } catch {
      return false;
    }
  }
  try {
    if (existsSync(`${logPath}.1`)) unlinkSync(`${logPath}.1`);
    renameSync(logPath, `${logPath}.1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort local diagnostics. It accepts a deliberately narrow event shape
 * and never throws: a logging failure must not change a business response.
 */
export function createDiagnosticLogger({ directory, fileName = 'mcp-diagnostics.log' } = {}) {
  const logPath = path.join(directory ?? '', fileName);
  let disabled = false;

  return {
    path: logPath,
    record(event = {}) {
      if (disabled || !directory) return;
      try {
        mkdirSync(directory, { recursive: true });
        if (!rotate(logPath)) {
          disabled = true;
          return;
        }
        const line = `${JSON.stringify(normalizeEvent(event))}\n`;
        appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 });
      } catch {
        disabled = true;
      }
    },
  };
}

export { MAX_LOG_BYTES, MAX_ROTATED_FILES, normalizeEvent };
