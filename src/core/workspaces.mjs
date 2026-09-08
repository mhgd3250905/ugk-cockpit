import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  beginCommand,
  canonicalJson,
  parseCommandResponse,
  readCommand,
} from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';
import { reopenWorkLineStateForReuse } from './manual-records.mjs';
import { readProjectContext, worktreeIdFor } from './projects.mjs';
import {
  listDevelopmentSpaces,
  readDevelopmentSpace,
  spaceIdFor,
} from './spaces.mjs';
import {
  acquireRepositoryLock,
  releaseRepositoryLock,
} from './integrations.mjs';
import { EmptyFolderGrantStore } from './folder-grants.mjs';
import {
  revalidateEmptyDirectory,
} from './path-guard.mjs';
import { probeGitWorktree } from '../git/probe.mjs';
import {
  checkBranchExists,
  createGitWorktree,
  generateStableBranchName,
  isStableWorkspaceBranch,
  listGitWorktrees,
  removeGitWorktree,
  switchGitWorktreeToNewBranch,
} from '../git/workspace-ops.mjs';

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

function samePath(left, right) {
  if (!isNonEmptyString(left) || !isNonEmptyString(right)) return false;
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function hasGitMarker(targetPath) {
  return existsSync(path.join(targetPath, '.git'));
}

function pathsOverlap(left, right) {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  const leftToRight = path.relative(leftPath, rightPath);
  const rightToLeft = path.relative(rightPath, leftPath);
  const isWithin = (relative) => relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative));
  return isWithin(leftToRight) || isWithin(rightToLeft);
}

