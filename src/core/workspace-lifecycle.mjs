import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { canonicalJson, beginCommand, parseCommandResponse } from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';

const ACTIVE_ASSIGNMENT_STATES = ['pending', 'accepted', 'active'];
const RESERVATION_STATES = new Set(['executing', 'unknown']);

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

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled. Treat it as
    // alive; only a definite missing-process result permits reclamation.
    return error?.code !== 'ESRCH';
  }
}

// Boot-relative start time of this process. Two processes can hold the same
// PID one after the other (Windows reuses PIDs within minutes), but never the
// same PID *and* start time, so a stored (pid, start) pair identifies the
// creator generation without platform-specific process APIs. The value is
// computed once per process: os.uptime() quantization would otherwise let two
// readings drift apart and misclassify this very process as a PID reuse.
const CURRENT_PROCESS_START = Math.max(0, Math.round((os.uptime() - process.uptime()) * 1000));

export function currentProcessStartTime() {
  return CURRENT_PROCESS_START;
}

function reservationOwnerStartedAt(row) {
  // Number(null) === 0, so the null check must come first: rows without a
  // recorded start time must stay conservative, not match start time 0.
  if (row?.owner_started_at === null || row?.owner_started_at === undefined) return null;
  const value = Number(row.owner_started_at);
  return Number.isFinite(value) ? value : null;
}

// True when the reservation was recorded by THIS process generation and its
// PID is still alive — i.e. the executor may genuinely still be running.
function reservationOwnerCouldBeExecuting(row) {
  if (!processIsAlive(row.owner_pid)) return false;
  const startedAt = reservationOwnerStartedAt(row);
  // Rows recorded before owner identity existed: stay conservative.
  if (startedAt === null) return true;
  return row.owner_pid === process.pid && startedAt === currentProcessStartTime();
}

function mapReservation(row) {
  if (!row) return null;
  return {
    repositoryIdentity: row.repository_identity,
    worktreeId: row.worktree_id,
    projectId: row.project_id,
    spaceId: row.space_id,
    commandId: row.command_id,
    operation: row.operation,
    state: row.state,
    epoch: row.epoch,
    expectedRevision: row.expected_revision,
    expectedStatus: row.expected_status,
    ownerPid: row.owner_pid,
    ownerStartedAt: row.owner_started_at,
    ownerToken: row.owner_token,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    effectObservedAt: row.effect_observed_at,
    lastErrorCode: row.last_error_code,
  };
}

function reservationTableExists(db) {
  return Boolean(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_lifecycle_reservations'",
  ).get());
}

function readReservationRow(db, repositoryIdentity) {
  if (!reservationTableExists(db) || !isNonEmptyString(repositoryIdentity)) return null;
  const row = db.prepare(`
    SELECT * FROM workspace_lifecycle_reservations
    WHERE repository_identity = ?
  `).get(repositoryIdentity);
  return row && RESERVATION_STATES.has(row.state) ? row : null;
}

function readLegacyPendingCommands(db, { repositoryIdentity, worktreeId } = {}) {
  if (!repositoryIdentity || !worktreeId) return [];
  const rows = db.prepare(`
    SELECT id, kind, state, request_json, created_at
    FROM commands
    WHERE kind IN ('workspace.reuse', 'workspace.remove')
      AND state IN ('received', 'observing', 'uncertain')
    ORDER BY created_at ASC, id ASC
  `).all();
  const pending = [];
  for (const row of rows) {
    let request;
    try { request = JSON.parse(row.request_json); } catch { continue; }
    const projectId = request?.projectId ?? request?.project_id;
    const spaceId = request?.spaceId ?? request?.space_id;
    if (!projectId || !spaceId) continue;
    const target = db.prepare(`
      SELECT development_spaces.worktree_id, worktrees.repository_identity
      FROM development_spaces
      JOIN worktrees ON worktrees.id = development_spaces.worktree_id
      WHERE development_spaces.id = ? AND development_spaces.project_id = ?
    `).get(spaceId, projectId);
    if (target?.worktree_id === worktreeId && target.repository_identity === repositoryIdentity) {
      pending.push({
        commandId: row.id,
        operation: row.kind === 'workspace.reuse' ? 'reuse' : 'remove',
        projectId,
        spaceId,
        state: row.state,
        createdAt: row.created_at,
      });
    }
  }
  return pending;
}

