import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  beginCommand,
  canonicalJson,
  parseCommandResponse,
  readCommand,
} from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';

/**
 * The assignment API is deliberately transport agnostic.  An HTTP/MCP
 * adapter can pass a request object to these functions and return the result
 * as-is.  Secrets are kept out of the command journal: only a dispatch-code
 * digest is ever included in a persisted request.
 */

export const DEFAULT_GRANT_TTL_MS = 5 * 60 * 1000;
export const MAX_GRANT_TTL_MS = 15 * 60 * 1000;

const TERMINAL_COMMAND_STATES = new Set(['committed', 'failed']);
const TERMINAL_ASSIGNMENT_STATES = new Set([
  'completed',
  'blocked',
  'abandoned',
  'failed',
  'cancelled',
]);

function nowMillis(options = {}) {
  const source = options.clock ?? options.now;
  const value = typeof source === 'function' ? source() : source;
  if (value === undefined) return Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function iso(value) {
  return new Date(value).toISOString();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalid(message = 'Invalid assignment request.') {
  return { ok: false, code: 'INVALID_REQUEST', message };
}

function commandIdFor(prefix, ...parts) {
  return `${prefix}.${parts.map((part) => String(part)).join('.')}`;
}

function deterministicSessionId(grantId, clientRequestId) {
  return `session_${createHash('sha256')
    .update(`${grantId}\0${clientRequestId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function eventIdFor(assignmentId, sessionId, clientRequestId) {
  return `progress_${createHash('sha256')
    .update(`${assignmentId}\0${sessionId}\0${clientRequestId}`)
    .digest('hex')}`;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function codeMatches(storedHash, code) {
  if (!isNonEmptyString(storedHash) || !isNonEmptyString(code)) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(digest(code), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function scopeJson(scope) {
  const value = scope === undefined || scope === null ? {} : scope;
  const encoded = canonicalJson(value);
  if (typeof encoded !== 'string') throw new TypeError('scope must be JSON serializable.');
  return encoded;
}

function parseScope(encoded) {
  try {
    return JSON.parse(encoded);
  } catch {
    return null;
  }
}

function terminalResult(command) {
  return command && TERMINAL_COMMAND_STATES.has(command.state)
    ? parseCommandResponse(command)
    : null;
}

function failCommand(db, commandId, response) {
  db.prepare(`
    UPDATE commands
    SET state = 'failed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), new Date().toISOString(), commandId);
  return response;
}

function commitCommand(db, commandId, response, timestamp, runId = null) {
  db.prepare(`
    UPDATE commands
    SET state = 'committed', response_json = ?, run_id = COALESCE(?, run_id), updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), runId, timestamp, commandId);
  return response;
}

function beginCoreCommand(db, { commandId, kind, request, runId = null }) {
  const begun = beginCommand(db, { commandId, kind, request, runId });
  return {
    commandId,
    command: begun.command,
    replay: terminalResult(begun.command),
  };
}

function assignmentRow(db, assignmentId) {
  return db.prepare(`
    SELECT assignments.*, projects.name AS project_name, projects.authorized_root,
           projects.stage AS project_stage, projects.authorized_root,
           worktrees.canonical_path, worktrees.repository_identity,
           worktrees.identity_fingerprint
    FROM assignments
    JOIN projects ON projects.id = assignments.project_id
    JOIN worktrees ON worktrees.id = assignments.worktree_id
    WHERE assignments.id = ?
  `).get(assignmentId) ?? null;
}

function grantRow(db, grantId) {
  return db.prepare(`
    SELECT dispatch_grants.*, assignments.status AS assignment_status,
           assignments.revision AS assignment_revision,
           assignments.session_id AS assignment_session_id,
           projects.name AS project_name, projects.stage AS project_stage,
           projects.authorized_root,
           worktrees.canonical_path, worktrees.repository_identity,
           worktrees.identity_fingerprint
    FROM dispatch_grants
    JOIN assignments ON assignments.id = dispatch_grants.assignment_id
    JOIN projects ON projects.id = dispatch_grants.project_id
    JOIN worktrees ON worktrees.id = dispatch_grants.worktree_id
    WHERE dispatch_grants.id = ?
  `).get(grantId) ?? null;
}

function assignmentBinding(row) {
  return {
    assignmentId: row.id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    canonicalPath: row.canonical_path,
    repositoryIdentity: row.repository_identity,
    worktreeIdentity: row.identity_fingerprint,
    agentId: row.agent_id,
    taskId: row.task_id,
    scope: parseScope(row.scope_json),
  };
}

function mapAssignment(row) {
  if (!row) return null;
  return {
    ...assignmentBinding(row),
    projectName: row.project_name,
    projectStage: row.project_stage,
    authorizedRoot: row.authorized_root,
    status: row.status,
    revision: row.revision,
    sessionId: row.session_id,
    acceptedGrantId: row.accepted_grant_id,
    acceptedAt: row.accepted_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapGrant(row) {
  if (!row) return null;
  return {
    grantId: row.id,
    assignmentId: row.assignment_id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    canonicalPath: row.canonical_path,
    repositoryIdentity: row.repository_identity,
    worktreeIdentity: row.identity_fingerprint,
    agentId: row.agent_id,
    taskId: row.task_id,
    scope: parseScope(row.scope_json),
    // A digest is safe to expose for diagnostics; the raw dispatch code is
    // intentionally absent from every read API and every persisted record.
    codeHash: row.code_hash,
    state: row.state,
    expiresAt: row.expires_at,
    expiresAtIso: iso(row.expires_at),
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    acceptedSessionId: row.accepted_session_id,
    acceptedClientRequestId: row.accepted_client_request_id,
    revokedAt: row.revoked_at,
  };
}

function mapProgress(row) {
  if (!row) return null;
  return {
    eventId: row.id,
    assignmentId: row.assignment_id,
    sessionId: row.session_id,
    clientRequestId: row.client_request_id,
    expectedRevision: row.expected_revision,
    revision: row.revision,
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
  };
}

function claimedBindingMatches(request, grant) {
  const projectId = request.projectId ?? request.project;
  const worktreeId = request.worktreeId ?? request.worktree;
  const canonicalPath = request.canonicalPath ?? request.path ?? request.worktreePath;
  const agentId = request.agentId ?? request.agent ?? request.agentClaim;
  const taskId = request.taskId ?? request.task;
  if (projectId !== undefined && projectId !== grant.project_id) return false;
  if (worktreeId !== undefined && worktreeId !== grant.worktree_id) return false;
  if (canonicalPath !== undefined && canonicalPath !== grant.canonical_path) return false;
  if (agentId !== undefined && agentId !== grant.agent_id) return false;
  if (taskId !== undefined && taskId !== grant.task_id) return false;
  if (request.scope !== undefined) {
    try {
      if (scopeJson(request.scope) !== grant.scope_json) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function grantBindingMatchesAssignment(grant, assignment) {
  return grant.assignment_id === assignment.id
    && grant.project_id === assignment.project_id
    && grant.worktree_id === assignment.worktree_id
    && grant.agent_id === assignment.agent_id
    && grant.task_id === assignment.task_id
    && grant.scope_json === assignment.scope_json;
}

function normalizedAgentId(request) {
  return request.agentId ?? request.agent ?? request.agentClaim;
}

function normalizedTaskId(request) {
  return request.taskId ?? request.task;
}

/**
 * Create a pending assignment.  projectId is authoritative for its worktree;
 * a supplied worktreeId/path is checked, never used to rebind the project.
 */
function createPendingAssignment(db, request = {}, options = {}) {
  const assignmentId = request.assignmentId ?? request.id
    ?? (request.commandId ? `assignment_${request.commandId}` : randomUUID());
  const commandId = request.commandId ?? commandIdFor('assignment.create', assignmentId);
  const agentId = normalizedAgentId(request);
  const taskId = normalizedTaskId(request);
  if (!isNonEmptyString(assignmentId)
    || !isNonEmptyString(request.projectId)
    || !isNonEmptyString(agentId)
    || !isNonEmptyString(taskId)) {
    return invalid('assignmentId, projectId, agentId and taskId are required.');
  }

  let encodedScope;
  try {
    encodedScope = scopeJson(request.scope);
  } catch {
    return invalid('scope must be JSON serializable.');
  }

  const timestamp = iso(nowMillis(options));
  const project = db.prepare(`
    SELECT projects.id AS project_id, projects.worktree_id,
           worktrees.canonical_path, worktrees.repository_identity,
           worktrees.identity_fingerprint
    FROM projects
    JOIN worktrees ON worktrees.id = projects.worktree_id
    WHERE projects.id = ?
  `).get(request.projectId);
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND', projectId: request.projectId };
  if (request.worktreeId !== undefined && request.worktreeId !== project.worktree_id) {
    return { ok: false, code: 'WORKTREE_BINDING_MISMATCH', projectId: request.projectId };
  }
  if ((request.canonicalPath ?? request.path) !== undefined
    && (request.canonicalPath ?? request.path) !== project.canonical_path) {
    return { ok: false, code: 'WORKTREE_BINDING_MISMATCH', projectId: request.projectId };
  }

  const intent = {
    assignmentId,
    projectId: request.projectId,
    worktreeId: project.worktree_id,
    agentId,
    taskId,
    scope: JSON.parse(encodedScope),
  };
  const begun = beginCoreCommand(db, {
    commandId,
    kind: 'assignment.create',
    request: intent,
  });
  if (begun.replay) return begun.replay;

  return withImmediateTransaction(db, () => {
    const command = readCommand(db, commandId);
    const replay = terminalResult(command);
    if (replay) return replay;

    const existing = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId);
    if (existing) {
      const same = existing.project_id === project.project_id
        && existing.worktree_id === project.worktree_id
        && existing.agent_id === agentId
        && existing.task_id === taskId
        && existing.scope_json === encodedScope;
      return failCommand(db, commandId, {
        ok: false,
        code: same ? 'ASSIGNMENT_ALREADY_EXISTS' : 'ASSIGNMENT_ID_CONFLICT',
        assignmentId,
      });
    }

    db.prepare(`
      INSERT INTO assignments (
        id, project_id, worktree_id, agent_id, task_id, scope_json,
        status, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(
      assignmentId,
      project.project_id,
      project.worktree_id,
      agentId,
      taskId,
      encodedScope,
      timestamp,
      timestamp,
    );
    const response = {
      ok: true,
      assignmentId,
      projectId: project.project_id,
      worktreeId: project.worktree_id,
      canonicalPath: project.canonical_path,
      repositoryIdentity: project.repository_identity,
      worktreeIdentity: project.identity_fingerprint,
      agentId,
      taskId,
      scope: JSON.parse(encodedScope),
      status: 'pending',
      revision: 0,
      createdAt: timestamp,
    };
    return commitCommand(db, commandId, response, timestamp);
  });
}

/**
 * Issue a one-time dispatch credential for a pending assignment.  The raw
 * code is returned to the caller once and is never persisted.  Callers may
 * provide a code in tests or use the generated high-entropy code.
 */
export function issueDispatchGrant(db, request = {}, options = {}) {
  const assignmentId = request.assignmentId;
  if (!isNonEmptyString(assignmentId)) return invalid('assignmentId is required.');
  const code = request.dispatchCode ?? request.code
    ?? randomBytes(32).toString('base64url');
  if (!isNonEmptyString(code)) return invalid('dispatchCode must be non-empty.');
  const grantId = request.grantId ?? request.id ?? randomUUID();
  if (!isNonEmptyString(grantId)) return invalid('grantId must be non-empty.');

  const issuedAt = nowMillis(options);
  let expiresAt;
  if (request.expiresAt !== undefined) {
    if (request.expiresAt instanceof Date) expiresAt = request.expiresAt.getTime();
    else if (typeof request.expiresAt === 'string' && !/^\d+(?:\.\d+)?$/.test(request.expiresAt)) {
      expiresAt = Date.parse(request.expiresAt);
    } else expiresAt = Number(request.expiresAt);
  } else {
    const ttlMs = Number(request.ttlMs ?? options.ttlMs ?? DEFAULT_GRANT_TTL_MS);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return invalid('ttlMs must be positive.');
    if (ttlMs > MAX_GRANT_TTL_MS) {
      return { ok: false, code: 'GRANT_TTL_TOO_LONG', maxTtlMs: MAX_GRANT_TTL_MS };
    }
    expiresAt = issuedAt + ttlMs;
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    return { ok: false, code: 'DISPATCH_GRANT_EXPIRED', grantId };
  }
  if (expiresAt - issuedAt > MAX_GRANT_TTL_MS) {
    return { ok: false, code: 'GRANT_TTL_TOO_LONG', maxTtlMs: MAX_GRANT_TTL_MS };
  }

  const assignment = db.prepare(`
    SELECT assignments.*, projects.name AS project_name,
           projects.stage AS project_stage, projects.authorized_root,
           worktrees.canonical_path, worktrees.repository_identity,
           worktrees.identity_fingerprint
    FROM assignments
    JOIN projects ON projects.id = assignments.project_id
    JOIN worktrees ON worktrees.id = assignments.worktree_id
    WHERE assignments.id = ?
  `).get(assignmentId);
  if (!assignment) return { ok: false, code: 'ASSIGNMENT_NOT_FOUND', assignmentId };
  if (assignment.status !== 'pending') {
    return { ok: false, code: 'ASSIGNMENT_NOT_PENDING', assignmentId, status: assignment.status };
  }

  const timestamp = iso(issuedAt);
  const codeHash = digest(code);
  return withImmediateTransaction(db, () => {
    const current = db.prepare('SELECT * FROM dispatch_grants WHERE id = ?').get(grantId);
    if (current) {
      if (current.assignment_id !== assignmentId || current.code_hash !== codeHash) {
        return { ok: false, code: 'DISPATCH_GRANT_ID_CONFLICT', grantId };
      }
      return {
        ok: true,
        ...mapGrant(grantRow(db, grantId)),
        dispatchCode: code,
        code,
        alreadyExists: true,
      };
    }
    db.prepare(`
      INSERT INTO dispatch_grants (
        id, assignment_id, project_id, worktree_id, agent_id, task_id,
        scope_json, code_hash, state, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      grantId,
      assignment.id,
      assignment.project_id,
      assignment.worktree_id,
      assignment.agent_id,
      assignment.task_id,
      assignment.scope_json,
      codeHash,
      expiresAt,
      timestamp,
    );
    return {
      ok: true,
      ...mapGrant(grantRow(db, grantId)),
      dispatchCode: code,
      code,
    };
  });
}

/**
 * Create the assignment and its short-lived dispatch grant in one adapter
 * friendly call.  The code is returned only in this response; its digest is
 * the sole credential representation written to SQLite.  A caller that needs
 * to issue a later/replacement grant may use issueDispatchGrant directly.
 */
export function createAssignment(db, request = {}, options = {}) {
  const assignment = createPendingAssignment(db, request, options);
  if (!assignment?.ok || request.createGrant === false || request.issueGrant === false) {
    return assignment;
  }

  const grantId = request.grantId ?? request.dispatchGrantId
    ?? (request.commandId ? `grant_${request.commandId}` : undefined);
  const issued = issueDispatchGrant(db, {
    assignmentId: assignment.assignmentId,
    ...(grantId ? { grantId } : {}),
    ...(request.dispatchCode !== undefined ? { dispatchCode: request.dispatchCode } : {}),
    ...(request.ttlMs !== undefined ? { ttlMs: request.ttlMs } : {}),
    ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
  }, options);
  if (!issued?.ok) return issued;
  return {
    ...assignment,
    grantId: issued.grantId,
    dispatchCode: issued.dispatchCode,
    // Keep `code` as a transport-neutral alias for small adapters.
    code: issued.dispatchCode,
    expiresAt: issued.expiresAt,
    expiresAtIso: issued.expiresAtIso,
    grantState: issued.state,
  };
}

/**
 * Resolve a dispatch code without consuming it.  This is useful for an
 * adapter's “inspect before accept” call; the returned object contains only
 * the persisted binding and grant metadata, never the supplied code.
 */
export function readDispatchGrantByCode(db, request = {}, options = {}) {
  const code = request.dispatchCode ?? request.code;
  if (!isNonEmptyString(code)) return invalid('dispatchCode is required.');
  const codeHash = digest(code);
  const timestamp = nowMillis(options);
  return withImmediateTransaction(db, () => {
    const candidates = db.prepare(`
      SELECT id FROM dispatch_grants WHERE code_hash = ?
      ${request.grantId !== undefined ? 'AND id = ?' : ''}
      ORDER BY created_at ASC, id ASC
    `).all(...(request.grantId !== undefined ? [codeHash, request.grantId] : [codeHash]));
    if (candidates.length === 0) {
      return { ok: false, code: 'DISPATCH_CODE_INVALID' };
    }
    if (candidates.length > 1) {
      return { ok: false, code: 'DISPATCH_CODE_AMBIGUOUS' };
    }
    const grant = db.prepare('SELECT * FROM dispatch_grants WHERE id = ?').get(candidates[0].id);
    if (grant.state === 'revoked') {
      return { ok: false, code: 'DISPATCH_GRANT_REVOKED', grantId: grant.id };
    }
    if (grant.state === 'active' && grant.expires_at <= timestamp) {
      db.prepare(`
        UPDATE dispatch_grants SET state = 'expired'
        WHERE id = ? AND state = 'active'
      `).run(grant.id);
      return { ok: false, code: 'DISPATCH_GRANT_EXPIRED', grantId: grant.id };
    }
    return {
      ok: true,
      ...mapGrant(grantRow(db, grant.id)),
      accepted: grant.state === 'accepted',
    };
  });
}

/** Revoke an active or previously accepted grant. */
export function revokeDispatchGrant(db, request = {}, options = {}) {
  const grantId = request.grantId ?? request.id;
  if (!isNonEmptyString(grantId)) return invalid('grantId is required.');
  const commandId = request.commandId ?? commandIdFor('dispatch.revoke', grantId);
  const intent = { grantId };
  const begun = beginCoreCommand(db, {
    commandId,
    kind: 'dispatch.grant.revoke',
    request: intent,
  });
  if (begun.replay) return begun.replay;

  const timestamp = iso(nowMillis(options));
  return withImmediateTransaction(db, () => {
    const command = readCommand(db, commandId);
    const replay = terminalResult(command);
    if (replay) return replay;
    const grant = db.prepare('SELECT * FROM dispatch_grants WHERE id = ?').get(grantId);
    if (!grant) return failCommand(db, commandId, { ok: false, code: 'DISPATCH_GRANT_NOT_FOUND', grantId });
    if (grant.state === 'revoked') {
      return commitCommand(db, commandId, { ok: true, grantId, state: 'revoked', alreadyRevoked: true }, timestamp);
    }
    if (grant.state === 'expired' || grant.expires_at <= nowMillis(options)) {
      db.prepare(`
        UPDATE dispatch_grants SET state = 'expired'
        WHERE id = ? AND state IN ('active', 'accepted')
      `).run(grantId);
      return failCommand(db, commandId, {
        ok: false,
        code: 'DISPATCH_GRANT_EXPIRED',
        grantId,
        state: 'expired',
      });
    }
    db.prepare(`
      UPDATE dispatch_grants
      SET state = 'revoked', revoked_at = ?
      WHERE id = ? AND state IN ('active', 'accepted')
    `).run(timestamp, grantId);
    return commitCommand(db, commandId, {
      ok: true,
      grantId,
      state: 'revoked',
      revokedAt: timestamp,
    }, timestamp);
  });
}

/**
 * Atomically consume a dispatch grant and bind its assignment to a session.
 * Only the grant's persisted binding is used for the assignment; optional
 * caller claims are checks, never replacement values.
 */
export function acceptDispatchGrant(db, request = {}, options = {}) {
  const grantId = request.grantId ?? request.id;
  const code = request.dispatchCode ?? request.code;
  const clientRequestId = request.clientRequestId ?? request.clientRequest;
  if (!isNonEmptyString(grantId)
    || !isNonEmptyString(code)
    || !isNonEmptyString(clientRequestId)) {
    return invalid('grantId, dispatchCode and clientRequestId are required.');
  }
  const sessionId = request.sessionId ?? deterministicSessionId(grantId, clientRequestId);
  if (!isNonEmptyString(sessionId)) return invalid('sessionId must be non-empty.');
  const codeHash = digest(code);
  const commandId = request.commandId
    ?? commandIdFor('dispatch.accept', grantId, clientRequestId);
  const intent = {
    grantId,
    clientRequestId,
    sessionId,
    dispatchCodeHash: codeHash,
    ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
    ...(request.worktreeId !== undefined ? { worktreeId: request.worktreeId } : {}),
    ...((request.canonicalPath ?? request.path ?? request.worktreePath) !== undefined
      ? { canonicalPath: request.canonicalPath ?? request.path ?? request.worktreePath }
      : {}),
    ...((request.agentId ?? request.agent ?? request.agentClaim) !== undefined
      ? { agentId: request.agentId ?? request.agent ?? request.agentClaim }
      : {}),
    ...((request.taskId ?? request.task) !== undefined
      ? { taskId: request.taskId ?? request.task }
      : {}),
    ...(request.scope !== undefined ? { scope: request.scope } : {}),
  };
  const begun = beginCoreCommand(db, {
    commandId,
    kind: 'dispatch.grant.accept',
    request: intent,
  });
  if (begun.replay) return begun.replay;

  const timestamp = iso(nowMillis(options));
  return withImmediateTransaction(db, () => {
    const command = readCommand(db, commandId);
    const replay = terminalResult(command);
    if (replay) return replay;
    const grant = grantRow(db, grantId);
    if (!grant) return failCommand(db, commandId, { ok: false, code: 'DISPATCH_GRANT_NOT_FOUND', grantId });

    if (!claimedBindingMatches(request, grant)) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'DISPATCH_GRANT_BINDING_MISMATCH',
        grantId,
        assignmentId: grant.assignment_id,
      });
    }
    const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(grant.assignment_id);
    if (!assignment) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'ASSIGNMENT_NOT_FOUND',
        assignmentId: grant.assignment_id,
      });
    }
    if (!grantBindingMatchesAssignment(grant, {
      ...assignment,
    })) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'DISPATCH_GRANT_BINDING_INVALID',
        grantId,
      });
    }

    const now = nowMillis(options);
    if (grant.state === 'revoked') {
      return failCommand(db, commandId, { ok: false, code: 'DISPATCH_GRANT_REVOKED', grantId });
    }
    if (grant.state === 'expired' || grant.expires_at <= now) {
      db.prepare(`
        UPDATE dispatch_grants SET state = 'expired'
        WHERE id = ? AND state = 'active'
      `).run(grantId);
      return failCommand(db, commandId, {
        ok: false,
        code: 'DISPATCH_GRANT_EXPIRED',
        grantId,
      });
    }
    if (grant.state === 'accepted') {
      if (grant.accepted_client_request_id === clientRequestId
        && grant.accepted_session_id === sessionId) {
        return {
          ok: true,
          grantId,
          assignmentId: grant.assignment_id,
          projectId: grant.project_id,
          worktreeId: grant.worktree_id,
          agentId: grant.agent_id,
          taskId: grant.task_id,
          scope: parseScope(grant.scope_json),
          sessionId,
          clientRequestId,
          status: grant.assignment_status,
          revision: grant.assignment_revision,
          acceptedAt: grant.accepted_at,
          alreadyAccepted: true,
        };
      }
      return failCommand(db, commandId, {
        ok: false,
        code: 'DISPATCH_GRANT_ALREADY_ACCEPTED',
        grantId,
        assignmentId: grant.assignment_id,
        sessionId: grant.accepted_session_id,
      });
    }

    if (!codeMatches(grant.code_hash, code)) {
      return failCommand(db, commandId, { ok: false, code: 'DISPATCH_CODE_INVALID', grantId });
    }
    if (assignment.status !== 'pending' || assignment.revision !== 0 || assignment.session_id) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'ASSIGNMENT_ALREADY_ACCEPTED',
        assignmentId: assignment.id,
        sessionId: assignment.session_id,
        revision: assignment.revision,
      });
    }

    const occupiedSession = db.prepare(`
      SELECT id FROM assignments WHERE session_id = ? AND id != ?
    `).get(sessionId, assignment.id);
    if (occupiedSession) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'SESSION_ALREADY_BOUND',
        sessionId,
      });
    }

    // A sessionId may refer to an existing Run.  When it does, the assignment
    // starts at that Run's revision and later progress advances both records.
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(sessionId);
    if (run && run.lifecycle !== 'active') {
      return failCommand(db, commandId, {
        ok: false,
        code: 'SESSION_NOT_ACTIVE',
        sessionId,
      });
    }
    if (run && run.worktree_id !== assignment.worktree_id) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'SESSION_BINDING_MISMATCH',
        sessionId,
        worktreeId: assignment.worktree_id,
      });
    }
    const initialRevision = run?.revision ?? 1;
    db.prepare(`
      UPDATE assignments
      SET status = 'accepted', revision = ?, session_id = ?, accepted_grant_id = ?,
          accepted_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND revision = 0 AND session_id IS NULL
    `).run(initialRevision, sessionId, grantId, timestamp, timestamp, assignment.id);
    const accepted = db.prepare('SELECT changes() AS count').get().count;
    if (accepted !== 1) {
      throw new Error('Assignment accept CAS failed.');
    }
    const marked = db.prepare(`
      UPDATE dispatch_grants
      SET state = 'accepted', accepted_at = ?, accepted_session_id = ?,
          accepted_client_request_id = ?
      WHERE id = ? AND state = 'active'
    `).run(timestamp, sessionId, clientRequestId, grantId);
    if (marked.changes !== 1) throw new Error('Dispatch grant accept CAS failed.');
    const response = {
      ok: true,
      grantId,
      assignmentId: assignment.id,
      projectId: assignment.project_id,
      worktreeId: assignment.worktree_id,
      canonicalPath: grant.canonical_path,
      repositoryIdentity: grant.repository_identity,
      worktreeIdentity: grant.identity_fingerprint,
      agentId: assignment.agent_id,
      taskId: assignment.task_id,
      scope: parseScope(assignment.scope_json),
      sessionId,
      clientRequestId,
      status: 'accepted',
      revision: initialRevision,
      acceptedAt: timestamp,
    };
    return commitCommand(db, commandId, response, timestamp, sessionId);
  });
}

