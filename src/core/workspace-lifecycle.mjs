import { randomUUID } from 'node:crypto';
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
 * command may reclaim it after the recorded executor process is gone.
 */
export function reserveWorkspaceLifecycle(db, request = {}, options = {}) {
  const timestamp = iso(nowMillis(options));
  const ownerToken = request.ownerToken ?? randomUUID();
  const ownerPid = request.ownerPid ?? process.pid;
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
      if (processIsAlive(current.owner_pid)) {
        return inProgress(current);
      }
      const reclaimed = db.prepare(`
        UPDATE workspace_lifecycle_reservations
        SET owner_pid = ?, owner_token = ?, state = 'executing', updated_at = ?,
            last_error_code = NULL
        WHERE repository_identity = ? AND command_id = ? AND owner_pid = ? AND owner_token = ?
      `).run(
        ownerPid,
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
        owner_pid, owner_token, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'executing', ?, ?, ?, ?, ?, ?, ?)
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
      SET owner_pid = 0, owner_token = ?, updated_at = ?
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
