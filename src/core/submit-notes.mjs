import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { beginCommand, canonicalJson, parseCommandResponse } from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';
import { authorizeExistingPath, revalidateAuthorizedPath } from './path-guard.mjs';
import { fileIdentity, gitText } from '../git/probe.mjs';
import { normalizeReferences } from './submit-notes-contract.mjs';
import { readConversationBinding } from './conversation-bindings.mjs';

export { normalizeReferences };

function id(prefix, value) {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

async function resolveGitPath(cwd, value) {
  return realpath(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

export async function resolveAuthorizedSource(db, workingDirectory, options = {}) {
  if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) {
    const error = new Error('MCP working directory is unavailable.');
    error.code = 'PROJECT_NOT_FOUND';
    throw error;
  }

  const candidates = db.prepare(`
    SELECT 'project' AS source_type, projects.id AS project_id, projects.name AS project_name,
           projects.worktree_id AS worktree_id, worktrees.canonical_path AS canonical_path,
           worktrees.repository_identity AS repository_identity,
           worktrees.identity_fingerprint AS identity_fingerprint,
           projects.authorized_root AS authorized_root,
           projects.authorized_root AS project_authorized_root,
           NULL AS space_id, NULL AS space_name
    FROM projects
    JOIN worktrees ON worktrees.id = projects.worktree_id

    UNION ALL

    SELECT 'space' AS source_type, development_spaces.project_id AS project_id, projects.name AS project_name,
           development_spaces.worktree_id AS worktree_id, worktrees.canonical_path AS canonical_path,
           worktrees.repository_identity AS repository_identity,
           worktrees.identity_fingerprint AS identity_fingerprint,
           worktrees.canonical_path AS authorized_root,
           projects.authorized_root AS project_authorized_root,
           development_spaces.id AS space_id, development_spaces.name AS space_name
    FROM development_spaces
    JOIN projects ON projects.id = development_spaces.project_id
    JOIN worktrees ON worktrees.id = development_spaces.worktree_id
    WHERE development_spaces.status != 'archived'

    UNION ALL

    SELECT 'delivery_source' AS source_type, delivery_sources.project_id AS project_id, projects.name AS project_name,
           delivery_sources.worktree_id AS worktree_id, worktrees.canonical_path AS canonical_path,
           worktrees.repository_identity AS repository_identity,
           worktrees.identity_fingerprint AS identity_fingerprint,
           delivery_sources.authorized_root AS authorized_root,
           projects.authorized_root AS project_authorized_root,
           NULL AS space_id, NULL AS space_name
    FROM delivery_sources
    JOIN projects ON projects.id = delivery_sources.project_id
    JOIN worktrees ON worktrees.id = delivery_sources.worktree_id
  `).all();

  const matches = [];
  for (const candidate of candidates) {
    // Do not probe unrelated registrations: their directories may be offline
    // or have moved without affecting the source of this message.
    const relative = path.relative(candidate.canonical_path, path.resolve(workingDirectory));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    let matched = false;
    try {
      const binding = authorizeExistingPath(workingDirectory, candidate.canonical_path);
      revalidateAuthorizedPath(binding);
      matched = true;
    } catch (err) {
      if (['PATH_OUTSIDE_SCOPE', 'PATH_NOT_AUTHORIZED', 'REPARSE_POINT', 'PATH_NOT_FOUND'].includes(err?.code)) {
        matched = false;
      } else {
        throw err;
      }
    }
    if (matched) {
      matches.push(candidate);
    }
  }

  if (matches.length === 0) {
    const error = new Error('当前工作目录未关联已登记的主项目，请先在 UGK Cockpit 确认或添加主项目，或完成项目目录授权。');
    error.code = 'PROJECT_NOT_FOUND';
    error.publicMessage = '当前工作目录未关联已登记的主项目，请先在 UGK Cockpit 确认或添加主项目，或完成项目目录授权。';
    throw error;
  }

  matches.sort((a, b) => b.canonical_path.length - a.canonical_path.length);
  const longest = matches[0].canonical_path.length;
  const bestMatches = matches.filter((c) => c.canonical_path.length === longest);

  const uniqueProjectIds = new Set(bestMatches.map((c) => c.project_id));
  const uniqueWorktreeIds = new Set(bestMatches.map((c) => c.worktree_id));
  if (uniqueProjectIds.size > 1 || uniqueWorktreeIds.size > 1) {
    const error = new Error('当前工作目录对应多个已登记项目，暂时无法确定所属项目。');
    error.code = 'DELIVERY_PROJECT_AMBIGUOUS';
    error.publicMessage = '当前工作目录对应多个已登记项目，暂时无法确定所属项目。请在 UGK Cockpit 平台核对项目对应关系。';
    throw error;
  }

  const selected = bestMatches[0];
  if (options.checkRepositoryIdentity !== false) {
    await assertWorktreeIdentity(selected, options);
  }
  return selected;
}

export async function assertWorktreeIdentity(candidate, options = {}) {
  if (!candidate?.canonical_path) {
    const error = new Error('Candidate canonical_path is missing');
    error.code = 'PROJECT_NOT_FOUND';
    throw error;
  }

  let requestedReal;
  try {
    requestedReal = await realpath(candidate.canonical_path);
  } catch (cause) {
    const error = new Error('当前目录未找到或无法访问。', { cause });
    error.code = 'PROJECT_NOT_FOUND';
    error.publicMessage = '当前目录未找到或无法访问。请先确认目录存在。';
    throw error;
  }

  if (candidate.identity_fingerprint) {
    try {
      const currentWtIdentity = await fileIdentity(requestedReal);
      if (currentWtIdentity.fingerprint !== candidate.identity_fingerprint) {
        const error = new Error('当前目录的代码工作副本身份与已登记记录不一致。');
        error.code = 'WORKTREE_IDENTITY_CHANGED';
        error.publicMessage = '当前目录的代码工作副本身份与已登记记录不一致。已停止操作，避免将记录关联到错误仓库。';
        throw error;
      }
    } catch (err) {
      if (err.code === 'WORKTREE_IDENTITY_CHANGED') throw err;
      const error = new Error('无法核验当前工作副本身份。', { cause: err });
      error.code = 'WORKTREE_IDENTITY_CHANGED';
      throw error;
    }
  }

  const git = options.gitText ?? gitText;
  let worktreeRootValue;
  try {
    worktreeRootValue = await git(candidate.canonical_path, ['rev-parse', '--show-toplevel'], { timeoutMs: 3000 });
  } catch (cause) {
    const error = new Error('当前目录不是有效的 Git 工作副本。', { cause });
    error.code = 'WORKTREE_IDENTITY_CHANGED';
    error.publicMessage = '当前目录不是有效的 Git 工作副本。';
    throw error;
  }

  let worktreeReal;
  try {
    worktreeReal = await resolveGitPath(candidate.canonical_path, (worktreeRootValue || '').trim());
  } catch (cause) {
    const error = new Error('无法解析 Git 顶层目录。', { cause });
    error.code = 'WORKTREE_IDENTITY_CHANGED';
    throw error;
  }

  const sameRoot = process.platform === 'win32'
    ? worktreeReal.toLowerCase() === requestedReal.toLowerCase()
    : worktreeReal === requestedReal;
  if (!sameRoot) {
    const error = new Error('Git 指向了所选文件夹之外的工作目录。');
    error.code = 'WORKTREE_IDENTITY_CHANGED';
    error.publicMessage = 'Git 指向了所选文件夹之外的工作目录。';
    throw error;
  }

  let commonDirValue;
  let gitDirValue;
  let objectDirValue;
  try {
    [commonDirValue, gitDirValue, objectDirValue] = await Promise.all([
      git(candidate.canonical_path, ['rev-parse', '--git-common-dir'], { timeoutMs: 3000 }),
      git(candidate.canonical_path, ['rev-parse', '--git-dir'], { timeoutMs: 3000 }),
      git(candidate.canonical_path, ['rev-parse', '--git-path', 'objects'], { timeoutMs: 3000 }),
    ]);
  } catch (cause) {
    const error = new Error('无法读取 Git 仓库元数据。', { cause });
    error.code = 'WORKTREE_IDENTITY_CHANGED';
    throw error;
  }

  const commonReal = await resolveGitPath(candidate.canonical_path, (commonDirValue || '').trim());
  const gitDirReal = await resolveGitPath(candidate.canonical_path, (gitDirValue || '').trim());
  const objectDirReal = await resolveGitPath(candidate.canonical_path, (objectDirValue || '').trim());

  if (candidate.repository_identity) {
    let repoIdentity;
    try {
      repoIdentity = await fileIdentity(commonReal);
    } catch (cause) {
      const error = new Error('无法读取 Git 仓库公共目录身份。', { cause });
      error.code = 'WORKTREE_IDENTITY_CHANGED';
      throw error;
    }
    if (repoIdentity?.fingerprint !== candidate.repository_identity) {
      const error = new Error('当前目录的代码仓库身份与已登记记录不一致。');
      error.code = 'WORKTREE_IDENTITY_CHANGED';
      error.publicMessage = '当前目录的代码仓库身份与已登记记录不一致。已停止操作，避免将记录关联到错误仓库。';
      throw error;
    }
  }

  const allowedRoots = [
    candidate.canonical_path,
    candidate.authorized_root,
    candidate.project_authorized_root,
  ].filter(Boolean);

  for (const metaPath of [commonReal, gitDirReal, objectDirReal]) {
    let authorized = false;
    for (const root of allowedRoots) {
      try {
        const binding = authorizeExistingPath(metaPath, root);
        revalidateAuthorizedPath(binding);
        authorized = true;
        break;
      } catch {}
    }
    if (!authorized) {
      const error = new Error('Git 元数据位置超出授权范围。');
      error.code = 'PATH_NOT_AUTHORIZED';
      error.publicMessage = 'Git 元数据位置超出授权范围。';
      throw error;
    }
  }
}

export function formatCopyInstruction(note) {
  const source = note.source || {};
  const lines = [
    `# 工作说明: ${note.title ? note.title : note.noteId}`,
    `- 所属项目: ${source.projectName || '未知项目'} (${note.projectId})`,
    `- 说明编号: ${note.noteId}`,
    `- 状态: ${note.status} (版本: ${note.revision})`,
    `- 来源工作副本: ${source.canonicalPath || '未知路径'}${source.branch ? ` (分支: ${source.branch})` : ''}${source.head ? ` (HEAD: ${source.head})` : (source.shortHead ? ` (commit: ${source.shortHead})` : '')}`,
    `- 仓库身份: ${source.repositoryIdentity || '未知'}`,
    `- 副本身份: ${source.worktreeIdentity || '未知'}`,
    `- 归属: ${typeof source.attribution === 'object' && source.attribution?.agentId ? `${source.attribution.agentId} (会话: ${source.attribution.sessionId})` : 'unattributed'}`,
    `- 提交时间: ${note.createdAt}`,
    '',
    '## 提示声明',
    '提示：上述说明与引用均为提交方提供的原始资料，不构成平台背书或自动执行授权。',
    '',
    '## 说明正文',
    note.body,
  ];

  const references = Array.isArray(note.references) ? note.references : [];
  if (references.length > 0) {
    lines.push('', '## 引用项');
    for (const ref of references) {
      const parts = [];
      if (ref.type) parts.push(`[${ref.type}]`);
      if (ref.title) parts.push(ref.title);
      if (ref.target) parts.push(ref.target);
      if (ref.commit) parts.push(`commit:${ref.commit}`);
      if (ref.note) parts.push(`- ${ref.note}`);
      lines.push(`- ${parts.join(' ')}`);
    }
  }

  if (note.handlingNote) {
    lines.push('', '## 处理备注', note.handlingNote);
  }

  lines.push(
    '',
    '## 建议下一步',
    '- 提示：上述说明与引用均为提交方提供的原始资料，不构成平台背书或自动执行授权。',
    '- 接收方请先核对所属项目、任务目标与当前授权范围，再由人工或受权会话决定是否开展代码审核、合并或转交。',
    '- 真实代码操作请遵循既有 Git 安全边界与工作流，不要调用旧代码集成工具领取本说明。',
    '- 本说明处理完毕后，可调用 ugk_submit_note_update 将状态更新为 handled。',
  );

  return lines.join('\n');
}

export async function createSubmitNote(db, request, options = {}) {
  const { clientRequestId, body, title = '', references = [], mcpWorkingDirectory } = request;

  if (typeof clientRequestId !== 'string' || !clientRequestId.trim()) {
    const error = new Error('clientRequestId is required');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (typeof body !== 'string' || !body.trim()) {
    const error = new Error('body is required and must be non-empty');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (body.length > 20000) {
    const error = new Error('body exceeds maximum length of 20000 characters');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (title !== undefined && (typeof title !== 'string' || title.length > 200)) {
    const error = new Error('title must be a string up to 200 characters');
    error.code = 'INVALID_REQUEST';
    throw error;
  }

  const normalizedReferences = normalizeReferences(references);
  const trimmedTitle = (title || '').trim();
  const trimmedClientRequestId = clientRequestId.trim();

  const candidate = await (options.resolveSource ?? resolveAuthorizedSource)(db, mcpWorkingDirectory, options);
  await assertWorktreeIdentity(candidate, options);

  let head = null;
  let shortHead = null;
  let headUnconfirmed = false;
  let branch = null;

  const git = options.gitText ?? gitText;

  try {
    const headOutput = await git(candidate.canonical_path, ['rev-parse', '--verify', 'HEAD'], { timeoutMs: 3000 });
    if (headOutput && /^[0-9a-fA-F]{40}$/.test(headOutput.trim())) {
      head = headOutput.trim();
      shortHead = head.slice(0, 7);
    } else {
      headUnconfirmed = true;
    }
  } catch {
    headUnconfirmed = true;
  }

  try {
    const branchOutput = await git(candidate.canonical_path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 3000 });
    branch = branchOutput ? branchOutput.trim() : null;
  } catch {
    branch = null;
  }

  let attribution = 'unattributed';
  // Resolve after asynchronous probes so a concurrent Relay cannot leave stale attribution.
  // Host identity takes precedence over all client-supplied legacy binding fields.
  let bridgeBinding = options.conversationKey
    ? readConversationBinding(db, options.conversationKey, candidate.worktree_id)
    : request.bridgeBinding;
  if (!options.conversationKey && bridgeBinding?.sessionId
    && db.prepare('SELECT 1 FROM conversation_bindings WHERE session_id = ? AND revoked = 0').get(bridgeBinding.sessionId)) {
    bridgeBinding = null;
  }
  if (!bridgeBinding?.revoked && bridgeBinding?.sessionId && typeof bridgeBinding.sessionId === 'string' && bridgeBinding.worktreeId === candidate.worktree_id) {
    const assignment = db.prepare(`
      SELECT agent_id, session_id, status FROM assignments
      WHERE session_id = ? AND worktree_id = ? AND project_id = ?
    `).get(bridgeBinding.sessionId, candidate.worktree_id, candidate.project_id);

    if (assignment && ['accepted', 'active'].includes(assignment.status)) {
      const run = db.prepare('SELECT lifecycle FROM runs WHERE id = ?').get(bridgeBinding.sessionId);
      if (!run || run.lifecycle === 'active') {
        const latestAcceptedRelay = db.prepare(`
          SELECT id, sequence, accepted_revision FROM relays
          WHERE session_id = ? AND state = 'accepted'
          ORDER BY sequence DESC, accepted_revision DESC LIMIT 1
        `).get(bridgeBinding.sessionId);

        let relayMatched = false;
        if (latestAcceptedRelay) {
          relayMatched = bridgeBinding.relayId === latestAcceptedRelay.id
            && bridgeBinding.relaySequence === latestAcceptedRelay.sequence
            && bridgeBinding.acceptedRevision === latestAcceptedRelay.accepted_revision;
        } else {
          relayMatched = bridgeBinding.relayId === null || bridgeBinding.relayId === undefined;
        }

        if (relayMatched && assignment.agent_id) {
          attribution = {
            type: 'verified_session',
            agentId: assignment.agent_id,
            sessionId: assignment.session_id,
          };
        }
      }
    }
  }

  const semanticRequest = {
    clientRequestId: trimmedClientRequestId,
    projectId: candidate.project_id,
    originWorktreeId: candidate.worktree_id,
    body,
    title: trimmedTitle,
    references: normalizedReferences,
  };

  const commandId = id('submit_note', `${candidate.worktree_id}:${trimmedClientRequestId}`);
  const kind = 'submit_note';

  const response = withImmediateTransaction(db, () => {
    const { command, fresh } = beginCommand(db, {
      commandId,
      kind,
      request: semanticRequest,
      inTransaction: true,
    });

    if (!fresh) {
      if (command.state === 'committed') {
        return parseCommandResponse(command);
      }
      if (command.state === 'failed') {
        const parsed = parseCommandResponse(command);
        const err = new Error(parsed?.message || 'Previous command failed');
        err.code = parsed?.code || 'REQUEST_FAILED';
        throw err;
      }
    }

    const noteId = id('note', `${candidate.project_id}:${candidate.worktree_id}:${trimmedClientRequestId}`);
    const now = new Date().toISOString();

    const sourceSnapshot = {
      projectId: candidate.project_id,
      projectName: candidate.project_name,
      worktreeId: candidate.worktree_id,
      worktreeType: candidate.source_type,
      spaceId: candidate.space_id ?? null,
      spaceName: candidate.space_name ?? null,
      canonicalPath: candidate.canonical_path,
      authorizedRoot: candidate.authorized_root,
      repositoryIdentity: candidate.repository_identity ?? null,
      worktreeIdentity: candidate.identity_fingerprint ?? null,
      branch,
      head,
      shortHead,
      headUnconfirmed,
      attribution,
      observedAt: now,
    };

    const receiptId = id('receipt_note', `${noteId}:${trimmedClientRequestId}`);
    const receipt = {
      receiptId,
      commandId,
      clientRequestId: trimmedClientRequestId,
      createdAt: now,
      updatedAt: now,
    };

    const copyText = formatCopyInstruction({
      noteId,
      projectId: candidate.project_id,
      projectName: candidate.project_name,
      title: trimmedTitle,
      body,
      status: 'pending',
      revision: 1,
      source: sourceSnapshot,
      references: normalizedReferences,
      createdAt: now,
    });

    const resp = {
      ok: true,
      noteId,
      projectId: candidate.project_id,
      revision: 1,
      status: 'pending',
      title: trimmedTitle,
      body,
      references: normalizedReferences,
      source: sourceSnapshot,
      receipt,
      copyText,
      createdAt: now,
      updatedAt: now,
    };

    db.prepare(`
      INSERT INTO submit_notes (
        id, project_id, command_id, title, body, status, revision,
        source_json, references_json, handling_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, ?, '', ?, ?)
    `).run(
      noteId,
      candidate.project_id,
      commandId,
      trimmedTitle,
      body,
      JSON.stringify(sourceSnapshot),
      JSON.stringify(normalizedReferences),
      now,
      now,
    );

    db.prepare(`
      UPDATE commands
      SET state = 'committed', response_json = ?, updated_at = ?
      WHERE id = ? AND state = 'received'
    `).run(canonicalJson(resp), now, commandId);

    return resp;
  });

  options.faultInjector?.('submit_note.after_transaction_commit_before_return');

  return response;
}

export async function readSubmitNote(db, request, options = {}) {
  const { noteId, mcpWorkingDirectory } = request;
  if (typeof noteId !== 'string' || !noteId.trim()) {
    const error = new Error('noteId is required');
    error.code = 'INVALID_REQUEST';
    throw error;
  }

  const skipPathCheck = Boolean(options.skipPathCheck);
  let authorizedProject = null;
  if (!skipPathCheck) {
    authorizedProject = await (options.resolveSource ?? resolveAuthorizedSource)(db, mcpWorkingDirectory, options);
  }

  const row = db.prepare('SELECT * FROM submit_notes WHERE id = ?').get(noteId.trim());
  if (!row) {
    const error = new Error('没有找到这条工作说明。');
    error.code = 'NOTE_NOT_FOUND';
    error.publicMessage = '没有找到这条工作说明。请确认说明编号是否正确。';
    throw error;
  }

  if (authorizedProject && row.project_id !== authorizedProject.project_id) {
    const error = new Error('无权跨项目读取工作说明。');
    error.code = 'PROJECT_MISMATCH';
    error.publicMessage = '无权跨项目查看或更新工作说明。请切换到所属项目工作目录。';
    throw error;
  }

  const source = JSON.parse(row.source_json || '{}');
  const references = JSON.parse(row.references_json || '[]');

  const note = {
    noteId: row.id,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
    status: row.status,
    revision: row.revision,
    handlingNote: row.handling_note,
    source,
    references,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    handledAt: row.handled_at,
    archivedAt: row.archived_at,
  };

  return {
    ok: true,
    note,
    copyText: formatCopyInstruction(note),
  };
}

export async function updateSubmitNote(db, request, options = {}) {
  const {
    noteId,
    clientRequestId,
    expectedRevision,
    status,
    handlingNote,
    mcpWorkingDirectory,
  } = request;

  if (typeof noteId !== 'string' || !noteId.trim()) {
    const error = new Error('noteId is required');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (typeof clientRequestId !== 'string' || !clientRequestId.trim()) {
    const error = new Error('clientRequestId is required');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    const error = new Error('expectedRevision must be a positive integer');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (!['pending', 'handled', 'archived'].includes(status)) {
    const error = new Error("status must be 'pending', 'handled', or 'archived'");
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (handlingNote !== undefined && (typeof handlingNote !== 'string' || handlingNote.length > 4000)) {
    const error = new Error('handlingNote must be a string up to 4000 characters');
    error.code = 'INVALID_REQUEST';
    throw error;
  }

  const trimmedNoteId = noteId.trim();
  const trimmedClientRequestId = clientRequestId.trim();

  // Authorize project BEFORE idempotency check or replay!
  const skipPathCheck = Boolean(options.skipPathCheck);
  let authorizedProject = null;
  if (!skipPathCheck) {
    authorizedProject = await (options.resolveSource ?? resolveAuthorizedSource)(db, mcpWorkingDirectory, options);
  }

  const row = db.prepare('SELECT * FROM submit_notes WHERE id = ?').get(trimmedNoteId);
  if (!row) {
    const error = new Error('没有找到这条工作说明。');
    error.code = 'NOTE_NOT_FOUND';
    error.publicMessage = '没有找到这条工作说明。请确认说明编号是否正确。';
    throw error;
  }

  if (authorizedProject && row.project_id !== authorizedProject.project_id) {
    const error = new Error('无权跨项目更新工作说明。');
    error.code = 'PROJECT_MISMATCH';
    error.publicMessage = '无权跨项目查看或更新工作说明。请切换到所属项目工作目录。';
    throw error;
  }

  const commandId = id('submit_note_update', `${row.project_id}:${trimmedNoteId}:${trimmedClientRequestId}`);
  const kind = 'submit_note_update';
  const semanticRequest = {
    noteId: trimmedNoteId,
    clientRequestId: trimmedClientRequestId,
    expectedRevision,
    status,
    ...(handlingNote !== undefined ? { handlingNote } : {}),
  };

  const response = withImmediateTransaction(db, () => {
    const { command, fresh } = beginCommand(db, {
      commandId,
      kind,
      request: semanticRequest,
      inTransaction: true,
    });

    if (!fresh) {
      if (command.state === 'committed') {
        return parseCommandResponse(command);
      }
      if (command.state === 'failed') {
        const parsed = parseCommandResponse(command);
        const err = new Error(parsed?.message || 'Previous update failed');
        err.code = parsed?.code || 'REQUEST_FAILED';
        throw err;
      }
    }

    const currentRow = db.prepare('SELECT * FROM submit_notes WHERE id = ?').get(trimmedNoteId);
    if (currentRow.revision !== expectedRevision) {
      const error = new Error(`Note revision conflict: current is ${currentRow.revision}, expected ${expectedRevision}`);
      error.code = 'NOTE_REVISION_CONFLICT';
      error.publicMessage = '这条工作说明刚刚被其他操作更新。请重新获取最新版本后重试。';
      error.currentRevision = currentRow.revision;
      error.expectedRevision = expectedRevision;
      throw error;
    }

    const now = new Date().toISOString();
    const nextRevision = currentRow.revision + 1;
    const handledAt = status === 'handled' ? (currentRow.handled_at || now) : currentRow.handled_at;
    const archivedAt = status === 'archived' ? (currentRow.archived_at || now) : currentRow.archived_at;
    const newHandlingNote = handlingNote !== undefined ? handlingNote : currentRow.handling_note;

    const updateResult = db.prepare(`
      UPDATE submit_notes
      SET status = ?,
          handling_note = ?,
          revision = ?,
          updated_at = ?,
          handled_at = ?,
          archived_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      status,
      newHandlingNote,
      nextRevision,
      now,
      handledAt,
      archivedAt,
      trimmedNoteId,
      expectedRevision,
    );

    if (updateResult.changes === 0) {
      const error = new Error('Revision CAS failed on submit_notes update');
      error.code = 'NOTE_REVISION_CONFLICT';
      throw error;
    }

    const resp = {
      ok: true,
      noteId: currentRow.id,
      projectId: currentRow.project_id,
      status,
      revision: nextRevision,
      handlingNote: newHandlingNote,
      createdAt: currentRow.created_at,
      updatedAt: now,
      handledAt,
      archivedAt,
    };

    db.prepare(`
      UPDATE commands
      SET state = 'committed', response_json = ?, updated_at = ?
      WHERE id = ? AND state = 'received'
    `).run(canonicalJson(resp), now, commandId);

    return resp;
  });

  options.faultInjector?.('submit_note_update.after_transaction_commit_before_return');

  return response;
}

export function listSubmitNotes(db, { projectId, limit = 50, offset = 0, status = null } = {}) {
  if (!projectId) return [];
  let query = 'SELECT * FROM submit_notes WHERE project_id = ?';
  const params = [projectId];
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }
  query += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
  params.push(Math.max(1, Math.min(100, limit)), Math.max(0, offset));

  const rows = db.prepare(query).all(...params);
  return rows.map((row) => {
    const note = {
      noteId: row.id,
      projectId: row.project_id,
      title: row.title,
      body: row.body,
      status: row.status,
      revision: row.revision,
      handlingNote: row.handling_note,
      source: JSON.parse(row.source_json || '{}'),
      references: JSON.parse(row.references_json || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      handledAt: row.handled_at,
      archivedAt: row.archived_at,
    };
    return {
      ...note,
      copyText: formatCopyInstruction(note),
    };
  });
}