function progressRequestMatches(row, request) {
  return row.expected_revision === request.expectedRevision
    && row.status === request.status
    && row.note === request.note;
}

/**
 * Append one fenced progress event and advance the assignment (and, when the
 * session is an existing active Run, the Run) revision in the same
 * transaction.  Replaying the same clientRequestId returns the original
 * event without appending a second row or incrementing a revision.
 */
export function appendProgressEvent(db, request = {}, options = {}) {
  const sessionId = request.sessionId;
  const clientRequestId = request.clientRequestId ?? request.clientRequest;
  const expectedRevision = Number(request.expectedRevision);
  const status = request.status;
  const note = request.note ?? '';
  if (!isNonEmptyString(sessionId)
    || !isNonEmptyString(clientRequestId)
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 0
    || !isNonEmptyString(status)
    || typeof note !== 'string') {
    return invalid('sessionId, clientRequestId, expectedRevision and status are required.');
  }
  const assignmentId = request.assignmentId
    ?? db.prepare('SELECT id FROM assignments WHERE session_id = ?').get(sessionId)?.id;
  if (!isNonEmptyString(assignmentId)) return { ok: false, code: 'ASSIGNMENT_NOT_FOUND', sessionId };
  const commandId = request.commandId
    ?? commandIdFor('dispatch.progress', assignmentId, sessionId, clientRequestId);
  const intent = {
    assignmentId,
    sessionId,
    clientRequestId,
    expectedRevision,
    status,
    note,
  };
  const begun = beginCoreCommand(db, {
    commandId,
    kind: 'assignment.progress',
    request: intent,
    runId: sessionId,
  });
  if (begun.replay) return begun.replay;

  const timestamp = iso(nowMillis(options));
  return withImmediateTransaction(db, () => {
    const command = readCommand(db, commandId);
    const replay = terminalResult(command);
    if (replay) return replay;

    const eventId = eventIdFor(assignmentId, sessionId, clientRequestId);
    const existingEvent = db.prepare(`
      SELECT * FROM progress_events
      WHERE assignment_id = ? AND session_id = ? AND client_request_id = ?
    `).get(assignmentId, sessionId, clientRequestId);
    if (existingEvent) {
      if (!progressRequestMatches(existingEvent, { expectedRevision, status, note })) {
        return failCommand(db, commandId, {
          ok: false,
          code: 'PROGRESS_REQUEST_CONFLICT',
          assignmentId,
          sessionId,
          clientRequestId,
        });
      }
      return { ok: true, ...mapProgress(existingEvent) };
    }

    const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId);
    if (!assignment) return failCommand(db, commandId, { ok: false, code: 'ASSIGNMENT_NOT_FOUND', assignmentId });
    if (assignment.status === 'pending') {
      return failCommand(db, commandId, {
        ok: false,
        code: 'ASSIGNMENT_NOT_ACCEPTED',
        assignmentId,
      });
    }
    if (assignment.session_id !== sessionId) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'SESSION_MISMATCH',
        assignmentId,
        sessionId,
      });
    }
    if (TERMINAL_ASSIGNMENT_STATES.has(assignment.status)) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'ASSIGNMENT_NOT_ACTIVE',
        assignmentId,
        status: assignment.status,
      });
    }
    if (assignment.accepted_grant_id) {
      const acceptedGrant = db.prepare(`
        SELECT state FROM dispatch_grants WHERE id = ?
      `).get(assignment.accepted_grant_id);
      if (acceptedGrant?.state === 'revoked') {
        return failCommand(db, commandId, {
          ok: false,
          code: 'DISPATCH_GRANT_REVOKED',
          grantId: assignment.accepted_grant_id,
        });
      }
    }

    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(sessionId);
    if (run && run.lifecycle !== 'active') {
      return failCommand(db, commandId, { ok: false, code: 'SESSION_NOT_ACTIVE', sessionId });
    }
    if (run && run.worktree_id !== assignment.worktree_id) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'SESSION_BINDING_MISMATCH',
        sessionId,
      });
    }
    if (assignment.revision !== expectedRevision
      || (run && run.revision !== expectedRevision)) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'ASSIGNMENT_REVISION_CONFLICT',
        assignmentId,
        sessionId,
        revision: assignment.revision,
        runRevision: run?.revision ?? null,
      });
    }

    const nextRevision = expectedRevision + 1;
    const nextStatus = TERMINAL_ASSIGNMENT_STATES.has(status) ? status : 'active';
    if (run) {
      const updatedRun = db.prepare(`
        UPDATE runs
        SET revision = revision + 1, last_heartbeat_at = ?
        WHERE id = ? AND lifecycle = 'active' AND revision = ?
      `).run(timestamp, sessionId, expectedRevision);
      if (updatedRun.changes !== 1) throw new Error('Run progress CAS failed.');
    }
    const updatedAssignment = db.prepare(`
      UPDATE assignments
      SET status = ?, revision = revision + 1, last_heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND session_id = ? AND revision = ?
    `).run(nextStatus, timestamp, timestamp, assignmentId, sessionId, expectedRevision);
    if (updatedAssignment.changes !== 1) throw new Error('Assignment progress CAS failed.');
    db.prepare(`
      INSERT INTO progress_events (
        id, assignment_id, session_id, client_request_id,
        expected_revision, revision, status, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      assignmentId,
      sessionId,
      clientRequestId,
      expectedRevision,
      nextRevision,
      status,
      note,
      timestamp,
    );
    const response = {
      ok: true,
      eventId,
      assignmentId,
      sessionId,
      clientRequestId,
      expectedRevision,
      revision: nextRevision,
      status,
      note,
      heartbeatAt: timestamp,
      createdAt: timestamp,
    };
    return commitCommand(db, commandId, response, timestamp, sessionId);
  });
}

/** Return the immutable dispatch binding addressed by a one-time code. */
export function readDispatchContext(db, request = {}, options = {}) {
  return readDispatchGrantByCode(db, request, options);
}

/** Accept by code (the adapter does not need to know the opaque grant id). */
export function acceptAssignment(db, request = {}, options = {}) {
  if (!isNonEmptyString(request.dispatchCode ?? request.code)) {
    return invalid('dispatchCode is required.');
  }
  const context = readDispatchContext(db, request, options);
  if (!context?.ok) return context;
  return acceptDispatchGrant(db, { ...request, grantId: context.grantId }, options);
}

/**
 * Finish an assignment with the same fenced revision used by progress.  It
 * records a final append-only event and updates assignment status; an
 * existing Run is deliberately left for the existing finishRun state machine
 * to finalize its snapshots/lease.
 */
export function completeAssignment(db, request = {}, options = {}) {
  const sessionId = request.sessionId;
  const assignmentId = request.assignmentId
    ?? db.prepare('SELECT id FROM assignments WHERE session_id = ?').get(sessionId)?.id;
  const clientRequestId = request.clientRequestId ?? request.clientRequest;
  const expectedRevision = Number(request.expectedRevision);
  const status = request.status ?? request.outcome;
  const note = request.note ?? request.summary ?? '';
  if (!isNonEmptyString(sessionId)
    || !isNonEmptyString(assignmentId)
    || !isNonEmptyString(clientRequestId)
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 1
    || !TERMINAL_ASSIGNMENT_STATES.has(status)
    || typeof note !== 'string') {
    return invalid('sessionId, clientRequestId, expectedRevision and terminal status are required.');
  }
  const commandId = request.commandId
    ?? commandIdFor('assignment.complete', assignmentId, sessionId, clientRequestId);
  const intent = { assignmentId, sessionId, clientRequestId, expectedRevision, status, note };
  const begun = beginCoreCommand(db, {
    commandId,
    kind: 'assignment.complete',
    request: intent,
    runId: sessionId,
  });
  if (begun.replay) return begun.replay;
  const timestamp = iso(nowMillis(options));
  return withImmediateTransaction(db, () => {
    const command = readCommand(db, commandId);
    const replay = terminalResult(command);
    if (replay) return replay;
    const eventId = eventIdFor(assignmentId, sessionId, clientRequestId);
    const existing = db.prepare(`
      SELECT * FROM progress_events
      WHERE assignment_id = ? AND session_id = ? AND client_request_id = ?
    `).get(assignmentId, sessionId, clientRequestId);
    if (existing) {
      if (!progressRequestMatches(existing, { expectedRevision, status, note })) {
        return failCommand(db, commandId, { ok: false, code: 'PROGRESS_REQUEST_CONFLICT' });
      }
      return { ok: true, ...mapProgress(existing), status: existing.status };
    }
    const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId);
    if (!assignment || assignment.status === 'pending') {
      return failCommand(db, commandId, {
        ok: false,
        code: assignment ? 'ASSIGNMENT_NOT_ACCEPTED' : 'ASSIGNMENT_NOT_FOUND',
        assignmentId,
      });
    }
    if (assignment.session_id !== sessionId) {
      return failCommand(db, commandId, { ok: false, code: 'SESSION_MISMATCH', assignmentId });
    }
    if (TERMINAL_ASSIGNMENT_STATES.has(assignment.status)) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'ASSIGNMENT_NOT_ACTIVE',
        assignmentId,
        status: assignment.status,
      });
    }
    if (assignment.revision !== expectedRevision) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'ASSIGNMENT_REVISION_CONFLICT',
        assignmentId,
        revision: assignment.revision,
      });
    }
    db.prepare(`
      UPDATE assignments
      SET status = ?, revision = revision + 1, last_heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND session_id = ? AND revision = ?
    `).run(status, timestamp, timestamp, assignmentId, sessionId, expectedRevision);
    if (db.prepare('SELECT changes() AS count').get().count !== 1) {
      throw new Error('Assignment completion CAS failed.');
    }
    db.prepare(`
      INSERT INTO progress_events (
        id, assignment_id, session_id, client_request_id,
        expected_revision, revision, status, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      assignmentId,
      sessionId,
      clientRequestId,
      expectedRevision,
      expectedRevision + 1,
      status,
      note,
      timestamp,
    );
    const response = {
      ok: true,
      eventId,
      assignmentId,
      sessionId,
      clientRequestId,
      expectedRevision,
      revision: expectedRevision + 1,
      status,
      outcome: status,
      summary: request.summary ?? note,
      nextStep: request.nextStep ?? '',
      heartbeatAt: timestamp,
      createdAt: timestamp,
    };
    return commitCommand(db, commandId, response, timestamp, sessionId);
  });
}