function legacyFence(db, request) {
  const pending = readLegacyPendingCommands(db, request);
  if (pending.length === 0) return { ok: true, pending };
  if (pending.length > 1) {
    return {
      ok: false,
      code: 'WORKSPACE_LIFECYCLE_AMBIGUOUS',
      pendingCommands: pending.map(({ commandId, operation, state }) => ({ commandId, operation, state })),
      outcome: 'unknown',
      state: 'received',
      retryable: true,
    };
  }
  if (pending[0].commandId !== request.commandId) {
    return inProgress({
      command_id: pending[0].commandId,
      operation: pending[0].operation,
      state: pending[0].state,
      epoch: null,
    }, 'WORKSPACE_LIFECYCLE_IN_PROGRESS');
  }
  return { ok: true, pending };
}

function inProgress(row, code = 'WORKSPACE_LIFECYCLE_IN_PROGRESS') {
  return {
    ok: false,
    code,
    commandId: row.command_id,
    operation: row.operation,
    reservationState: row.state,
    epoch: row.epoch,
    outcome: 'unknown',
    state: 'received',
    retryable: true,
  };
}

function conflictFromActiveWork(worktreeId, lease, assignment) {
  if (lease) {
    return {
      ok: false,
      code: 'SPACE_HAS_ACTIVE_WORK',
      worktreeId,
      kind: 'write_lease',
      runId: lease.run_id,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    };
  }
  if (assignment) {
    return {
      ok: false,
      code: 'SPACE_HAS_ACTIVE_WORK',
      worktreeId,
      kind: 'assignment',
      assignmentId: assignment.id,
      assignmentStatus: assignment.status,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    };
  }
  return null;
}

