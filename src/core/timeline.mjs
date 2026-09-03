function parseJson(encoded, fallback) {
  try {
    return JSON.parse(encoded);
  } catch {
    return fallback;
  }
}

function truncateLegacyNote(note, maxLength = 80) {
  if (!note || typeof note !== 'string') return '';
  const trimmed = note.trim();
  if (trimmed.length <= maxLength) return trimmed;

  const candidate = trimmed.slice(0, maxLength);
  const punctuationRegex = /[。！？；\n\r.!?;\uff0c,]/g;
  let lastIndex = -1;
  let match;
  while ((match = punctuationRegex.exec(candidate)) !== null) {
    if (match.index >= 35) {
      lastIndex = match.index;
    }
  }
  if (lastIndex !== -1) {
    return candidate.slice(0, lastIndex + 1).trim() + '…';
  }
  return candidate.trim() + '…';
}

function timelineLaneResolver(db, projectId) {
  const project = db.prepare(`
    SELECT worktree_id
    FROM projects
    WHERE id = ?
  `).get(projectId) ?? null;
  const spaces = db.prepare(`
    SELECT id, name, branch, base_commit, worktree_id, created_at, archived_at
    FROM development_spaces
    WHERE project_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(projectId);
  const spaceByWorktree = new Map(spaces.map((space) => [space.worktree_id, space]));
  const sources = db.prepare(`
    SELECT d.id, d.worktree_id, w.canonical_path
    FROM delivery_sources d JOIN worktrees w ON w.id = d.worktree_id
    WHERE d.project_id = ?
  `).all(projectId);
  const sourceByWorktree = new Map(sources.map((source) => [source.worktree_id, source]));
  const lanes = new Map();

  function addLane(worktreeId) {
    if (worktreeId && worktreeId === project?.worktree_id) {
      const lane = {
        key: 'main',
        role: 'main',
        label: '主项目',
        worktreeId,
        spaceId: null,
        origin: null,
      };
      lanes.set(lane.key, lane);
      return lane;
    }

    const space = worktreeId ? spaceByWorktree.get(worktreeId) : null;
    if (space) {
      const lane = {
        key: `space:${space.id}`,
        role: 'development_space',
        label: space.name || '通用开发空间',
        worktreeId: space.worktree_id,
        spaceId: space.id,
        origin: {
          kind: 'development_space_created',
          createdAt: space.created_at,
          branch: space.branch ?? null,
          baseCommit: space.base_commit ?? null,
        },
      };
      lanes.set(lane.key, lane);
      return lane;
    }

    const source = sourceByWorktree.get(worktreeId);
    if (source) {
      const directoryName = source.canonical_path.split(/[\\/]/).filter(Boolean).at(-1);
      const lane = {
        key: `source:${source.id}`, role: 'delivery_source',
        label: `外部工作副本 · ${directoryName || '已登记位置'}`,
        worktreeId, spaceId: null, origin: null,
      };
      lanes.set(lane.key, lane);
      return lane;
    }
    const key = worktreeId ? `worktree:${worktreeId}` : 'unknown';
    const lane = {
      key,
      role: 'unknown',
      label: '来源未确认',
      worktreeId: worktreeId ?? null,
      spaceId: null,
      origin: null,
    };
    lanes.set(lane.key, lane);
    return lane;
  }

  if (project?.worktree_id) addLane(project.worktree_id);
  for (const space of spaces) addLane(space.worktree_id);

  return {
    forWorktree(worktreeId) {
      return addLane(worktreeId ?? null);
    },
    all() {
      return Array.from(lanes.values());
    },
  };
}

function attachTimelineLane(item, resolver) {
  const lane = resolver.forWorktree(item.worktreeId);
  return {
    ...item,
    laneKey: lane.key,
    laneRole: lane.role,
    laneLabel: lane.label,
    spaceId: lane.spaceId,
  };
}

/**
 * Read the reverse-chronological timeline of work events for a project.
 * Fixed node semantics:
 * - 'init': Project adoption & baseline
 * - 'progress': Meaningful checkpoints/progress notes
 * - 'relay': Mid-session conversational relays
 * - 'handoff': Stage completion handoffs
 * - 'integration': Main-project integration receipts with an integrated commit
 */
export function readProjectTimeline(db, projectId, { limit = 30, offset = 0 } = {}) {
  const laneResolver = timelineLaneResolver(db, projectId);
  const handoffRows = db.prepare(`
    SELECT h.id, h.sequence, h.assignment_id, h.project_id, h.worktree_id,
           h.session_id, h.run_id, h.client_request_id, h.expected_revision, h.revision,
           h.next_session_focus, h.summary, h.current_state, h.completed_items,
           h.pending_items, h.decisions, h.artifact_refs, h.risks, h.suggested_skills,
           h.body_markdown, h.created_at,
           a.agent_id, a.task_id,
           s.head AS snapshot_head, s.branch AS snapshot_branch,
           s.coherence AS snapshot_coherence, s.observed_at AS snapshot_observed_at
    FROM handoffs h
    LEFT JOIN assignments a ON a.id = h.assignment_id
    LEFT JOIN snapshots s ON (s.run_id = h.session_id OR s.run_id = h.run_id) AND s.phase = 'final'
    WHERE h.project_id = ?
  `).all(projectId);

  const handoffSessionIds = new Set(handoffRows.map((r) => r.session_id).filter(Boolean));
  const handoffRunIds = new Set(handoffRows.map((r) => r.run_id).filter(Boolean));

  const receiptRows = db.prepare(`
    SELECT hr.id AS receipt_id, hr.run_id, hr.outcome, hr.summary, hr.next_step,
           hr.payload_json, hr.created_at,
           r.worktree_id, r.agent_claim, r.goal, r.revision, r.created_at AS run_created_at, r.finished_at,
           s.head AS snapshot_head, s.branch AS snapshot_branch,
           s.coherence AS snapshot_coherence, s.observed_at AS snapshot_observed_at
    FROM handoff_receipts hr
    JOIN runs r ON r.id = hr.run_id
    JOIN projects p ON p.worktree_id = r.worktree_id
    LEFT JOIN snapshots s ON s.run_id = r.id AND s.phase = 'final'
    WHERE p.id = ?
  `).all(projectId).filter((r) => !handoffSessionIds.has(r.run_id) && !handoffRunIds.has(r.run_id));

  // An integration edge is safe to draw only from an append-only receipt that
  // says the source was integrated and records the resulting main commit.
  const integrationReceiptRows = db.prepare(`
    SELECT ir.id AS receipt_id, ir.submission_id, ir.project_id, ir.space_id,
           ir.source_commit, ir.target_head, ir.integrated_commit, ir.outcome,
           ir.summary, ir.payload_json, ir.created_at,
           s.source_worktree_id, s.target_worktree_id,
           s.source_branch, s.target_branch
    FROM integration_receipts ir
    JOIN submissions s ON s.id = ir.submission_id
    WHERE ir.project_id = ?
      AND ir.outcome = 'integrated'
      AND ir.integrated_commit IS NOT NULL
  `).all(projectId);

  const relayRows = db.prepare(`
    SELECT rel.id, rel.sequence, rel.assignment_id, rel.project_id, rel.worktree_id,
           rel.session_id, rel.run_id, rel.client_request_id, rel.expected_revision,
           rel.revision, rel.next_session_focus, rel.summary, rel.current_state,
           rel.completed_items, rel.pending_items, rel.decisions, rel.artifact_refs,
           rel.risks, rel.suggested_skills, rel.state, rel.created_at, rel.accepted_at,
           rel.git_head, rel.git_branch, rel.git_coherence, rel.git_observed_at,
           a.agent_id, a.task_id,
           r.agent_claim
    FROM relays rel
    LEFT JOIN assignments a ON a.id = rel.assignment_id
    LEFT JOIN runs r ON r.id = rel.session_id OR r.id = rel.run_id
    WHERE rel.project_id = ?
  `).all(projectId);

  const progressRows = db.prepare(`
    SELECT pe.id, pe.assignment_id, pe.session_id, pe.client_request_id,
           pe.expected_revision, pe.revision, pe.status, pe.summary, pe.details_json,
           pe.note, pe.git_head, pe.git_branch, pe.git_coherence, pe.git_observed_at,
           pe.created_at,
           a.worktree_id, a.agent_id, a.task_id,
           r.agent_claim
    FROM progress_events pe
    JOIN assignments a ON a.id = pe.assignment_id
    LEFT JOIN runs r ON r.id = pe.session_id
    WHERE a.project_id = ?
      AND pe.status NOT IN ('adopted', 'completed', 'blocked', 'abandoned', 'failed', 'cancelled')
  `).all(projectId);

  const assignmentRows = db.prepare(`
    SELECT a.id AS assignment_id, a.agent_id, a.task_id, a.scope_json, a.status AS assignment_status,
           a.worktree_id, a.session_id, a.revision AS assignment_revision, a.accepted_at, a.created_at,
           pe.note AS adopted_note, pe.created_at AS adopted_at,
           s.head AS baseline_head, s.branch AS baseline_branch,
           s.coherence AS baseline_coherence, s.observed_at AS baseline_observed_at,
           r.agent_claim, r.goal, r.created_at AS run_created_at
    FROM assignments a
    LEFT JOIN progress_events pe ON pe.assignment_id = a.id AND pe.status = 'adopted'
    LEFT JOIN snapshots s ON (s.run_id = a.session_id OR s.run_id = a.id) AND s.phase = 'baseline'
    LEFT JOIN runs r ON r.id = a.session_id
    WHERE a.project_id = ? AND (a.status != 'pending' OR a.session_id IS NOT NULL OR pe.id IS NOT NULL)
  `).all(projectId);

  const initSessionIds = new Set(assignmentRows.map((r) => r.session_id).filter(Boolean));

  const standaloneRuns = db.prepare(`
    SELECT r.id AS run_id, r.worktree_id, r.agent_claim, r.goal, r.created_at, r.revision,
           s.head AS baseline_head, s.branch AS baseline_branch,
           s.coherence AS baseline_coherence, s.observed_at AS baseline_observed_at
    FROM runs r
    JOIN projects p ON p.worktree_id = r.worktree_id
    LEFT JOIN snapshots s ON s.run_id = r.id AND s.phase = 'baseline'
    WHERE p.id = ?
  `).all(projectId).filter((r) => !initSessionIds.has(r.run_id));

  let submitNoteRows = [];
  try {
    submitNoteRows = db.prepare(`
      SELECT id, project_id, command_id, title, body, status, revision,
             source_json, references_json, handling_note, created_at, updated_at,
             handled_at, archived_at
      FROM submit_notes
      WHERE project_id = ?
    `).all(projectId);
  } catch (err) {
    if (!err.message?.includes('no such table')) throw err;
  }

  const handoffItems = handoffRows.map((row) => ({
    id: row.id,
    kind: 'handoff',
    typeLabel: '阶段交接',
    timestamp: row.created_at,
    agent: row.agent_id || null,
    worktreeId: row.worktree_id ?? null,
    revision: row.revision ?? 1,
    sequence: row.sequence ?? 1,
    git: (row.snapshot_branch || row.snapshot_head || row.snapshot_coherence || row.snapshot_observed_at) ? {
      branch: row.snapshot_branch ?? null,
      head: row.snapshot_head ?? null,
      shortHead: row.snapshot_head ? row.snapshot_head.slice(0, 7) : null,
      coherence: row.snapshot_coherence ?? 'unknown',
      observedAt: row.snapshot_observed_at ?? null,
    } : null,
    summary: row.summary,
    details: [],
    note: null,
    nextSessionFocus: row.next_session_focus || null,
    currentState: row.current_state || null,
    completedItems: parseJson(row.completed_items, []),
    pendingItems: parseJson(row.pending_items, []),
    decisions: parseJson(row.decisions, []),
    artifactRefs: parseJson(row.artifact_refs, []),
    risks: parseJson(row.risks, []),
    suggestedSkills: parseJson(row.suggested_skills, []),
    bodyMarkdown: row.body_markdown || null,
  }));

  const receiptItems = receiptRows.map((row) => ({
    id: `receipt_${row.receipt_id}`,
    kind: 'handoff',
    typeLabel: '阶段交接',
    timestamp: row.created_at || row.finished_at || row.run_created_at,
    agent: row.agent_claim || null,
    worktreeId: row.worktree_id ?? null,
    revision: row.revision ?? 1,
    sequence: 1,
    git: (row.snapshot_branch || row.snapshot_head || row.snapshot_coherence || row.snapshot_observed_at) ? {
      branch: row.snapshot_branch ?? null,
      head: row.snapshot_head ?? null,
      shortHead: row.snapshot_head ? row.snapshot_head.slice(0, 7) : null,
      coherence: row.snapshot_coherence ?? 'unknown',
      observedAt: row.snapshot_observed_at ?? null,
    } : null,
    summary: row.summary,
    details: [],
    note: null,
    nextSessionFocus: row.next_step || null,
    currentState: null,
    completedItems: [],
    pendingItems: [],
    decisions: [],
    artifactRefs: [],
    risks: [],
    suggestedSkills: [],
    bodyMarkdown: null,
  }));

  const mainWorktreeId = laneResolver.all().find((lane) => lane.role === 'main')?.worktreeId ?? null;
  const integrationItems = integrationReceiptRows
    .filter((row) => row.target_worktree_id === mainWorktreeId
      && row.source_worktree_id !== row.target_worktree_id)
    .map((row) => {
      const sourceLane = laneResolver.forWorktree(row.source_worktree_id);
      return {
        id: `integration_${row.receipt_id}`,
        kind: 'integration',
        typeLabel: '接入主项目',
        timestamp: row.created_at,
        agent: null,
        worktreeId: row.target_worktree_id,
        sourceWorktreeId: row.source_worktree_id,
        sourceLaneKey: sourceLane.key,
        targetWorktreeId: row.target_worktree_id,
        sourceBranch: row.source_branch ?? null,
        targetBranch: row.target_branch ?? null,
        sourceCommit: row.source_commit ?? null,
        targetHead: row.target_head ?? null,
        integratedCommit: row.integrated_commit,
        integrationReceiptId: row.receipt_id,
        revision: 1,
        sequence: 1,
        git: null,
        summary: row.summary || '已确认接入主项目',
        details: [],
        note: null,
        nextSessionFocus: null,
        currentState: '已由集成回执确认主项目接入',
        completedItems: [],
        pendingItems: [],
        decisions: [],
        artifactRefs: [],
        risks: [],
        suggestedSkills: [],
        bodyMarkdown: null,
      };
    });

  const relayItems = relayRows.map((row) => {
    const gitEvidence = (row.git_branch || row.git_head || row.git_coherence || row.git_observed_at) ? {
      branch: row.git_branch ?? null,
      head: row.git_head ?? null,
      shortHead: row.git_head ? row.git_head.slice(0, 7) : null,
      coherence: row.git_coherence ?? 'unknown',
      observedAt: row.git_observed_at ?? null,
    } : null;
    return {
      id: row.id,
      kind: 'relay',
      typeLabel: '聊天接力',
      timestamp: row.created_at,
      agent: row.agent_id || row.agent_claim || null,
      worktreeId: row.worktree_id ?? null,
      revision: row.revision ?? 1,
      sequence: row.sequence ?? 1,
      git: gitEvidence,
      state: row.state || 'active',
      acceptedAt: row.accepted_at || null,
      summary: row.summary,
      details: [],
      note: null,
      nextSessionFocus: row.next_session_focus || null,
      currentState: row.current_state || null,
      completedItems: parseJson(row.completed_items, []),
      pendingItems: parseJson(row.pending_items, []),
      decisions: parseJson(row.decisions, []),
      artifactRefs: parseJson(row.artifact_refs, []),
      risks: parseJson(row.risks, []),
      suggestedSkills: parseJson(row.suggested_skills, []),
      bodyMarkdown: null,
    };
  });

  const progressItems = progressRows.map((row) => {
    const details = parseJson(row.details_json, []);
    const isLegacy = !row.summary;
    const summary = row.summary || truncateLegacyNote(row.note, 80);
    const gitEvidence = (row.git_branch || row.git_head || row.git_coherence || row.git_observed_at) ? {
      branch: row.git_branch ?? null,
      head: row.git_head ?? null,
      shortHead: row.git_head ? row.git_head.slice(0, 7) : null,
      coherence: row.git_coherence ?? 'unknown',
      observedAt: row.git_observed_at ?? null,
    } : null;

    return {
      id: row.id,
      kind: 'progress',
      typeLabel: '工作进展',
      timestamp: row.created_at,
      agent: row.agent_id || row.agent_claim || null,
      worktreeId: row.worktree_id ?? null,
      revision: row.revision ?? 1,
      sequence: row.revision ?? 1,
      git: gitEvidence,
      summary,
      details: Array.isArray(details) ? details : [],
      note: row.note,
      isLegacyNote: isLegacy && row.note !== summary,
      nextSessionFocus: null,
      currentState: null,
      completedItems: [],
      pendingItems: [],
      decisions: [],
      artifactRefs: [],
      risks: [],
      suggestedSkills: [],
      bodyMarkdown: null,
    };
  });

  const initItems = [
    ...assignmentRows.map((row) => ({
      id: `init_${row.assignment_id}`,
      kind: 'init',
      typeLabel: '接入项目',
      timestamp: row.adopted_at || row.accepted_at || row.run_created_at || row.created_at,
      agent: row.agent_id || row.agent_claim || null,
      worktreeId: row.worktree_id ?? null,
      revision: 1,
      sequence: 1,
      git: (row.baseline_branch || row.baseline_head || row.baseline_coherence || row.baseline_observed_at) ? {
        branch: row.baseline_branch ?? null,
        head: row.baseline_head ?? null,
        shortHead: row.baseline_head ? row.baseline_head.slice(0, 7) : null,
        coherence: row.baseline_coherence ?? 'unknown',
        observedAt: row.baseline_observed_at ?? null,
      } : null,
      summary: row.task_id || row.goal || truncateLegacyNote(row.adopted_note, 80) || '接入项目与基线',
      note: row.adopted_note || null,
      nextSessionFocus: null,
      currentState: row.adopted_note || null,
      completedItems: [],
      pendingItems: [],
      decisions: [],
      artifactRefs: [],
      risks: [],
      suggestedSkills: [],
      bodyMarkdown: null,
    })),
    ...standaloneRuns.map((row) => ({
      id: `init_run_${row.run_id}`,
      kind: 'init',
      typeLabel: '接入项目',
      timestamp: row.created_at,
      agent: row.agent_claim || null,
      worktreeId: row.worktree_id ?? null,
      revision: 1,
      sequence: 1,
      git: (row.baseline_branch || row.baseline_head || row.baseline_coherence || row.baseline_observed_at) ? {
        branch: row.baseline_branch ?? null,
        head: row.baseline_head ?? null,
        shortHead: row.baseline_head ? row.baseline_head.slice(0, 7) : null,
        coherence: row.baseline_coherence ?? 'unknown',
        observedAt: row.baseline_observed_at ?? null,
      } : null,
      summary: row.goal || '接入项目与基线',
      note: null,
      nextSessionFocus: null,
      currentState: null,
      completedItems: [],
      pendingItems: [],
      decisions: [],
      artifactRefs: [],
      risks: [],
      suggestedSkills: [],
      bodyMarkdown: null,
    })),
  ];

  const submitNoteItems = submitNoteRows.map((row) => {
    const source = parseJson(row.source_json, {});
    const references = parseJson(row.references_json, []);
    const gitEvidence = (source.branch || source.head || source.observedAt) ? {
      branch: source.branch ?? null,
      head: source.head ?? null,
      shortHead: source.shortHead ?? (source.head ? source.head.slice(0, 7) : null),
      coherence: source.headUnconfirmed ? 'unconfirmed' : 'coherent',
      observedAt: source.observedAt ?? null,
    } : null;

    const agent = typeof source.attribution === 'object' && source.attribution?.agentId
      ? source.attribution.agentId
      : (source.attribution === 'unattributed' ? null : (source.attribution || null));

    const summary = row.title || truncateLegacyNote(row.body, 80) || '工作说明';

    return {
      id: row.id,
      kind: 'submit_note',
      typeLabel: '工作说明',
      timestamp: row.created_at,
      agent,
      worktreeId: source.worktreeId ?? null,
      // This is one immutable publication event, not a status-update event.
      revision: 1,
      sequence: 1,
      noteRevision: row.revision,
      git: gitEvidence,
      summary,
      details: [],
      note: row.body,
      nextSessionFocus: null,
      currentState: null,
      completedItems: [],
      pendingItems: [],
      decisions: [],
      artifactRefs: Array.isArray(references) ? references.map((r) => r.target).filter(Boolean) : [],
      risks: [],
      suggestedSkills: [],
      bodyMarkdown: row.body,
      noteId: row.id,
      title: row.title,
      body: row.body,
      status: row.status,
      handlingNote: row.handling_note,
      source,
      references,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      handledAt: row.handled_at,
      archivedAt: row.archived_at,
    };
  });

  const allItems = [
    ...initItems,
    ...progressItems,
    ...relayItems,
    ...handoffItems,
    ...receiptItems,
    ...integrationItems,
    ...submitNoteItems,
  ].map((item) => attachTimelineLane(item, laneResolver));

  // Sort only for display order. A branch name changing between adjacent
  // events is not evidence of a checkout, ancestry, or a cross-worktree
  // transition.
  allItems.sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime();
    const timeB = new Date(b.timestamp).getTime();
    if (timeA !== timeB) return timeA - timeB;
    const revA = Number(a.revision ?? 0);
    const revB = Number(b.revision ?? 0);
    if (revA !== revB) return revA - revB;
    const seqA = Number(a.sequence ?? 0);
    const seqB = Number(b.sequence ?? 0);
    if (seqA !== seqB) return seqA - seqB;
    return String(a.id).localeCompare(String(b.id));
  });

  // Reverse chronological sort (newest first)
  allItems.sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime();
    const timeB = new Date(b.timestamp).getTime();
    if (timeB !== timeA) return timeB - timeA;
    const revA = Number(a.revision ?? 0);
    const revB = Number(b.revision ?? 0);
    if (revB !== revA) return revB - revA;
    const seqA = Number(a.sequence ?? 0);
    const seqB = Number(b.sequence ?? 0);
    if (seqB !== seqA) return seqB - seqA;
    return String(b.id).localeCompare(String(a.id));
  });

  const total = allItems.length;
  const paged = allItems.slice(offset, offset + limit);
  const hasMore = offset + paged.length < total;
  const counts = new Map();
  for (const item of allItems) {
    counts.set(item.laneKey, (counts.get(item.laneKey) ?? 0) + 1);
  }
  const lanes = laneResolver.all().map((lane) => ({
    ...lane,
    eventCount: counts.get(lane.key) ?? 0,
  }));

  return {
    total,
    offset,
    limit,
    hasMore,
    lanes,
    items: paged,
  };
}

/**
 * Read the full detail of a project for the dialog view, including header metadata and timeline.
 */
export function readProjectDetail(db, projectId, options = {}) {
  const row = db.prepare(`
    SELECT projects.id, projects.name, projects.stage, projects.authorized_root,
           projects.last_observed_at, projects.status, projects.status_reason,
           projects.created_at, projects.updated_at,
           worktrees.canonical_path, worktrees.repository_identity, worktrees.identity_fingerprint,
           observations.head AS obs_head, observations.branch AS obs_branch,
           observations.has_changes AS obs_has_changes, observations.coherence AS obs_coherence,
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
        ORDER BY observed_at DESC, id DESC LIMIT 1
      )
    LEFT JOIN runs ON runs.worktree_id = worktrees.id AND runs.lifecycle = 'active'
    LEFT JOIN runs AS last_runs ON last_runs.id = (
      SELECT id FROM runs AS history
      WHERE history.worktree_id = worktrees.id
        AND history.lifecycle IN ('completed', 'blocked', 'abandoned')
      ORDER BY history.finished_at DESC, history.id DESC LIMIT 1
    )
    LEFT JOIN handoff_receipts AS receipts ON receipts.run_id = last_runs.id
    WHERE projects.id = ?
  `).get(projectId);

  if (!row) return null;

  const activeAssignment = db.prepare(`
    SELECT * FROM assignments
    WHERE project_id = ? AND status IN ('pending', 'accepted', 'active')
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get(projectId) ?? null;

  const lastProgress = activeAssignment ? db.prepare(`
    SELECT status, note, revision, created_at FROM progress_events
    WHERE assignment_id = ? ORDER BY revision DESC, id DESC LIMIT 1
  `).get(activeAssignment.id) ?? null : null;

  const latestHandoff = db.prepare(`
    SELECT id, summary, next_session_focus, body_markdown, created_at
    FROM handoffs
    WHERE project_id = ?
    ORDER BY created_at DESC, sequence DESC, id DESC
    LIMIT 1
  `).get(projectId) ?? null;

  const nowAt = Date.now();
  const activeRelay = activeAssignment?.session_id ? db.prepare(`
    SELECT id, session_id, revision, next_session_focus,
           summary, expires_at, created_at,
           git_head, git_branch, git_coherence, git_observed_at
    FROM relays
    WHERE session_id = ? AND state = 'active' AND expires_at > ?
    ORDER BY created_at DESC, sequence DESC, id DESC
    LIMIT 1
  `).get(activeAssignment.session_id, nowAt) ?? null : null;

  const isWaiting = activeAssignment?.status === 'accepted' && !row.active_run_id;
  const isWorking = Boolean(row.active_run_id || activeAssignment?.status === 'active');
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

  const project = {
    id: row.id,
    name: row.name,
    stage: row.stage,
    status: isWorking
      ? 'active'
      : (row.stage === 'paused'
        ? 'paused'
        : (row.obs_coherence !== 'coherent' || row.obs_has_changes ? 'attention' : 'ready')),
    statusReason: isWorking
      ? (isRelayWaiting ? 'relay_waiting' : 'active_work')
      : (isWaiting
        ? 'agent_waiting'
        : (activeAssignment?.status === 'pending'
          ? 'assignment_waiting'
          : (row.obs_coherence !== 'coherent'
            ? 'status_check_incomplete'
            : (row.obs_has_changes ? 'preexisting_changes' : 'ready_to_start')))),
    lastObservedAt: row.last_observed_at,
    path: row.canonical_path,
    authorizedRoot: row.authorized_root,
    git: {
      head: row.obs_head ?? null,
      shortHead: row.obs_head ? row.obs_head.slice(0, 7) : null,
      branch: row.obs_branch ?? null,
      hasChanges: Boolean(row.obs_has_changes),
      coherence: row.obs_coherence ?? 'unknown',
    },
    currentAgent: activeAssignment?.agent_id || row.agent_claim || row.last_agent_claim || null,
    currentGoal: activeAssignment?.task_id || row.goal || row.last_goal || null,
    lastHandoffManual: latestHandoff ? {
      id: latestHandoff.id,
      summary: latestHandoff.summary,
      nextSessionFocus: latestHandoff.next_session_focus,
      markdown: latestHandoff.body_markdown,
      createdAt: latestHandoff.created_at,
    } : null,
    pendingAssignment: activeAssignment?.status === 'pending' ? {
      id: activeAssignment.id,
      agent: activeAssignment.agent_id,
      task: activeAssignment.task_id,
      mode: (() => {
        try {
          return JSON.parse(activeAssignment.scope_json).mode ?? null;
        } catch {
          return null;
        }
      })(),
      expiresAt: db.prepare(`
        SELECT expires_at FROM dispatch_grants
        WHERE assignment_id = ? AND state = 'active'
        ORDER BY created_at DESC LIMIT 1
      `).get(activeAssignment.id)?.expires_at ?? null,
    } : null,
    waitingAgent: isWaiting ? {
      assignmentId: activeAssignment.id,
      sessionId: activeAssignment.session_id,
      agent: activeAssignment.agent_id,
      task: activeAssignment.task_id,
      revision: activeAssignment.revision,
      acceptedAt: activeAssignment.accepted_at,
    } : null,
    activeWork: isWorking && activeAssignment ? {
      assignmentId: activeAssignment.id,
      sessionId: activeAssignment.session_id,
      agent: activeAssignment.agent_id,
      task: activeAssignment.task_id,
      revision: activeAssignment.revision,
      lastActivityAt: activeAssignment.last_heartbeat_at ?? activeAssignment.accepted_at,
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
      git: (activeRelay.git_branch || activeRelay.git_head || activeRelay.git_coherence || activeRelay.git_observed_at) ? {
        branch: activeRelay.git_branch ?? null,
        head: activeRelay.git_head ?? null,
        shortHead: activeRelay.git_head ? activeRelay.git_head.slice(0, 7) : null,
        coherence: activeRelay.git_coherence ?? 'unknown',
        observedAt: activeRelay.git_observed_at ?? null,
      } : null,
      expiresAt: activeRelay.expires_at,
      createdAt: activeRelay.created_at,
    } : null,
    lastHandoff: lastWork,
    lastWork,
  };

  const timeline = readProjectTimeline(db, projectId, options);
  return { project, timeline };
}
