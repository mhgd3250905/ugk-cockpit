import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  beginCommand,
  canonicalJson,
  parseCommandResponse,
  readCommand,
} from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';
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
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
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