function checkLifecycleTarget(db, request, { allowedStatuses = [] } = {}) {
  const project = db.prepare(`
    SELECT id, archived_at, archive_revision, status
    FROM projects WHERE id = ?
  `).get(request.projectId);
  if (!project) {
    return {
      ok: false,
      code: 'PROJECT_NOT_FOUND',
      projectId: request.projectId,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    };
  }
  if (project.archived_at !== null) {
    return {
      ok: false,
      code: 'PROJECT_ARCHIVED',
      projectId: request.projectId,
      archivedAt: project.archived_at,
      archiveRevision: project.archive_revision,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    };
  }

  const space = db.prepare(`
    SELECT * FROM development_spaces
    WHERE id = ? AND project_id = ? AND worktree_id = ?
  `).get(request.spaceId, request.projectId, request.worktreeId);
  if (!space) {
    return {
      ok: false,
      code: 'SPACE_NOT_FOUND',
      spaceId: request.spaceId,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    };
  }
  if (!allowedStatuses.includes(space.status)) {
    return {
      ok: false,
      code: request.operation === 'reuse' ? 'SPACE_NOT_REUSABLE' : 'SPACE_NOT_REMOVABLE',
      spaceId: space.id,
      status: space.status,
      currentStatus: space.status,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    };
  }
  if (space.revision !== request.expectedRevision) {
    return {
      ok: false,
      code: 'SPACE_REVISION_CONFLICT',
      spaceId: space.id,
      expectedRevision: request.expectedRevision,
      currentRevision: space.revision,
      currentStatus: space.status,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    };
  }

  const worktree = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(request.worktreeId);
  if (!worktree || worktree.repository_identity !== request.repositoryIdentity) {
    return {
      ok: false,
      code: 'WORKSPACE_IDENTITY_MISMATCH',
      worktreeId: request.worktreeId,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    };
  }

  const lease = db.prepare(`
    SELECT write_leases.run_id AS run_id
    FROM write_leases
    LEFT JOIN runs ON runs.id = write_leases.run_id
    WHERE write_leases.worktree_id = ?
  `).get(request.worktreeId);
  const assignment = db.prepare(`
    SELECT id, status FROM assignments
    WHERE worktree_id = ? AND status IN (${ACTIVE_ASSIGNMENT_STATES.map(() => '?').join(', ')})
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get(request.worktreeId, ...ACTIVE_ASSIGNMENT_STATES);
  const activeWork = conflictFromActiveWork(request.worktreeId, lease, assignment);
  if (activeWork) return activeWork;

  return { ok: true, project, space, worktree };
}

function sameOwner(row, request) {
  return row?.command_id === request.commandId && row?.owner_token === request.ownerToken;
}

export function readWorkspaceLifecycleReservation(db, repositoryIdentity) {
  return mapReservation(readReservationRow(db, repositoryIdentity));
}

export function readWorkspaceLifecycleEpoch(db, worktreeId) {
  const row = db.prepare(`
    SELECT lifecycle_epoch, lifecycle_started_at, lifecycle_completed_at
    FROM worktrees WHERE id = ?
  `).get(worktreeId);
  if (!row) return null;
  return {
    lifecycleEpoch: row.lifecycle_epoch,
    lifecycleStartedAt: row.lifecycle_started_at,
    lifecycleCompletedAt: row.lifecycle_completed_at,
  };
}

/**
 * Reserve a workspace lifecycle operation after all durable admission checks.
 * The row has no TTL. A different command may not replace it; only the same
 * command may reclaim it after the recorded executor process generation is
 * gone (a live PID whose start time differs from the recorded one is a reused
 * PID, not the original executor).
 */
export function reserveWorkspaceLifecycle(db, request = {}, options = {}) {
  const timestamp = iso(nowMillis(options));
  const ownerToken = request.ownerToken ?? randomUUID();
  const ownerPid = request.ownerPid ?? process.pid;
  const ownerStartedAt = request.ownerStartedAt ?? currentProcessStartTime();
  const allowedStatuses = request.allowedStatuses ?? [];

  return withImmediateTransaction(db, () => {
    const current = readReservationRow(db, request.repositoryIdentity);
    if (current) {
      if (current.command_id !== request.commandId) {
        return inProgress(current);
      }
      if (sameOwner(current, { ...request, ownerToken })) {
        return inProgress(current);
      }
      if (reservationOwnerCouldBeExecuting(current)) {
        return inProgress(current);
      }
      const reclaimed = db.prepare(`
        UPDATE workspace_lifecycle_reservations
        SET owner_pid = ?, owner_started_at = ?, owner_token = ?, state = 'executing', updated_at = ?,
            last_error_code = NULL
        WHERE repository_identity = ? AND command_id = ? AND owner_pid = ? AND owner_token = ?
      `).run(
        ownerPid,
        ownerStartedAt,
        ownerToken,
        timestamp,
        request.repositoryIdentity,
        request.commandId,
        current.owner_pid,
        current.owner_token,
      );
      if (reclaimed.changes !== 1) {
        const latest = readReservationRow(db, request.repositoryIdentity);
        return latest ? inProgress(latest) : {
          ok: false,
          code: 'WORKSPACE_LIFECYCLE_CONFLICT',
          outcome: 'unknown',
          state: 'received',
          retryable: true,
        };
      }
      return {
        ok: true,
        reclaimed: true,
        ownerToken,
        ownerPid,
        reservation: mapReservation({
          ...current,
          owner_pid: ownerPid,
          owner_token: ownerToken,
          state: 'executing',
          updated_at: timestamp,
          last_error_code: null,
        }),
      };
    }

    const legacy = legacyFence(db, request);
    if (!legacy.ok) return legacy;

    const target = checkLifecycleTarget(db, request, { allowedStatuses });
    if (!target.ok) return target;

    const epoch = Number(target.worktree.lifecycle_epoch ?? 0) + 1;
    db.prepare(`
      UPDATE worktrees
      SET lifecycle_epoch = ?, lifecycle_started_at = ?, lifecycle_completed_at = NULL
      WHERE id = ? AND lifecycle_epoch = ?
    `).run(epoch, timestamp, request.worktreeId, epoch - 1);
    if (db.prepare('SELECT changes() AS count').get().count !== 1) {
      throw new Error('Workspace lifecycle epoch CAS failed.');
    }

    db.prepare(`
      INSERT INTO workspace_lifecycle_reservations (
        repository_identity, worktree_id, project_id, space_id, command_id,
        operation, state, epoch, expected_revision, expected_status,
        owner_pid, owner_started_at, owner_token, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'executing', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.repositoryIdentity,
      request.worktreeId,
      request.projectId,
      request.spaceId,
      request.commandId,
      request.operation,
      epoch,
      request.expectedRevision,
      target.space.status,
      ownerPid,
      ownerStartedAt,
      ownerToken,
      timestamp,
      timestamp,
    );

    return {
      ok: true,
      reclaimed: false,
      ownerToken,
      ownerPid,
      reservation: mapReservation({
        repository_identity: request.repositoryIdentity,
        worktree_id: request.worktreeId,
        project_id: request.projectId,
        space_id: request.spaceId,
        command_id: request.commandId,
        operation: request.operation,
        state: 'executing',
        epoch,
        expected_revision: request.expectedRevision,
        expected_status: target.space.status,
        owner_pid: ownerPid,
        owner_token: ownerToken,
        started_at: timestamp,
        updated_at: timestamp,
        effect_observed_at: null,
        last_error_code: null,
      }),
    };
  });
}

function ownershipFailure(row, request) {
  if (!row) {
    return {
      ok: false,
      code: 'WORKSPACE_LIFECYCLE_RESERVATION_MISSING',
      outcome: 'unknown',
      state: 'received',
      retryable: true,
    };
  }
  if (row.command_id !== request.commandId) return inProgress(row);
  return {
    ok: false,
    code: 'WORKSPACE_LIFECYCLE_RESERVATION_LOST',
    commandId: row.command_id,
    outcome: 'unknown',
    state: 'received',
    retryable: true,
  };
}