/** Promote an accepted standby assignment into active work after a Run exists. */
export function beginAssignmentWork(db, request = {}, options = {}) {
  const { sessionId, clientRequestId, task } = request;
  const expectedRevision = Number(request.expectedRevision);
  if (!isNonEmptyString(sessionId)
    || !isNonEmptyString(clientRequestId)
    || !isNonEmptyString(task)
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 1) {
    return invalid('sessionId, clientRequestId, expectedRevision and task are required.');
  }
  const commandId = request.commandId
    ?? commandIdFor('assignment.begin', sessionId, clientRequestId);
  const intent = { sessionId, clientRequestId, expectedRevision, task: task.trim() };
  const begun = beginCoreCommand(db, {
    commandId,
    kind: 'assignment.begin',
    request: intent,
    runId: sessionId,
  });
  if (begun.replay) return begun.replay;
  const timestamp = iso(nowMillis(options));
  return withImmediateTransaction(db, () => {
    const command = readCommand(db, commandId);
    const replay = terminalResult(command);
    if (replay) return replay;
    const assignment = db.prepare('SELECT * FROM assignments WHERE session_id = ?').get(sessionId);
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(sessionId);
    if (!assignment || !run) {
      return failCommand(db, commandId, {
        ok: false,
        code: assignment ? 'SESSION_NOT_ACTIVE' : 'SESSION_NOT_FOUND',
        sessionId,
      });
    }
    if (assignment.revision !== expectedRevision || run.revision !== expectedRevision) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'ASSIGNMENT_REVISION_CONFLICT',
        sessionId,
        revision: assignment.revision,
      });
    }
    if (run.lifecycle !== 'active' || run.worktree_id !== assignment.worktree_id) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'SESSION_BINDING_MISMATCH',
        sessionId,
      });
    }
    if (assignment.status !== 'accepted' && assignment.status !== 'active') {
      return failCommand(db, commandId, {
        ok: false,
        code: 'ASSIGNMENT_NOT_ACTIVE',
        sessionId,
        status: assignment.status,
      });
    }
    db.prepare(`
      UPDATE assignments SET status = 'active', task_id = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND status IN ('accepted', 'active')
    `).run(task.trim(), timestamp, assignment.id, expectedRevision);
    return commitCommand(db, commandId, {
      ok: true,
      assignmentId: assignment.id,
      sessionId,
      status: 'active',
      task: task.trim(),
      revision: expectedRevision,
      startedAt: run.created_at,
    }, timestamp, sessionId);
  });
}