function failCommand(db, commandId, response) {
  if (!commandId) return response;
  db.prepare(`
    UPDATE commands SET state = 'failed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), now(), commandId);
  return response;
}

function commitCommand(db, commandId, response, timestamp) {
  if (!commandId) return response;
  db.prepare(`
    UPDATE commands SET state = 'committed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), timestamp, commandId);
  return response;
}

function registerAndCompleteWorkspace({
  db,
  commandId,
  projectId,
  name,
  branchName,
  baseCommit,
  observation,
  grantId,
  grantStore,
  status = 'ready',
  statusReason = 'created',
  options = {},
}) {
  const timestamp = iso(nowMillis(options));
  const worktreeId = worktreeIdFor(observation.worktreeIdentity);
  const spaceId = spaceIdFor(projectId, worktreeId);

  return withImmediateTransaction(db, () => {
    const existingWorktree = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(worktreeId);
    if (existingWorktree && (
      !samePath(existingWorktree.canonical_path, observation.canonicalPath)
      || existingWorktree.repository_identity !== observation.repositoryIdentity
      || existingWorktree.identity_fingerprint !== observation.worktreeIdentity
    )) {
      return {
        ok: false,
        code: 'WORKTREE_REGISTRATION_CONFLICT',
        message: '现有工作副本记录与新观测不一致，未覆盖任何记录。',
        humanActionRequired: true,
        worktreeId,
      };
    }

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

    const existingSpace = db.prepare('SELECT * FROM development_spaces WHERE id = ?').get(spaceId);
    if (existingSpace && (
      existingSpace.project_id !== projectId
      || existingSpace.worktree_id !== worktreeId
      || existingSpace.branch !== branchName
      || existingSpace.base_commit !== baseCommit
    )) {
      return {
        ok: false,
        code: 'SPACE_REGISTRATION_CONFLICT',
        message: '现有开发空间记录与新观测不一致，未覆盖任何记录。',
        humanActionRequired: true,
        spaceId,
      };
    }
    if (!existingSpace) {
      db.prepare(`
        INSERT INTO development_spaces (
          id, project_id, name, branch, base_commit, worktree_id,
          status, status_reason, revision, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)
      `).run(
        spaceId,
        projectId,
        name,
        branchName,
        baseCommit,
        worktreeId,
        status,
        statusReason,
        timestamp,
        timestamp,
      );
    }

    if (grantId) {
      if (grantStore && typeof grantStore.complete === 'function') {
        grantStore.complete(grantId, commandId);
      } else {
        db.prepare(`
          UPDATE empty_folder_grants SET state = 'consumed'
          WHERE id = ? AND claimed_by_command = ? AND state = 'claimed'
        `).run(grantId, commandId);
      }
    }

    const space = readDevelopmentSpace(db, spaceId);
    const response = {
      ok: true,
      commandId: commandId ?? null,
      spaceId,
      projectId,
      name,
      branch: branchName,
      baseCommit,
      worktreeId,
      canonicalPath: observation.canonicalPath,
      repositoryIdentity: observation.repositoryIdentity,
      worktreeIdentity: observation.worktreeIdentity,
      status,
      statusReason,
      space,
      alreadyExists: Boolean(existingSpace),
    };

    if (commandId) commitCommand(db, commandId, response, timestamp);
    return response;
  });
}

export async function createDevelopmentWorkspace(db, request = {}, options = {}) {
  const projectId = request.projectId;
  const expectedBaseHead = request.expectedBaseHead ?? request.expected_base_head;
  const commandId = request.commandId;
  const grantId = request.grantId ?? request.grant_id;
  const principalHash = request.principalHash ?? request.principal_hash;

  if (!isNonEmptyString(commandId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'commandId is required.' };
  }
  if (!isNonEmptyString(projectId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'projectId is required.' };
  }
  if (!isNonEmptyString(grantId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'grantId is required.' };
  }
  if (!isNonEmptyString(principalHash)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'principalHash is required.' };
  }
  if (!isNonEmptyString(expectedBaseHead)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'expectedBaseHead is required.' };
  }
  if (request.baseCommit !== undefined && request.baseCommit !== null && request.baseCommit !== expectedBaseHead) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'baseCommit must equal expectedBaseHead.' };
  }
  if (request.branch !== undefined && request.branch !== null && !isStableWorkspaceBranch(request.branch)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Custom branch must follow cockpit/work/<opaque> format.' };
  }

  const branchName = request.branch ?? generateStableBranchName(projectId, commandId);
  const frozenRequest = {
    commandId,
    projectId,
    name: request.name ?? '',
    grantId,
    principalHash,
    expectedBaseHead,
    baseCommit: expectedBaseHead,
    branch: branchName,
  };

  const begun = beginCommand(db, {
    commandId,
    kind: 'workspace.create',
    request: frozenRequest,
  });
  if (begun.command.state === 'committed' || begun.command.state === 'failed') {
    return parseCommandResponse(begun.command);
  }

  const project = readProjectContext(db, projectId);
  if (!project) {
    const res = { ok: false, code: 'PROJECT_NOT_FOUND', projectId };
    failCommand(db, commandId, res);
    return res;
  }

  const repositoryIdentity = project.repository_identity || project.worktree_repository_identity;
  const mainRepoPath = project.canonical_path;
  const mainWorktreeIdentity = project.identity_fingerprint;

  const grantStore = options.grantStore ?? new EmptyFolderGrantStore({
    db,
    clock: () => nowMillis(options),
  });

  let grant = null;
  let targetPath = null;
  let expectedFileIdentity = null;

  try {
    grant = grantStore.claim(grantId, commandId, principalHash);
    targetPath = grant.canonical_path;
    expectedFileIdentity = grant.file_identity;
  } catch (err) {
    const res = {
      ok: false,
      code: err.code ?? 'FOLDER_GRANT_ERROR',
      message: err.message,
      grantId,
    };
    failCommand(db, commandId, res);
    return res;
  }

  const lockHolder = request.lockHolder ?? commandId ?? `workspace_creator_${projectId}`;
  const lockTtlMs = options.lockTtlMs ?? options.ttlMs ?? 60_000;
  const lockRes = acquireRepositoryLock(db, {
    repositoryIdentity,
    holder: lockHolder,
    operation: 'create_workspace',
    ttlMs: lockTtlMs,
  }, options);

  if (!lockRes.ok) {
    return {
      ok: false,
      code: 'REPOSITORY_LOCKED',
      message: 'Repository is currently locked by another operation.',
      repositoryIdentity,
      holder: lockRes.holder,
      operation: lockRes.operation,
      expiresAt: lockRes.expiresAt,
    };
  }

  try {
    const probeFn = options.probe ?? probeGitWorktree;
    let mainObservation;
    try {
      mainObservation = await probeFn(mainRepoPath);
    } catch (err) {
      const res = {
        ok: false,
        code: 'PROBE_FAILED',
        message: `Failed to probe repository: ${err.message}`,
      };
      failCommand(db, commandId, res);
      grantStore.unclaim(grantId, commandId);
      return res;
    }

    const isMainPathSame = samePath(mainObservation.canonicalPath, mainRepoPath);

    if (!isMainPathSame) {
      const res = {
        ok: false,
        code: 'MAIN_WORKTREE_INVALID',
        message: `Main worktree path ${mainObservation.canonicalPath} does not match project canonical path ${mainRepoPath}.`,
      };
      failCommand(db, commandId, res);
      grantStore.unclaim(grantId, commandId);
      return res;
    }

    if (mainObservation.repositoryIdentity !== repositoryIdentity) {
      const res = {
        ok: false,
        code: 'REPOSITORY_IDENTITY_MISMATCH',
        message: `Main repository identity ${mainObservation.repositoryIdentity} does not match project repository identity ${repositoryIdentity}.`,
        projectRepositoryIdentity: repositoryIdentity,
        worktreeRepositoryIdentity: mainObservation.repositoryIdentity,
      };
      failCommand(db, commandId, res);
      grantStore.unclaim(grantId, commandId);
      return res;
    }

    if (mainWorktreeIdentity && mainObservation.worktreeIdentity !== mainWorktreeIdentity) {
      const res = {
        ok: false,
        code: 'MAIN_WORKTREE_INVALID',
        message: `Main worktree identity ${mainObservation.worktreeIdentity} does not match project worktree identity ${mainWorktreeIdentity}.`,
      };
      failCommand(db, commandId, res);
      grantStore.unclaim(grantId, commandId);
      return res;
    }

    if (mainObservation.coherence !== 'coherent') {
      const res = {
        ok: false,
        code: 'MAIN_WORKTREE_INCOHERENT',
        message: 'Main repository worktree is not coherent.',
      };
      failCommand(db, commandId, res);
      grantStore.unclaim(grantId, commandId);
      return res;
    }

    if (mainObservation.after.head !== expectedBaseHead) {
      const res = {
        ok: false,
        code: 'BASE_HEAD_STALE',
        message: `Expected base HEAD ${expectedBaseHead} does not match current repository HEAD ${mainObservation.after.head}.`,
        currentHead: mainObservation.after.head,
        expectedBaseHead,
      };
      failCommand(db, commandId, res);
      grantStore.unclaim(grantId, commandId);
      return res;
    }

    const overlappingWorktree = db.prepare(`
      SELECT id, canonical_path
      FROM worktrees
      WHERE repository_identity = ?
    `).all(repositoryIdentity).find((row) => pathsOverlap(row.canonical_path, targetPath));
    if (overlappingWorktree) {
      const res = {
        ok: false,
        code: 'WORKTREE_PATH_OVERLAP',
        message: '目标目录不能位于现有工作副本内部，也不能包含现有工作副本。',
        targetPath,
        conflictingWorktreeId: overlappingWorktree.id,
      };
      failCommand(db, commandId, res);
      grantStore.unclaim(grantId, commandId);
      return res;
    }

    // Check if targetPath is already a worktree (crash recovery check)
    let existingWorktreeProbe = null;
    try {
      existingWorktreeProbe = await probeFn(targetPath);
    } catch (error) {
      if (hasGitMarker(targetPath)) {
        return {
          ok: false,
          code: 'WORKTREE_RECOVERY_UNCERTAIN',
          message: `目标目录已经出现 Git 工作副本标记，但暂时无法核验：${error.message}`,
          humanActionRequired: true,
          retryable: true,
          targetPath,
          branch: branchName,
        };
      }
    }

    if (existingWorktreeProbe) {
      const isSameTargetPath = samePath(existingWorktreeProbe.canonicalPath, targetPath);
      const matchesIdentity = existingWorktreeProbe.repositoryIdentity === repositoryIdentity;
      const matchesBranch = existingWorktreeProbe.after.branch === branchName
        || existingWorktreeProbe.after.branch === `refs/heads/${branchName}`;
      const matchesCommit = existingWorktreeProbe.after.head === expectedBaseHead;
      const isCoherent = existingWorktreeProbe.coherence === 'coherent';
      const isClean = !existingWorktreeProbe.after.hasChanges;

      if (isSameTargetPath && matchesIdentity && matchesBranch && matchesCommit && isCoherent && isClean) {
        return registerAndCompleteWorkspace({
          db,
          commandId,
          projectId,
          name: request.name ?? '',
          branchName,
          baseCommit: expectedBaseHead,
          observation: existingWorktreeProbe,
          grantId,
          grantStore,
          status: request.status ?? 'ready',
          statusReason: request.statusReason ?? 'recovered_after_crash',
          options,
        });
      }

      return {
        ok: false,
        code: 'WORKTREE_RECOVERY_UNCERTAIN',
        message: 'Existing worktree at target path cannot be proven to belong to this command. Manual intervention required. No data was deleted.',
        humanActionRequired: true,
        targetPath,
        branch: branchName,
      };
    }

    // Revalidate empty directory
    try {
      revalidateEmptyDirectory({
        rootInput: targetPath,
        candidateInput: targetPath,
        rootReal: targetPath,
        candidateReal: targetPath,
        fileIdentity: expectedFileIdentity,
      });
    } catch (err) {
      if (hasGitMarker(targetPath)) {
        return {
          ok: false,
          code: 'WORKTREE_RECOVERY_UNCERTAIN',
          message: `目录核验期间出现 Git 工作副本标记，需要重试核验：${err.message}`,
          humanActionRequired: true,
          retryable: true,
          targetPath,
          branch: branchName,
        };
      }
      const res = {
        ok: false,
        code: err.code ?? 'DIRECTORY_VERIFICATION_FAILED',
        message: err.message,
        targetPath,
      };
      failCommand(db, commandId, res);
      grantStore.unclaim(grantId, commandId);
      return res;
    }

    // Check if branch already exists in repository
    const checkBranchFn = options.checkBranchExists ?? checkBranchExists;
    let branchExists;
    try {
      branchExists = await checkBranchFn(mainRepoPath, branchName);
    } catch (err) {
      const res = {
        ok: false,
        code: 'BRANCH_CHECK_FAILED',
        message: `Failed to check if branch exists: ${err.message}`,
        branch: branchName,
      };
      failCommand(db, commandId, res);
      grantStore.unclaim(grantId, commandId);
      return res;
    }
    if (branchExists) {
      const res = {
        ok: false,
        code: 'BRANCH_ALREADY_EXISTS',
        message: `Branch ${branchName} already exists in repository.`,
        branch: branchName,
      };
      failCommand(db, commandId, res);
      grantStore.unclaim(grantId, commandId);
      return res;
    }

    // Create git worktree
    const createGitWorktreeFn = options.createGitWorktree ?? createGitWorktree;
    try {
      await createGitWorktreeFn(mainRepoPath, {
        targetPath,
        branch: branchName,
        baseCommit: expectedBaseHead,
        timeoutMs: options.timeoutMs ?? 15_000,
        maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      });
    } catch (err) {
      let probeAfterErr = null;
      try {
        probeAfterErr = await probeFn(targetPath);
      } catch {}
      if (probeAfterErr) {
        return {
          ok: false,
          code: 'WORKTREE_RECOVERY_UNCERTAIN',
          message: `Git worktree add error occurred but worktree was created: ${err.message}`,
          humanActionRequired: true,
          targetPath,
          branch: branchName,
        };
      }
      const res = {
        ok: false,
        code: 'GIT_WORKTREE_ADD_FAILED',
        message: `Failed to create git worktree: ${err.message}`,
        targetPath,
        branch: branchName,
      };
      failCommand(db, commandId, res);
      grantStore.unclaim(grantId, commandId);
      return res;
    }

    // Probe newly created worktree
    let newObservation;
    try {
      newObservation = await probeFn(targetPath);
    } catch (err) {
      return {
        ok: false,
        code: 'WORKTREE_RECOVERY_UNCERTAIN',
        message: `Failed to probe newly created worktree: ${err.message}`,
        humanActionRequired: true,
        targetPath,
        branch: branchName,
      };
    }

    const isSameTargetPath = samePath(newObservation.canonicalPath, targetPath);
    const matchesIdentity = newObservation.repositoryIdentity === repositoryIdentity;
    const matchesBranch = newObservation.after.branch === branchName
      || newObservation.after.branch === `refs/heads/${branchName}`;
    const matchesCommit = newObservation.after.head === expectedBaseHead;
    const isCoherent = newObservation.coherence === 'coherent';
    const isClean = !newObservation.after.hasChanges;

    if (!isSameTargetPath || !matchesIdentity || !matchesBranch || !matchesCommit || !isCoherent || !isClean) {
      return {
        ok: false,
        code: 'WORKTREE_RECOVERY_UNCERTAIN',
        message: 'Newly created worktree validation failed (path, repo identity, branch, head, coherence, or clean mismatch).',
        humanActionRequired: true,
        targetPath,
        branch: branchName,
      };
    }

    return registerAndCompleteWorkspace({
      db,
      commandId,
      projectId,
      name: request.name ?? '',
      branchName,
      baseCommit: expectedBaseHead,
      observation: newObservation,
      grantId,
      grantStore,
      status: request.status ?? 'ready',
      statusReason: request.statusReason ?? 'created',
      options,
    });
  } finally {
    if (lockRes.ok && lockRes.lockId) {
      releaseRepositoryLock(db, {
        repositoryIdentity,
        holder: lockHolder,
        lockId: lockRes.lockId,
      }, options);
    }
  }
}