/** Recheck ownership and all pre-effect durable state in one write transaction. */
export function revalidateWorkspaceLifecycle(db, request = {}, options = {}) {
  const timestamp = iso(nowMillis(options));
  return withImmediateTransaction(db, () => {
    const row = readReservationRow(db, request.repositoryIdentity);
    if (!sameOwner(row, request)) return ownershipFailure(row, request);
    const target = checkLifecycleTarget(db, request, {
      allowedStatuses: request.allowedStatuses ?? [],
    });
    if (!target.ok) {
      db.prepare(`
        UPDATE workspace_lifecycle_reservations
        SET last_error_code = ?, updated_at = ?
        WHERE repository_identity = ? AND command_id = ? AND owner_token = ?
      `).run(target.code, timestamp, request.repositoryIdentity, request.commandId, request.ownerToken);
      return target;
    }
    return { ok: true, reservation: mapReservation(row), ...target };
  });
}

export function markWorkspaceLifecycleEffectUnknown(db, request = {}, options = {}) {
  const timestamp = iso(nowMillis(options));
  return withImmediateTransaction(db, () => {
    const row = readReservationRow(db, request.repositoryIdentity);
    if (!sameOwner(row, request)) return ownershipFailure(row, request);
    db.prepare(`
      UPDATE workspace_lifecycle_reservations
      SET state = 'unknown', effect_observed_at = ?, updated_at = ?
      WHERE repository_identity = ? AND command_id = ? AND owner_token = ?
    `).run(timestamp, timestamp, request.repositoryIdentity, request.commandId, request.ownerToken);
    return {
      ok: true,
      reservation: mapReservation({ ...row, state: 'unknown', effect_observed_at: timestamp, updated_at: timestamp }),
    };
  });
}

/** Complete and release a reservation from the caller's existing transaction. */
export function completeWorkspaceLifecycleInTransaction(db, request = {}, timestamp = new Date().toISOString()) {
  const row = readReservationRow(db, request.repositoryIdentity);
  if (!sameOwner(row, request)) return ownershipFailure(row, request);
  const updated = db.prepare(`
    UPDATE worktrees
    SET lifecycle_completed_at = ?
    WHERE id = ? AND lifecycle_epoch = ?
  `).run(timestamp, request.worktreeId, row.epoch);
  if (updated.changes !== 1) {
    const error = new Error('Workspace lifecycle epoch changed before reservation release.');
    error.code = 'WORKSPACE_LIFECYCLE_CONFLICT';
    throw error;
  }
  db.prepare(`
    DELETE FROM workspace_lifecycle_reservations
    WHERE repository_identity = ? AND command_id = ? AND owner_token = ?
  `).run(request.repositoryIdentity, request.commandId, request.ownerToken);
  return { ok: true, epoch: row.epoch };
}

export function releaseWorkspaceLifecycle(db, request = {}, options = {}) {
  const timestamp = iso(nowMillis(options));
  return withImmediateTransaction(db, () => {
    const row = readReservationRow(db, request.repositoryIdentity);
    if (!row) return { ok: true, released: false };
    if (!sameOwner(row, request)) return ownershipFailure(row, request);
    db.prepare(`
      DELETE FROM workspace_lifecycle_reservations
      WHERE repository_identity = ? AND command_id = ? AND owner_token = ?
    `).run(request.repositoryIdentity, request.commandId, request.ownerToken);
    return { ok: true, released: true, updatedAt: timestamp };
  });
}

/** Keep an unknown reservation as a durable fence while releasing this
 * process's executor token so a same-process retry can reclaim it. */
export function releaseWorkspaceLifecycleExecutor(db, request = {}, options = {}) {
  const timestamp = iso(nowMillis(options));
  return withImmediateTransaction(db, () => {
    const row = readReservationRow(db, request.repositoryIdentity);
    if (!sameOwner(row, request)) return ownershipFailure(row, request);
    db.prepare(`
      UPDATE workspace_lifecycle_reservations
      SET owner_pid = 0, owner_started_at = NULL, owner_token = ?, updated_at = ?
      WHERE repository_identity = ? AND command_id = ? AND owner_token = ?
    `).run(
      `released:${randomUUID()}`,
      timestamp,
      request.repositoryIdentity,
      request.commandId,
      request.ownerToken,
    );
    return { ok: true, released: true };
  });
}

