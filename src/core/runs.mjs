import {
  beginCommand,
  canonicalJson,
  CommandConflictError,
  parseCommandResponse,
  readCommand,
  requestDigest,
} from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';
import { checkWorkspaceWriteAdmission } from './workspace-lifecycle.mjs';

function now() {
  return new Date().toISOString();
}

function deterministicId(prefix, source) {
  return `${prefix}_${source.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function terminalCommandResult(command) {
  if (command.state === 'committed' || command.state === 'failed') {
    return parseCommandResponse(command);
  }
  return null;
}

function failCommand(db, commandId, state, response) {
  db.prepare(`
    UPDATE commands SET state = 'failed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = ?
  `).run(canonicalJson(response), now(), commandId, state);
  return response;
}

function startIntent(request, runId) {
  const intent = { ...request, runId };
  delete intent.commandPayload;
  delete intent.baseline;
  return request.commandPayload ?? intent;
}

function finishIntent(request) {
  const intent = { ...request };
  delete intent.commandPayload;
  delete intent.finalSnapshot;
  return request.commandPayload ?? intent;
}

function assertFrozenIntent(command, intent) {
  if (command.request_digest !== requestDigest(intent)) {
    throw new CommandConflictError(
      `Command ${command.id} finalize payload does not match its frozen request.`,
    );
  }
  return JSON.parse(command.request_json);
}

export function startWriteRun(db, request, { faultInjector } = {}) {
  const {
    commandId,
    worktreeId,
    canonicalPath,
    repositoryIdentity,
    worktreeIdentity = worktreeId,
    agentClaim,
    goal,
    baseline,
  } = request;
  const runId = request.runId ?? deterministicId('run', commandId);
  const snapshotId = deterministicId('snapshot_baseline', runId);
  const commandRequest = startIntent(request, runId);
  const begun = beginCommand(db, {
    commandId,
    kind: 'run.start',
    request: commandRequest,
    runId,
  });
  const terminal = terminalCommandResult(begun.command);
  if (terminal) return terminal;

  const result = withImmediateTransaction(db, () => {
    const current = readCommand(db, commandId);
    const replay = terminalCommandResult(current);
    if (replay) return replay;
    assertFrozenIntent(current, commandRequest);

    const occupied = db
      .prepare('SELECT run_id FROM write_leases WHERE worktree_id = ?')
      .get(worktreeId);
    if (occupied) {
      const response = {
        ok: false,
        code: 'WRITE_LEASE_CONFLICT',
        message: '另一个 AI 正在编辑这份代码。你的代码没有被修改。',
        activeRunId: occupied.run_id,
      };
      return failCommand(db, commandId, 'received', response);
    }

    const createdAt = now();
    const existingPath = db
      .prepare('SELECT * FROM worktrees WHERE canonical_path = ?')
      .get(canonicalPath);
    if (
      existingPath
      && (
        existingPath.id !== worktreeId
        || existingPath.repository_identity !== repositoryIdentity
        || existingPath.identity_fingerprint !== worktreeIdentity
      )
    ) {
      return failCommand(db, commandId, 'received', {
        ok: false,
        code: 'WORKTREE_IDENTITY_CHANGED',
        runId,
      });
    }

    const lifecycleAdmission = checkWorkspaceWriteAdmission(db, {
      worktreeId,
      repositoryIdentity,
      baseline,
    });
    if (!lifecycleAdmission.ok) {
      if (lifecycleAdmission.retryable === false || lifecycleAdmission.outcome === 'confirmed_failure') {
        return failCommand(db, commandId, 'received', lifecycleAdmission);
      }
      return lifecycleAdmission;
    }
    db.prepare(`
      INSERT OR IGNORE INTO worktrees (
        id, canonical_path, repository_identity, identity_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(worktreeId, canonicalPath, repositoryIdentity, worktreeIdentity, createdAt);

    const worktree = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(worktreeId);
    if (
      !worktree
      || worktree.canonical_path !== canonicalPath
      || worktree.repository_identity !== repositoryIdentity
      || worktree.identity_fingerprint !== worktreeIdentity
    ) {
      throw new Error(`Worktree identity ${worktreeId} was rebound without validation.`);
    }
    db.prepare('UPDATE worktrees SET lease_generation = lease_generation + 1 WHERE id = ?')
      .run(worktreeId);
    const leaseGeneration = db
      .prepare('SELECT lease_generation FROM worktrees WHERE id = ?')
      .get(worktreeId).lease_generation;

    db.prepare(`
      INSERT INTO runs (
        id, worktree_id, mode, lifecycle, health, revision, lease_generation,
        agent_claim, goal, created_at
      ) VALUES (?, ?, 'write', 'active', 'healthy', 1, ?, ?, ?, ?)
    `).run(runId, worktreeId, leaseGeneration, agentClaim, goal, createdAt);
    faultInjector?.('start.after_run_insert');

    db.prepare(`
      INSERT INTO snapshots (
        id, run_id, phase, head, branch, index_fingerprint,
        worktree_fingerprint, repository_identity, worktree_identity,
        head_relation, coherence, observed_at, lifecycle_epoch
      ) VALUES (?, ?, 'baseline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      runId,
      baseline.head ?? null,
      baseline.branch ?? null,
      baseline.indexFingerprint ?? null,
      baseline.worktreeFingerprint ?? null,
      baseline.repositoryIdentity ?? repositoryIdentity,
      baseline.worktreeIdentity ?? worktreeIdentity,
      baseline.headRelation ?? 'same',
      baseline.coherence ?? 'unknown',
      baseline.observedAt ?? createdAt,
      worktree.lifecycle_epoch ?? 0,
    );
    faultInjector?.('start.after_snapshot_insert');

    db.prepare(`
      INSERT INTO write_leases (worktree_id, run_id, generation, acquired_at)
      VALUES (?, ?, ?, ?)
    `).run(worktreeId, runId, leaseGeneration, createdAt);
    faultInjector?.('start.after_lease_insert');

    const response = {
      ok: true,
      commandId,
      runId,
      revision: 1,
      status: 'active',
      health: 'healthy',
      leaseGeneration,
      baselineId: snapshotId,
    };
    db.prepare(`
      UPDATE commands
      SET state = 'committed', response_json = ?, run_id = ?, updated_at = ?
      WHERE id = ? AND state = 'received'
    `).run(canonicalJson(response), runId, now(), commandId);
    faultInjector?.('start.after_command_commit_before_transaction_commit');
    return response;
  });
  if (result.ok) faultInjector?.('start.after_transaction_commit_before_response');
  return result;
}

export function prepareFinish(db, request, options = {}) {
  const { commandId, runId } = request;
  const commandRequest = finishIntent(request);
  const begun = beginCommand(db, {
    commandId,
    kind: 'run.finish',
    request: commandRequest,
    runId,
    inTransaction: options.inTransaction === true,
  });
  const terminal = terminalCommandResult(begun.command);
  if (terminal) return { terminal: true, response: terminal };

  const operation = () => {
    const current = readCommand(db, commandId);
    const replay = terminalCommandResult(current);
    if (replay) return { terminal: true, response: replay };
    if (current.state === 'received') {
      db.prepare(`
        UPDATE commands SET state = 'observing', updated_at = ?
        WHERE id = ? AND state = 'received'
      `).run(now(), commandId);
    }
    return { terminal: false, state: 'observing' };
  };
  return options.inTransaction === true ? operation() : withImmediateTransaction(db, operation);
}

export function finalizeFinish(db, request, options = {}) {
  const { faultInjector } = options;
  const { commandId, runId, finalSnapshot } = request;
  const receiptId = deterministicId('receipt', runId);
  const snapshotId = deterministicId('snapshot_final', runId);

  const operation = () => {
    const command = readCommand(db, commandId);
    const replay = terminalCommandResult(command);
    if (replay) return replay;
    if (!command || command.state !== 'observing') {
      throw new Error(`Command ${commandId} is not ready to finalize.`);
    }
    const frozen = assertFrozenIntent(command, finishIntent(request));
    if (
      command.kind !== 'run.finish'
      || command.run_id !== runId
      || frozen.runId !== runId
    ) {
      throw new CommandConflictError(
        `Command ${commandId} cannot be finalized for a different Run.`,
      );
    }
    const {
      expectedRevision,
      leaseGeneration,
      outcome,
      summary = '',
      nextStep = '',
      commitRefs = [],
      acknowledgeUnattributed = false,
    } = frozen;

    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    const lease = db.prepare('SELECT * FROM write_leases WHERE run_id = ?').get(runId);
    const worktree = run
      ? db.prepare('SELECT * FROM worktrees WHERE id = ?').get(run.worktree_id)
      : null;
    const baseline = run
      ? db.prepare("SELECT * FROM snapshots WHERE run_id = ? AND phase = 'baseline'").get(runId)
      : null;
    if (
      run
      && (run.lease_generation !== leaseGeneration
        || !lease
        || lease.generation !== leaseGeneration)
    ) {
      const response = {
        ok: false,
        code: 'STALE_WRITE_LEASE',
        message: '这次 AI 工作会话已经被接管，旧会话不能再写入记录。',
        runId,
      };
      return failCommand(db, commandId, 'observing', response);
    }
    if (!run || run.lifecycle !== 'active' || run.revision !== expectedRevision) {
      const existingReceipt = db
        .prepare('SELECT * FROM handoff_receipts WHERE run_id = ?')
        .get(runId);
      const response = {
        ok: false,
        code: existingReceipt ? 'RUN_ALREADY_FINISHED' : 'RUN_REVISION_CONFLICT',
        runId,
        receiptId: existingReceipt?.id ?? null,
      };
      return failCommand(db, commandId, 'observing', response);
    }

    if (outcome === 'completed' && finalSnapshot.coherence !== 'coherent') {
      const response = {
        ok: false,
        code: 'INCOHERENT_FINAL_SNAPSHOT',
        message: '结束时代码仍在变化，暂未标记为完成。代码没有被修改。',
        runId,
      };
      return failCommand(db, commandId, 'observing', response);
    }

    if (
      !baseline
      || !worktree
      || !finalSnapshot.repositoryIdentity
      || !finalSnapshot.worktreeIdentity
      || finalSnapshot.repositoryIdentity !== worktree.repository_identity
      || finalSnapshot.worktreeIdentity !== worktree.identity_fingerprint
      || baseline.repository_identity !== finalSnapshot.repositoryIdentity
      || baseline.worktree_identity !== finalSnapshot.worktreeIdentity
    ) {
      return failCommand(db, commandId, 'observing', {
        ok: false,
        code: 'WORKTREE_IDENTITY_CHANGED',
        runId,
      });
    }

    if (outcome === 'completed' && baseline.branch !== finalSnapshot.branch) {
      return failCommand(db, commandId, 'observing', {
        ok: false,
        code: 'BRANCH_CHANGED_DURING_RUN',
        runId,
      });
    }

    if (
      outcome === 'completed'
      && baseline.head !== finalSnapshot.head
      && (
        finalSnapshot.headRelation !== 'descendant'
        || !Array.isArray(commitRefs)
        || !commitRefs.includes(finalSnapshot.head)
      )
    ) {
      return failCommand(db, commandId, 'observing', {
        ok: false,
        code: 'FOREIGN_HEAD_CHANGE',
        runId,
      });
    }

    const hasUnattributedChanges = (
      baseline.index_fingerprint !== finalSnapshot.indexFingerprint
      || baseline.worktree_fingerprint !== finalSnapshot.worktreeFingerprint
    );
    if (outcome === 'completed' && hasUnattributedChanges && acknowledgeUnattributed !== true) {
      return failCommand(db, commandId, 'observing', {
        ok: false,
        code: 'UNATTRIBUTED_CHANGES_REQUIRE_CONFIRMATION',
        runId,
      });
    }

    const finishedAt = now();
    db.prepare(`
      INSERT INTO snapshots (
        id, run_id, phase, head, branch, index_fingerprint,
        worktree_fingerprint, repository_identity, worktree_identity,
        head_relation, coherence, observed_at, lifecycle_epoch
      ) VALUES (?, ?, 'final', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      runId,
      finalSnapshot.head ?? null,
      finalSnapshot.branch ?? null,
      finalSnapshot.indexFingerprint ?? null,
      finalSnapshot.worktreeFingerprint ?? null,
      finalSnapshot.repositoryIdentity,
      finalSnapshot.worktreeIdentity,
      finalSnapshot.headRelation ?? 'unknown',
      finalSnapshot.coherence ?? 'unknown',
      finalSnapshot.observedAt ?? finishedAt,
      worktree.lifecycle_epoch ?? 0,
    );
    faultInjector?.('finish.after_snapshot_insert');

    const payload = {
      schemaVersion: 1,
      runId,
      outcome,
      summary,
      nextStep,
      commitRefs,
      changeAttribution: hasUnattributedChanges
        ? 'unattributed_acknowledged'
        : 'no_detected_change',
      finalSnapshotId: snapshotId,
    };
    db.prepare(`
      INSERT INTO handoff_receipts (
        id, run_id, finish_command_id, final_snapshot_id,
        outcome, summary, next_step, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      runId,
      commandId,
      snapshotId,
      outcome,
      summary,
      nextStep,
      canonicalJson(payload),
      finishedAt,
    );
    faultInjector?.('finish.after_receipt_insert');

    const lifecycle = outcome;
    const updated = db.prepare(`
      UPDATE runs
      SET lifecycle = ?, revision = revision + 1, finished_at = ?
      WHERE id = ? AND lifecycle = 'active' AND revision = ?
    `).run(lifecycle, finishedAt, runId, expectedRevision);
    if (updated.changes !== 1) {
      throw new Error('Run CAS failed while finalizing.');
    }
    faultInjector?.('finish.after_run_cas');
    db.prepare('DELETE FROM write_leases WHERE run_id = ?').run(runId);
    faultInjector?.('finish.after_lease_release');

    const response = {
      ok: true,
      commandId,
      runId,
      receiptId,
      revision: expectedRevision + 1,
      status: lifecycle,
    };
    db.prepare(`
      UPDATE commands
      SET state = 'committed', response_json = ?, receipt_id = ?, updated_at = ?
      WHERE id = ? AND state = 'observing'
    `).run(canonicalJson(response), receiptId, finishedAt, commandId);
    faultInjector?.('finish.after_command_commit_before_transaction_commit');
    return response;
  };
  const result = options.inTransaction === true ? operation() : withImmediateTransaction(db, operation);
  if (result.ok && options.inTransaction !== true) {
    faultInjector?.('finish.after_transaction_commit_before_response');
  }
  return result;
}

export function finishRun(db, request, options = {}) {
  const prepared = prepareFinish(db, request, options);
  if (prepared.terminal) return prepared.response;
  return finalizeFinish(db, request, options);
}

export function heartbeatWriteRun(db, request) {
  const { commandId, runId, expectedRevision, leaseGeneration } = request;
  const begun = beginCommand(db, {
    commandId,
    kind: 'run.heartbeat',
    request,
    runId,
  });
  const terminal = terminalCommandResult(begun.command);
  if (terminal) return terminal;

  return withImmediateTransaction(db, () => {
    const current = readCommand(db, commandId);
    const replay = terminalCommandResult(current);
    if (replay) return replay;
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    const lease = db.prepare('SELECT * FROM write_leases WHERE run_id = ?').get(runId);
    let response;
    if (!run || !lease || run.lease_generation !== leaseGeneration || lease.generation !== leaseGeneration) {
      response = { ok: false, code: 'STALE_WRITE_LEASE', runId };
    } else if (run.lifecycle !== 'active' || run.revision !== expectedRevision) {
      response = { ok: false, code: 'RUN_REVISION_CONFLICT', runId, revision: run.revision };
    } else {
      const heartbeatAt = now();
      db.prepare(`
        UPDATE runs SET revision = revision + 1, last_heartbeat_at = ?
        WHERE id = ? AND revision = ? AND lifecycle = 'active'
      `).run(heartbeatAt, runId, expectedRevision);
      response = {
        ok: true,
        commandId,
        runId,
        revision: expectedRevision + 1,
        leaseGeneration,
        recentActivityAt: heartbeatAt,
      };
    }
    db.prepare(`
      UPDATE commands SET state = ?, response_json = ?, updated_at = ?
      WHERE id = ? AND state = 'received'
    `).run(response.ok ? 'committed' : 'failed', canonicalJson(response), now(), commandId);
    return response;
  });
}

export function takeoverWriteRun(db, request) {
  const {
    commandId,
    worktreeId,
    previousRunId,
    expectedPreviousRevision,
    newRunId = deterministicId('run', commandId),
    agentClaim,
    goal,
    baseline,
    userConfirmed,
  } = request;
  const commandRequest = { ...request, newRunId };
  const begun = beginCommand(db, {
    commandId,
    kind: 'run.takeover',
    request: commandRequest,
    runId: newRunId,
  });
  const terminal = terminalCommandResult(begun.command);
  if (terminal) return terminal;

  return withImmediateTransaction(db, () => {
    const current = readCommand(db, commandId);
    const replay = terminalCommandResult(current);
    if (replay) return replay;
    if (userConfirmed !== true) {
      const response = {
        ok: false,
        code: 'USER_CONFIRMATION_REQUIRED',
        message: '接管会停止旧 AI 的写入权限，需要你确认。',
      };
      db.prepare(`
        UPDATE commands SET state = 'failed', response_json = ?, updated_at = ?
        WHERE id = ? AND state = 'received'
      `).run(canonicalJson(response), now(), commandId);
      return response;
    }

    const takeoverWorktree = db.prepare(`
      SELECT repository_identity FROM worktrees WHERE id = ?
    `).get(worktreeId);
    const lifecycleAdmission = checkWorkspaceWriteAdmission(db, {
      worktreeId,
      repositoryIdentity: takeoverWorktree?.repository_identity,
      baseline,
    });
    if (!lifecycleAdmission.ok) {
      if (lifecycleAdmission.retryable === false || lifecycleAdmission.outcome === 'confirmed_failure') {
        return failCommand(db, commandId, 'received', lifecycleAdmission);
      }
      return lifecycleAdmission;
    }

    const lease = db.prepare('SELECT * FROM write_leases WHERE worktree_id = ?').get(worktreeId);
    const previous = db.prepare('SELECT * FROM runs WHERE id = ?').get(previousRunId);
    if (
      !lease
      || !previous
      || lease.run_id !== previousRunId
      || previous.lifecycle !== 'active'
      || previous.revision !== expectedPreviousRevision
    ) {
      const response = { ok: false, code: 'TAKEOVER_CONFLICT', previousRunId };
      db.prepare(`
        UPDATE commands SET state = 'failed', response_json = ?, updated_at = ?
        WHERE id = ? AND state = 'received'
      `).run(canonicalJson(response), now(), commandId);
      return response;
    }

    const changedAt = now();
    db.prepare(`
      UPDATE runs
      SET lifecycle = 'superseded', revision = revision + 1, finished_at = ?
      WHERE id = ? AND lifecycle = 'active' AND revision = ?
    `).run(changedAt, previousRunId, expectedPreviousRevision);
    db.prepare('UPDATE worktrees SET lease_generation = lease_generation + 1 WHERE id = ?')
      .run(worktreeId);
    const leaseGeneration = db
      .prepare('SELECT lease_generation FROM worktrees WHERE id = ?')
      .get(worktreeId).lease_generation;
    const worktree = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(worktreeId);
    const snapshotId = deterministicId('snapshot_baseline', newRunId);
    db.prepare(`
      INSERT INTO runs (
        id, worktree_id, mode, lifecycle, health, revision, lease_generation,
        agent_claim, goal, created_at
      ) VALUES (?, ?, 'write', 'active', 'healthy', 1, ?, ?, ?, ?)
    `).run(newRunId, worktreeId, leaseGeneration, agentClaim, goal, changedAt);
    db.prepare(`
      INSERT INTO snapshots (
        id, run_id, phase, head, branch, index_fingerprint,
        worktree_fingerprint, repository_identity, worktree_identity,
        head_relation, coherence, observed_at, lifecycle_epoch
      ) VALUES (?, ?, 'baseline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      newRunId,
      baseline.head ?? null,
      baseline.branch ?? null,
      baseline.indexFingerprint ?? null,
      baseline.worktreeFingerprint ?? null,
      baseline.repositoryIdentity ?? worktree.repository_identity,
      baseline.worktreeIdentity ?? worktree.identity_fingerprint,
      baseline.headRelation ?? 'same',
      baseline.coherence ?? 'unknown',
      baseline.observedAt ?? changedAt,
      worktree.lifecycle_epoch ?? 0,
    );
    db.prepare(`
      UPDATE write_leases
      SET run_id = ?, generation = ?, acquired_at = ?
      WHERE worktree_id = ? AND run_id = ?
    `).run(newRunId, leaseGeneration, changedAt, worktreeId, previousRunId);
    const response = {
      ok: true,
      commandId,
      runId: newRunId,
      previousRunId,
      leaseGeneration,
      revision: 1,
      status: 'active',
    };
    db.prepare(`
      UPDATE commands
      SET state = 'committed', response_json = ?, run_id = ?, updated_at = ?
      WHERE id = ? AND state = 'received'
    `).run(canonicalJson(response), newRunId, changedAt, commandId);
    return response;
  });
}

// User-confirmed escape hatch for an orphaned write lease on an *unmanaged*
// legacy run: the previous writer's process is gone without a finish, and no
// assignment, conversation binding, or transfer record exists for the session,
// so the owner declares the run abandoned. Managed work chains must go through
// the workbench transfer protocol instead of this release. Mirrors
// finalizeFinish's lease release (terminal run + lease delete) with the same
// revision/lease-generation fencing as heartbeat, but creates no receipt
// because the code state was never re-observed. The confirmation, the managed
// refusal, and every outcome land in the command journal, matching the
// takeover precedent.
export function releaseOrphanedWriteRun(db, request, { faultInjector } = {}) {
  const { commandId, runId, expectedRevision, leaseGeneration, userConfirmed } = request;
  const begun = beginCommand(db, {
    commandId,
    kind: 'run.release',
    request,
    runId,
  });
  const terminal = terminalCommandResult(begun.command);
  if (terminal) return terminal;

  return withImmediateTransaction(db, () => {
    const current = readCommand(db, commandId);
    const replay = terminalCommandResult(current);
    if (replay) return replay;
    let response;
    if (userConfirmed !== true) {
      response = {
        ok: false,
        code: 'RUN_LEASE_CONFIRMATION_REQUIRED',
        message: '释放残留的写入锁需要你明确确认。',
      };
    } else if (db.prepare('SELECT 1 AS managed FROM assignments WHERE session_id = ?').get(runId)) {
      // conversation_bindings and conversation_transfers both reference
      // assignments(session_id) under foreign_keys=ON, so one assignment row
      // means the session sits in a managed chain (possibly with a pending or
      // frozen transfer) that only the workbench transfer protocol may resolve.
      response = { ok: false, code: 'RUN_LEASE_MANAGED_SESSION', runId };
    } else {
      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
      if (!run || run.lifecycle !== 'active') {
        response = { ok: false, code: 'RUN_NOT_FOUND', runId };
      } else if (
        run.revision !== expectedRevision
        || run.lease_generation !== leaseGeneration
      ) {
        response = { ok: false, code: 'STALE_WRITE_LEASE', runId };
      } else {
        const releasedAt = now();
        const updated = db.prepare(`
          UPDATE runs
          SET lifecycle = 'abandoned', revision = revision + 1, finished_at = ?
          WHERE id = ? AND lifecycle = 'active' AND revision = ? AND lease_generation = ?
        `).run(releasedAt, runId, expectedRevision, leaseGeneration);
        if (updated.changes !== 1) {
          throw new Error('Run CAS failed while releasing the write lease.');
        }
        faultInjector?.('release.after_run_cas');
        db.prepare('DELETE FROM write_leases WHERE run_id = ? AND generation = ?')
          .run(runId, leaseGeneration);
        faultInjector?.('release.after_lease_release');
        response = {
          ok: true,
          commandId,
          runId,
          status: 'abandoned',
          revision: expectedRevision + 1,
        };
      }
    }
    db.prepare(`
      UPDATE commands SET state = ?, response_json = ?, updated_at = ?
      WHERE id = ? AND state = 'received'
    `).run(response.ok ? 'committed' : 'failed', canonicalJson(response), now(), commandId);
    faultInjector?.('release.after_command_commit_before_transaction_commit');
    return response;
  });
}
