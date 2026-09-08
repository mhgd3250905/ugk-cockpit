const ACTIVE_ASSIGNMENT_STATES = new Set(['pending', 'accepted', 'active']);

const EVIDENCE_PRIORITY = new Map([
  ['workspace_reuse', 5],
  ['project_observation', 4],
  ['snapshot', 3],
  ['progress_event', 2],
  ['relay', 1],
]);

function nullableText(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseScope(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) return null;
  try {
    const value = JSON.parse(encoded);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function timeValue(value) {
  if (typeof value !== 'string' || value.length === 0) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareNewest(a, b) {
  const aTime = timeValue(a?.effectiveAt ?? a?.observedAt ?? a?.activityAt ?? a?.createdAt);
  const bTime = timeValue(b?.effectiveAt ?? b?.observedAt ?? b?.activityAt ?? b?.createdAt);
  if (aTime !== bTime) return bTime - aTime;

  const aPriority = EVIDENCE_PRIORITY.get(a?.source) ?? 0;
  const bPriority = EVIDENCE_PRIORITY.get(b?.source) ?? 0;
  if (aPriority !== bPriority) return bPriority - aPriority;

  return String(b?.recordId ?? b?.id ?? '').localeCompare(String(a?.recordId ?? a?.id ?? ''));
}

function latestValue(...values) {
  return values
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort((a, b) => timeValue(b) - timeValue(a))[0] ?? null;
}

function laneDirectoryName(canonicalPath) {
  if (typeof canonicalPath !== 'string') return null;
  return canonicalPath.split(/[\\/]/).filter(Boolean).at(-1) || null;
}

function laneMetadata({ role, laneKey, worktreeId, path, space = null, source = null }) {
  const name = role === 'main'
    ? '主项目'
    : role === 'development_space'
      ? nullableText(space?.name) ?? '通用开发空间'
      : role === 'delivery_source'
        ? `外部工作副本 · ${laneDirectoryName(path) ?? '已登记位置'}`
        : '来源未确认';

  return {
    laneKey,
    name,
    role,
    worktreeId: worktreeId ?? null,
    path: path ?? null,
    spaceId: space?.id ?? null,
    sourceId: source?.id ?? null,
    configuredBranch: space?.branch ?? null,
    baseCommit: space?.base_commit ?? null,
    lineStatus: space?.status ?? null,
    lineStatusReason: space?.status_reason ?? null,
    lineCreatedAt: space?.created_at ?? source?.created_at ?? null,
    lineUpdatedAt: space?.updated_at ?? null,
    archivedAt: space?.archived_at ?? null,
  };
}

function addLane(lanes, byWorktree, meta) {
  let laneKey = 'unknown';
  if (meta.role === 'main') {
    laneKey = 'main';
  } else if (meta.worktreeId) {
    laneKey = `${meta.role === 'development_space' ? 'space'
      : meta.role === 'delivery_source' ? 'source' : 'worktree'}:${meta.role === 'development_space'
      ? meta.space.id : meta.role === 'delivery_source' ? meta.source.id : meta.worktreeId}`;
  }

  const existing = lanes.find((lane) => lane.laneKey === laneKey);
  if (existing) return existing;

  const lane = laneMetadata({ ...meta, laneKey });
  lanes.push(lane);
  if (meta.worktreeId) byWorktree.set(meta.worktreeId, lane);
  return lane;
}

function addWorktreeLane(lanes, byWorktree, projectWorktreeId, row) {
  const worktreeId = row?.worktree_id ?? null;
  if (worktreeId && worktreeId === projectWorktreeId) return null;
  if (worktreeId && byWorktree.has(worktreeId)) return byWorktree.get(worktreeId);
  return addLane(lanes, byWorktree, {
    role: 'unknown',
    worktreeId,
    path: row?.canonical_path ?? null,
  });
}

function assignmentIsCurrent(assignment) {
  return Boolean(assignment && ACTIVE_ASSIGNMENT_STATES.has(assignment.status));
}

function candidateActivity(candidate) {
  return latestValue(
    candidate.run?.last_heartbeat_at,
    candidate.assignment?.last_heartbeat_at,
    candidate.run?.finished_at,
    candidate.assignment?.updated_at,
    candidate.assignment?.accepted_at,
    candidate.run?.created_at,
    candidate.assignment?.created_at,
  );
}

function candidateStartedAt(candidate) {
  return candidate?.run?.created_at
    ?? candidate?.assignment?.accepted_at
    ?? candidate?.assignment?.created_at
    ?? null;
}

function candidateStartedAfter(candidate, boundaryAt) {
  if (!boundaryAt) return true;
  const boundaryTime = timeValue(boundaryAt);
  const startedTime = timeValue(candidateStartedAt(candidate));
  return startedTime !== Number.NEGATIVE_INFINITY
    && boundaryTime !== Number.NEGATIVE_INFINITY
    && startedTime >= boundaryTime;
}

function candidateIsCurrent(candidate) {
  return candidate.run?.lifecycle === 'active' || assignmentIsCurrent(candidate.assignment);
}

function compareSessionCandidates(a, b) {
  const aCurrent = candidateIsCurrent(a) ? 1 : 0;
  const bCurrent = candidateIsCurrent(b) ? 1 : 0;
  if (aCurrent !== bCurrent) return bCurrent - aCurrent;

  const aTime = timeValue(candidateActivity(a));
  const bTime = timeValue(candidateActivity(b));
  if (aTime !== bTime) return bTime - aTime;

  return String(b.sessionId ?? b.assignment?.id ?? b.run?.id ?? '')
    .localeCompare(String(a.sessionId ?? a.assignment?.id ?? a.run?.id ?? ''));
}

function sessionCandidate(assignment, run = null) {
  const assignmentScope = parseScope(assignment?.scope_json);
  const assignmentRevision = assignment?.revision ?? null;
  const runRevision = run?.revision ?? null;
  const revision = assignment && run && assignmentRevision !== runRevision
    ? null
    : runRevision ?? assignmentRevision;

  return {
    assignment,
    run,
    sessionId: assignment?.session_id ?? run?.id ?? null,
    agent: nullableText(assignment?.agent_id) ?? nullableText(run?.agent_claim),
    goal: nullableText(assignment?.task_id) ?? nullableText(run?.goal),
    revision,
    assignmentRevision,
    runRevision,
    status: assignment?.status ?? null,
    lifecycle: run?.lifecycle ?? null,
    mode: run?.mode ?? assignmentScope?.mode ?? null,
  };
}

function readLatestSession(lane, assignments, runsById, reuseBoundaryAt = null) {
  const candidates = [];
  const addCandidate = (candidate) => {
    if (candidateStartedAfter(candidate, reuseBoundaryAt)) candidates.push(candidate);
  };
  for (const assignment of assignments.filter((row) => row.worktree_id === lane.worktreeId)) {
    const run = assignment.session_id
      ? runsById.get(assignment.session_id)?.worktree_id === assignment.worktree_id
        ? runsById.get(assignment.session_id)
        : null
      : null;
    addCandidate(sessionCandidate(assignment, run));
  }

  for (const run of runsById.values()) {
    if (run.worktree_id !== lane.worktreeId) continue;
    const hasExactAssignment = assignments.some((assignment) => (
      assignment.session_id === run.id && assignment.worktree_id === run.worktree_id
    ));
    if (!hasExactAssignment) addCandidate(sessionCandidate(null, run));
  }

  candidates.sort(compareSessionCandidates);
  return candidates[0] ?? null;
}

function hasGitEvidence(row, prefix = 'git_') {
  return Boolean(
    nullableText(row?.[`${prefix}head`])
      || nullableText(row?.[`${prefix}branch`])
      || nullableText(row?.[`${prefix}coherence`])
      || nullableText(row?.[`${prefix}observed_at`]),
  );
}

function snapshotEvidence(row) {
  return {
    source: 'snapshot',
    recordId: row.id,
    phase: nullableText(row.phase),
    sessionId: row.run_id ?? null,
    observedAt: row.observed_at ?? null,
    createdAt: row.observed_at ?? null,
    head: nullableText(row.head),
    branch: nullableText(row.branch),
    hasChanges: null,
    coherence: nullableText(row.coherence) ?? 'unknown',
  };
}

function projectObservationEvidence(row) {
  return {
    source: 'project_observation',
    recordId: row.id,
    phase: null,
    sessionId: null,
    observedAt: row.observed_at ?? null,
    createdAt: row.observed_at ?? null,
    head: nullableText(row.head),
    branch: nullableText(row.branch),
    hasChanges: row.has_changes === null || row.has_changes === undefined
      ? null
      : Boolean(row.has_changes),
    coherence: nullableText(row.coherence) ?? 'unknown',
  };
}

function eventEvidence(row, source) {
  return {
    source,
    recordId: row.id,
    phase: null,
    sessionId: row.session_id ?? null,
    observedAt: row.git_observed_at ?? null,
    createdAt: row.created_at ?? null,
    head: nullableText(row.git_head),
    branch: nullableText(row.git_branch),
    hasChanges: null,
    coherence: nullableText(row.git_coherence) ?? 'unknown',
  };
}

function evidenceIsAfterBoundary(evidence, boundaryAt) {
  if (!boundaryAt) return true;
  const evidenceTime = timeValue(evidence?.effectiveAt ?? evidence?.observedAt ?? evidence?.activityAt ?? evidence?.createdAt);
  const boundaryTime = timeValue(boundaryAt);
  return evidenceTime !== Number.NEGATIVE_INFINITY
    && boundaryTime !== Number.NEGATIVE_INFINITY
    && evidenceTime >= boundaryTime;
}

function addEvidence(evidenceByLane, lane, evidence, boundaryAt = null) {
  if (!lane || !evidence) return;
  if (!evidenceIsAfterBoundary(evidence, boundaryAt)) return;
  const existing = evidenceByLane.get(lane.laneKey);
  if (!existing || compareNewest(evidence, existing) < 0) {
    evidenceByLane.set(lane.laneKey, evidence);
  }
}

function parseObject(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) return null;
  try {
    const value = JSON.parse(encoded);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function hasResponseGitEvidence(git) {
  return Boolean(
    nullableText(git?.head)
      || nullableText(git?.branch)
      || typeof git?.hasChanges === 'boolean'
      || nullableText(git?.coherence)
      || nullableText(git?.observedAt),
  );
}

function workspaceReuseEvidence(row, response, boundaryAt) {
  const git = response?.git;
  if (!git || typeof git !== 'object' || Array.isArray(git) || !hasResponseGitEvidence(git)) return null;
  return {
    source: 'workspace_reuse',
    recordId: row.id,
    phase: null,
    sessionId: null,
    observedAt: nullableText(git.observedAt),
    // The committed space update is the operation's durable ordering point.
    // Git fields themselves are copied only when the receipt explicitly has
    // them; no field is inferred from the branch or space metadata.
    effectiveAt: boundaryAt,
    createdAt: boundaryAt,
    head: nullableText(git.head),
    branch: nullableText(git.branch),
    hasChanges: typeof git.hasChanges === 'boolean' ? git.hasChanges : null,
    coherence: nullableText(git.coherence) ?? 'unknown',
  };
}

function compareBoundaries(a, b) {
  const aTime = timeValue(a?.boundaryAt);
  const bTime = timeValue(b?.boundaryAt);
  if (aTime !== bTime) return bTime - aTime;
  return String(b?.commandId ?? '').localeCompare(String(a?.commandId ?? ''));
}

function readWorkspaceReuseMarkers(db, projectId, lanes) {
  const markers = new Map();
  const rows = db.prepare(`
    SELECT id, response_json, created_at, updated_at
    FROM commands
    WHERE kind = 'workspace.reuse' AND state = 'committed'
  `).all();

  for (const row of rows) {
    const response = parseObject(row.response_json);
    if (!response || response.ok !== true || response.projectId !== projectId) continue;
    if (typeof response.spaceId !== 'string' || response.spaceId.length === 0) continue;

    const responseSpace = response.space;
    if (!responseSpace || typeof responseSpace !== 'object' || Array.isArray(responseSpace)) continue;
    const responseWorktreeId = nullableText(responseSpace.worktreeId);
    const responseSpaceIds = [responseSpace.id, responseSpace.spaceId]
      .filter((value) => value !== undefined && value !== null);
    if (!responseWorktreeId || responseSpaceIds.some((value) => value !== response.spaceId)) continue;

    const lane = lanes.find((candidate) => (
      candidate.role === 'development_space'
        && candidate.spaceId === response.spaceId
        && candidate.worktreeId === responseWorktreeId
    ));
    const boundaryAt = nullableText(responseSpace.updatedAt);
    if (!lane || !boundaryAt || timeValue(boundaryAt) === Number.NEGATIVE_INFINITY) continue;

    const marker = {
      laneKey: lane.laneKey,
      commandId: row.id,
      boundaryAt,
      evidence: workspaceReuseEvidence(row, response, boundaryAt),
    };
    const existing = markers.get(lane.laneKey);
    if (!existing || compareBoundaries(marker, existing) < 0) markers.set(lane.laneKey, marker);
  }
  return markers;
}

function mapSession(candidate) {
  if (!candidate) return null;
  const activityAt = candidateActivity(candidate);
  return {
    id: candidate.sessionId,
    assignmentId: candidate.assignment?.id ?? null,
    runId: candidate.run?.id ?? null,
    agent: candidate.agent ?? null,
    goal: candidate.goal ?? null,
    status: candidate.status ?? null,
    lifecycle: candidate.lifecycle ?? null,
    active: candidateIsCurrent(candidate),
    mode: candidate.mode ?? null,
    revision: candidate.revision ?? null,
    assignmentRevision: candidate.assignmentRevision ?? null,
    runRevision: candidate.runRevision ?? null,
    startedAt: candidate.run?.created_at ?? candidate.assignment?.accepted_at ?? candidate.assignment?.created_at ?? null,
    lastActivityAt: activityAt,
    finishedAt: candidate.run?.finished_at ?? null,
  };
}

function mapGit(evidence) {
  return {
    head: evidence?.head ?? null,
    shortHead: evidence?.head ? evidence.head.slice(0, 7) : null,
    branch: evidence?.branch ?? null,
    // Progress, relay, and run snapshots do not store a has-changes
    // observation. Keep it null instead of inferring it from coherence or
    // fingerprints. Main project observations may provide the boolean.
    hasChanges: evidence?.hasChanges ?? null,
    coherence: evidence?.coherence ?? 'unknown',
    source: evidence?.source ?? 'unknown',
    sourceRecordId: evidence?.recordId ?? null,
    sourcePhase: evidence?.phase ?? null,
    observedAt: evidence?.observedAt ?? null,
  };
}

function mapLastCheck(evidence) {
  return {
    source: evidence?.source ?? 'unknown',
    recordId: evidence?.recordId ?? null,
    phase: evidence?.phase ?? null,
    sessionId: evidence?.sessionId ?? null,
    observedAt: evidence?.observedAt ?? null,
  };
}

/**
 * Read the durable, read-only context for every work line in a project. The
 * result is deliberately an array so callers can find a lane by its stable
 * timeline key (for example, `data.workLineContexts.find(({ laneKey }) =>
 * laneKey === selectedLaneKey)`):
 *
 * [{
 *   laneKey, name, role, worktreeId, path, spaceId, sourceId,
 *   currentAgent, currentGoal, sessionId, revision,
 *   session: { id, assignmentId, runId, agent, goal, status, lifecycle,
 *     active, mode, revision, assignmentRevision, runRevision,
 *     startedAt, lastActivityAt, finishedAt } | null,
 *   git: { head, shortHead, branch, hasChanges, coherence, source,
 *     sourceRecordId, sourcePhase, observedAt },
 *   lastObservedAt, lastCheck,
 *   configuredBranch, baseCommit, lineStatus, lineStatusReason,
 *   lineCreatedAt, lineUpdatedAt, archivedAt,
 * }]
 *
 * `main` is resolved from `projects.worktree_id` and has the same shape as
 * every other item. Every other lane is resolved by its exact worktree id,
 * with development spaces taking precedence over delivery sources and
 * unregistered worktrees. No filesystem or Git probe is performed.
 */
export function readWorkLineContexts(db, projectId) {
  if (typeof projectId !== 'string' || projectId.length === 0) return [];

  const project = db.prepare(`
    SELECT projects.id, projects.worktree_id, worktrees.canonical_path
    FROM projects
    LEFT JOIN worktrees ON worktrees.id = projects.worktree_id
    WHERE projects.id = ?
  `).get(projectId);
  if (!project) return [];

  const lanes = [];
  const byWorktree = new Map();

  addLane(lanes, byWorktree, {
    role: 'main',
    worktreeId: project.worktree_id,
    path: project.canonical_path,
  });

  const spaces = db.prepare(`
    SELECT development_spaces.id, development_spaces.name,
           development_spaces.branch, development_spaces.base_commit,
           development_spaces.worktree_id, development_spaces.status,
           development_spaces.status_reason, development_spaces.created_at,
           development_spaces.updated_at, development_spaces.archived_at,
           worktrees.canonical_path
    FROM development_spaces
    LEFT JOIN worktrees ON worktrees.id = development_spaces.worktree_id
    WHERE development_spaces.project_id = ?
    ORDER BY development_spaces.created_at ASC, development_spaces.id ASC
  `).all(projectId);
  for (const space of spaces) {
    if (space.worktree_id === project.worktree_id) continue;
    addLane(lanes, byWorktree, {
      role: 'development_space',
      worktreeId: space.worktree_id,
      path: space.canonical_path,
      space,
    });
  }

  const sources = db.prepare(`
    SELECT delivery_sources.id, delivery_sources.worktree_id,
           delivery_sources.created_at, worktrees.canonical_path
    FROM delivery_sources
    LEFT JOIN worktrees ON worktrees.id = delivery_sources.worktree_id
    WHERE delivery_sources.project_id = ?
    ORDER BY delivery_sources.created_at ASC, delivery_sources.id ASC
  `).all(projectId);
  for (const source of sources) {
    if (source.worktree_id === project.worktree_id || byWorktree.has(source.worktree_id)) continue;
    addLane(lanes, byWorktree, {
      role: 'delivery_source',
      worktreeId: source.worktree_id,
      path: source.canonical_path,
      source,
    });
  }

  const assignments = db.prepare(`
    SELECT assignments.*,
           worktrees.canonical_path
    FROM assignments
    LEFT JOIN worktrees ON worktrees.id = assignments.worktree_id
    WHERE assignments.project_id = ?
  `).all(projectId);
  for (const assignment of assignments) {
    addWorktreeLane(lanes, byWorktree, project.worktree_id, assignment);
  }

  const relayWorktrees = db.prepare(`
    SELECT DISTINCT relays.worktree_id, worktrees.canonical_path
    FROM relays
    LEFT JOIN worktrees ON worktrees.id = relays.worktree_id
    WHERE project_id = ?
  `).all(projectId);
  for (const relayWorktree of relayWorktrees) {
    addWorktreeLane(lanes, byWorktree, project.worktree_id, relayWorktree);
  }

  const worktreeIds = lanes.map((lane) => lane.worktreeId).filter(Boolean);
  const reuseMarkers = readWorkspaceReuseMarkers(db, projectId, lanes);
  const runs = worktreeIds.length === 0
    ? []
    : db.prepare(`
      SELECT *
      FROM runs
      WHERE worktree_id IN (${worktreeIds.map(() => '?').join(', ')})
    `).all(...worktreeIds);
  const runsById = new Map(runs.map((run) => [run.id, run]));

  const evidenceByLane = new Map();
  for (const row of db.prepare(`
    SELECT snapshots.*, runs.worktree_id
    FROM snapshots
    JOIN runs ON runs.id = snapshots.run_id
    WHERE runs.worktree_id IN (${worktreeIds.length ? worktreeIds.map(() => '?').join(', ') : "''"})
  `).all(...worktreeIds)) {
    const lane = byWorktree.get(row.worktree_id);
    addEvidence(
      evidenceByLane,
      lane,
      snapshotEvidence(row),
      reuseMarkers.get(lane?.laneKey)?.boundaryAt ?? null,
    );
  }

  const latestProjectObservation = db.prepare(`
    SELECT id, head, branch, has_changes, coherence, observed_at
    FROM project_observations
    WHERE project_id = ?
    ORDER BY observed_at DESC, id DESC
    LIMIT 1
  `).get(projectId);
  if (latestProjectObservation) {
    addEvidence(
      evidenceByLane,
      lanes.find((lane) => lane.laneKey === 'main'),
      projectObservationEvidence(latestProjectObservation),
    );
  }

  for (const marker of reuseMarkers.values()) {
    addEvidence(evidenceByLane, lanes.find((lane) => lane.laneKey === marker.laneKey), marker.evidence, marker.boundaryAt);
  }

  for (const row of db.prepare(`
    SELECT progress_events.*, assignments.worktree_id,
           assignments.project_id, assignments.session_id AS assignment_session_id
    FROM progress_events
    JOIN assignments ON assignments.id = progress_events.assignment_id
    WHERE assignments.project_id = ?
      AND progress_events.session_id = assignments.session_id
  `).all(projectId)) {
    if (!hasGitEvidence(row)) continue;
    const lane = byWorktree.get(row.worktree_id);
    addEvidence(
      evidenceByLane,
      lane,
      eventEvidence(row, 'progress_event'),
      reuseMarkers.get(lane?.laneKey)?.boundaryAt ?? null,
    );
  }

  for (const row of db.prepare(`
    SELECT relays.*, assignments.project_id AS assignment_project_id,
           assignments.worktree_id AS assignment_worktree_id,
           assignments.session_id AS assignment_session_id
    FROM relays
    LEFT JOIN assignments ON assignments.id = relays.assignment_id
    WHERE relays.project_id = ?
      AND assignments.project_id = relays.project_id
      AND assignments.worktree_id = relays.worktree_id
      AND assignments.session_id = relays.session_id
  `).all(projectId)) {
    if (!hasGitEvidence(row)) continue;
    const lane = byWorktree.get(row.worktree_id);
    addEvidence(
      evidenceByLane,
      lane,
      eventEvidence(row, 'relay'),
      reuseMarkers.get(lane?.laneKey)?.boundaryAt ?? null,
    );
  }

  return lanes.map((lane) => {
    const candidate = readLatestSession(
      lane,
      assignments,
      new Map([...runsById].filter(([, run]) => run.worktree_id === lane.worktreeId)),
      reuseMarkers.get(lane.laneKey)?.boundaryAt ?? null,
    );
    const session = mapSession(candidate);
    const evidence = evidenceByLane.get(lane.laneKey) ?? null;
    return {
      ...lane,
      currentAgent: candidate?.agent ?? null,
      currentGoal: candidate?.goal ?? null,
      sessionId: candidate?.sessionId ?? null,
      revision: candidate?.revision ?? null,
      assignmentId: candidate?.assignment?.id ?? null,
      runId: candidate?.run?.id ?? null,
      session,
      git: mapGit(evidence),
      lastObservedAt: evidence?.observedAt ?? null,
      lastCheck: mapLastCheck(evidence),
    };
  });
}