/** Shared admission fence for every path that can acquire a write lease. */
export function checkWorkspaceWriteAdmission(db, {
  worktreeId,
  repositoryIdentity,
  baseline = null,
  enforceObservation = true,
} = {}) {
  const reservation = repositoryIdentity
    ? readReservationRow(db, repositoryIdentity)
    : null;
  if (reservation) return inProgress(reservation);

  const legacy = readLegacyPendingCommands(db, { repositoryIdentity, worktreeId });
  if (legacy.length > 1) {
    return {
      ok: false,
      code: 'WORKSPACE_LIFECYCLE_AMBIGUOUS',
      pendingCommands: legacy.map(({ commandId, operation, state }) => ({ commandId, operation, state })),
      outcome: 'unknown',
      state: 'received',
      retryable: true,
    };
  }
  if (legacy.length === 1) {
    return inProgress({
      command_id: legacy[0].commandId,
      operation: legacy[0].operation,
      state: legacy[0].state,
      epoch: null,
    }, 'WORKSPACE_LIFECYCLE_IN_PROGRESS');
  }

  const space = db.prepare(`
    SELECT development_spaces.status, projects.archived_at, projects.archive_revision
    FROM development_spaces
    JOIN projects ON projects.id = development_spaces.project_id
    WHERE development_spaces.worktree_id = ?
  `).get(worktreeId);
  if (space?.archived_at !== null && space?.archived_at !== undefined) {
    return {
      ok: false,
      code: 'PROJECT_ARCHIVED',
      archivedAt: space.archived_at,
      archiveRevision: space.archive_revision,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    };
  }
  if (space?.status === 'archived') {
    return {
      ok: false,
      code: 'SPACE_ARCHIVED',
      currentStatus: space.status,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    };
  }

  const worktree = db.prepare(`
    SELECT lifecycle_epoch, lifecycle_started_at, lifecycle_completed_at
    FROM worktrees WHERE id = ?
  `).get(worktreeId);
  if (!worktree) return { ok: true };

  const suppliedEpoch = baseline?.lifecycleEpoch ?? baseline?.lifecycle_epoch;
  if (!enforceObservation) return { ok: true, lifecycleEpoch: worktree.lifecycle_epoch };
  if (suppliedEpoch !== undefined && suppliedEpoch !== null
    && (!Number.isInteger(suppliedEpoch) || suppliedEpoch !== worktree.lifecycle_epoch)) {
    return {
      ok: false,
      code: 'WORKSPACE_OBSERVATION_STALE',
      lifecycleEpoch: worktree.lifecycle_epoch,
      expectedLifecycleEpoch: suppliedEpoch,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    };
  }

  const observedAt = baseline?.observedAt ?? baseline?.observed_at;
  const completedAt = worktree.lifecycle_completed_at;
  if (worktree.lifecycle_epoch > 0 && suppliedEpoch === undefined && !observedAt) {
    return {
      ok: false,
      code: 'WORKSPACE_OBSERVATION_STALE',
      lifecycleEpoch: worktree.lifecycle_epoch,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    };
  }
  if (worktree.lifecycle_epoch > 0 && completedAt && observedAt) {
    const observedMs = Date.parse(observedAt);
    const completedMs = Date.parse(completedAt);
    if (!Number.isNaN(observedMs) && !Number.isNaN(completedMs) && observedMs <= completedMs) {
      return {
        ok: false,
        code: 'WORKSPACE_OBSERVATION_STALE',
        lifecycleEpoch: worktree.lifecycle_epoch,
        lifecycleCompletedAt: completedAt,
        observedAt,
        outcome: 'confirmed_failure',
        state: 'failed',
        retryable: false,
      };
    }
  }
  return { ok: true, lifecycleEpoch: worktree.lifecycle_epoch };
}

export function workspaceLifecycleAllowedStatuses() {
  return [...['ready', 'cleanup_ready', 'paused', 'attention']];
}

const NON_TERMINAL_COMMAND_STATES = ['received', 'observing', 'uncertain'];

/**
 * Settle a command that is still waiting for its outcome. Unlike the journal's
 * ordinary failure path this one also covers `observing` and `uncertain`,
 * because a lifecycle command that died mid-flight is exactly what gets stuck.
 */
function settleCommand(db, commandId, response, timestamp) {
  db.prepare(`
    UPDATE commands SET state = 'failed', response_json = ?, updated_at = ?
    WHERE id = ? AND state IN (${NON_TERMINAL_COMMAND_STATES.map(() => '?').join(', ')})
  `).run(canonicalJson(response), timestamp, commandId, ...NON_TERMINAL_COMMAND_STATES);
  return response;
}

