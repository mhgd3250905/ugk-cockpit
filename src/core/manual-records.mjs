import { createHash } from 'node:crypto';
import {
  beginCommand,
  canonicalJson,
  parseCommandResponse,
  readCommand,
} from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';

export const MANUAL_RECORD_ERROR_CODES = Object.freeze({
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROJECT_ARCHIVE_REVISION_CONFLICT: 'PROJECT_ARCHIVE_REVISION_CONFLICT',
  WORK_LINE_NOT_FOUND: 'WORK_LINE_NOT_FOUND',
  MAIN_WORK_LINE_NOT_CLOSABLE: 'MAIN_WORK_LINE_NOT_CLOSABLE',
  WORK_LINE_REVISION_CONFLICT: 'WORK_LINE_REVISION_CONFLICT',
  COMMAND_CONFLICT: 'COMMAND_CONFLICT',
});

export const WORK_LINE_EVENT_KINDS = Object.freeze({
  close: 'work_line_closed',
  reopen: 'work_line_reopened',
});

function now() {
  return new Date().toISOString();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidRequest(message) {
  return { ok: false, code: 'INVALID_REQUEST', message };
}

function failCommand(db, commandId, response, timestamp = now()) {
  db.prepare(`
    UPDATE commands SET state = 'failed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), timestamp, commandId);
  return response;
}

function commitCommand(db, commandId, response, timestamp = now()) {
  db.prepare(`
    UPDATE commands SET state = 'committed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), timestamp, commandId);
  return response;
}

function terminalCommandResponse(db, commandId) {
  const command = readCommand(db, commandId);
  if (command?.state === 'committed' || command?.state === 'failed') {
    return parseCommandResponse(command);
  }
  return null;
}

function validateProjectArchiveRequest(request) {
  if (!isNonEmptyString(request?.commandId)
    || !isNonEmptyString(request?.projectId)
    || !Number.isSafeInteger(request?.expectedRevision)
    || request.expectedRevision < 0
    || typeof request.archived !== 'boolean') {
    return invalidRequest('commandId, projectId, expectedRevision, and archived are required.');
  }
  return null;
}

function validateWorkLineRequest(request) {
  if (!isNonEmptyString(request?.commandId)
    || !isNonEmptyString(request?.projectId)
    || !isNonEmptyString(request?.worktreeId)
    || !Number.isSafeInteger(request?.expectedRevision)
    || request.expectedRevision < 0
    || typeof request.closed !== 'boolean') {
    return invalidRequest('commandId, projectId, worktreeId, expectedRevision, and closed are required.');
  }
  return null;
}

function projectArchiveView(row) {
  return {
    id: row.id,
    name: row.name,
    stage: row.stage,
    status: row.status,
    statusReason: row.status_reason,
    archived: row.archived_at !== null,
    archivedAt: row.archived_at ?? null,
    archiveRevision: row.archive_revision,
    updatedAt: row.updated_at,
  };
}

function projectArchiveConflict(projectId, expectedRevision, row) {
  return {
    ok: false,
    code: MANUAL_RECORD_ERROR_CODES.PROJECT_ARCHIVE_REVISION_CONFLICT,
    projectId,
    expectedRevision,
    currentRevision: row.archive_revision,
    archiveRevision: row.archive_revision,
    archived: row.archived_at !== null,
    archivedAt: row.archived_at ?? null,
  };
}

/**
 * Set the user's archive state for a project. Archive state has its own CAS
 * revision and does not change the project's stage, status, or code records.
 */
export function setProjectArchived(db, request = {}) {
  const invalid = validateProjectArchiveRequest(request);
  if (invalid) return invalid;

  const { commandId, projectId, expectedRevision, archived } = request;
  const frozenRequest = { commandId, projectId, expectedRevision, archived };
  const begun = beginCommand(db, {
    commandId,
    kind: 'project.archive',
    request: frozenRequest,
  });
  if (begun.command.state === 'committed' || begun.command.state === 'failed') {
    return parseCommandResponse(begun.command);
  }

  return withImmediateTransaction(db, () => {
    const replay = terminalCommandResponse(db, commandId);
    if (replay) return replay;

    const current = db.prepare(`
      SELECT id, name, stage, status, status_reason,
             archived_at, archive_revision, updated_at
      FROM projects
      WHERE id = ?
    `).get(projectId);
    if (!current) {
      return failCommand(db, commandId, {
        ok: false,
        code: MANUAL_RECORD_ERROR_CODES.PROJECT_NOT_FOUND,
        projectId,
      });
    }

    if (current.archive_revision !== expectedRevision) {
      return failCommand(db, commandId, projectArchiveConflict(projectId, expectedRevision, current));
    }

    const currentArchived = current.archived_at !== null;
    if (currentArchived === archived) {
      const response = {
        ok: true,
        commandId,
        projectId,
        archived,
        archivedAt: current.archived_at ?? null,
        archiveRevision: current.archive_revision,
        updatedAt: current.updated_at,
        changed: false,
        project: projectArchiveView(current),
      };
      return commitCommand(db, commandId, response, current.updated_at);
    }

    const timestamp = now();
    const nextRevision = current.archive_revision + 1;
    const archivedAt = archived ? timestamp : null;
    const update = db.prepare(`
      UPDATE projects
      SET archived_at = ?, archive_revision = ?, updated_at = ?
      WHERE id = ? AND archive_revision = ?
    `).run(archivedAt, nextRevision, timestamp, projectId, expectedRevision);
    if (update.changes !== 1) {
      const latest = db.prepare(`
        SELECT id, name, stage, status, status_reason,
               archived_at, archive_revision, updated_at
        FROM projects
        WHERE id = ?
      `).get(projectId);
      return failCommand(db, commandId, latest
        ? projectArchiveConflict(projectId, expectedRevision, latest)
        : { ok: false, code: MANUAL_RECORD_ERROR_CODES.PROJECT_NOT_FOUND, projectId }, timestamp);
    }

    const updated = { ...current, archived_at: archivedAt, archive_revision: nextRevision, updated_at: timestamp };
    const response = {
      ok: true,
      commandId,
      projectId,
      archived,
      archivedAt,
      archiveRevision: nextRevision,
      updatedAt: timestamp,
      changed: true,
      project: projectArchiveView(updated),
    };
    return commitCommand(db, commandId, response, timestamp);
  });
}

function manualEventId(commandId) {
  return `work_line_event_${createHash('sha256').update(commandId).digest('hex').slice(0, 32)}`;
}

function readProject(db, projectId) {
  return db.prepare('SELECT id, worktree_id FROM projects WHERE id = ?').get(projectId) ?? null;
}

function isRegisteredWorkLine(db, projectId, worktreeId) {
  return Boolean(db.prepare(`
    SELECT 1 AS registered
    FROM development_spaces
    WHERE project_id = ? AND worktree_id = ?
    UNION
    SELECT 1 AS registered
    FROM delivery_sources
    WHERE project_id = ? AND worktree_id = ?
    LIMIT 1
  `).get(projectId, worktreeId, projectId, worktreeId));
}

function readStoredWorkLineState(db, projectId, worktreeId) {
  return db.prepare(`
    SELECT project_id, worktree_id, status, revision, updated_at
    FROM work_line_states
    WHERE project_id = ? AND worktree_id = ?
  `).get(projectId, worktreeId) ?? null;
}

function mapWorkLineState(projectId, row, defaults = {}) {
  return {
    projectId,
    worktreeId: row?.worktree_id ?? defaults.worktreeId,
    status: row?.status ?? defaults.status ?? 'open',
    revision: row?.revision ?? defaults.revision ?? 0,
    updatedAt: row?.updated_at ?? defaults.updatedAt ?? null,
  };
}

function appendWorkLineEvent(db, {
  projectId,
  worktreeId,
  event,
  revision,
  commandId,
  timestamp,
}) {
  const eventId = manualEventId(commandId);
  db.prepare(`
    INSERT INTO work_line_events (
      id, project_id, worktree_id, event, revision, actor, command_id, created_at
    ) VALUES (?, ?, ?, ?, ?, 'user', ?, ?)
  `).run(eventId, projectId, worktreeId, event, revision, commandId, timestamp);
  return { eventId, eventKind: WORK_LINE_EVENT_KINDS[event] };
}

/**
 * Reopen a closed work line as part of another already-journaled command,
 * such as a successful workspace reuse. This helper deliberately does not
 * begin or commit a transaction and does not create a command row. Call it
 * from the caller's write transaction after the caller's command row exists.
 */
export function reopenWorkLineStateForReuse(db, {
  projectId,
  worktreeId,
  commandId,
  timestamp = now(),
} = {}) {
  if (!isNonEmptyString(projectId) || !isNonEmptyString(worktreeId) || !isNonEmptyString(commandId)) {
    return invalidRequest('projectId, worktreeId, and commandId are required.');
  }

  const project = readProject(db, projectId);
  if (!project) return { ok: false, code: MANUAL_RECORD_ERROR_CODES.PROJECT_NOT_FOUND, projectId, worktreeId };
  if (worktreeId === project.worktree_id) {
    return { ok: false, code: MANUAL_RECORD_ERROR_CODES.MAIN_WORK_LINE_NOT_CLOSABLE, projectId, worktreeId };
  }
  if (!isRegisteredWorkLine(db, projectId, worktreeId)) {
    return { ok: false, code: MANUAL_RECORD_ERROR_CODES.WORK_LINE_NOT_FOUND, projectId, worktreeId };
  }

  const stored = readStoredWorkLineState(db, projectId, worktreeId);
  const current = stored ?? {
    project_id: projectId,
    worktree_id: worktreeId,
    status: 'open',
    revision: 0,
    updated_at: null,
  };
  if (current.status !== 'closed') {
    return {
      ok: true,
      projectId,
      worktreeId,
      changed: false,
      state: mapWorkLineState(projectId, current),
      eventId: null,
      eventKind: null,
    };
  }

  const nextRevision = current.revision + 1;
  const update = db.prepare(`
    UPDATE work_line_states
    SET status = 'open', revision = ?, updated_at = ?
    WHERE project_id = ? AND worktree_id = ? AND revision = ? AND status = 'closed'
  `).run(nextRevision, timestamp, projectId, worktreeId, current.revision);
  if (update.changes !== 1) {
    const latest = readStoredWorkLineState(db, projectId, worktreeId);
    return latest
      ? workLineConflict(projectId, worktreeId, current.revision, latest)
      : { ok: false, code: MANUAL_RECORD_ERROR_CODES.WORK_LINE_NOT_FOUND, projectId, worktreeId };
  }

  const eventResult = appendWorkLineEvent(db, {
    projectId,
    worktreeId,
    event: 'reopen',
    revision: nextRevision,
    commandId,
    timestamp,
  });
  return {
    ok: true,
    projectId,
    worktreeId,
    changed: true,
    state: {
      projectId,
      worktreeId,
      status: 'open',
      revision: nextRevision,
      updatedAt: timestamp,
    },
    ...eventResult,
  };
}

function workLineConflict(projectId, worktreeId, expectedRevision, current) {
  return {
    ok: false,
    code: MANUAL_RECORD_ERROR_CODES.WORK_LINE_REVISION_CONFLICT,
    projectId,
    worktreeId,
    expectedRevision,
    currentRevision: current.revision,
    status: current.status,
    updatedAt: current.updated_at,
    state: mapWorkLineState(projectId, current),
  };
}

/**
 * Set a user's open/closed marker for one registered non-main work line.
 * This changes only Cockpit records; it never probes, checks out, removes, or
 * otherwise changes the referenced worktree.
 */
export function setWorkLineClosed(db, request = {}) {
  const invalid = validateWorkLineRequest(request);
  if (invalid) return invalid;

  const { commandId, projectId, worktreeId, expectedRevision, closed } = request;
  const frozenRequest = { commandId, projectId, worktreeId, expectedRevision, closed };
  const begun = beginCommand(db, {
    commandId,
    kind: 'work-line.state',
    request: frozenRequest,
  });
  if (begun.command.state === 'committed' || begun.command.state === 'failed') {
    return parseCommandResponse(begun.command);
  }

  return withImmediateTransaction(db, () => {
    const replay = terminalCommandResponse(db, commandId);
    if (replay) return replay;

    const project = readProject(db, projectId);
    if (!project) {
      return failCommand(db, commandId, {
        ok: false,
        code: MANUAL_RECORD_ERROR_CODES.PROJECT_NOT_FOUND,
        projectId,
        worktreeId,
      });
    }
    if (worktreeId === project.worktree_id) {
      return failCommand(db, commandId, {
        ok: false,
        code: MANUAL_RECORD_ERROR_CODES.MAIN_WORK_LINE_NOT_CLOSABLE,
        projectId,
        worktreeId,
      });
    }
    if (!isRegisteredWorkLine(db, projectId, worktreeId)) {
      return failCommand(db, commandId, {
        ok: false,
        code: MANUAL_RECORD_ERROR_CODES.WORK_LINE_NOT_FOUND,
        projectId,
        worktreeId,
      });
    }

    const stored = readStoredWorkLineState(db, projectId, worktreeId);
    const current = stored ?? {
      project_id: projectId,
      worktree_id: worktreeId,
      status: 'open',
      revision: 0,
      updated_at: null,
    };
    if (current.revision !== expectedRevision) {
      return failCommand(db, commandId, workLineConflict(projectId, worktreeId, expectedRevision, current));
    }

    const nextStatus = closed ? 'closed' : 'open';
    if (current.status === nextStatus) {
      const state = mapWorkLineState(projectId, current);
      const response = {
        ok: true,
        commandId,
        projectId,
        worktreeId,
        closed,
        status: state.status,
        revision: state.revision,
        updatedAt: state.updatedAt,
        changed: false,
        eventId: null,
        eventKind: null,
        state,
      };
      return commitCommand(db, commandId, response, state.updatedAt ?? now());
    }

    const timestamp = now();
    const nextRevision = current.revision + 1;
    if (stored) {
      const update = db.prepare(`
        UPDATE work_line_states
        SET status = ?, revision = ?, updated_at = ?
        WHERE project_id = ? AND worktree_id = ? AND revision = ?
      `).run(nextStatus, nextRevision, timestamp, projectId, worktreeId, expectedRevision);
      if (update.changes !== 1) {
        const latest = readStoredWorkLineState(db, projectId, worktreeId);
        return failCommand(db, commandId, latest
          ? workLineConflict(projectId, worktreeId, expectedRevision, latest)
          : { ok: false, code: MANUAL_RECORD_ERROR_CODES.WORK_LINE_NOT_FOUND, projectId, worktreeId }, timestamp);
      }
    } else {
      db.prepare(`
        INSERT INTO work_line_states (project_id, worktree_id, status, revision, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(projectId, worktreeId, nextStatus, nextRevision, timestamp);
    }

    const event = closed ? 'close' : 'reopen';
    const eventResult = appendWorkLineEvent(db, {
      projectId,
      worktreeId,
      event,
      revision: nextRevision,
      commandId,
      timestamp,
    });

    const state = {
      projectId,
      worktreeId,
      status: nextStatus,
      revision: nextRevision,
      updatedAt: timestamp,
    };
    const response = {
      ok: true,
      commandId,
      projectId,
      worktreeId,
      closed,
      status: nextStatus,
      revision: nextRevision,
      updatedAt: timestamp,
      changed: true,
      ...eventResult,
      state,
    };
    return commitCommand(db, commandId, response, timestamp);
  });
}

/**
 * Read every registered non-main work line. A line without a manual state row
 * is exported as open at revision zero without creating a record on read.
 */
export function readWorkLineStates(db, projectId) {
  if (!isNonEmptyString(projectId)) return [];
  const project = readProject(db, projectId);
  if (!project) return [];

  const rows = db.prepare(`
    SELECT lines.worktree_id, states.status, states.revision, states.updated_at
    FROM (
      SELECT worktree_id
      FROM development_spaces
      WHERE project_id = ? AND worktree_id != ?
      UNION
      SELECT worktree_id
      FROM delivery_sources
      WHERE project_id = ? AND worktree_id != ?
    ) AS lines
    LEFT JOIN work_line_states AS states
      ON states.project_id = ? AND states.worktree_id = lines.worktree_id
    ORDER BY lines.worktree_id ASC
  `).all(projectId, project.worktree_id, projectId, project.worktree_id, projectId);
  return rows.map((row) => ({
    worktreeId: row.worktree_id,
    status: row.status ?? 'open',
    revision: row.revision ?? 0,
    updatedAt: row.updated_at ?? null,
  }));
}
