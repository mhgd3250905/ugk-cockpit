import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { openCockpitDatabase } from '../core/database.mjs';
import { beginCommand, parseCommandResponse } from '../core/command-journal.mjs';
import { authorizeExistingPath, revalidateAuthorizedPath } from '../core/path-guard.mjs';
import { finishRun, startWriteRun } from '../core/runs.mjs';
import { probeGitWorktree } from '../git/probe.mjs';
import { VERSION } from '../version.mjs';

const MAX_BODY_BYTES = 64 * 1024;

const PUBLIC_ERRORS = {
  AUTH_REQUIRED: {
    status: 401,
    message: '本地控制台身份已失效。',
    impact: '代码和已有记录都没有被修改。',
    requiredAction: '请关闭当前页面后重新打开 UGK Cockpit。',
  },
  ORIGIN_REJECTED: {
    status: 403,
    message: '已拒绝来自其他网页的控制请求。',
    impact: '代码和 Cockpit 记录都没有被修改。',
    requiredAction: '请只在 UGK Cockpit 本地页面中执行这个操作。',
  },
  REQUEST_TOO_LARGE: {
    status: 413,
    message: '这次提交的内容过大，无法安全处理。',
    impact: '代码和已有记录都没有被修改。',
    requiredAction: '请缩短说明或移除大段日志后重试。',
  },
  INVALID_REQUEST: {
    status: 400,
    message: '提交的信息不完整或格式不正确。',
    impact: '代码和已有记录都没有被修改。',
    requiredAction: '请返回上一页检查必填项后重试。',
  },
  PATH_NOT_AUTHORIZED: {
    status: 403,
    message: '这个文件夹还没有获得访问授权。',
    impact: 'Cockpit 没有读取或修改该文件夹。',
    requiredAction: '请重新选择项目文件夹并确认授权。',
  },
  RUN_NOT_FOUND: {
    status: 404,
    message: '找不到这次 AI 工作会话。',
    impact: '代码和已有记录都没有被修改。',
    requiredAction: '请返回项目页，选择仍然存在的工作会话。',
  },
  WRITE_LEASE_CONFLICT: {
    status: 409,
    message: '另一个 AI 正在编辑这份代码。',
    impact: '本次操作没有修改代码，也没有启动第二个写入会话。',
    requiredAction: '建议先只读查看；如需接管，请由你明确确认。',
  },
  RUN_REVISION_CONFLICT: {
    status: 409,
    message: '这次 AI 工作会话刚刚发生了变化。',
    impact: '本次操作没有覆盖新的状态。',
    requiredAction: '请刷新当前会话，确认最新状态后重试。',
  },
  STALE_WRITE_LEASE: {
    status: 409,
    message: '这次 AI 工作会话已经被接管。',
    impact: '旧会话的写入被拒绝，当前记录没有被覆盖。',
    requiredAction: '请切换到新的工作会话继续。',
  },
  INCOHERENT_FINAL_SNAPSHOT: {
    status: 409,
    message: '结束检查时代码仍在变化，暂时不能标记为完成。',
    impact: '代码没有被 Cockpit 修改，本次会话仍保留为进行中。',
    requiredAction: '请等待其他修改结束，刷新状态后再次结束。',
  },
  WORKTREE_IDENTITY_CHANGED: {
    status: 409,
    message: '这个文件夹已经不是开始工作时的那份代码。',
    impact: 'Cockpit 已停止结束操作，历史记录没有重新绑定到新仓库。',
    requiredAction: '请返回项目页确认正确的代码位置；重新绑定必须由你确认。',
  },
  BRANCH_CHANGED_DURING_RUN: {
    status: 409,
    message: '工作期间切换了代码工作线。',
    impact: '本次会话暂未标记为完成，代码没有被 Cockpit 修改。',
    requiredAction: '请确认当前工作线是否正确，然后重新检查并结束。',
  },
  FOREIGN_HEAD_CHANGE: {
    status: 409,
    message: '工作期间出现了未确认来源的代码保存点。',
    impact: '本次会话暂未标记为完成，也没有覆盖任何代码。',
    requiredAction: '请查看新的代码保存点；确认属于本次工作后再重新结束。',
  },
  UNATTRIBUTED_CHANGES_REQUIRE_CONFIRMATION: {
    status: 409,
    message: '发现了还不能确认由谁产生的本地改动。',
    impact: '这些改动被完整保留，但不会自动算给当前 AI。',
    requiredAction: '请查看改动并确认是否纳入本次工作记录。',
  },
  COMMAND_CONFLICT: {
    status: 409,
    message: '这个操作编号已经用于另一项操作。',
    impact: '原记录保持不变，新请求没有执行。',
    requiredAction: '请刷新页面后重新执行，系统会生成新的操作编号。',
  },
  NOT_FOUND: {
    status: 404,
    message: '没有找到这个本地操作。',
    impact: '代码和已有记录都没有被修改。',
    requiredAction: '请返回上一页，使用页面中提供的操作按钮。',
  },
  REQUEST_FAILED: {
    status: 400,
    message: '本地操作没有完成。',
    impact: 'Cockpit 没有确认保存成功，代码不会被自动清理或覆盖。',
    requiredAction: '请刷新状态后重试；如果仍然失败，请保留当前代码并查看技术详情。',
  },
  DATABASE_BUSY: {
    status: 503,
    message: '本地记录正在被另一项操作占用。',
    impact: '本次操作没有确认保存成功，代码没有被修改。',
    requiredAction: '请稍等片刻后重试；不要重复启动另一个 Cockpit 服务。',
  },
  GIT_METADATA_TOO_LARGE: {
    status: 409,
    message: '这份代码的 Git 配置超出了安全读取范围。',
    impact: 'Cockpit 已停止读取，没有修改代码或已有记录。',
    requiredAction: '请在技术详情中检查 Git alternates 配置，确认后再重试。',
  },
};