/** Read all immutable binding and run context needed by a finish adapter. */
export function readSessionContext(db, sessionId) {
  if (!isNonEmptyString(sessionId)) return { ok: false, code: 'INVALID_REQUEST' };
  const assignment = db.prepare(`
    SELECT assignments.*, projects.name AS project_name, projects.authorized_root,
           worktrees.canonical_path, worktrees.repository_identity,
           worktrees.identity_fingerprint
    FROM assignments
    JOIN projects ON projects.id = assignments.project_id
    JOIN worktrees ON worktrees.id = assignments.worktree_id
    WHERE assignments.session_id = ?
  `).get(sessionId);
  if (!assignment) return { ok: false, code: 'SESSION_NOT_FOUND', sessionId };
  const run = db.prepare(`
    SELECT id, worktree_id, lifecycle, health, revision, lease_generation,
           agent_claim, goal, last_heartbeat_at, created_at, finished_at
    FROM runs WHERE id = ?
  `).get(sessionId) ?? null;
  const context = mapAssignment(assignment);
  return {
    ok: true,
    sessionId,
    ...context,
    run: run ? {
      id: run.id,
      worktreeId: run.worktree_id,
      lifecycle: run.lifecycle,
      health: run.health,
      revision: run.revision,
      leaseGeneration: run.lease_generation,
      agentClaim: run.agent_claim,
      goal: run.goal,
      lastHeartbeatAt: run.last_heartbeat_at,
      createdAt: run.created_at,
      finishedAt: run.finished_at,
    } : null,
  };
}

