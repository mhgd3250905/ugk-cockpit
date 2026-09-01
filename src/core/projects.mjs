import { createHash } from 'node:crypto';
import {
  beginCommand,
  canonicalJson,
  parseCommandResponse,
  readCommand,
} from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';

function now() {
  return new Date().toISOString();
}

export function projectIdFor(worktreeIdentity) {
  return `project_${createHash('sha256').update(worktreeIdentity).digest('hex').slice(0, 24)}`;
}

export function worktreeIdFor(worktreeIdentity) {
  return `worktree_${createHash('sha256').update(worktreeIdentity).digest('hex').slice(0, 24)}`;
}

function failCommand(db, commandId, response) {
  db.prepare(`
    UPDATE commands SET state = 'failed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), now(), commandId);
  return response;
}

export function registerProject(db, request) {
  const {
    commandId,
    name,
    stage = 'development',
    observation,
    authorizedRoot = observation.canonicalPath,
    grantId,
  } = request;
  const worktreeId = worktreeIdFor(observation.worktreeIdentity);
  const projectId = projectIdFor(observation.worktreeIdentity);
  const frozenRequest = {
    commandId,
    name,
    stage,
    canonicalPath: observation.canonicalPath,
    repositoryIdentity: observation.repositoryIdentity,
    worktreeIdentity: observation.worktreeIdentity,
    ...(grantId ? { grantId } : {}),
  };
  const begun = beginCommand(db, {
    commandId,
    kind: 'project.register',
    request: frozenRequest,
  });
  if (begun.command.state === 'committed' || begun.command.state === 'failed') {
    return parseCommandResponse(begun.command);
  }

  return withImmediateTransaction(db, () => {
    const command = readCommand(db, commandId);
    if (command.state === 'committed' || command.state === 'failed') {
      return parseCommandResponse(command);
    }
    const byPath = db.prepare(`
      SELECT id, repository_identity, identity_fingerprint
      FROM worktrees WHERE canonical_path = ?
    `).get(observation.canonicalPath);
    if (byPath && (
      byPath.repository_identity !== observation.repositoryIdentity
      || byPath.identity_fingerprint !== observation.worktreeIdentity
    )) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'WORKTREE_IDENTITY_CHANGED',
        projectId: null,
      });
    }

    const byIdentity = db.prepare(`
      SELECT id, canonical_path FROM worktrees WHERE identity_fingerprint = ?
    `).get(observation.worktreeIdentity);
    if (byIdentity && byIdentity.canonical_path !== observation.canonicalPath) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'PROJECT_LOCATION_CHANGED',
        projectId: null,
      });
    }

    const timestamp = now();
    db.prepare(`
      INSERT OR IGNORE INTO worktrees (
        id, canonical_path, repository_identity, identity_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      worktreeId,
      observation.canonicalPath,
      observation.repositoryIdentity,
      observation.worktreeIdentity,
      timestamp,
    );
    const status = stage === 'paused'
      ? 'paused'
      : (observation.after.hasChanges ? 'attention' : 'ready');
    const statusReason = stage === 'paused'
      ? 'user_paused'
      : (observation.after.hasChanges ? 'preexisting_changes' : 'ready_to_start');
    db.prepare(`
      INSERT OR IGNORE INTO projects (
        id, name, stage, worktree_id, status, status_reason,
        last_observed_at, created_at, updated_at, authorized_root
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      name,
      stage,
      worktreeId,
      status,
      statusReason,
      observation.observedAt,
      timestamp,
      timestamp,
      authorizedRoot,
    );
    db.prepare(`
      INSERT OR IGNORE INTO project_observations (
        id, project_id, head, branch, index_fingerprint, worktree_fingerprint,
        has_changes, coherence, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `project_observation_${commandId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      projectId,
      observation.after.head ?? null,
      observation.after.branch ?? null,
      observation.after.indexFingerprint ?? null,
      observation.after.worktreeFingerprint ?? null,
      observation.after.hasChanges ? 1 : 0,
      observation.coherence ?? 'unknown',
      observation.observedAt,
    );
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    const response = {
      ok: true,
      commandId,
      projectId,
      name: project.name,
      stage: project.stage,
      status: project.status,
      statusReason: project.status_reason,
    };
    db.prepare(`
      UPDATE commands SET state = 'committed', response_json = ?, updated_at = ?
      WHERE id = ? AND state = 'received'
    `).run(canonicalJson(response), timestamp, commandId);
    return response;
  });
}

export function readDashboard(db) {
  return db.prepare(`
    SELECT projects.id, projects.name, projects.stage,
           projects.last_observed_at, observations.has_changes,
           observations.coherence,
           worktrees.canonical_path,
           runs.id AS active_run_id, runs.agent_claim, runs.goal,
           runs.health AS run_health, runs.last_heartbeat_at
    FROM projects
    JOIN worktrees ON worktrees.id = projects.worktree_id
    LEFT JOIN project_observations AS observations
      ON observations.id = (
        SELECT id FROM project_observations
        WHERE project_id = projects.id
        ORDER BY observed_at DESC LIMIT 1
      )
    LEFT JOIN runs ON runs.worktree_id = worktrees.id AND runs.lifecycle = 'active'
    ORDER BY
      CASE
        WHEN runs.id IS NOT NULL AND runs.health = 'recovery_uncertain' THEN 0
        WHEN observations.coherence != 'coherent' OR observations.has_changes = 1 THEN 0
        WHEN runs.id IS NOT NULL THEN 1
        WHEN projects.stage != 'paused' THEN 2 ELSE 3
      END,
      projects.updated_at DESC
  `).all().map((row) => ({
    id: row.id,
    name: row.name,
    stage: row.stage,
    status: row.active_run_id
      ? 'active'
      : (row.stage === 'paused'
        ? 'paused'
        : (row.coherence !== 'coherent' || row.has_changes ? 'attention' : 'ready')),
    statusReason: row.active_run_id && row.run_health === 'recovery_uncertain'
      ? 'run_may_be_interrupted'
      : (row.coherence !== 'coherent'
        ? 'status_check_incomplete'
        : (row.has_changes ? 'preexisting_changes' : 'ready_to_start')),
    lastObservedAt: row.last_observed_at,
    path: row.canonical_path,
    activeRun: row.active_run_id ? {
      id: row.active_run_id,
      agentClaim: row.agent_claim,
      goal: row.goal,
      health: row.run_health,
      lastActivityAt: row.last_heartbeat_at,
    } : null,
  }));
}
