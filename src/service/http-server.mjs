import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCockpitDatabase, withImmediateTransaction } from '../core/database.mjs';
import {
  acceptAssignment,
  beginAssignmentWork,
  completeAssignment,
  createAssignment,
  issueDispatchGrant,
  readDispatchContext,
  readSessionContext,
  reassignPendingAssignment,
  recordProgress,
} from '../core/assignments.mjs';
import { FolderGrantStore } from '../core/folder-grants.mjs';
import { createHandoff, readLatestHandoff } from '../core/handoffs.mjs';
import { createRelay, resumeRelay } from '../core/relays.mjs';
import { beginCommand, parseCommandResponse, readCommand } from '../core/command-journal.mjs';
import { authorizeExistingPath, revalidateAuthorizedPath } from '../core/path-guard.mjs';
import { readDashboard, readProjectContext, registerProject } from '../core/projects.mjs';
import { readProjectDetail, readProjectTimeline } from '../core/timeline.mjs';
import { finishRun, startWriteRun } from '../core/runs.mjs';
import { probeGitWorktree } from '../git/probe.mjs';
import { selectFolder } from '../platform/select-folder.mjs';
import { serveWebAsset } from './web-assets.mjs';
import { VERSION } from '../version.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const MCP_SESSION_LIMIT = 64;
const MCP_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../dist/web', import.meta.url));

class AtomicHandoffAbort extends Error {
  constructor(result) {
    super(result?.code ?? 'REQUEST_FAILED');
    this.name = 'AtomicHandoffAbort';
    this.result = result;
  }
}

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
  FOLDER_GRANT_EXPIRED: {
    status: 409,
    message: '这次文件夹选择已经过期。',
    impact: '没有添加项目，也没有修改文件。',
    requiredAction: '请重新点击“选择项目文件夹”，再选择一次。',
  },
  FOLDER_PICKER_UNAVAILABLE: {
    status: 503,
    message: '暂时无法打开系统文件夹选择器。',
    impact: '没有添加项目，也没有修改文件。',
    requiredAction: '请稍后重试；当前不需要手动填写路径。',
  },
  FOLDER_PICKER_TIMEOUT: {
    status: 504,
    message: '系统选择器没有正常返回。',
    impact: '没有添加项目，也没有修改文件。',
    requiredAction: '请重新点击“选择项目文件夹”；如果窗口被其他应用遮住，请从任务栏切换到它。',
  },
  FOLDER_NOT_CODE_PROJECT: {
    status: 422,
    message: '这个文件夹里没有找到可识别的代码项目。',
    impact: '没有添加项目，也没有修改文件。',
    requiredAction: '请重新选择包含项目代码的文件夹。',
  },
  REPARSE_POINT: {
    status: 400,
    message: '这个文件夹经过了 Windows 链接，无法安全确认实际位置。',
    impact: 'Cockpit 已停止读取，没有添加项目，也没有修改文件。',
    requiredAction: '请重新选择项目的真实文件夹，而不是它的快捷方式或链接。',
  },
  FOLDER_GRANT_IN_USE: {
    status: 409,
    message: '这次文件夹选择正在用于另一项添加操作。',
    impact: '没有重复添加项目，也没有修改文件。',
    requiredAction: '请等待当前操作完成，或重新选择项目文件夹。',
  },
  FOLDER_SELECTION_CHANGED: {
    status: 409,
    message: '确认前，这个文件夹里的代码已经发生了身份变化。',
    impact: 'Cockpit 已停止添加，没有把新代码绑定到旧选择。',
    requiredAction: '请重新选择文件夹并确认当前看到的项目。',
  },
  CLIENT_ID_REQUIRED: {
    status: 401,
    message: '这个浏览器的本地身份已经失效。',
    impact: '没有执行写入，代码和已有记录都不受影响。',
    requiredAction: '请刷新 UGK Cockpit 页面后重试。',
  },
  PROJECT_LOCATION_CHANGED: {
    status: 409,
    message: '这份代码的位置与已有记录不一致。',
    impact: 'Cockpit 没有自动改变绑定，也没有修改代码。',
    requiredAction: '请从原项目卡片进入“重新选择位置”并确认。',
  },
  PROJECT_NOT_FOUND: {
    status: 404,
    message: '找不到这个项目。',
    impact: '没有创建任务，也没有修改代码。',
    requiredAction: '请刷新首页后从现有项目重新发起。',
  },
  DISPATCH_CODE_INVALID: {
    status: 404,
    message: '这个接手码无效。',
    impact: '没有接手任务，也没有修改代码。',
    requiredAction: '请从 Cockpit 页面重新复制接手消息。',
  },
  DISPATCH_GRANT_EXPIRED: {
    status: 409,
    message: '这次接手码已经过期。',
    impact: '任务仍未被接手，代码没有受到影响。',
    requiredAction: '请在 Cockpit 页面重新分配并复制新消息。',
  },
  DISPATCH_GRANT_REVOKED: {
    status: 409,
    message: '这次接手已经被撤销。',
    impact: '旧接手码不能再更新任务，代码没有受到影响。',
    requiredAction: '请使用 Cockpit 页面最新生成的接手消息。',
  },
  DISPATCH_GRANT_ALREADY_ACCEPTED: {
    status: 409,
    message: '这项任务已经被另一条 AI 会话接手。',
    impact: '没有启动第二条写入会话，已有工作记录保持不变。',
    requiredAction: '请回到 Cockpit 查看当前接手者；接管必须由你确认。',
  },
  ASSIGNMENT_REVISION_CONFLICT: {
    status: 409,
    message: '这项任务已经有更新的进展。',
    impact: '旧进度没有覆盖新记录，代码没有被 Cockpit 修改。',
    requiredAction: '请使用工具返回的最新 revision 后重试。',
  },
  HANDOFF_REVISION_CONFLICT: {
    status: 409,
    message: '生成交接时发现这项工作已有更新。',
    impact: '旧内容没有覆盖新记录，代码没有被 Cockpit 修改。',
    requiredAction: '请使用工具返回的最新 revision 重新生成交接。',
  },
  SESSION_NOT_FOUND: {
    status: 404,
    message: '找不到这次 AI 工作会话。',
    impact: '没有写入进展，也没有修改代码。',
    requiredAction: '请先使用接手消息成功接手任务。',
  },
  SESSION_NOT_ACTIVE: {
    status: 409,
    message: '这次 AI 工作会话已经不在进行中。',
    impact: '没有创建接力，也没有修改代码。',
    requiredAction: '请刷新项目状态，确认当前仍在使用的工作会话。',
  },
  RELAY_CODE_INVALID: {
    status: 404,
    message: '这个接力码无效。',
    impact: '没有切换工作会话，也没有修改代码。',
    requiredAction: '请从上一条 AI 会话复制最新的接力消息。',
  },
  RELAY_EXPIRED: {
    status: 409,
    message: '这次接力码已经过期。',
    impact: '原 AI 工作会话仍保留其已有记录；没有创建新的会话。',
    requiredAction: '请回到 Cockpit 确认当前会话，必要时由用户重新安排接力。',
  },
  RELAY_ALREADY_ACCEPTED: {
    status: 409,
    message: '这次接力已经被另一个 AI 会话接收。',
    impact: '没有创建第二个工作会话，也没有释放当前写入权限。',
    requiredAction: '请使用已经接收接力的会话继续；如需接管，请由用户明确确认。',
  },
  RELAY_ALREADY_WAITING: {
    status: 409,
    message: '这次工作会话已经在等待新的 AI 会话继续。',
    impact: '没有创建重复接力，当前写入会话和代码都保持不变。',
    requiredAction: '请使用 Cockpit 已生成的接力消息，或先确认当前状态。',
  },
  RELAY_REQUEST_CONFLICT: {
    status: 409,
    message: '这个接力请求编号已经用于另一份接力内容。',
    impact: '原有接力记录和代码都没有被覆盖。',
    requiredAction: '请生成新的 clientRequestId，并确认最新 revision。',
  },
  RELAY_REVISION_CONFLICT: {
    status: 409,
    message: '这次接力对应的工作状态刚刚发生了变化。',
    impact: '没有覆盖新的进展，工作会话和写入权限保持原状。',
    requiredAction: '请读取最新 revision 后重新记录接力。',
  },
  RELAY_BINDING_MISMATCH: {
    status: 409,
    message: '当前 AI 会话所在的代码位置与接力记录不一致。',
    impact: '没有接受接力，也没有修改代码或项目绑定。',
    requiredAction: '请在原项目目录中重试，不要手动改写路径绑定。',
  },
  RELAY_TTL_TOO_LONG: {
    status: 400,
    message: '接力码有效期超过安全上限。',
    impact: '没有创建接力，也没有修改代码。',
    requiredAction: '请使用较短的有效期后重试。',
  },
};

