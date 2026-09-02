import { createHash, randomUUID } from 'node:crypto';
import {
  beginCommand,
  canonicalJson,
  parseCommandResponse,
  readCommand,
} from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';

export const VALID_SPACE_STATUSES = new Set([
  'ready',
  'active',
  'busy',
  'integrating',
  'archived',
  'paused',
  'awaiting_review',
  'attention',
  'missing',
  'cleanup_ready',
]);

function now() {
  return new Date().toISOString();
}

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

function failCommand(db, commandId, response) {
  db.prepare(`
    UPDATE commands SET state = 'failed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), now(), commandId);
  return response;
}

function commitCommand(db, commandId, response, timestamp) {
  db.prepare(`
    UPDATE commands SET state = 'committed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), timestamp, commandId);
  return response;
}

export function spaceIdFor(projectIdOrWorktreeId, maybeWorktreeId) {
  const seed = maybeWorktreeId !== undefined
    ? `${projectIdOrWorktreeId}\0${maybeWorktreeId}`
    : `${projectIdOrWorktreeId}`;
  return `space_${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

function mapSpace(row, worktreeRow, projectRow) {
  if (!row) return null;
  return {
    id: row.id,
    spaceId: row.id,
    projectId: row.project_id,
    projectName: projectRow?.name ?? row.project_name ?? null,
    projectStage: projectRow?.stage ?? row.project_stage ?? null,
    name: row.name,
    branch: row.branch,
    baseCommit: row.base_commit,
    worktreeId: row.worktree_id,
    canonicalPath: worktreeRow?.canonical_path ?? row.canonical_path ?? null,
    repositoryIdentity: worktreeRow?.repository_identity ?? projectRow?.repository_identity ?? row.repository_identity ?? null,
    worktreeIdentity: worktreeRow?.identity_fingerprint ?? row.identity_fingerprint ?? null,
    status: row.status,
    statusReason: row.status_reason,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
  };
}

export function createDevelopmentSpace(db, request = {}, options = {}) {
  const projectId = request.projectId;
  const name = typeof request.name === 'string' ? request.name : '';
  const branch = request.branch;
  const baseCommit = request.baseCommit ?? request.base_commit;
  const worktreeId = request.worktreeId ?? request.worktree_id;
  const status = request.status ?? 'ready';
  const statusReason = request.statusReason ?? request.status_reason ?? 'created';
  const commandId = request.commandId;

  if (!isNonEmptyString(projectId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'projectId is required.' };
  }
  if (!isNonEmptyString(branch)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'branch is required.' };
  }
  if (!isNonEmptyString(baseCommit)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'baseCommit is required.' };
  }
  if (!isNonEmptyString(worktreeId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'worktreeId is required.' };
  }
  if (!VALID_SPACE_STATUSES.has(status)) {
    return { ok: false, code: 'INVALID_STATUS', message: `Invalid status: ${status}` };
  }

  const spaceId = request.spaceId ?? request.id ?? spaceIdFor(projectId, worktreeId);
  const timestamp = iso(nowMillis(options));

  const frozenRequest = {
    commandId,
    spaceId,
    projectId,
    name,
    branch,
    baseCommit,
    worktreeId,
    status,
    statusReason,
  };

  if (commandId) {
    const begun = beginCommand(db, {
      commandId,
      kind: 'space.create',
      request: frozenRequest,
    });
    if (begun.command.state === 'committed' || begun.command.state === 'failed') {
      return parseCommandResponse(begun.command);
    }
  }

  return withImmediateTransaction(db, () => {
    if (commandId) {
      const command = readCommand(db, commandId);
      if (command.state === 'committed' || command.state === 'failed') {
        return parseCommandResponse(command);
      }
    }

    const project = db.prepare('SELECT id, name, stage, worktree_id, repository_identity FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      const response = { ok: false, code: 'PROJECT_NOT_FOUND', projectId };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    let worktree = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(worktreeId);
    if (!worktree) {
      if (request.canonicalPath) {
        db.prepare(`
          INSERT INTO worktrees (
            id, canonical_path, repository_identity, identity_fingerprint, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          worktreeId,
          request.canonicalPath,
          request.repositoryIdentity ?? project.repository_identity,
          request.worktreeIdentity ?? worktreeId,
          timestamp,
        );
        worktree = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(worktreeId);
      } else {
        const response = { ok: false, code: 'WORKTREE_NOT_FOUND', worktreeId };
        if (commandId) failCommand(db, commandId, response);
        return response;
      }
    }

    if (worktree.repository_identity !== project.repository_identity) {
      const response = {
        ok: false,
        code: 'REPOSITORY_IDENTITY_MISMATCH',
        projectId,
        worktreeId,
        projectRepositoryIdentity: project.repository_identity,
        worktreeRepositoryIdentity: worktree.repository_identity,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    const existingWorktreeSpace = db.prepare('SELECT * FROM development_spaces WHERE worktree_id = ?').get(worktreeId);
    if (existingWorktreeSpace) {
      const same = existingWorktreeSpace.id === spaceId
        && existingWorktreeSpace.project_id === projectId
        && existingWorktreeSpace.name === name
        && existingWorktreeSpace.branch === branch
        && existingWorktreeSpace.base_commit === baseCommit;
      if (same) {
        const mapped = mapSpace(existingWorktreeSpace, worktree, project);
        const response = {
          ok: true,
          spaceId: existingWorktreeSpace.id,
          space: mapped,
          ...mapped,
          alreadyExists: true,
        };
        if (commandId) commitCommand(db, commandId, response, timestamp);
        return response;
      }
      const response = {
        ok: false,
        code: 'WORKTREE_ALREADY_IN_USE',
        worktreeId,
        spaceId: existingWorktreeSpace.id,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    const existingSpace = db.prepare('SELECT * FROM development_spaces WHERE id = ?').get(spaceId);
    if (existingSpace) {
      const response = { ok: false, code: 'SPACE_ID_CONFLICT', spaceId };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    db.prepare(`
      INSERT INTO development_spaces (
        id, project_id, name, branch, base_commit, worktree_id,
        status, status_reason, revision, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)
    `).run(
      spaceId,
      projectId,
      name,
      branch,
      baseCommit,
      worktreeId,
      status,
      statusReason,
      timestamp,
      timestamp,
    );

    const createdRow = db.prepare('SELECT * FROM development_spaces WHERE id = ?').get(spaceId);
    const mapped = mapSpace(createdRow, worktree, project);
    const response = {
      ok: true,
      spaceId,
      space: mapped,
      ...mapped,
    };
    if (commandId) commitCommand(db, commandId, response, timestamp);
    return response;
  });
}

export function readDevelopmentSpace(db, spaceId) {
  if (!isNonEmptyString(spaceId)) return null;
  const row = db.prepare(`
    SELECT development_spaces.*,
           worktrees.canonical_path, worktrees.repository_identity, worktrees.identity_fingerprint,
           projects.name AS project_name, projects.stage AS project_stage
    FROM development_spaces
    JOIN worktrees ON worktrees.id = development_spaces.worktree_id
    JOIN projects ON projects.id = development_spaces.project_id
    WHERE development_spaces.id = ?
  `).get(spaceId);
  return mapSpace(row);
}

export function readDevelopmentSpaceByWorktree(db, worktreeId) {
  if (!isNonEmptyString(worktreeId)) return null;
  const row = db.prepare(`
    SELECT id FROM development_spaces WHERE worktree_id = ?
  `).get(worktreeId);
  if (!row) return null;
  return readDevelopmentSpace(db, row.id);
}

export function listDevelopmentSpaces(db, options = {}) {
  const { projectId, status } = options;
  let sql = `
    SELECT development_spaces.*,
           worktrees.canonical_path, worktrees.repository_identity, worktrees.identity_fingerprint,
           projects.name AS project_name, projects.stage AS project_stage
    FROM development_spaces
    JOIN worktrees ON worktrees.id = development_spaces.worktree_id
    JOIN projects ON projects.id = development_spaces.project_id
    WHERE 1 = 1
  `;
  const params = [];
  if (isNonEmptyString(projectId)) {
    sql += ' AND development_spaces.project_id = ?';
    params.push(projectId);
  }
  if (isNonEmptyString(status)) {
    sql += ' AND development_spaces.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY development_spaces.created_at DESC, development_spaces.id DESC';

  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => mapSpace(row));
}

export function updateDevelopmentSpaceStatus(db, request = {}, options = {}) {
  const {
    commandId,
    spaceId,
    expectedRevision,
    status,
    statusReason = '',
  } = request;

  if (!isNonEmptyString(spaceId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'spaceId is required.' };
  }
  if (typeof expectedRevision !== 'number' || expectedRevision < 0) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'expectedRevision is required and must be a non-negative integer.' };
  }
  if (!isNonEmptyString(status) || !VALID_SPACE_STATUSES.has(status)) {
    return { ok: false, code: 'INVALID_STATUS', message: `Invalid status: ${status}` };
  }

  const timestamp = iso(nowMillis(options));
  const frozenRequest = {
    commandId,
    spaceId,
    expectedRevision,
    status,
    statusReason,
  };

  if (commandId) {
    const begun = beginCommand(db, {
      commandId,
      kind: 'space.update_status',
      request: frozenRequest,
    });
    if (begun.command.state === 'committed' || begun.command.state === 'failed') {
      return parseCommandResponse(begun.command);
    }
  }

  return withImmediateTransaction(db, () => {
    if (commandId) {
      const command = readCommand(db, commandId);
      if (command.state === 'committed' || command.state === 'failed') {
        return parseCommandResponse(command);
      }
    }

    const current = db.prepare('SELECT * FROM development_spaces WHERE id = ?').get(spaceId);
    if (!current) {
      const response = { ok: false, code: 'SPACE_NOT_FOUND', spaceId };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (current.revision !== expectedRevision) {
      const response = {
        ok: false,
        code: 'REVISION_CONFLICT',
        spaceId,
        currentRevision: current.revision,
        expectedRevision,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    const nextRevision = current.revision + 1;
    const archivedAt = status === 'archived'
      ? (current.archived_at ?? timestamp)
      : null;

    db.prepare(`
      UPDATE development_spaces
      SET status = ?, status_reason = ?, revision = ?, updated_at = ?, archived_at = ?
      WHERE id = ? AND revision = ?
    `).run(status, statusReason, nextRevision, timestamp, archivedAt, spaceId, expectedRevision);

    const updated = readDevelopmentSpace(db, spaceId);
    const response = {
      ok: true,
      spaceId,
      status,
      statusReason,
      revision: nextRevision,
      updatedAt: timestamp,
      archivedAt,
      space: updated,
    };
    if (commandId) commitCommand(db, commandId, response, timestamp);
    return response;
  });
}

export function archiveDevelopmentSpace(db, request = {}, options = {}) {
  return updateDevelopmentSpaceStatus(db, {
    ...request,
    status: 'archived',
    statusReason: request.statusReason ?? 'archived_by_user',
  }, options);
}
