import {
  beginCommand,
  canonicalJson,
  parseCommandResponse,
} from './command-journal.mjs';
import { readSessionContext } from './assignments.mjs';
import {
  acquireRepositoryLock,
  createSubmission,
  releaseRepositoryLock,
} from './integrations.mjs';
import {
  readDevelopmentSpaceByWorktree,
  updateDevelopmentSpaceStatus,
} from './spaces.mjs';
import { probeGitWorktree } from '../git/probe.mjs';
import {
  choosePushRemote,
  createSubmissionCommit,
  ensureLocalCommitIdentity,
  hasUncommittedChanges,
  isCommitDescendant,
  isRecoverableSubmissionCommit,
  listGitRemotes,
  pushSubmissionBranch,
  readHeadMetadata,
  rejectUnsupportedSubmitFeatures,
  stageAllChanges,
} from '../git/submit-ops.mjs';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function nowMillis(options = {}) {
  const value = typeof options.clock === 'function' ? options.clock() : Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function now(options = {}) {
  return new Date(nowMillis(options)).toISOString();
}

function samePath(left, right) {
  if (!left || !right) return false;
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function failCommand(db, commandId, response, options = {}) {
  db.prepare(`
    UPDATE commands SET state = 'failed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), now(options), commandId);
  return response;
}

function commitCommand(db, commandId, response, options = {}) {
  db.prepare(`
    UPDATE commands SET state = 'committed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), now(options), commandId);
  return response;
}

function mapAttempt(row) {
  if (!row) return null;
  return {
    commandId: row.command_id,
    sessionId: row.session_id,
    assignmentRevision: row.assignment_revision,
    projectId: row.project_id,
    spaceId: row.space_id,
    sourceWorktreeId: row.source_worktree_id,
    targetWorktreeId: row.target_worktree_id,
    sourceBranch: row.source_branch,
    targetBranch: row.target_branch,
    startHead: row.start_head,
    targetHead: row.target_head,
    remoteName: row.remote_name,
    summary: row.summary,
    commitMessage: row.commit_message,
    state: row.state,
    sourceCommit: row.source_commit ?? null,
    submissionId: row.submission_id ?? null,
    lastErrorCode: row.last_error_code ?? null,
    lastErrorMessage: row.last_error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readSubmissionAttempt(db, commandId) {
  return mapAttempt(db.prepare('SELECT * FROM submission_attempts WHERE command_id = ?').get(commandId));
}

function updateAttempt(db, commandId, values, options = {}) {
  const fields = [];
  const params = [];
  for (const [column, value] of Object.entries(values)) {
    fields.push(`${column} = ?`);
    params.push(value);
  }
  fields.push('updated_at = ?');
  params.push(now(options), commandId);
  db.prepare(`UPDATE submission_attempts SET ${fields.join(', ')} WHERE command_id = ?`).run(...params);
  return readSubmissionAttempt(db, commandId);
}

function validateObservation(observation, expected, label) {
  const valid = observation
    && observation.coherence === 'coherent'
    && samePath(observation.canonicalPath, expected.canonicalPath)
    && observation.repositoryIdentity === expected.repositoryIdentity
    && observation.worktreeIdentity === expected.worktreeIdentity;
  if (!valid) {
    const error = new Error(`${label} code location no longer matches its platform record.`);
    error.code = `${label.toUpperCase()}_WORKTREE_CHANGED`;
    throw error;
  }
}

function retryableAttemptError(db, attempt, code, message, extra = {}, options = {}) {
  updateAttempt(db, attempt.commandId, {
    last_error_code: code,
    last_error_message: message,
  }, options);
  return {
    ok: false,
    code,
    message,
    commandId: attempt.commandId,
    attemptState: attempt.state,
    localSaved: attempt.state !== 'prepared',
    pushed: ['pushed', 'completed'].includes(attempt.state),
    retryable: true,
    ...extra,
  };
}

export async function submitDevelopmentSpace(db, request = {}, options = {}) {
  const { commandId, sessionId, expectedRevision } = request;
  const summary = typeof request.summary === 'string' ? request.summary.trim() : '';
  if (!isNonEmptyString(commandId)
    || !isNonEmptyString(sessionId)
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 1
    || !summary
    || summary.length > 160) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'commandId, sessionId, expectedRevision and summary are required.' };
  }

  const frozenRequest = { commandId, sessionId, expectedRevision, summary };
  const begun = beginCommand(db, {
    commandId,
    kind: 'development_space.submit',
    request: frozenRequest,
  });
  if (['committed', 'failed'].includes(begun.command.state)) {
    return parseCommandResponse(begun.command);
  }

  const context = readSessionContext(db, sessionId);
  if (!context.ok) return failCommand(db, commandId, context, options);
  let attempt = readSubmissionAttempt(db, commandId);
  if (!attempt && (
    context.status !== 'active'
    || context.run?.lifecycle !== 'active'
    || context.revision !== expectedRevision
  )) {
    return failCommand(db, commandId, {
      ok: false,
      code: context.revision !== expectedRevision ? 'REVISION_CONFLICT' : 'SESSION_NOT_ACTIVE',
      sessionId,
      currentRevision: context.revision,
      expectedRevision,
    }, options);
  }

  const space = readDevelopmentSpaceByWorktree(db, context.worktreeId);
  if (!space || space.projectId !== context.projectId || space.status === 'archived' || space.archivedAt) {
    return failCommand(db, commandId, {
      ok: false,
      code: 'DEVELOPMENT_SPACE_REQUIRED',
      message: 'Only a live managed development space can be submitted.',
    }, options);
  }

  const project = db.prepare(`
    SELECT projects.id, projects.worktree_id, projects.repository_identity,
           worktrees.canonical_path, worktrees.identity_fingerprint
    FROM projects
    JOIN worktrees ON worktrees.id = projects.worktree_id
    WHERE projects.id = ?
  `).get(context.projectId);
  if (!project || project.repository_identity !== context.repositoryIdentity) {
    return failCommand(db, commandId, { ok: false, code: 'PROJECT_BINDING_CHANGED' }, options);
  }

  const lockHolder = `submit:${commandId}`;
  const lock = acquireRepositoryLock(db, {
    repositoryIdentity: project.repository_identity,
    holder: lockHolder,
    operation: 'submit_development_space',
    ttlMs: options.lockTtlMs ?? 60_000,
  }, options);
  if (!lock.ok) {
    return { ok: false, code: 'REPOSITORY_LOCKED', retryable: true, localSaved: false, pushed: false };
  }

  const probe = options.probe ?? probeGitWorktree;
  try {
    if (!attempt) {
      let sourceObservation;
      let targetObservation;
      try {
        [sourceObservation, targetObservation] = await Promise.all([
          probe(context.canonicalPath),
          probe(project.canonical_path),
        ]);
        validateObservation(sourceObservation, {
          canonicalPath: context.canonicalPath,
          repositoryIdentity: context.repositoryIdentity,
          worktreeIdentity: context.worktreeIdentity,
        }, 'source');
        validateObservation(targetObservation, {
          canonicalPath: project.canonical_path,
          repositoryIdentity: project.repository_identity,
          worktreeIdentity: project.identity_fingerprint,
        }, 'target');
      } catch (error) {
        return failCommand(db, commandId, { ok: false, code: error.code ?? 'SUBMIT_PROBE_FAILED', message: error.message }, options);
      }
      if (sourceObservation.after.branch !== space.branch) {
        return failCommand(db, commandId, { ok: false, code: 'SOURCE_BRANCH_CHANGED' }, options);
      }
      const remotes = await (options.listGitRemotes ?? listGitRemotes)(context.canonicalPath);
      let remoteName;
      try {
        remoteName = choosePushRemote(remotes);
      } catch (error) {
        return failCommand(db, commandId, { ok: false, code: error.code, message: error.message }, options);
      }
      try {
        await (options.rejectUnsupportedSubmitFeatures ?? rejectUnsupportedSubmitFeatures)(context.canonicalPath);
      } catch (error) {
        return failCommand(db, commandId, { ok: false, code: error.code, message: error.message }, options);
      }
      const timestamp = now(options);
      const commitMessage = `${summary}\n\nUGK-Cockpit-Command: ${commandId}`;
      db.prepare(`
        INSERT INTO submission_attempts (
          command_id, session_id, assignment_revision, project_id, space_id,
          source_worktree_id, target_worktree_id, source_branch, target_branch,
          start_head, target_head, remote_name, summary, commit_message,
          state, source_commit, submission_id, last_error_code, last_error_message,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        commandId,
        sessionId,
        expectedRevision,
        context.projectId,
        space.spaceId,
        context.worktreeId,
        project.worktree_id,
        space.branch,
        targetObservation.after.branch,
        sourceObservation.after.head,
        targetObservation.after.head,
        remoteName,
        summary,
        commitMessage,
        timestamp,
        timestamp,
      );
      attempt = readSubmissionAttempt(db, commandId);
      await options.faultInjector?.('after_attempt_prepared', attempt);
    }

    if (attempt.state === 'attention') {
      return {
        ok: false,
        code: attempt.lastErrorCode ?? 'SUBMIT_ATTENTION_REQUIRED',
        message: attempt.lastErrorMessage ?? 'Submission requires attention.',
        localSaved: Boolean(attempt.sourceCommit),
        pushed: false,
        humanActionRequired: true,
      };
    }

    if (attempt.state === 'prepared') {
      const sourceObservation = await probe(context.canonicalPath);
      validateObservation(sourceObservation, {
        canonicalPath: context.canonicalPath,
        repositoryIdentity: context.repositoryIdentity,
        worktreeIdentity: context.worktreeIdentity,
      }, 'source');
      if (sourceObservation.after.branch !== attempt.sourceBranch) {
        updateAttempt(db, commandId, {
          state: 'attention',
          last_error_code: 'SOURCE_BRANCH_CHANGED',
          last_error_message: 'The development space branch changed after submission preparation.',
        }, options);
        return { ok: false, code: 'SOURCE_BRANCH_CHANGED', humanActionRequired: true, localSaved: false, pushed: false };
      }

      let sourceCommit = sourceObservation.after.head;
      if (sourceCommit !== attempt.startHead) {
        const metadata = await (options.readHeadMetadata ?? readHeadMetadata)(context.canonicalPath);
        if (!isRecoverableSubmissionCommit(metadata, { commandId, startHead: attempt.startHead })) {
          updateAttempt(db, commandId, {
            state: 'attention',
            last_error_code: 'SOURCE_MOVED',
            last_error_message: 'Source HEAD changed and cannot be attributed to this submission command.',
          }, options);
          return { ok: false, code: 'SOURCE_MOVED', humanActionRequired: true, localSaved: false, pushed: false };
        }
        sourceCommit = metadata.head;
      } else {
        const dirty = await (options.hasUncommittedChanges ?? hasUncommittedChanges)(context.canonicalPath);
        if (dirty) {
          try {
            await (options.ensureLocalCommitIdentity ?? ensureLocalCommitIdentity)(context.canonicalPath);
            await (options.stageAllChanges ?? stageAllChanges)(context.canonicalPath);
            await (options.createSubmissionCommit ?? createSubmissionCommit)(context.canonicalPath, {
              summary,
              commandId,
            });
          } catch (error) {
            return retryableAttemptError(db, attempt, 'COMMIT_FAILED', error.message, {}, options);
          }
          await options.faultInjector?.('after_commit_before_persist');
          const metadata = await (options.readHeadMetadata ?? readHeadMetadata)(context.canonicalPath);
          if (!isRecoverableSubmissionCommit(metadata, { commandId, startHead: attempt.startHead })) {
            updateAttempt(db, commandId, {
              state: 'attention',
              last_error_code: 'COMMIT_UNVERIFIED',
              last_error_message: 'The saved commit could not be attributed to this command.',
            }, options);
            return { ok: false, code: 'COMMIT_UNVERIFIED', humanActionRequired: true, localSaved: true, pushed: false };
          }
          sourceCommit = metadata.head;
        } else if (sourceCommit === space.baseCommit) {
          return failCommand(db, commandId, { ok: false, code: 'NO_CHANGES_TO_SUBMIT' }, options);
        }
      }

      const descendsFromBase = await (options.isCommitDescendant ?? isCommitDescendant)(
        context.canonicalPath,
        space.baseCommit,
        sourceCommit,
      );
      if (!descendsFromBase) {
        updateAttempt(db, commandId, {
          state: 'attention',
          last_error_code: 'SOURCE_HISTORY_DIVERGED',
          last_error_message: 'The development branch no longer descends from its recorded base.',
        }, options);
        return { ok: false, code: 'SOURCE_HISTORY_DIVERGED', humanActionRequired: true, localSaved: true, pushed: false };
      }
      attempt = updateAttempt(db, commandId, {
        state: 'local_saved',
        source_commit: sourceCommit,
        last_error_code: null,
        last_error_message: null,
      }, options);
    }

    if (attempt.state === 'local_saved') {
      const sourceObservation = await probe(context.canonicalPath);
      validateObservation(sourceObservation, {
        canonicalPath: context.canonicalPath,
        repositoryIdentity: context.repositoryIdentity,
        worktreeIdentity: context.worktreeIdentity,
      }, 'source');
      if (sourceObservation.after.head !== attempt.sourceCommit || sourceObservation.after.hasChanges) {
        updateAttempt(db, commandId, {
          state: 'attention',
          last_error_code: 'SOURCE_CHANGED_AFTER_SAVE',
          last_error_message: 'The development space changed after its local save.',
        }, options);
        return { ok: false, code: 'SOURCE_CHANGED_AFTER_SAVE', humanActionRequired: true, localSaved: true, pushed: false };
      }
      try {
        await (options.pushSubmissionBranch ?? pushSubmissionBranch)(context.canonicalPath, {
          remote: attempt.remoteName,
          branch: attempt.sourceBranch,
        });
      } catch (error) {
        return retryableAttemptError(db, attempt, 'PUSH_FAILED', error.message, {
          sourceCommit: attempt.sourceCommit,
          remote: attempt.remoteName,
        }, options);
      }
      await options.faultInjector?.('after_push_before_persist');
      attempt = updateAttempt(db, commandId, {
        state: 'pushed',
        last_error_code: null,
        last_error_message: null,
      }, options);
    }

    if (attempt.state === 'pushed') {
      const created = createSubmission(db, {
        commandId: `create_submission:${commandId}`,
        projectId: attempt.projectId,
        spaceId: attempt.spaceId,
        sourceWorktreeId: attempt.sourceWorktreeId,
        targetWorktreeId: attempt.targetWorktreeId,
        sourceBranch: attempt.sourceBranch,
        sourceCommit: attempt.sourceCommit,
        targetBranch: attempt.targetBranch,
        targetHead: attempt.targetHead,
        title: attempt.summary,
        description: `Submitted from managed development space ${attempt.spaceId}.`,
      }, options);
      if (!created.ok) {
        return retryableAttemptError(db, attempt, created.code, created.message ?? 'Could not create submission record.', {}, options);
      }
      await options.faultInjector?.('after_submission_before_space_status');
      const currentSpace = readDevelopmentSpaceByWorktree(db, attempt.sourceWorktreeId);
      if (currentSpace.status !== 'awaiting_review') {
        const updated = updateDevelopmentSpaceStatus(db, {
          commandId: `space_awaiting_review:${commandId}:${currentSpace.revision}`,
          spaceId: currentSpace.spaceId,
          expectedRevision: currentSpace.revision,
          status: 'awaiting_review',
          statusReason: 'submission_created',
        }, options);
        if (!updated.ok) {
          return retryableAttemptError(db, attempt, updated.code, 'Submission exists but the space status could not be updated.', {
            submissionId: created.submissionId,
          }, options);
        }
      }
      attempt = updateAttempt(db, commandId, {
        state: 'completed',
        submission_id: created.submissionId,
        last_error_code: null,
        last_error_message: null,
      }, options);
    }

    return commitCommand(db, commandId, {
      ok: true,
      commandId,
      sessionId,
      projectId: attempt.projectId,
      spaceId: attempt.spaceId,
      submissionId: attempt.submissionId,
      sourceCommit: attempt.sourceCommit,
      targetHead: attempt.targetHead,
      branch: attempt.sourceBranch,
      remote: attempt.remoteName,
      localSaved: true,
      pushed: true,
      status: 'waiting_review',
      revision: expectedRevision,
      message: '功能已保存并送达，等待主项目审核。',
    }, options);
  } catch (error) {
    if (error?.simulateCrash) throw error;
    if (attempt) {
      return retryableAttemptError(db, readSubmissionAttempt(db, commandId), error.code ?? 'SUBMIT_FAILED', error.message, {}, options);
    }
    return failCommand(db, commandId, { ok: false, code: error.code ?? 'SUBMIT_FAILED', message: error.message }, options);
  } finally {
    releaseRepositoryLock(db, {
      repositoryIdentity: project.repository_identity,
      holder: lockHolder,
      lockId: lock.lockId,
    }, options);
  }
}