function id(prefix, value) {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

function sendError(response, code, { commandId = null, extra = {} } = {}) {
  const definition = PUBLIC_ERRORS[code] ?? PUBLIC_ERRORS.REQUEST_FAILED;
  sendJson(response, definition.status, {
    code: PUBLIC_ERRORS[code] ? code : 'REQUEST_FAILED',
    message: definition.message,
    impact: definition.impact,
    required_action: definition.requiredAction,
    next_command: null,
    warnings: [],
    command_id: commandId,
    ...extra,
  });
}

function requireString(body, field) {
  if (typeof body?.[field] !== 'string' || body[field].trim() === '') {
    const error = new Error(`Missing ${field}`);
    error.code = 'INVALID_REQUEST';
    throw error;
  }
}

function validateStartBody(body) {
  requireString(body, 'commandId');
  requireString(body, 'worktreePath');
  requireString(body, 'agentClaim');
  requireString(body, 'goal');
}

function validateFinishBody(body) {
  requireString(body, 'commandId');
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) {
    const error = new Error('Invalid expectedRevision');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (!Number.isInteger(body.leaseGeneration) || body.leaseGeneration < 1) {
    const error = new Error('Invalid leaseGeneration');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (!['completed', 'blocked', 'abandoned'].includes(body.outcome)) {
    const error = new Error('Invalid outcome');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (body.summary !== undefined && typeof body.summary !== 'string') {
    const error = new Error('Invalid summary');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (
    body.commitRefs !== undefined
    && (!Array.isArray(body.commitRefs) || body.commitRefs.some((value) => typeof value !== 'string'))
  ) {
    const error = new Error('Invalid commitRefs');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (
    body.acknowledgeUnattributed !== undefined
    && typeof body.acknowledgeUnattributed !== 'boolean'
  ) {
    const error = new Error('Invalid acknowledgeUnattributed');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.');
      error.code = 'REQUEST_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function tokenMatches(actual, expected) {
  if (!actual?.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(actual.slice(7));
  const reference = Buffer.from(expected);
  return candidate.length === reference.length && timingSafeEqual(candidate, reference);
}

function allowedOrigin(origin, port) {
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function toSnapshot(probe) {
  return {
    head: probe.after.head,
    branch: probe.after.branch,
    indexFingerprint: probe.after.indexFingerprint,
    worktreeFingerprint: probe.after.worktreeFingerprint,
    repositoryIdentity: probe.repositoryIdentity,
    worktreeIdentity: probe.worktreeIdentity,
    headRelation: probe.headRelation,
    coherence: probe.coherence,
    observedAt: probe.observedAt,
  };
}

function findGrant(candidatePath, roots) {
  for (const root of roots) {
    try {
      return authorizeExistingPath(candidatePath, root);
    } catch {
      // Continue through explicit grants; the final failure stays fail-closed.
    }
  }
  const error = new Error('这个文件夹还没有获得访问授权。');
  error.code = 'PATH_NOT_AUTHORIZED';
  throw error;
}

function authorizeObservation(observation, roots) {
  const paths = [
    observation.canonicalPath,
    observation.repositoryCommonDir,
    observation.gitDirectory,
    observation.indexPath,
    ...(observation.objectDirectories ?? []),
  ];
  for (const candidatePath of paths) {
    const binding = findGrant(candidatePath, roots);
    revalidateAuthorizedPath(binding);
  }
}

export async function createCockpitHttpServer({
  dbPath,
  token,
  authorizedRoots = [],
  host = '127.0.0.1',
  port = 0,
  probe = probeGitWorktree,
  faultInjector,
}) {
  if (!token || token.length < 32) throw new Error('A local API token of at least 32 characters is required.');
  const db = openCockpitDatabase(dbPath);
  db.prepare(`
    UPDATE runs SET health = 'recovery_uncertain'
    WHERE lifecycle = 'active'
  `).run();

  const server = createServer(async (request, response) => {
    try {
      const currentPort = server.address().port;
      const url = new URL(request.url, `http://${host}:${currentPort}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          status: 'ok',
          version: VERSION,
          now: new Date().toISOString(),
        });
        return;
      }

      if (!allowedOrigin(request.headers.origin, currentPort)) {
        sendError(response, 'ORIGIN_REJECTED');
        return;
      }
      if (!tokenMatches(request.headers.authorization, token)) {
        sendError(response, 'AUTH_REQUIRED');
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/runs/start') {
        const body = await readJson(request);
        validateStartBody(body);
        const runId = body.runId ?? id('run', body.commandId);
        const commandPayload = { ...body, runId };
        const binding = findGrant(body.worktreePath, authorizedRoots);
        revalidateAuthorizedPath(binding);
        const begun = beginCommand(db, {
          commandId: body.commandId,
          kind: 'run.start',
          request: commandPayload,
          runId,
        });
        if (begun.command.state === 'committed' || begun.command.state === 'failed') {
          const replay = parseCommandResponse(begun.command);
          if (replay.ok) sendJson(response, 200, replay);
          else sendError(response, replay.code, {
            commandId: body.commandId,
            extra: { run_id: replay.runId ?? null, active_run_id: replay.activeRunId ?? null },
          });
          return;
        }
        const observation = await probe(binding.candidateReal);
        revalidateAuthorizedPath(binding);
        authorizeObservation(observation, authorizedRoots);
        const result = startWriteRun(db, {
          commandId: body.commandId,
          commandPayload,
          runId,
          worktreeId: id('worktree', observation.worktreeIdentity),
          canonicalPath: observation.canonicalPath,
          repositoryIdentity: observation.repositoryIdentity,
          worktreeIdentity: observation.worktreeIdentity,
          agentClaim: body.agentClaim,
          goal: body.goal,
          baseline: toSnapshot(observation),
        }, { faultInjector });
        if (result.ok) sendJson(response, 201, result);
        else sendError(response, result.code, {
          commandId: body.commandId,
          extra: { run_id: result.runId ?? null, active_run_id: result.activeRunId ?? null },
        });
        return;
      }

      const finishMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/finish$/);
      if (request.method === 'POST' && finishMatch) {
        const runId = decodeURIComponent(finishMatch[1]);
        const body = await readJson(request);
        validateFinishBody(body);
        const row = db.prepare(`
          SELECT worktrees.canonical_path,
                 worktrees.repository_identity,
                 worktrees.identity_fingerprint,
                 snapshots.head AS baseline_head
          FROM runs JOIN worktrees ON worktrees.id = runs.worktree_id
          JOIN snapshots ON snapshots.run_id = runs.id AND snapshots.phase = 'baseline'
          WHERE runs.id = ?
        `).get(runId);
        if (!row) {
          sendError(response, 'RUN_NOT_FOUND', {
            commandId: body.commandId,
            extra: { run_id: runId },
          });
          return;
        }
        const binding = findGrant(row.canonical_path, authorizedRoots);
        revalidateAuthorizedPath(binding);
        const commandPayload = { ...body, runId };
        const begun = beginCommand(db, {
          commandId: body.commandId,
          kind: 'run.finish',
          request: commandPayload,
          runId,
        });
        if (begun.command.state === 'committed' || begun.command.state === 'failed') {
          const replay = parseCommandResponse(begun.command);
          if (replay.ok) sendJson(response, 200, replay);
          else sendError(response, replay.code, {
            commandId: body.commandId,
            extra: { run_id: runId, receipt_id: replay.receiptId ?? null },
          });
          return;
        }
        const observation = await probe(binding.candidateReal, {
          expectedBaselineHead: row.baseline_head,
        });
        revalidateAuthorizedPath(binding);
        authorizeObservation(observation, authorizedRoots);
        const result = finishRun(db, {
          commandId: body.commandId,
          commandPayload,
          runId,
          expectedRevision: body.expectedRevision,
          leaseGeneration: body.leaseGeneration,
          outcome: body.outcome,
          summary: body.summary ?? '',
          finalSnapshot: toSnapshot(observation),
        }, { faultInjector });
        if (result.ok) sendJson(response, 200, result);
        else sendError(response, result.code, {
          commandId: body.commandId,
          extra: { run_id: runId, receipt_id: result.receiptId ?? null },
        });
        return;
      }

      sendError(response, 'NOT_FOUND');
    } catch (error) {
      const sqliteBusy = (
        error?.code === 'ERR_SQLITE_ERROR'
        && /busy|locked/i.test(error?.message ?? '')
      );
      const code = error instanceof SyntaxError
        ? 'INVALID_REQUEST'
        : (sqliteBusy ? 'DATABASE_BUSY' : error?.code);
      sendError(response, PUBLIC_ERRORS[code] ? code : 'REQUEST_FAILED');
    }
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    host,
    port: server.address().port,
    async close() {
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      db.close();
    },
  };
}
