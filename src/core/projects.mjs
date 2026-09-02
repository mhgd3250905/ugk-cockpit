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

export function readProjectContext(db, projectId) {
  return db.prepare(`
    SELECT projects.id, projects.name, projects.stage, projects.authorized_root,
           projects.repository_identity,
           projects.worktree_id, worktrees.canonical_path,
           worktrees.repository_identity AS worktree_repository_identity,
           worktrees.identity_fingerprint
    FROM projects
    JOIN worktrees ON worktrees.id = projects.worktree_id
    WHERE projects.id = ?
  `).get(projectId) ?? null;
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
    const projectInsert = db.prepare(`
      INSERT OR IGNORE INTO projects (
        id, name, stage, worktree_id, status, status_reason,
        last_observed_at, created_at, updated_at, authorized_root, repository_identity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      observation.repositoryIdentity,
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
      alreadyExists: projectInsert.changes === 0,
    };
    db.prepare(`
      UPDATE commands SET state = 'committed', response_json = ?, updated_at = ?
      WHERE id = ? AND state = 'received'
    `).run(canonicalJson(response), timestamp, commandId);
    return response;
  });
}

export function refreshProject(db, request) {
  const { commandId, projectId, observation } = request;
  const frozenRequest = {
    commandId,
    projectId,
    canonicalPath: observation.canonicalPath,
    repositoryIdentity: observation.repositoryIdentity,
    worktreeIdentity: observation.worktreeIdentity,
  };
  const begun = beginCommand(db, {
    commandId,
    kind: 'project.refresh',
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
    const project = readProjectContext(db, projectId);
    if (!project) {
      return failCommand(db, commandId, { ok: false, code: 'PROJECT_NOT_FOUND' });
    }
    if (
      project.canonical_path !== observation.canonicalPath
      || project.repository_identity !== observation.repositoryIdentity
      || project.identity_fingerprint !== observation.worktreeIdentity
    ) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'WORKTREE_IDENTITY_CHANGED',
        projectId,
      });
    }

    const hasChanges = observation.after.hasChanges ? 1 : 0;
    const status = project.stage === 'paused'
      ? 'paused'
      : (observation.coherence !== 'coherent' || hasChanges ? 'attention' : 'ready');
    const statusReason = project.stage === 'paused'
      ? 'user_paused'
      : (observation.coherence !== 'coherent'
        ? 'status_check_incomplete'
        : (hasChanges ? 'preexisting_changes' : 'ready_to_start'));
    const timestamp = now();
    db.prepare(`
      INSERT INTO project_observations (
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
      hasChanges,
      observation.coherence ?? 'unknown',
      observation.observedAt,
    );
    db.prepare(`
      UPDATE projects
      SET status = ?, status_reason = ?, last_observed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, statusReason, observation.observedAt, timestamp, projectId);
    const response = {
      ok: true,
      commandId,
      projectId,
      status,
      statusReason,
      observedAt: observation.observedAt,
      git: {
        head: observation.after.head ?? null,
        branch: observation.after.branch ?? null,
        hasChanges: Boolean(observation.after.hasChanges),
        coherence: observation.coherence ?? 'unknown',
      },
    };
    db.prepare(`
      UPDATE commands SET state = 'committed', response_json = ?, updated_at = ?
      WHERE id = ? AND state = 'received'
    `).run(canonicalJson(response), timestamp, commandId);
    return response;
  });
}

export function readDashboard(db) {
  const rows = db.prepare(`
    SELECT projects.id, projects.name, projects.stage,
           projects.last_observed_at, observations.has_changes,
           observations.coherence,
           worktrees.canonical_path,
           runs.id AS active_run_id, runs.agent_claim, runs.goal,
           runs.health AS run_health, runs.last_heartbeat_at,
           runs.revision AS run_revision, runs.lease_generation,
           runs.created_at AS run_started_at,
           last_runs.id AS last_run_id,
           last_runs.agent_claim AS last_agent_claim,
           last_runs.goal AS last_goal,
           last_runs.lifecycle AS last_outcome,
           last_runs.finished_at,
           receipts.summary AS last_summary,
           receipts.next_step AS last_next_step
    FROM projects
    JOIN worktrees ON worktrees.id = projects.worktree_id
    LEFT JOIN project_observations AS observations
      ON observations.id = (
        SELECT id FROM project_observations
        WHERE project_id = projects.id
        ORDER BY observed_at DESC LIMIT 1
      )
    LEFT JOIN runs ON runs.worktree_id = worktrees.id AND runs.lifecycle = 'active'
    LEFT JOIN runs AS last_runs ON last_runs.id = (
      SELECT id FROM runs AS history
      WHERE history.worktree_id = worktrees.id
        AND history.lifecycle IN ('completed', 'blocked', 'abandoned')
      ORDER BY history.finished_at DESC LIMIT 1
    )
    LEFT JOIN handoff_receipts AS receipts ON receipts.run_id = last_runs.id
    ORDER BY
      CASE
        WHEN observations.coherence != 'coherent' OR observations.has_changes = 1 THEN 0
        WHEN runs.id IS NOT NULL THEN 1
        WHEN projects.stage != 'paused' THEN 2 ELSE 3
      END,
      projects.updated_at DESC
  `).all();
  const activeAssignmentQuery = db.prepare(`
    SELECT * FROM assignments
    WHERE project_id = ? AND status IN ('pending', 'accepted', 'active')
    ORDER BY updated_at DESC LIMIT 1
  `);
  const lastProgressQuery = db.prepare(`
    SELECT status, note, revision, created_at FROM progress_events
    WHERE assignment_id = ? ORDER BY revision DESC LIMIT 1
  `);
  const latestHandoffQuery = db.prepare(`
    SELECT id, summary, next_session_focus, body_markdown, created_at
    FROM handoffs
    WHERE project_id = ?
    ORDER BY created_at DESC, sequence DESC, id DESC
    LIMIT 1
  `);
  const activeRelayQuery = db.prepare(`
    SELECT id, session_id, revision, next_session_focus,
           summary, expires_at, created_at
    FROM relays
    WHERE session_id = ? AND state = 'active' AND expires_at > ?
    ORDER BY created_at DESC, sequence DESC, id DESC
    LIMIT 1
  `);
  const nowAt = Date.now();
  return rows.map((row) => {
    const assignment = activeAssignmentQuery.get(row.id) ?? null;
    const lastProgress = assignment ? lastProgressQuery.get(assignment.id) ?? null : null;
    const latestHandoff = latestHandoffQuery.get(row.id) ?? null;
    const activeRelay = assignment?.session_id
      ? activeRelayQuery.get(assignment.session_id, nowAt) ?? null
      : null;
    const isWaiting = assignment?.status === 'accepted' && !row.active_run_id;
    const isWorking = Boolean(row.active_run_id || assignment?.status === 'active');
    const isRelayWaiting = Boolean(isWorking && activeRelay);
    const lastWork = row.last_run_id ? {
      runId: row.last_run_id,
      agentClaim: row.last_agent_claim,
      goal: row.last_goal,
      outcome: row.last_outcome,
      summary: row.last_summary,
      nextStep: row.last_next_step,
      finishedAt: row.finished_at,
    } : null;
    return {
      id: row.id,
      name: row.name,
      stage: row.stage,
      status: isWorking
        ? 'active'
        : (row.stage === 'paused'
          ? 'paused'
          : (row.coherence !== 'coherent' || row.has_changes ? 'attention' : 'ready')),
      statusReason: isWorking
        ? (isRelayWaiting
          ? 'relay_waiting'
          : 'active_work')
        : (isWaiting
          ? 'agent_waiting'
          : (assignment?.status === 'pending'
          ? 'assignment_waiting'
          : (row.coherence !== 'coherent'
            ? 'status_check_incomplete'
            : (row.has_changes ? 'preexisting_changes' : 'ready_to_start')))),
      lastObservedAt: row.last_observed_at,
      path: row.canonical_path,
      lastHandoffManual: latestHandoff ? {
        id: latestHandoff.id,
        summary: latestHandoff.summary,
        nextSessionFocus: latestHandoff.next_session_focus,
        markdown: latestHandoff.body_markdown,
        createdAt: latestHandoff.created_at,
      } : null,
      pendingAssignment: assignment?.status === 'pending' ? {
        id: assignment.id,
        agent: assignment.agent_id,
        task: assignment.task_id,
        mode: (() => {
          try {
            return JSON.parse(assignment.scope_json).mode ?? null;
          } catch {
            return null;
          }
        })(),
        expiresAt: db.prepare(`
          SELECT expires_at FROM dispatch_grants
          WHERE assignment_id = ? AND state = 'active'
          ORDER BY created_at DESC LIMIT 1
        `).get(assignment.id)?.expires_at ?? null,
      } : null,
      waitingAgent: isWaiting ? {
        assignmentId: assignment.id,
        sessionId: assignment.session_id,
        agent: assignment.agent_id,
        task: assignment.task_id,
        revision: assignment.revision,
        acceptedAt: assignment.accepted_at,
      } : null,
      activeWork: isWorking && assignment ? {
        assignmentId: assignment.id,
        sessionId: assignment.session_id,
        agent: assignment.agent_id,
        task: assignment.task_id,
        revision: assignment.revision,
        lastActivityAt: assignment.last_heartbeat_at ?? assignment.accepted_at,
        lastProgress: lastProgress ? {
          status: lastProgress.status,
          note: lastProgress.note,
          revision: lastProgress.revision,
          createdAt: lastProgress.created_at,
        } : null,
      } : null,
      activeRun: row.active_run_id ? {
        id: row.active_run_id,
        agentClaim: row.agent_claim,
        goal: row.goal,
        health: row.run_health,
        lastActivityAt: row.last_heartbeat_at,
        revision: row.run_revision,
        leaseGeneration: row.lease_generation,
        startedAt: row.run_started_at,
      } : null,
      activeRelay: activeRelay ? {
        relayId: activeRelay.id,
        sessionId: activeRelay.session_id,
        revision: activeRelay.revision,
        nextSessionFocus: activeRelay.next_session_focus,
        summary: activeRelay.summary,
        expiresAt: activeRelay.expires_at,
        createdAt: activeRelay.created_at,
      } : null,
      lastHandoff: lastWork,
      lastWork,
    };
  });
}