export const createWorkspace = createDevelopmentWorkspace;

export function readDevelopmentWorkspace(db, spaceId) {
  return readDevelopmentSpace(db, spaceId);
}

export function listDevelopmentWorkspaces(db, options = {}) {
  return listDevelopmentSpaces(db, options);
}

const REUSABLE_SPACE_STATUSES = new Set(['ready', 'cleanup_ready', 'paused', 'attention']);

function branchMatches(observedBranch, expectedBranch) {
  return observedBranch === expectedBranch || observedBranch === `refs/heads/${expectedBranch}`;
}

function readActiveWorkspaceWork(db, worktreeId) {
  const lease = db.prepare(`
    SELECT write_leases.run_id AS run_id
    FROM write_leases
    JOIN runs ON runs.id = write_leases.run_id
    WHERE write_leases.worktree_id = ? AND runs.lifecycle = 'active'
  `).get(worktreeId);
  if (lease) return { kind: 'write_lease', runId: lease.run_id };

  const assignment = db.prepare(`
    SELECT id, status FROM assignments
    WHERE worktree_id = ? AND status IN ('pending', 'accepted', 'active')
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get(worktreeId);
  return assignment ? { kind: 'assignment', assignmentId: assignment.id, status: assignment.status } : null;
}

function validateWorkspaceObservation(space, project, observation) {
  if (
    !samePath(observation.canonicalPath, space.canonicalPath)
    || observation.repositoryIdentity !== project.repository_identity
    || observation.repositoryIdentity !== space.repositoryIdentity
    || observation.worktreeIdentity !== space.worktreeIdentity
  ) {
    return { ok: false, code: 'WORKSPACE_IDENTITY_MISMATCH' };
  }
  if (observation.coherence !== 'coherent') {
    return { ok: false, code: 'WORKSPACE_INCOHERENT' };
  }
  return { ok: true };
}

function validatePrimaryObservation(project, observation) {
  if (
    !samePath(observation.canonicalPath, project.canonical_path)
    || observation.repositoryIdentity !== project.repository_identity
    || observation.worktreeIdentity !== project.identity_fingerprint
  ) {
    return { ok: false, code: 'MAIN_WORKTREE_INVALID' };
  }
  if (observation.coherence !== 'coherent') {
    return { ok: false, code: 'MAIN_WORKTREE_INCOHERENT' };
  }
  return { ok: true };
}

function validateSpaceLifecycleRequest(request, { expectedBaseHead = false } = {}) {
  if (!isNonEmptyString(request.commandId)
    || !isNonEmptyString(request.projectId)
    || !isNonEmptyString(request.spaceId)
    || !Number.isInteger(request.expectedRevision)
    || request.expectedRevision < 0
  ) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  if (expectedBaseHead && !isNonEmptyString(request.expectedBaseHead)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  return { ok: true };
}

function finalizeWorkspaceReuse(db, {
  commandId,
  projectId,
  spaceId,
  expectedRevision,
  branch,
  baseCommit,
  observation,
  options,
}) {
  const timestamp = iso(nowMillis(options));
  return withImmediateTransaction(db, () => {
    const command = readCommand(db, commandId);
    if (command.state === 'committed' || command.state === 'failed') return parseCommandResponse(command);

    const current = db.prepare('SELECT * FROM development_spaces WHERE id = ?').get(spaceId);
    if (!current || current.project_id !== projectId) {
      return failCommand(db, commandId, { ok: false, code: 'SPACE_NOT_FOUND', spaceId });
    }
    if (current.revision !== expectedRevision) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'SPACE_REVISION_CONFLICT',
        spaceId,
        expectedRevision,
        currentRevision: current.revision,
      });
    }

    const revision = current.revision + 1;
    db.prepare(`
      UPDATE development_spaces
      SET branch = ?, base_commit = ?, status = 'ready', status_reason = 'reused_from_latest_main',
          revision = ?, updated_at = ?, archived_at = NULL
      WHERE id = ? AND revision = ?
    `).run(branch, baseCommit, revision, timestamp, spaceId, expectedRevision);

    const reopened = reopenWorkLineStateForReuse(db, {
      projectId,
      worktreeId: current.worktree_id,
      commandId,
      timestamp,
    });
    if (!reopened.ok) throw Object.assign(new Error(reopened.code), { code: reopened.code });

    const space = readDevelopmentSpace(db, spaceId);
    const response = {
      ok: true,
      commandId,
      projectId,
      spaceId,
      previousBranch: current.branch,
      branch,
      baseCommit,
      revision,
      space,
      git: {
        head: observation.after.head,
        branch: observation.after.branch,
        hasChanges: observation.after.hasChanges ?? null,
        coherence: observation.coherence,
        observedAt: observation.observedAt ?? null,
      },
    };
    return commitCommand(db, commandId, response, timestamp);
  });
}

function finalizeWorkspaceRemoval(db, {
  commandId,
  projectId,
  spaceId,
  expectedRevision,
  options,
}) {
  const timestamp = iso(nowMillis(options));
  return withImmediateTransaction(db, () => {
    const command = readCommand(db, commandId);
    if (command.state === 'committed' || command.state === 'failed') return parseCommandResponse(command);

    const current = db.prepare('SELECT * FROM development_spaces WHERE id = ?').get(spaceId);
    if (!current || current.project_id !== projectId) {
      return failCommand(db, commandId, { ok: false, code: 'SPACE_NOT_FOUND', spaceId });
    }
    if (current.revision !== expectedRevision) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'SPACE_REVISION_CONFLICT',
        spaceId,
        expectedRevision,
        currentRevision: current.revision,
      });
    }

    const revision = current.revision + 1;
    db.prepare(`
      UPDATE development_spaces
      SET status = 'archived', status_reason = 'removed_by_user',
          revision = ?, updated_at = ?, archived_at = ?
      WHERE id = ? AND revision = ?
    `).run(revision, timestamp, timestamp, spaceId, expectedRevision);

    const space = readDevelopmentSpace(db, spaceId);
    const response = {
      ok: true,
      commandId,
      projectId,
      spaceId,
      branch: current.branch,
      revision,
      space,
    };
    return commitCommand(db, commandId, response, timestamp);
  });
}

export async function reuseDevelopmentWorkspace(db, request = {}, options = {}) {
  const validation = validateSpaceLifecycleRequest(request, { expectedBaseHead: true });
  if (!validation.ok) return validation;

  const nextBranch = generateStableBranchName(request.projectId, request.commandId);
  const frozenRequest = {
    commandId: request.commandId,
    projectId: request.projectId,
    spaceId: request.spaceId,
    expectedRevision: request.expectedRevision,
    expectedBaseHead: request.expectedBaseHead,
    nextBranch,
  };
  const begun = beginCommand(db, {
    commandId: request.commandId,
    kind: 'workspace.reuse',
    request: frozenRequest,
  });
  if (begun.command.state === 'committed' || begun.command.state === 'failed') {
    return parseCommandResponse(begun.command);
  }

  const project = readProjectContext(db, request.projectId);
  const space = readDevelopmentSpace(db, request.spaceId);
  if (!project) return failCommand(db, request.commandId, { ok: false, code: 'PROJECT_NOT_FOUND', projectId: request.projectId });
  if (!space || space.projectId !== request.projectId) {
    return failCommand(db, request.commandId, { ok: false, code: 'SPACE_NOT_FOUND', spaceId: request.spaceId });
  }
  if (!REUSABLE_SPACE_STATUSES.has(space.status)) {
    return failCommand(db, request.commandId, { ok: false, code: 'SPACE_NOT_REUSABLE', spaceId: space.spaceId, status: space.status });
  }
  if (space.revision !== request.expectedRevision) {
    return failCommand(db, request.commandId, {
      ok: false,
      code: 'SPACE_REVISION_CONFLICT',
      spaceId: space.spaceId,
      expectedRevision: request.expectedRevision,
      currentRevision: space.revision,
    });
  }
  const activeWork = readActiveWorkspaceWork(db, space.worktreeId);
  if (activeWork) {
    return failCommand(db, request.commandId, { ok: false, code: 'SPACE_HAS_ACTIVE_WORK', spaceId: space.spaceId, ...activeWork });
  }

  const lockHolder = request.commandId;
  const lock = acquireRepositoryLock(db, {
    repositoryIdentity: project.repository_identity,
    holder: lockHolder,
    operation: 'reuse_workspace',
    ttlMs: options.lockTtlMs ?? 60_000,
  }, options);
  if (!lock.ok) return { ok: false, code: 'REPOSITORY_LOCKED', repositoryIdentity: project.repository_identity };

  try {
    const probe = options.probe ?? probeGitWorktree;
    let workspaceObservation;
    try {
      workspaceObservation = await probe(space.canonicalPath);
    } catch (error) {
      return failCommand(db, request.commandId, { ok: false, code: 'WORKSPACE_PROBE_FAILED', spaceId: space.spaceId, message: error.message });
    }
    const workspaceValidation = validateWorkspaceObservation(space, project, workspaceObservation);
    if (!workspaceValidation.ok) return failCommand(db, request.commandId, { ok: false, ...workspaceValidation, spaceId: space.spaceId });

    const alreadySwitched = branchMatches(workspaceObservation.after.branch, nextBranch)
      && workspaceObservation.after.head === request.expectedBaseHead
      && !workspaceObservation.after.hasChanges;
    if (alreadySwitched) {
      return finalizeWorkspaceReuse(db, {
        commandId: request.commandId,
        projectId: request.projectId,
        spaceId: request.spaceId,
        expectedRevision: request.expectedRevision,
        branch: nextBranch,
        baseCommit: request.expectedBaseHead,
        observation: workspaceObservation,
        options,
      });
    }
    if (workspaceObservation.after.hasChanges) {
      return failCommand(db, request.commandId, { ok: false, code: 'WORKSPACE_HAS_CHANGES', spaceId: space.spaceId });
    }

    let primaryObservation;
    try {
      primaryObservation = await probe(project.canonical_path);
    } catch (error) {
      return failCommand(db, request.commandId, { ok: false, code: 'PROBE_FAILED', message: error.message });
    }
    const primaryValidation = validatePrimaryObservation(project, primaryObservation);
    if (!primaryValidation.ok) return failCommand(db, request.commandId, { ok: false, ...primaryValidation });
    if (primaryObservation.after.head !== request.expectedBaseHead) {
      return failCommand(db, request.commandId, {
        ok: false,
        code: 'BASE_HEAD_STALE',
        expectedBaseHead: request.expectedBaseHead,
        currentHead: primaryObservation.after.head,
      });
    }

    const branchExists = await (options.checkBranchExists ?? checkBranchExists)(project.canonical_path, nextBranch);
    if (branchExists) {
      return failCommand(db, request.commandId, { ok: false, code: 'BRANCH_ALREADY_EXISTS', branch: nextBranch });
    }

    try {
      await (options.switchGitWorktreeToNewBranch ?? switchGitWorktreeToNewBranch)(space.canonicalPath, {
        branch: nextBranch,
        baseCommit: request.expectedBaseHead,
        timeoutMs: options.timeoutMs ?? 15_000,
        maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      });
    } catch (error) {
      let afterError = null;
      try { afterError = await probe(space.canonicalPath); } catch {}
      if (afterError && branchMatches(afterError.after.branch, nextBranch) && afterError.after.head === request.expectedBaseHead && !afterError.after.hasChanges) {
        return finalizeWorkspaceReuse(db, {
          commandId: request.commandId,
          projectId: request.projectId,
          spaceId: request.spaceId,
          expectedRevision: request.expectedRevision,
          branch: nextBranch,
          baseCommit: request.expectedBaseHead,
          observation: afterError,
          options,
        });
      }
      return failCommand(db, request.commandId, { ok: false, code: 'WORKSPACE_SWITCH_FAILED', spaceId: space.spaceId, message: error.message });
    }

    const after = await probe(space.canonicalPath);
    const afterValidation = validateWorkspaceObservation(space, project, after);
    if (!afterValidation.ok || !branchMatches(after.after.branch, nextBranch) || after.after.head !== request.expectedBaseHead || after.after.hasChanges) {
      return { ok: false, code: 'WORKSPACE_RECOVERY_UNCERTAIN', spaceId: space.spaceId, retryable: true };
    }
    return finalizeWorkspaceReuse(db, {
      commandId: request.commandId,
      projectId: request.projectId,
      spaceId: request.spaceId,
      expectedRevision: request.expectedRevision,
      branch: nextBranch,
      baseCommit: request.expectedBaseHead,
      observation: after,
      options,
    });
  } finally {
    releaseRepositoryLock(db, {
      repositoryIdentity: project.repository_identity,
      holder: lockHolder,
      lockId: lock.lockId,
    }, options);
  }
}

export async function removeDevelopmentWorkspace(db, request = {}, options = {}) {
  const validation = validateSpaceLifecycleRequest(request);
  if (!validation.ok) return validation;

  const frozenRequest = {
    commandId: request.commandId,
    projectId: request.projectId,
    spaceId: request.spaceId,
    expectedRevision: request.expectedRevision,
  };
  const begun = beginCommand(db, {
    commandId: request.commandId,
    kind: 'workspace.remove',
    request: frozenRequest,
  });
  if (begun.command.state === 'committed' || begun.command.state === 'failed') {
    return parseCommandResponse(begun.command);
  }

  const project = readProjectContext(db, request.projectId);
  const space = readDevelopmentSpace(db, request.spaceId);
  if (!project) return failCommand(db, request.commandId, { ok: false, code: 'PROJECT_NOT_FOUND', projectId: request.projectId });
  if (!space || space.projectId !== request.projectId) {
    return failCommand(db, request.commandId, { ok: false, code: 'SPACE_NOT_FOUND', spaceId: request.spaceId });
  }
  if (!REUSABLE_SPACE_STATUSES.has(space.status)) {
    return failCommand(db, request.commandId, { ok: false, code: 'SPACE_NOT_REMOVABLE', spaceId: space.spaceId, status: space.status });
  }
  if (space.revision !== request.expectedRevision) {
    return failCommand(db, request.commandId, {
      ok: false,
      code: 'SPACE_REVISION_CONFLICT',
      spaceId: space.spaceId,
      expectedRevision: request.expectedRevision,
      currentRevision: space.revision,
    });
  }
  const activeWork = readActiveWorkspaceWork(db, space.worktreeId);
  if (activeWork) {
    return failCommand(db, request.commandId, { ok: false, code: 'SPACE_HAS_ACTIVE_WORK', spaceId: space.spaceId, ...activeWork });
  }

  const lockHolder = request.commandId;
  const lock = acquireRepositoryLock(db, {
    repositoryIdentity: project.repository_identity,
    holder: lockHolder,
    operation: 'remove_workspace',
    ttlMs: options.lockTtlMs ?? 60_000,
  }, options);
  if (!lock.ok) return { ok: false, code: 'REPOSITORY_LOCKED', repositoryIdentity: project.repository_identity };

  try {
    const listWorktrees = options.listGitWorktrees ?? listGitWorktrees;
    const listed = await listWorktrees(project.canonical_path);
    const registered = listed.find((entry) => samePath(entry.worktree, space.canonicalPath));
    if (!registered) {
      if (begun.fresh) {
        return failCommand(db, request.commandId, { ok: false, code: 'WORKSPACE_RECOVERY_UNCERTAIN', spaceId: space.spaceId });
      }
      return finalizeWorkspaceRemoval(db, {
        commandId: request.commandId,
        projectId: request.projectId,
        spaceId: request.spaceId,
        expectedRevision: request.expectedRevision,
        options,
      });
    }
    if (!branchMatches(registered.branch, space.branch)) {
      return failCommand(db, request.commandId, { ok: false, code: 'WORKSPACE_IDENTITY_MISMATCH', spaceId: space.spaceId });
    }

    const probe = options.probe ?? probeGitWorktree;
    let workspaceObservation;
    try {
      workspaceObservation = await probe(space.canonicalPath);
    } catch (error) {
      return failCommand(db, request.commandId, { ok: false, code: 'WORKSPACE_PROBE_FAILED', spaceId: space.spaceId, message: error.message });
    }
    const workspaceValidation = validateWorkspaceObservation(space, project, workspaceObservation);
    if (!workspaceValidation.ok) return failCommand(db, request.commandId, { ok: false, ...workspaceValidation, spaceId: space.spaceId });
    if (workspaceObservation.after.hasChanges) {
      return failCommand(db, request.commandId, { ok: false, code: 'WORKSPACE_HAS_CHANGES', spaceId: space.spaceId });
    }

    try {
      await (options.removeGitWorktree ?? removeGitWorktree)(project.canonical_path, {
        targetPath: space.canonicalPath,
        timeoutMs: options.timeoutMs ?? 15_000,
        maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      });
    } catch (error) {
      const remaining = await listWorktrees(project.canonical_path);
      if (remaining.some((entry) => samePath(entry.worktree, space.canonicalPath))) {
        return failCommand(db, request.commandId, { ok: false, code: 'WORKSPACE_REMOVE_FAILED', spaceId: space.spaceId, message: error.message });
      }
    }

    const after = await listWorktrees(project.canonical_path);
    if (after.some((entry) => samePath(entry.worktree, space.canonicalPath))) {
      return { ok: false, code: 'WORKSPACE_REMOVE_FAILED', spaceId: space.spaceId, retryable: true };
    }
    return finalizeWorkspaceRemoval(db, {
      commandId: request.commandId,
      projectId: request.projectId,
      spaceId: request.spaceId,
      expectedRevision: request.expectedRevision,
      options,
    });
  } finally {
    releaseRepositoryLock(db, {
      repositoryIdentity: project.repository_identity,
      holder: lockHolder,
      lockId: lock.lockId,
    }, options);
  }
}