function commitCommand(db, commandId, response, timestamp) {
  db.prepare(`
    UPDATE commands SET state = 'committed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), timestamp, commandId);
  return response;
}

function activeWorkOnWorktree(db, worktreeId) {
  const lease = db.prepare('SELECT run_id FROM write_leases WHERE worktree_id = ?').get(worktreeId);
  const assignment = db.prepare(`
    SELECT id, status FROM assignments
    WHERE worktree_id = ? AND status IN (${ACTIVE_ASSIGNMENT_STATES.map(() => '?').join(', ')})
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get(worktreeId, ...ACTIVE_ASSIGNMENT_STATES);
  return conflictFromActiveWork(worktreeId, lease, assignment);
}

/**
 * Commands that keep the lifecycle fence up without owning a reservation.
 *
 * A repository with two or more unsettled lifecycle commands deliberately gets
 * no reservation row (the migration that backfilled them refused to guess which
 * command produced which Git effect), and a command can outlive its reservation
 * during recovery. Those rows still fence the repository through
 * `checkWorkspaceWriteAdmission` and `acquireRepositoryLock`, so an exit that
 * only understood reservations would report "nothing is stuck" while every write
 * session kept being refused.
 */
// Both spellings appear in frozen lifecycle requests (the core reads
// `request.projectId ?? request.project_id`), so the fence scan has to match
// what the write admission scans match — otherwise a row the fence blocks on is
// invisible to the console that is supposed to explain it.
const SPACE_ID_PATH = "COALESCE(json_extract(commands.request_json, '$.spaceId'),"
  + " json_extract(commands.request_json, '$.space_id'))";
const PROJECT_ID_PATH = "COALESCE(json_extract(commands.request_json, '$.projectId'),"
  + " json_extract(commands.request_json, '$.project_id'))";

function readJournalFenceCommands(db, repositoryIdentity) {
  if (!reservationTableExists(db) || !isNonEmptyString(repositoryIdentity)) return [];
  return db.prepare(`
    SELECT commands.id, commands.kind, commands.state, commands.created_at, commands.updated_at,
           development_spaces.project_id, development_spaces.id AS space_id,
           development_spaces.worktree_id
    FROM commands
    JOIN development_spaces
      ON development_spaces.id = ${SPACE_ID_PATH}
     AND development_spaces.project_id = ${PROJECT_ID_PATH}
    JOIN worktrees ON worktrees.id = development_spaces.worktree_id
    WHERE commands.kind IN ('workspace.reuse', 'workspace.remove')
      AND commands.state IN (${NON_TERMINAL_COMMAND_STATES.map(() => '?').join(', ')})
      AND worktrees.repository_identity = ?
      AND NOT EXISTS (
        SELECT 1 FROM workspace_lifecycle_reservations reservations
        WHERE reservations.command_id = commands.id
      )
    ORDER BY commands.created_at ASC, commands.id ASC
  `).all(...NON_TERMINAL_COMMAND_STATES, repositoryIdentity);
}

function journalSpaceOf(db, commandId) {
  const row = db.prepare(`
    SELECT development_spaces.id AS space_id, development_spaces.worktree_id AS worktree_id
    FROM commands
    JOIN development_spaces
      ON development_spaces.id = ${SPACE_ID_PATH}
     AND development_spaces.project_id = ${PROJECT_ID_PATH}
    WHERE commands.id = ?
  `).get(commandId);
  return row ? { spaceId: row.space_id, worktreeId: row.worktree_id } : null;
}

/**
 * Which repository a project's fence lives in. The project row is the normal
 * source, but the escape hatch also has to work for a project that is no longer
 * on the dashboard: the reservation and the space rows still carry the
 * repository identity, and that is the fact the fence is keyed on.
 */
export function resolveFenceRepositoryIdentity(db, projectId) {
  if (!isNonEmptyString(projectId)) return null;
  const fromProject = db.prepare(`
    SELECT worktrees.repository_identity AS repository_identity
    FROM projects JOIN worktrees ON worktrees.id = projects.worktree_id
    WHERE projects.id = ?
  `).get(projectId);
  if (fromProject?.repository_identity) return fromProject.repository_identity;
  if (reservationTableExists(db)) {
    const fromReservation = db.prepare(
      `SELECT repository_identity FROM workspace_lifecycle_reservations
        WHERE project_id = ? ORDER BY started_at DESC, repository_identity LIMIT 1`,
    ).get(projectId);
    if (fromReservation?.repository_identity) return fromReservation.repository_identity;
  }
  const fromSpace = db.prepare(`
    SELECT worktrees.repository_identity AS repository_identity
    FROM development_spaces JOIN worktrees ON worktrees.id = development_spaces.worktree_id
    WHERE development_spaces.project_id = ?
    ORDER BY development_spaces.created_at ASC, development_spaces.id ASC
    LIMIT 1
  `).get(projectId);
  return fromSpace?.repository_identity ?? null;
}

function journalFenceDescription(entries) {
  const oldest = entries[0];
  return {
    source: 'journal',
    blockedCommandId: oldest.id,
    pendingCommandIds: entries.map((entry) => entry.id),
    operation: oldest.kind === 'workspace.reuse' ? 'reuse' : 'remove',
    state: oldest.state,
    projectId: oldest.project_id,
    spaceId: oldest.space_id,
    worktreeId: oldest.worktree_id,
    since: oldest.created_at,
    updatedAt: oldest.updated_at,
    effectObservedAt: null,
    lastErrorCode: oldest.state,
    executorCouldBeRunning: false,
    canAbandon: true,
  };
}

function fenceLock(db, repositoryIdentity) {
  const lock = db.prepare(
    'SELECT holder, operation, expires_at FROM repository_locks WHERE repository_identity = ?',
  ).get(repositoryIdentity);
  if (!lock) return null;
  return { holder: lock.holder, operation: lock.operation, expiresAt: lock.expires_at };
}

/**
 * Read-only description of the durable lifecycle fence held for a repository,
 * so the workbench can explain what is blocked and whether an abandon is
 * permitted. It reports facts only; it never releases anything.
 *
 * The reservation is not the only thing that refuses a write: sibling journal
 * rows keep `acquireRepositoryLock` closed even while a reservation exists, and
 * a persistent lock can outlive its command. Every one of those is named here,
 * because a console that answers "nothing is stuck" while writes are still
 * refused would be a second version of the original defect.
 */
export function describeWorkspaceLifecycleFence(db, repositoryIdentity) {
  const siblings = readJournalFenceCommands(db, repositoryIdentity);
  const lock = fenceLock(db, repositoryIdentity);
  const row = readReservationRow(db, repositoryIdentity);
  if (row) {
    const executorCouldBeRunning = reservationOwnerCouldBeExecuting(row);
    return {
      source: 'reservation',
      blockedCommandId: row.command_id,
      pendingCommandIds: [row.command_id, ...siblings.map((entry) => entry.id)],
      operation: row.operation,
      state: row.state,
      projectId: row.project_id,
      spaceId: row.space_id,
      worktreeId: row.worktree_id,
      since: row.started_at,
      updatedAt: row.updated_at,
      effectObservedAt: row.effect_observed_at,
      lastErrorCode: row.last_error_code,
      lock,
      executorCouldBeRunning,
      canAbandon: !executorCouldBeRunning,
    };
  }
  if (siblings.length > 0) return { ...journalFenceDescription(siblings), lock };
  if (lock) {
    // Observability only: an orphaned lock is named, but nothing here releases a
    // lock no command still answers for, and that path has not been shown to be
    // reachable in this codebase.
    return {
      source: 'lock',
      blockedCommandId: null,
      pendingCommandIds: [],
      operation: lock.operation,
      state: 'locked',
      projectId: null,
      spaceId: null,
      worktreeId: null,
      since: null,
      updatedAt: null,
      effectObservedAt: null,
      lastErrorCode: null,
      lock,
      executorCouldBeRunning: false,
      canAbandon: false,
    };
  }
  return null;
}

/**
 * The only supported exit from a stranded lifecycle fence.
 *
 * A lifecycle reservation exists so that a Git effect whose outcome was never
 * reconciled cannot race a second lifecycle operation. The reservation and the
 * persistent repository lock it holds are keyed on the *command*, and that
 * command's admission checks are frozen from the client's view — so once the
 * space moves on (a pause, an archive, any unrelated revision) the original
 * command can never finalise, no new command can take over, and every write
 * session in the repository stays blocked. Those durable rows have no TTL by
 * design; the escape has to be an explicit user decision.
 *
 * The abandon settles the layers in one transaction: the journal row, the
 * reservation where there is one, and the persistent repository lock that
 * command holds. It refuses while the recorded executor could still be running
 * in this process generation, and refuses while the worktree still has live
 * work; both of those refusals leave the request open so the same command can be
 * retried once the condition clears, instead of caching a permanent "no". The
 * code is never touched — the space goes to `attention` rather than `ready`,
 * because the Git effect did happen while its business outcome was not confirmed.
 *
 * A fence carried only by journal rows (two or more unsettled commands, or a
 * command that outlived its reservation) is settled the same way, one named
 * command at a time, because each unknown effect needs its own confirmation.
 */
export function abandonWorkspaceLifecycle(db, request = {}, options = {}) {
  const timestamp = iso(nowMillis(options));
  const { commandId, repositoryIdentity, blockedCommandId } = request;
  if (!isNonEmptyString(commandId) || !isNonEmptyString(repositoryIdentity)
    || !isNonEmptyString(blockedCommandId)) {
    return {
      ok: false, code: 'INVALID_REQUEST',
      outcome: 'confirmed_failure', state: 'failed', retryable: false,
    };
  }
  if (request.userConfirmed !== true) {
    return {
      ok: false,
      code: 'WORKSPACE_LIFECYCLE_CONFIRMATION_REQUIRED',
      commandId,
      blockedCommandId,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    };
  }

  const begun = beginCommand(db, {
    commandId,
    kind: 'workspace.lifecycle_abandon',
    request: { commandId, repositoryIdentity, blockedCommandId, userConfirmed: true },
  });
  if (begun.command.state === 'committed' || begun.command.state === 'failed') {
    return parseCommandResponse(begun.command);
  }

  return withImmediateTransaction(db, () => {
    const refusal = (code, extra = {}) => settleCommand(db, commandId, {
      ok: false,
      code,
      commandId,
      blockedCommandId,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
      ...extra,
    }, timestamp);
    const transient = (code, extra = {}) => ({
      ok: false,
      code,
      commandId,
      blockedCommandId,
      outcome: 'unknown',
      state: 'received',
      retryable: true,
      ...extra,
    });

    const row = readReservationRow(db, repositoryIdentity);
    if (row && row.command_id !== blockedCommandId) return refusal('WORKSPACE_LIFECYCLE_NOT_STUCK');
    if (!row) {
      const journal = readJournalFenceCommands(db, repositoryIdentity);
      if (!journal.some((entry) => entry.id === blockedCommandId)) {
        return refusal('WORKSPACE_LIFECYCLE_NOT_STUCK');
      }
    } else if (reservationOwnerCouldBeExecuting(row)) {
      return transient('WORKSPACE_LIFECYCLE_EXECUTING');
    }

    const journalTarget = row ? null : journalSpaceOf(db, blockedCommandId);
    const worktreeId = row?.worktree_id ?? journalTarget?.worktreeId ?? null;
    const spaceId = row?.space_id ?? journalTarget?.spaceId ?? null;

    if (worktreeId) {
      const activeWork = activeWorkOnWorktree(db, worktreeId);
      if (activeWork) {
        return transient(activeWork.code, {
          worktreeId,
          runId: activeWork.runId ?? null,
          assignmentId: activeWork.assignmentId ?? null,
        });
      }
    }

    settleCommand(db, blockedCommandId, {
      ok: false,
      code: 'WORKSPACE_LIFECYCLE_ABANDONED',
      commandId: blockedCommandId,
      abandonedByCommandId: commandId,
      outcome: 'confirmed_failure',
      state: 'failed',
      retryable: false,
    }, timestamp);

    if (row) {
      db.prepare('DELETE FROM workspace_lifecycle_reservations WHERE repository_identity = ?')
        .run(repositoryIdentity);
      // The worktree did change out from under any observation taken before this
      // point, so those observations must stop being usable as a baseline.
      db.prepare('UPDATE worktrees SET lifecycle_completed_at = ? WHERE id = ? AND lifecycle_epoch = ?')
        .run(timestamp, row.worktree_id, row.epoch);
    }

    const lock = db.prepare('SELECT * FROM repository_locks WHERE repository_identity = ?')
      .get(repositoryIdentity);
    let lockReleased = false;
    if (lock && (lock.holder === blockedCommandId
      || lock.holder === `workspace-lifecycle:${blockedCommandId}`)) {
      lockReleased = db.prepare(
        'DELETE FROM repository_locks WHERE repository_identity = ? AND holder = ? AND lock_id = ?',
      ).run(repositoryIdentity, lock.holder, lock.lock_id).changes === 1;
    }

    let spaceMarkedForAttention = false;
    if (spaceId) {
      spaceMarkedForAttention = db.prepare(`
        UPDATE development_spaces
        SET status = 'attention', status_reason = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND status <> 'archived'
      `).run('workspace_lifecycle_abandoned', timestamp, spaceId).changes === 1;
    }

    // Sibling journal rows and a lock that outlived its command keep the
    // repository closed after this one settles, so the receipt has to say so
    // rather than imply the fence is gone.
    const remaining = readJournalFenceCommands(db, repositoryIdentity);
    return commitCommand(db, commandId, {
      ok: true,
      commandId,
      repositoryIdentity,
      abandonedCommandId: blockedCommandId,
      fenceSource: row ? 'reservation' : 'journal',
      worktreeId,
      spaceId,
      lockReleased,
      spaceMarkedForAttention,
      remainingPendingCommandIds: remaining.map((entry) => entry.id),
      blockingLock: fenceLock(db, repositoryIdentity),
      updatedAt: timestamp,
    }, timestamp);
  });
}