function id(prefix, value) {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function relayContinueCode(apiToken, sessionId, clientRequestId) {
  return createHmac('sha256', apiToken)
    .update(`relay:${sessionId}:${clientRequestId}`)
    .digest('base64url');
}

function assignmentDispatchMessage({ mode, dispatchCode, agent, task }) {
  if (mode === 'init') {
    const target = typeof task === 'string' && task.trim() ? task.trim() : null;
    return [
      '请使用 `$cockpit-init` 把当前项目接入 UGK Cockpit，并在成功后直接开始工作。',
      `一次性 initCode: "${dispatchCode}"。`,
      target ? `当前目标：${target}` : '当前没有额外目标，请按当前对话继续工作。',
      '成功后直接进入 working；不要清理、覆盖或重置已有改动。',
      '后续可用 `$cockpit-progress` 自动记录有效检查点；只有用户明确要求换 AI 会话时才调用 `$cockpit-relay`。',
      '只有用户明确要求结束当前阶段时，才用 `$cockpit-handoff` 生成标准交接手册；普通功能完成不会触发阶段结束交接。',
      '如果 Agent 不支持这个 Skill，可改用 UGK Cockpit MCP 完成同一 init；不要传路径或本地 token。',
      '如果工具报告项目不匹配或已有写入会话，请停止并告诉用户，不要强行接管。',
    ].join('\n');
  }
  if (mode === 'handoff') {
    return [
      '请使用 UGK Cockpit MCP 接上这个项目的上下文。',
      `调用 ugk_work_accept(dispatchCode: "${dispatchCode}", clientRequestId: 你生成的唯一请求号)。`,
      '读取工具返回的 latestHandoff，简要告诉用户你理解的现状，然后等待后续安排。',
      '此时不要修改代码；收到明确任务后先调用 ugk_work_begin，再开始工作。',
      '如果 MCP 工具不可用或接手失败，不要声称已经读取交接或开始工作。',
    ].join('\n');
  }
  return [
    `请使用 UGK Cockpit MCP 接手这项任务：${task}`,
    `先调用 ugk_work_accept(dispatchCode: "${dispatchCode}", clientRequestId: 你生成的唯一请求号)，成功后再修改代码。`,
    '工作中可调用 `$cockpit-progress`（ugk_work_progress）记录检查点；只有用户明确要求换 AI 会话时才调用 `$cockpit-relay`（ugk_work_relay）。',
    '只有用户明确要求结束当前阶段时，才调用 `$cockpit-handoff`（ugk_work_handoff）；普通功能完成不会触发阶段结束交接。',
    '如果 MCP 工具不可用或接手失败，不要声称已经接手或完成。',
  ].join('\n');
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

function validateAssignmentBody(body) {
  requireString(body, 'clientRequestId');
  requireString(body, 'agent');
  requireString(body, 'mode');
  if (body.mode === 'task') requireString(body, 'task');
  if (!['Codex', 'ZCode', 'Antigravity'].includes(body.agent)
    || !['handoff', 'task', 'init'].includes(body.mode)
    || (body.task !== undefined && (typeof body.task !== 'string' || body.task.length > 1000))) {
    const error = new Error('Invalid assignment request.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
}

function validateMcpProgressBody(body) {
  requireString(body, 'sessionId');
  requireString(body, 'clientRequestId');
  requireString(body, 'status');
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) {
    const error = new Error('Invalid progress request.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  const allowedKeys = new Set(['sessionId', 'clientRequestId', 'expectedRevision', 'status', 'summary', 'details', 'note']);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      const error = new Error(`Unexpected progress property: ${key}`);
      error.code = 'INVALID_REQUEST';
      throw error;
    }
  }
  let hasSummary = false;
  if (body.summary !== undefined) {
    if (typeof body.summary !== 'string' || !body.summary.trim() || body.summary.length > 160) {
      const error = new Error('Invalid progress request.');
      error.code = 'INVALID_REQUEST';
      throw error;
    }
    hasSummary = true;
  }
  if (body.details !== undefined) {
    if (!Array.isArray(body.details)
      || body.details.length > 8
      || body.details.some((item) => typeof item !== 'string' || !item.trim() || item.length > 500)) {
      const error = new Error('Invalid progress request.');
      error.code = 'INVALID_REQUEST';
      throw error;
    }
  }
  let hasNote = false;
  if (body.note !== undefined) {
    if (typeof body.note !== 'string' || body.note.length > 4000) {
      const error = new Error('Invalid progress request.');
      error.code = 'INVALID_REQUEST';
      throw error;
    }
    if (body.note.trim() !== '') {
      hasNote = true;
    }
  }
  if (!hasSummary && !hasNote) {
    const error = new Error('Invalid progress request.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
}

function validateMcpBeginBody(body) {
  requireString(body, 'sessionId');
  requireString(body, 'clientRequestId');
  requireString(body, 'task');
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1 || body.task.length > 1000) {
    const error = new Error('Invalid begin request.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
}

function validateMcpHandoffBody(body) {
  requireString(body, 'sessionId');
  requireString(body, 'clientRequestId');
  const textFields = ['nextSessionFocus', 'summary', 'currentState'];
  const listFields = [
    'completedItems',
    'pendingItems',
    'decisions',
    'artifactRefs',
    'risks',
    'suggestedSkills',
  ];
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1
    || !['completed', 'blocked', 'abandoned'].includes(body.outcome)
    || textFields.some((field) => typeof body[field] !== 'string' || body[field].length > 20_000)
    || listFields.some((field) => !Array.isArray(body[field])
      || body[field].length > 100
      || body[field].some((value) => typeof value !== 'string' || value.length > 4000))
    || (body.acknowledgements !== undefined
      && (!Array.isArray(body.acknowledgements)
        || body.acknowledgements.some((value) => typeof value !== 'string')))) {
    const error = new Error('Invalid handoff request.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
}

function validateMcpInitBody(body) {
  requireString(body, 'initCode');
  requireString(body, 'clientRequestId');
  requireString(body, 'currentTask');
  requireString(body, 'currentState');
  if (body.currentTask.length > 1000 || body.currentState.length > 4000) {
    const error = new Error('Invalid init request.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
}

function validRelayItems(value, { stringsOnly = false } = {}) {
  return Array.isArray(value)
    && value.length <= 100
    && value.every((item) => {
      if (typeof item === 'string') return item.length <= 4000;
      return !stringsOnly && item !== null && typeof item === 'object' && !Array.isArray(item);
    });
}

const MCP_RELAY_KEYS = new Set([
  'sessionId',
  'clientRequestId',
  'expectedRevision',
  'nextSessionFocus',
  'summary',
  'currentState',
  'completedItems',
  'pendingItems',
  'decisions',
  'artifactRefs',
  'risks',
  'suggestedSkills',
]);

const MCP_RESUME_KEYS = new Set([
  'continueCode',
  'clientRequestId',
  // The stdio adapter adds this binding-only field before calling HTTP.
  'mcpWorkingDirectory',
]);

function rejectUnexpectedMcpFields(body, allowedKeys, operation) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error(`Invalid ${operation} request.`);
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  for (const field of Object.keys(body)) {
    if (!allowedKeys.has(field)) {
      const error = new Error(`Unexpected ${operation} property: ${field}`);
      error.code = 'INVALID_REQUEST';
      throw error;
    }
  }
}

function validateMcpRelayBody(body) {
  rejectUnexpectedMcpFields(body, MCP_RELAY_KEYS, 'relay');
  requireString(body, 'sessionId');
  requireString(body, 'clientRequestId');
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) {
    const error = new Error('Invalid relay expectedRevision.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  const textFields = ['nextSessionFocus', 'summary', 'currentState'];
  const listFields = [
    'completedItems',
    'pendingItems',
    'decisions',
    'artifactRefs',
    'risks',
    'suggestedSkills',
  ];
  if (
    textFields.some((field) => typeof body[field] !== 'string'
      || body[field].trim() === ''
      || body[field].length > 20_000)
    || listFields.some((field) => !validRelayItems(body[field], { stringsOnly: field === 'artifactRefs' }))
  ) {
    const error = new Error('Invalid relay request.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
}

function validateMcpResumeBody(body) {
  rejectUnexpectedMcpFields(body, MCP_RESUME_KEYS, 'resume');
  requireString(body, 'continueCode');
  requireString(body, 'clientRequestId');
  requireString(body, 'mcpWorkingDirectory');
}

function validateMcpFinishBody(body) {
  requireString(body, 'sessionId');
  requireString(body, 'clientRequestId');
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1
    || !['completed', 'blocked', 'abandoned'].includes(body.outcome)
    || typeof body.summary !== 'string' || body.summary.length > 4000
    || typeof body.nextStep !== 'string' || body.nextStep.length > 2000
    || (body.acknowledgements !== undefined
      && (!Array.isArray(body.acknowledgements)
        || body.acknowledgements.some((value) => typeof value !== 'string')))) {
    const error = new Error('Invalid finish request.');
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

function cookieValue(cookieHeader, name) {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function authenticate(request, apiToken, browserToken, mcpSessions) {
  const bearer = request.headers.authorization;
  if (tokenMatches(bearer, apiToken)) {
    return {
      kind: 'bearer',
      principalHash: createHash('sha256').update(apiToken).digest('hex'),
    };
  }
  if (bearer?.startsWith('Bearer ')) {
    const candidate = bearer.slice(7);
    const session = mcpSessions.get(candidate);
    if (session && session.expiresAt > Date.now()) {
      return {
        kind: 'mcp',
        principalHash: createHash('sha256').update(`mcp:${candidate}`).digest('hex'),
      };
    }
    if (session) mcpSessions.delete(candidate);
  }
  const session = cookieValue(request.headers.cookie, 'ugk_cockpit_session');
  if (tokenMatches(`Bearer ${session ?? ''}`, browserToken)) {
    return {
      kind: 'browser',
      principalHash: null,
    };
  }
  return null;
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
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
  folderPicker = selectFolder,
  folderGrants = null,
  webRoot = DEFAULT_WEB_ROOT,
  faultInjector,
}) {
  if (!token || token.length < 32) throw new Error('A local API token of at least 32 characters is required.');
  const db = openCockpitDatabase(dbPath);
  const activeFolderGrants = folderGrants ?? new FolderGrantStore({ db });
  const browserSessionToken = randomBytes(32).toString('base64url');
  const mcpSessions = new Map();

  async function prepareFolderSelection(selectedPath, principalHash) {
    if (!selectedPath) return { ok: true, cancelled: true };
    const binding = authorizeExistingPath(selectedPath, selectedPath);
    let observation;
    try {
      observation = await probe(binding.candidateReal);
    } catch (error) {
      if (error?.code === 128 && /not a git repository/i.test(error?.stderr ?? '')) {
        const publicError = new Error('Selected folder is not a Git repository.', { cause: error });
        publicError.code = 'FOLDER_NOT_CODE_PROJECT';
        throw publicError;
      }
      throw error;
    }
    revalidateAuthorizedPath(binding);
    authorizeObservation(observation, [binding.rootReal]);
    const grant = activeFolderGrants.issue({
      folderPath: binding.candidateReal,
      canonicalPath: observation.canonicalPath,
      repositoryIdentity: observation.repositoryIdentity,
      worktreeIdentity: observation.worktreeIdentity,
    }, principalHash);
    return {
      ok: true,
      cancelled: false,
      grantId: grant.grantId,
      folderName: path.basename(binding.candidateReal),
      folderPath: binding.candidateReal,
      expiresAt: grant.expiresAt,
      promise: '只读取必要的代码状态；不会清理、覆盖、提交、上传或删除文件。',
    };
  }

  async function observeRegisteredProject(projectId, expected = null) {
    const project = readProjectContext(db, projectId);
    if (!project) {
      const error = new Error('Project not found.');
      error.code = 'PROJECT_NOT_FOUND';
      throw error;
    }
    const binding = authorizeExistingPath(project.canonical_path, project.authorized_root);
    const observation = await probe(
      binding.candidateReal,
      expected?.baselineHead ? { expectedBaselineHead: expected.baselineHead } : undefined,
    );
    revalidateAuthorizedPath(binding);
    authorizeObservation(observation, [project.authorized_root]);
    if (
      observation.canonicalPath !== project.canonical_path
      || observation.repositoryIdentity !== project.repository_identity
      || observation.worktreeIdentity !== project.identity_fingerprint
      || (expected && (
        expected.projectId !== project.id
        || expected.worktreeId !== project.worktree_id
        || expected.repositoryIdentity !== project.repository_identity
        || expected.worktreeIdentity !== project.identity_fingerprint
      ))
    ) {
      const error = new Error('Registered project identity changed.');
      error.code = 'WORKTREE_IDENTITY_CHANGED';
      throw error;
    }
    return { project, observation };
  }

  async function resolveMcpWorkingProject(workingDirectory) {
    if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) {
      const error = new Error('MCP working directory is unavailable.');
      error.code = 'PROJECT_NOT_FOUND';
      throw error;
    }
    const candidates = db.prepare(`
      SELECT projects.id, worktrees.canonical_path
      FROM projects
      JOIN worktrees ON worktrees.id = projects.worktree_id
      ORDER BY length(worktrees.canonical_path) DESC
    `).all();
    for (const candidate of candidates) {
      try {
        const binding = authorizeExistingPath(workingDirectory, candidate.canonical_path);
        revalidateAuthorizedPath(binding);
        return observeRegisteredProject(candidate.id);
      } catch (error) {
        if (['PATH_OUTSIDE_SCOPE', 'PATH_NOT_AUTHORIZED', 'REPARSE_POINT', 'PATH_NOT_FOUND'].includes(error?.code)) continue;
        throw error;
      }
    }
    const error = new Error('The MCP working project is not registered.');
    error.code = 'PROJECT_NOT_FOUND';
    throw error;
  }

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

      if (await serveWebAsset({
        request,
        response,
        pathname: url.pathname,
        webRoot,
        sessionToken: browserSessionToken,
      })) return;

      if (!allowedOrigin(request.headers.origin, currentPort)) {
        sendError(response, 'ORIGIN_REJECTED');
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/session') {
        if (
          request.headers.origin
          || request.headers['sec-fetch-site']
          || !isLoopbackAddress(request.socket.remoteAddress)
          || !request.headers['content-type']?.toLowerCase().startsWith('application/json')
        ) {
          sendError(response, 'ORIGIN_REJECTED');
          return;
        }
        const body = await readJson(request);
        if (body.client !== 'ugk-cockpit-stdio') {
          sendError(response, 'INVALID_REQUEST');
          return;
        }
        const now = Date.now();
        for (const [candidate, session] of mcpSessions) {
          if (session.expiresAt <= now) mcpSessions.delete(candidate);
        }
        if (mcpSessions.size >= MCP_SESSION_LIMIT) {
          mcpSessions.delete(mcpSessions.keys().next().value);
        }
        const scopedToken = randomBytes(32).toString('base64url');
        const expiresAt = now + MCP_SESSION_TTL_MS;
        mcpSessions.set(scopedToken, { expiresAt });
        sendJson(response, 201, {
          ok: true,
          token: scopedToken,
          expiresAt: new Date(expiresAt).toISOString(),
        });
        return;
      }
      const authentication = authenticate(request, token, browserSessionToken, mcpSessions);
      if (!authentication) {
        sendError(response, 'AUTH_REQUIRED');
        return;
      }
      if (
        authentication.kind === 'browser'
        && request.method !== 'GET'
        && (
          !request.headers.origin
          || request.headers['sec-fetch-site'] !== 'same-origin'
          || !request.headers['content-type']?.toLowerCase().startsWith('application/json')
        )
      ) {
        sendError(response, 'ORIGIN_REJECTED');
        return;
      }
      if (authentication.kind === 'browser' && request.method !== 'GET') {
        const clientId = request.headers['x-ugk-client-id'];
        if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(clientId)) {
          sendError(response, 'CLIENT_ID_REQUIRED');
          return;
        }
        authentication.principalHash = createHash('sha256')
          .update(`browser:${clientId}`)
          .digest('hex');
      }
      if (
        url.pathname.startsWith('/api/v1/mcp/')
        && !['bearer', 'mcp'].includes(authentication.kind)
      ) {
        sendError(response, 'AUTH_REQUIRED');
        return;
      }
      if (authentication.kind === 'mcp' && !url.pathname.startsWith('/api/v1/mcp/')) {
        sendError(response, 'AUTH_REQUIRED');
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/folders/select') {
        const selectedPath = await folderPicker();
        sendJson(response, 200, await prepareFolderSelection(selectedPath, authentication.principalHash));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/projects') {
        const body = await readJson(request);
        if (
          typeof body.commandId !== 'string' || body.commandId.length < 1
          || typeof body.grantId !== 'string' || body.grantId.length < 1
          || (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length < 1))
          || (body.stage !== undefined && !['development', 'maintenance', 'paused'].includes(body.stage))
        ) {
          const error = new Error('Invalid project registration request.');
          error.code = 'INVALID_REQUEST';
          throw error;
        }
        const grant = activeFolderGrants.claim(
          body.grantId,
          body.commandId,
          authentication.principalHash,
        );
        const replay = readCommand(db, body.commandId);
        if (replay?.kind === 'project.register' && ['committed', 'failed'].includes(replay.state)) {
          const frozen = JSON.parse(replay.request_json);
          const expectedName = body.name?.trim() || path.basename(grant.canonical_path);
          if (
            frozen.grantId !== body.grantId
            || frozen.name !== expectedName
            || frozen.stage !== (body.stage ?? 'development')
          ) {
            const error = new Error('Command payload changed during replay.');
            error.code = 'COMMAND_CONFLICT';
            throw error;
          }
          activeFolderGrants.complete(body.grantId, body.commandId);
            const result = parseCommandResponse(replay);
            if (result.ok) sendJson(response, 200, result);
            else sendError(response, result.code, { commandId: body.commandId });
            return;
        }
        const binding = authorizeExistingPath(grant.folder_path, grant.folder_path);
        const observation = await probe(binding.candidateReal);
        revalidateAuthorizedPath(binding);
        authorizeObservation(observation, [binding.rootReal]);
        if (
          observation.canonicalPath !== grant.canonical_path
          || observation.repositoryIdentity !== grant.repository_identity
          || observation.worktreeIdentity !== grant.worktree_identity
        ) {
          activeFolderGrants.complete(body.grantId, body.commandId);
          const error = new Error('Folder identity changed after selection.');
          error.code = 'FOLDER_SELECTION_CHANGED';
          throw error;
        }
        const result = registerProject(db, {
          commandId: body.commandId,
          name: body.name?.trim() || path.basename(observation.canonicalPath),
          stage: body.stage ?? 'development',
          observation,
          authorizedRoot: binding.rootReal,
          grantId: body.grantId,
        });
        activeFolderGrants.complete(body.grantId, body.commandId);
        if (result.ok) sendJson(response, 201, result);
        else sendError(response, result.code, {
          commandId: body.commandId,
          extra: { project_id: result.projectId ?? null },
        });
        return;
      }

      const projectDetailMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
      if (request.method === 'GET' && projectDetailMatch) {
        const projectId = decodeURIComponent(projectDetailMatch[1]);
        const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
        const detail = readProjectDetail(db, projectId, { limit, offset });
        if (!detail) {
          sendError(response, 'PROJECT_NOT_FOUND');
          return;
        }
        sendJson(response, 200, {
          ok: true,
          refreshedAt: new Date().toISOString(),
          ...detail,
        });
        return;
      }

      const projectTimelineMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/timeline$/);
      if (request.method === 'GET' && projectTimelineMatch) {
        const projectId = decodeURIComponent(projectTimelineMatch[1]);
        const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
        const project = readProjectContext(db, projectId);
        if (!project) {
          sendError(response, 'PROJECT_NOT_FOUND');
          return;
        }
        const timeline = readProjectTimeline(db, projectId, { limit, offset });
        sendJson(response, 200, {
          ok: true,
          projectId,
          refreshedAt: new Date().toISOString(),
          ...timeline,
        });
        return;
      }

      const assignmentMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/assignments$/);
      if (request.method === 'POST' && assignmentMatch) {
        const projectId = decodeURIComponent(assignmentMatch[1]);
        const body = await readJson(request);
        validateAssignmentBody(body);
        await observeRegisteredProject(projectId);
        const assignmentId = id('assignment', `${projectId}:${body.clientRequestId}`);
        const grantId = id('dispatch', `${projectId}:${body.clientRequestId}`);
        const dispatchCode = createHmac('sha256', token)
          .update(`dispatch:${projectId}:${body.clientRequestId}`)
          .digest('base64url');
        const task = body.mode === 'handoff'
          ? '读取最后一次交接并等待用户安排'
          : (body.mode === 'init'
            ? (body.task?.trim() || '接入项目并继续当前对话中的工作')
            : body.task.trim());
        const result = createAssignment(db, {
          commandId: id('assignment_create', `${projectId}:${body.clientRequestId}`),
          assignmentId,
          grantId,
          projectId,
          agentId: body.agent,
          taskId: task,
          scope: {
            mode: body.mode === 'handoff'
              ? 'standby'
              : (body.mode === 'init' ? 'adopt' : 'write'),
          },
          dispatchCode,
        });
        if (!result.ok) {
          sendError(response, result.code, { extra: { assignment_id: result.assignmentId ?? null } });
          return;
        }
        const message = assignmentDispatchMessage({
          mode: body.mode,
          dispatchCode,
          agent: body.agent,
          task,
        });
        sendJson(response, 201, {
          ok: true,
          assignmentId,
          agent: body.agent,
          mode: body.mode,
          task,
          expiresAt: result.expiresAt,
          message,
        });
        return;
      }

      const reissueMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/assignments\/reissue$/);
      if (request.method === 'POST' && reissueMatch) {
        const projectId = decodeURIComponent(reissueMatch[1]);
        const body = await readJson(request);
        requireString(body, 'clientRequestId');
        if (body.mode !== undefined && body.mode !== 'init') {
          sendError(response, 'INVALID_REQUEST');
          return;
        }
        if (body.agent !== undefined
          && !['Codex', 'ZCode', 'Antigravity'].includes(body.agent)) {
          sendError(response, 'INVALID_REQUEST');
          return;
        }
        await observeRegisteredProject(projectId);
        const pendingAssignments = db.prepare(`
          SELECT * FROM assignments
          WHERE project_id = ? AND status = 'pending'
          ORDER BY created_at DESC, id DESC
        `).all(projectId);
        const assignment = pendingAssignments.find((row) => {
          try {
            return JSON.parse(row.scope_json).mode === 'adopt';
          } catch {
            return false;
          }
        });
        if (!assignment) {
          sendError(response, 'NOT_FOUND');
          return;
        }
        if (body.agent && body.agent !== assignment.agent_id) {
          const reassigned = reassignPendingAssignment(db, {
            assignmentId: assignment.id,
            agentId: body.agent,
            commandId: id('assignment_reassign', `${assignment.id}:${body.agent}`),
          });
          if (!reassigned.ok) {
            sendError(response, reassigned.code, { extra: { assignment_id: assignment.id } });
            return;
          }
          assignment.agent_id = body.agent;
        }
        const dispatchCode = createHmac('sha256', token)
          .update(`dispatch:reissue:${assignment.id}:${body.clientRequestId}`)
          .digest('base64url');
        const grant = issueDispatchGrant(db, {
          assignmentId: assignment.id,
          grantId: id('dispatch_reissue', `${assignment.id}:${body.clientRequestId}`),
          dispatchCode,
        });
        if (!grant.ok) {
          sendError(response, grant.code, { extra: { assignment_id: assignment.id } });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          reissued: true,
          assignmentId: assignment.id,
          agent: assignment.agent_id,
          mode: 'init',
          task: assignment.task_id,
          expiresAt: grant.expiresAt,
          message: assignmentDispatchMessage({
            mode: 'init',
            dispatchCode,
            agent: assignment.agent_id,
            task: assignment.task_id,
          }),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/dashboard') {
        sendJson(response, 200, {
          ok: true,
          refreshedAt: new Date().toISOString(),
          projects: readDashboard(db),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/accept') {
        const body = await readJson(request);
        requireString(body, 'dispatchCode');
        requireString(body, 'clientRequestId');
        const context = readDispatchContext(db, body);
        if (!context.ok) {
          sendError(response, context.code);
          return;
        }
        const { observation } = await observeRegisteredProject(context.projectId, context);
        const accepted = acceptAssignment(db, body);
        if (!accepted.ok) {
          sendError(response, accepted.code);
          return;
        }
        if (accepted.scope?.mode === 'adopt') {
          sendError(response, 'INVALID_REQUEST');
          return;
        }
        const latestHandoff = readLatestHandoff(db, accepted.projectId);
        if (accepted.scope?.mode === 'standby') {
          sendJson(response, 200, {
            ok: true,
            assignmentId: accepted.assignmentId,
            sessionId: accepted.sessionId,
            agent: accepted.agentId,
            task: accepted.taskId,
            status: 'waiting_for_instruction',
            revision: accepted.revision,
            acceptedAt: accepted.acceptedAt,
            latestHandoff,
            message: latestHandoff
              ? '已读取最后一次交接；当前没有写入权限，请向用户复述现状并等待安排。'
              : '这个项目还没有交接手册；当前没有写入权限，请告知用户并等待安排。',
          });
          return;
        }
        const started = startWriteRun(db, {
          commandId: id('mcp_start', `${accepted.grantId}:${body.clientRequestId}`),
          runId: accepted.sessionId,
          worktreeId: accepted.worktreeId,
          canonicalPath: observation.canonicalPath,
          repositoryIdentity: observation.repositoryIdentity,
          worktreeIdentity: observation.worktreeIdentity,
          agentClaim: accepted.agentId,
          goal: accepted.taskId,
          baseline: toSnapshot(observation),
        }, { faultInjector });
        if (!started.ok) {
          sendError(response, started.code, {
            extra: { session_id: accepted.sessionId, active_run_id: started.activeRunId ?? null },
          });
          return;
        }
        const current = readSessionContext(db, accepted.sessionId);
        sendJson(response, 200, {
          ok: true,
          assignmentId: accepted.assignmentId,
          sessionId: accepted.sessionId,
          agent: accepted.agentId,
          task: accepted.taskId,
          status: 'active',
          revision: current.revision,
          leaseGeneration: started.leaseGeneration,
          acceptedAt: accepted.acceptedAt,
          latestHandoff,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/begin') {
        const body = await readJson(request);
        validateMcpBeginBody(body);
        const context = readSessionContext(db, body.sessionId);
        if (!context.ok) {
          sendError(response, context.code);
          return;
        }
        if (context.scope?.mode !== 'standby') {
          sendError(response, 'INVALID_REQUEST');
          return;
        }
        const { observation } = await observeRegisteredProject(context.projectId, context);
        const started = startWriteRun(db, {
          commandId: id('mcp_begin_run', `${body.sessionId}:${body.clientRequestId}`),
          runId: body.sessionId,
          worktreeId: context.worktreeId,
          canonicalPath: observation.canonicalPath,
          repositoryIdentity: observation.repositoryIdentity,
          worktreeIdentity: observation.worktreeIdentity,
          agentClaim: context.agentId,
          goal: body.task.trim(),
          baseline: toSnapshot(observation),
        }, { faultInjector });
        if (!started.ok) {
          sendError(response, started.code, {
            extra: { session_id: body.sessionId, active_run_id: started.activeRunId ?? null },
          });
          return;
        }
        const begun = beginAssignmentWork(db, {
          ...body,
          commandId: id('mcp_begin_assignment', `${body.sessionId}:${body.clientRequestId}`),
        });
        if (!begun.ok) {
          sendError(response, begun.code, {
            extra: { session_id: body.sessionId, revision: begun.revision ?? null },
          });
          return;
        }
        sendJson(response, 200, {
          ...begun,
          leaseGeneration: started.leaseGeneration,
          message: '已开始工作；现在可以修改代码并报告进展。',
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/init') {
        const body = await readJson(request);
        validateMcpInitBody(body);
        const dispatchRequest = {
          dispatchCode: body.initCode,
          clientRequestId: body.clientRequestId,
        };
        const context = readDispatchContext(db, dispatchRequest);
        if (!context.ok) {
          sendError(response, context.code);
          return;
        }
        if (context.scope?.mode !== 'adopt') {
          sendError(response, 'INVALID_REQUEST');
          return;
        }
        const working = await resolveMcpWorkingProject(body.mcpWorkingDirectory);
        if (working.project.id !== context.projectId
          || working.project.worktree_id !== context.worktreeId) {
          sendError(response, 'DISPATCH_GRANT_BINDING_MISMATCH');
          return;
        }
        const { observation } = await observeRegisteredProject(context.projectId, context);
        const accepted = acceptAssignment(db, dispatchRequest);
        if (!accepted.ok) {
          sendError(response, accepted.code);
          return;
        }
        const latestHandoff = readLatestHandoff(db, accepted.projectId);
        const started = startWriteRun(db, {
          commandId: id('mcp_init_run', `${accepted.grantId}:${body.clientRequestId}`),
          runId: accepted.sessionId,
          worktreeId: accepted.worktreeId,
          canonicalPath: observation.canonicalPath,
          repositoryIdentity: observation.repositoryIdentity,
          worktreeIdentity: observation.worktreeIdentity,
          agentClaim: accepted.agentId,
          goal: body.currentTask.trim(),
          baseline: toSnapshot(observation),
        }, { faultInjector });
        if (!started.ok) {
          sendError(response, started.code, {
            extra: { session_id: accepted.sessionId, active_run_id: started.activeRunId ?? null },
          });
          return;
        }
        const begun = beginAssignmentWork(db, {
          sessionId: accepted.sessionId,
          clientRequestId: `${body.clientRequestId}:begin`,
          expectedRevision: 1,
          task: body.currentTask,
          commandId: id('mcp_init_assignment', `${accepted.sessionId}:${body.clientRequestId}`),
        });
        if (!begun.ok) {
          sendError(response, begun.code, { extra: { session_id: accepted.sessionId } });
          return;
        }
        const initialized = recordProgress(db, {
          sessionId: accepted.sessionId,
          clientRequestId: `${body.clientRequestId}:state`,
          expectedRevision: 1,
          status: 'adopted',
          note: body.currentState,
        });
        if (!initialized.ok) {
          sendError(response, initialized.code, { extra: { session_id: accepted.sessionId } });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          assignmentId: accepted.assignmentId,
          sessionId: accepted.sessionId,
          agent: accepted.agentId,
          task: body.currentTask.trim(),
          status: 'active',
          revision: initialized.revision,
          leaseGeneration: started.leaseGeneration,
          baselineAt: started.startedAt,
          preexistingChangesPreserved: Boolean(observation.after?.hasChanges),
          latestHandoff,
          message: '当前项目已接入 Cockpit；已有改动已作为接入基线保留。',
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/relay') {
        const body = await readJson(request);
        validateMcpRelayBody(body);
        const result = createRelay(db, {
          ...body,
          // Derive the one-time secret from the persistent service token so a
          // lost HTTP response can be safely retried with the same payload.
          // Only its digest is persisted by the core relay implementation.
          continueCode: relayContinueCode(token, body.sessionId, body.clientRequestId),
        }, { faultInjector });
        if (result.ok) sendJson(response, 200, result);
        else sendError(response, result.code, {
          extra: {
            session_id: body.sessionId,
            relay_id: result.relayId ?? null,
            revision: result.revision ?? null,
          },
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/resume') {
        const body = await readJson(request);
        validateMcpResumeBody(body);
        const working = await resolveMcpWorkingProject(body.mcpWorkingDirectory);
        const result = resumeRelay(db, {
          ...body,
          projectId: working.project.id,
          worktreeId: working.project.worktree_id,
          canonicalPath: working.observation.canonicalPath,
          repositoryIdentity: working.observation.repositoryIdentity,
          worktreeIdentity: working.observation.worktreeIdentity,
        });
        if (result.ok) sendJson(response, 200, result);
        else sendError(response, result.code, {
          extra: {
            session_id: result.sessionId ?? null,
            relay_id: result.relayId ?? null,
            revision: result.revision ?? null,
          },
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/progress') {
        const body = await readJson(request);
        validateMcpProgressBody(body);
        let gitEvidence = {};
        const context = readSessionContext(db, body.sessionId);
        if (context?.ok) {
          try {
            const { observation } = await observeRegisteredProject(context.projectId, context);
            gitEvidence = {
              gitHead: observation.after?.head ?? null,
              gitBranch: observation.after?.branch ?? null,
              gitCoherence: observation.coherence ?? 'unknown',
              gitObservedAt: observation.observedAt ?? new Date().toISOString(),
            };
          } catch {
            gitEvidence = {
              gitHead: null,
              gitBranch: null,
              gitCoherence: 'unknown',
              gitObservedAt: new Date().toISOString(),
            };
          }
        }
        const result = recordProgress(db, { ...body, ...gitEvidence });
        if (result.ok) sendJson(response, 200, result);
        else sendError(response, result.code, {
          extra: { session_id: body.sessionId, revision: result.revision ?? null },
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/finish') {
        const body = await readJson(request);
        validateMcpFinishBody(body);
        const context = readSessionContext(db, body.sessionId);
        if (!context.ok || !context.run) {
          sendError(response, context.code ?? 'SESSION_NOT_FOUND');
          return;
        }
        const baseline = db.prepare(`
          SELECT head FROM snapshots WHERE run_id = ? AND phase = 'baseline'
        `).get(body.sessionId);
        const { observation } = await observeRegisteredProject(context.projectId, {
          ...context,
          baselineHead: baseline?.head ?? null,
        });
        const acknowledgements = body.acknowledgements ?? [];
        const result = finishRun(db, {
          commandId: id('mcp_finish', `${body.sessionId}:${body.clientRequestId}`),
          runId: body.sessionId,
          expectedRevision: body.expectedRevision,
          leaseGeneration: context.run.leaseGeneration,
          outcome: body.outcome,
          summary: body.summary,
          nextStep: body.nextStep,
          commitRefs: acknowledgements
            .filter((value) => value.startsWith('commit:'))
            .map((value) => value.slice('commit:'.length)),
          acknowledgeUnattributed: acknowledgements.includes('unattributed_changes'),
          finalSnapshot: toSnapshot(observation),
        }, { faultInjector });
        if (!result.ok) {
          sendError(response, result.code, {
            extra: { session_id: body.sessionId, receipt_id: result.receiptId ?? null },
          });
          return;
        }
        const completed = completeAssignment(db, body);
        if (!completed.ok) {
          sendError(response, completed.code, { extra: { session_id: body.sessionId } });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          assignmentId: completed.assignmentId,
          sessionId: body.sessionId,
          status: completed.status,
          revision: completed.revision,
          receiptId: result.receiptId,
          cockpitVerified: true,
          summary: body.summary,
          nextStep: body.nextStep,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/handoff') {
        const body = await readJson(request);
        validateMcpHandoffBody(body);
        const context = readSessionContext(db, body.sessionId);
        if (!context.ok || !context.run) {
          sendError(response, context.code ?? 'SESSION_NOT_FOUND');
          return;
        }
        const baseline = db.prepare(`
          SELECT head FROM snapshots WHERE run_id = ? AND phase = 'baseline'
        `).get(body.sessionId);
        const { observation } = await observeRegisteredProject(context.projectId, {
          ...context,
          baselineHead: baseline?.head ?? null,
        });
        let result;
        try {
          result = withImmediateTransaction(db, () => {
            const handoff = createHandoff(db, body, { inTransaction: true });
            if (!handoff.ok) throw new AtomicHandoffAbort(handoff);

            const finished = finishRun(db, {
              commandId: id('mcp_handoff_finish', `${body.sessionId}:${body.clientRequestId}`),
              runId: body.sessionId,
              expectedRevision: body.expectedRevision,
              leaseGeneration: context.run.leaseGeneration,
              outcome: body.outcome,
              summary: body.summary,
              nextStep: body.nextSessionFocus,
              commitRefs: (body.acknowledgements ?? [])
                .filter((value) => value.startsWith('commit:'))
                .map((value) => value.slice('commit:'.length)),
              acknowledgeUnattributed: (body.acknowledgements ?? []).includes('unattributed_changes'),
              finalSnapshot: toSnapshot(observation),
            }, { faultInjector, inTransaction: true });
            if (!finished.ok) throw new AtomicHandoffAbort(finished);

            const completed = completeAssignment(db, {
              ...body,
              commandId: id('mcp_handoff_assignment', `${body.sessionId}:${body.clientRequestId}`),
              nextStep: body.nextSessionFocus,
            }, {
              allowTerminalReconciliation: true,
              inTransaction: true,
            });
            if (!completed.ok) throw new AtomicHandoffAbort(completed);

            return { handoff, finished, completed };
          });
        } catch (error) {
          if (!(error instanceof AtomicHandoffAbort)) throw error;
          sendError(response, error.result.code, {
            extra: {
              session_id: body.sessionId,
              revision: error.result.revision ?? null,
            },
          });
          return;
        }
        faultInjector?.('finish.after_transaction_commit_before_response');
        faultInjector?.('handoff.after_transaction_commit_before_response');
        const { handoff, finished, completed } = result;
        sendJson(response, 200, {
          ok: true,
          assignmentId: completed.assignmentId,
          sessionId: body.sessionId,
          status: completed.status,
          revision: completed.revision,
          handoffId: handoff.handoffId,
          handoffMarkdown: handoff.bodyMarkdown,
          receiptId: finished.receiptId,
          cockpitVerified: true,
          summary: body.summary,
          nextSessionFocus: body.nextSessionFocus,
        });
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