/** Revoke by opaque grant id, dispatch code, or assignment's latest grant. */
export function revokeAssignment(db, request = {}, options = {}) {
  let grantId = request.grantId;
  if (!grantId && (request.dispatchCode ?? request.code)) {
    const context = readDispatchContext(db, request, options);
    if (!context?.ok) return context;
    grantId = context.grantId;
  }
  if (!grantId && request.assignmentId) {
    grantId = db.prepare(`
      SELECT id FROM dispatch_grants WHERE assignment_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(request.assignmentId)?.id;
  }
  if (!grantId) return { ok: false, code: 'DISPATCH_GRANT_NOT_FOUND' };
  return revokeDispatchGrant(db, { ...request, grantId }, options);
}

export function readAssignment(db, assignmentId) {
  return mapAssignment(assignmentRow(db, assignmentId));
}

export function listAssignments(db, { projectId, status } = {}) {
  const predicates = [];
  const values = [];
  if (projectId !== undefined) {
    predicates.push('assignments.project_id = ?');
    values.push(projectId);
  }
  if (status !== undefined) {
    predicates.push('assignments.status = ?');
    values.push(status);
  }
  const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
  return db.prepare(`
    SELECT assignments.*, projects.name AS project_name,
           projects.stage AS project_stage, projects.authorized_root,
           worktrees.canonical_path, worktrees.repository_identity,
           worktrees.identity_fingerprint
    FROM assignments
    JOIN projects ON projects.id = assignments.project_id
    JOIN worktrees ON worktrees.id = assignments.worktree_id
    ${where}
    ORDER BY assignments.created_at ASC, assignments.id ASC
  `).all(...values).map(mapAssignment);
}

export function readDispatchGrant(db, grantId) {
  return mapGrant(grantRow(db, grantId));
}

export function listDispatchGrants(db, { assignmentId, state } = {}) {
  const predicates = [];
  const values = [];
  if (assignmentId !== undefined) {
    predicates.push('dispatch_grants.assignment_id = ?');
    values.push(assignmentId);
  }
  if (state !== undefined) {
    predicates.push('dispatch_grants.state = ?');
    values.push(state);
  }
  const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
  return db.prepare(`
    SELECT dispatch_grants.*, assignments.status AS assignment_status,
           assignments.revision AS assignment_revision,
           assignments.session_id AS assignment_session_id,
           projects.name AS project_name, projects.stage AS project_stage,
           projects.authorized_root,
           worktrees.canonical_path, worktrees.repository_identity,
           worktrees.identity_fingerprint
    FROM dispatch_grants
    JOIN assignments ON assignments.id = dispatch_grants.assignment_id
    JOIN projects ON projects.id = dispatch_grants.project_id
    JOIN worktrees ON worktrees.id = dispatch_grants.worktree_id
    ${where}
    ORDER BY dispatch_grants.created_at ASC, dispatch_grants.id ASC
  `).all(...values).map(mapGrant);
}

export function listProgressEvents(db, assignmentId) {
  if (!isNonEmptyString(assignmentId)) return [];
  return db.prepare(`
    SELECT * FROM progress_events
    WHERE assignment_id = ?
    ORDER BY revision ASC, created_at ASC, id ASC
  `).all(assignmentId).map(mapProgress);
}

// Small aliases keep the core convenient for adapters whose vocabulary uses
// “grant”, “progress” or “record” rather than the storage-oriented names.
export const createDispatchGrant = issueDispatchGrant;
export const acceptGrant = acceptDispatchGrant;
export const revokeGrant = revokeDispatchGrant;
export const recordProgressEvent = appendProgressEvent;
export const appendProgress = appendProgressEvent;
export const createTaskAssignment = createAssignment;
export const recordProgress = appendProgressEvent;
