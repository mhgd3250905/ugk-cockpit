import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCockpitDatabase, withImmediateTransaction } from '../core/database.mjs';
import {
  bindConversation,
  readConversationBinding,
  readConversationOwner,
  readConversationAuthorization,
} from '../core/conversation-bindings.mjs';
import { conversationIdentity, conversationKey } from '../mcp/conversation-identity.mjs';
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
import { FolderGrantStore, EmptyFolderGrantStore } from '../core/folder-grants.mjs';
import { createHandoff, readLatestHandoff } from '../core/handoffs.mjs';
import { createRelay, resumeRelay } from '../core/relays.mjs';
import { beginCommand, parseCommandResponse, readCommand, withCommandActor, setCommandActor } from '../core/command-journal.mjs';
import { issueConversationTransfer, consumeConversationTransfer, cancelConversationTransfer, readTransferState } from '../core/conversation-transfers.mjs';
import {
  authorizeEmptyDirectory,
  authorizeExistingPath,
  revalidateAuthorizedPath,
  revalidateEmptyDirectory,
} from '../core/path-guard.mjs';
import {
  readDashboard,
  readProjectContext,
  refreshProject,
  registerProject,
  updateProject,
} from '../core/projects.mjs';
import {
  resolveProjectAvatar,
  stageProjectAvatar,
  MAX_AVATAR_FILE_SIZE,
} from '../core/project-avatars.mjs';
import { listDevelopmentSpaces, readDevelopmentSpace } from '../core/spaces.mjs';
import { listSubmissions } from '../core/integrations.mjs';
import {
  createDevelopmentWorkspace,
  listDevelopmentWorkspaces,
  removeDevelopmentWorkspace,
  reuseDevelopmentWorkspace,
} from '../core/workspaces.mjs';
import { readProjectDetail, readProjectTimeline } from '../core/timeline.mjs';
import { readWorkLineContexts } from '../core/work-line-context.mjs';
import { setProjectArchived, setWorkLineClosed, readWorkLineStates } from '../core/manual-records.mjs';
import { finishRun, startWriteRun } from '../core/runs.mjs';
import { prepareDelivery, submitDelivery } from '../core/delivery-service.mjs';
import { validateDeliveryRequest } from '../core/delivery-contract.mjs';
import { deliveryResponse } from '../core/delivery-messages.mjs';
import { checkUnsupportedFeatures } from '../git/delivery-ops.mjs';
import { authorizeDeliveryObservation, registerDeliveryLocation, observeDeliverySource, assertDeliveryCwd, readDeliverySource } from '../core/delivery-sources.mjs';
import {
  beginIntegrationReview,
  mergeApprovedSubmission,
  recordSessionIntegrationReview,
} from '../core/integration-service.mjs';
import { probeGitWorktree } from '../git/probe.mjs';
import { closeFolderPicker, selectFolder } from '../platform/select-folder.mjs';
import {
  createSubmitNote,
  readSubmitNote,
  updateSubmitNote,
  listSubmitNotes,
} from '../core/submit-notes.mjs';
import {
  validateSubmitNoteBody,
  validateSubmitNoteGetBody,
  validateSubmitNoteUpdateBody,
  validateBrowserStatusBody,
} from '../core/submit-notes-contract.mjs';
import { serveWebAsset as defaultServeWebAsset } from './web-assets.mjs';
import { createDiagnosticLogger, readRecentSessionDiagnostics } from './diagnostics.mjs';
import { VERSION } from '../version.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const MCP_SESSION_LIMIT = 64;
const MCP_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../dist/web', import.meta.url));
const MCP_CONNECTION_HANDLE_DOMAIN = 'ugk-cockpit:mcp-connection:v1';
const MCP_CONNECTION_HANDLE_PATTERN = /^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
const DIAGNOSTIC_ID_PATTERN = /^diag_[A-Za-z0-9_-]{16,64}$/;
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_BINDING_REASON_PATTERN = /^[a-z][a-z0-9_.-]{1,79}$/;
const SAFE_BINDING_REASONS = new Set([
  'metadata_missing',
  'binding_missing',
  'revoked',
  'replaced',
  'held_elsewhere',
  'session_missing',
  'session_not_active',
  'binding_mismatch',
  'transfer_pending',
]);
const SAFE_STATUS_VALUES = new Set([
  'active',
  'accepted',
  'awaiting_resume',
  'blocked',
  'completed',
  'abandoned',
  'cancelled',
  'failed',
  'stale_write_lease',
  'session_not_found',
]);
const SAFE_BINDING_STATUS_VALUES = new Set([
  'bound',
  'stale',
  'unbound',
  'ambiguous',
]);

class AtomicHandoffAbort extends Error {
  constructor(result) {
    super(result?.code ?? 'REQUEST_FAILED');
    this.name = 'AtomicHandoffAbort';
    this.result = result;
  }
}

const WORKSPACE_PENDING_ERROR = {
  status: 409,
  message: '开发空间操作尚未确认完成。',
  impact: '代码可能已发生变化；相关操作和历史记录仍保留，暂不开放新的 AI 工作。',
  requiredAction: '请在开发空间区域使用“恢复并核对”，沿原请求继续核对，不要新建删除或重新开始请求。',
};

const PUBLIC_ERRORS = {
  CONVERSATION_PLATFORM_AUTHORIZATION_REQUIRED: {
    status: 409, message: '需要项目所有者在工作台授权转交。',
    impact: '代码与现有会话归属没有改变。',
    requiredAction: '打开项目的会话接续与转交面板，由用户签发接手指令；不能在聊天内自行确认接手。',
  },
  CONVERSATION_TRANSFER_STALE: {
    status: 409, message: '转交状态已变化，本次操作没有生效。', impact: '现有代码未被修改。',
    requiredAction: '刷新工作台核对当前节点，再由用户决定下一步。',
  },
  CONVERSATION_TRANSFER_INVALID: {
    status: 409, message: '接手授权无效或已被处理。', impact: '现有代码与归属未被修改。',
    requiredAction: '请在工作台查看当前转交状态，不要重复接手或重新 init。',
  },
  CONVERSATION_TRANSFER_EXPIRED: {
    status: 409, message: '接手授权已过期，工作链仍在等待处理。', impact: '旧聊天没有自动恢复写入权，代码未被修改。',
    requiredAction: '请用户在工作台重新授权或取消转交。',
  },
  CONVERSATION_TRANSFER_TARGET_MISMATCH: {
    status: 403, message: '此接手授权不是发给当前聊天的。', impact: '代码与归属未被修改。',
    requiredAction: '请回到指定聊天，或由用户在工作台重新授权。',
  },
  CONVERSATION_BINDING_MISSING: {
    status: 409, message: '未找到可转交的当前持有人。', impact: '没有修改代码或创建工作会话。',
    requiredAction: '请刷新工作台核对已有工作会话。',
  },
  LEASE_NOT_HELD: {
    status: 409, message: '当前会话已不再持有这份代码的写租约。', impact: '代码与归属没有被本次操作修改。',
    requiredAction: '先查询工作会话确认当前持有人；需要接管时由用户在工作台授权，不要用旧 revision 重试。',
  },
  SESSION_MISMATCH: {
    status: 409, message: '请求的会话与当前绑定不一致。', impact: '没有修改代码或记录。',
    requiredAction: '核对 sessionId 后重试；不要在多个聊天间混用同一会话编号。',
  },
  ASSIGNMENT_NOT_FOUND: {
    status: 404, message: '没有找到对应的工作任务。', impact: '没有修改代码或记录。',
    requiredAction: '刷新项目总览确认任务状态；任务可能已被取消或从未创建。',
  },
  ASSIGNMENT_NOT_PENDING: {
    status: 409, message: '该任务已不处于等待接入状态。', impact: '没有创建新的接入指令。',
    requiredAction: '如需重新生成接入指令，请在工作台使用重新分配动作。',
  },
  ASSIGNMENT_NOT_ACTIVE: {
    status: 409, message: '该任务当前不可执行此操作。', impact: '没有修改代码或记录。',
    requiredAction: '查询任务状态后按当前阶段选择动作；不要重复接入。',
  },
  ASSIGNMENT_ALREADY_ACCEPTED: {
    status: 409, message: '该任务已被其他会话接入。', impact: '没有产生重复接入；原会话保持不变。',
    requiredAction: '如需更换执行聊天，由用户在工作台授权转交，不要强行接入。',
  },
  ASSIGNMENT_NOT_ACCEPTED: {
    status: 409, message: '任务还没有被有效接入，不能执行该操作。', impact: '没有修改代码或记录。',
    requiredAction: '先完成一次性接入指令的接入，再继续后续动作。',
  },
  ASSIGNMENT_ALREADY_ACTIVE: {
    status: 409, message: '该任务已经接入，不能重复接入。', impact: '没有产生重复工作节点，代码没有被修改。',
    requiredAction: '直接查询当前工作会话并继续安排任务；不要再次发送接入请求。',
  },
  SESSION_NOT_ACCEPTED: {
    status: 409, message: '当前会话尚未通过接入指令建立，不能执行该操作。', impact: '没有修改代码或记录。',
    requiredAction: '使用项目卡片“交给 AI”生成的一次性接入指令重新接入。',
  },
  PROGRESS_REQUEST_CONFLICT: {
    status: 409, message: '进展记录与平台当前状态冲突。', impact: '代码没有被修改；本次进展没有入账。',
    requiredAction: '查询最新 revision 后用同一 clientRequestId 重试或放弃本次记录。',
  },
  HANDOFF_REQUEST_CONFLICT: {
    status: 409, message: '交接请求与平台当前状态冲突。', impact: '代码没有被修改；本次交接没有生效。',
    requiredAction: '查询当前会话状态与 revision，再决定重试或取消交接。',
  },
  DISPATCH_CODE_AMBIGUOUS: {
    status: 409, message: '接入指令不唯一，无法安全解析。', impact: '没有创建工作会话，代码没有被修改。',
    requiredAction: '请在工作台重新生成一次性接入指令后再接入。',
  },
  DISPATCH_GRANT_ID_CONFLICT: {
    status: 409, message: '接入指令编号冲突，签发没有完成。', impact: '没有产生新的有效接入指令。',
    requiredAction: '换一个新的 clientRequestId 重新发起任务分配。',
  },
  DISPATCH_GRANT_NOT_FOUND: {
    status: 404, message: '接入指令不存在或已失效。', impact: '没有创建工作会话，代码没有被修改。',
    requiredAction: '在项目卡片重新生成接入指令；旧指令不能恢复。',
  },
  GRANT_TTL_TOO_LONG: {
    status: 400, message: '接入指令有效期超出允许范围。', impact: '没有签发接入指令。',
    requiredAction: '使用平台默认有效期，或调短请求的 TTL 后重试。',
  },
  MCP_CONNECTION_HANDLE_INVALID: {
    status: 401,
    message: '这个 MCP 连接无法安全续接。',
    impact: '没有创建新的连接归属，代码、工作会话和已有记录都没有被修改。',
    requiredAction: '请重新连接当前 MCP；如果服务凭据已更换，旧连接不能恢复。',
  },
  MCP_CONNECTION_HANDLE_REQUIRED: {
    status: 401,
    message: '当前 MCP 服务不支持安全的连接续接。',
    impact: '没有创建新的连接归属，代码、工作会话和已有记录都没有被修改。',
    requiredAction: '请重新连接新版 UGK Cockpit MCP。',
  },
  CONVERSATION_BINDING_CONFLICT: {
    status: 409,
    message: '当前聊天没有此工作会话的有效绑定，或已由另一聊天接手。',
    impact: '代码和已有运行记录没有被修改。',
    requiredAction: '请先查询当前工作会话查看持有人；异常接手必须由用户在工作台授权，不在聊天内重复确认。',
  },
  CONVERSATION_IDENTITY_REQUIRED: {
    status: 409,
    message: '当前宿主没有提供可核验的平台和会话 ID，不能写入 AI 工作节点。',
    impact: '代码、会话归属和已有记录都没有被修改。',
    requiredAction: '请升级并加载支持当前宿主会话元数据的 MCP 接入；身份就绪后查询，必要时由用户在工作台授权转交。不要重新 init 或猜身份。',
  },
  CONVERSATION_TAKEOVER_NOT_REQUIRED: {
    status: 409,
    message: '当前聊天已经持有这个工作会话，无需接手。',
    impact: '代码和已有记录没有被修改。',
    requiredAction: '请刷新当前工作会话后继续；如需换到新聊天，请由用户明确发起接力。',
  },
  CONVERSATION_TAKEOVER_STALE: {
    status: 409,
    message: '接手确认已过期：这次工作会话或持有人刚刚发生了变化。',
    impact: '原有持有人、代码和运行记录都没有被覆盖。',
    requiredAction: '请重新查询当前工作会话，向用户展示最新持有人后再次确认。',
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: '本地控制台静态资源暂不可用。',
    impact: '代码和已有记录都没有被修改。',
    requiredAction: '请确认前端资源已构建或服务环境完整后重试。',
  },
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
  IMAGE_PICKER_UNAVAILABLE: {
    status: 503,
    message: '暂时无法打开系统图片选择器。',
    impact: '头像未被更改，代码和已有记录不受影响。',
    requiredAction: '请稍后重试；当前不需要手动填写路径。',
  },
  IMAGE_PICKER_TIMEOUT: {
    status: 504,
    message: '系统图片选择器没有正常返回。',
    impact: '头像未被更改，代码和已有记录不受影响。',
    requiredAction: '请重新点击“选择图片”；如果窗口被其他应用遮住，请从任务栏切换到它。',
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
  PROJECT_NAME_REQUIRED: {
    status: 400,
    message: '项目显示名称不能为空。',
    impact: '项目代码和已有记录不受影响。',
    requiredAction: '请填写至少一个字符的项目显示名称后重试。',
  },
  IMAGE_NOT_FOUND: {
    status: 404,
    message: '找不到指定的图片文件。',
    impact: '项目代码和已有记录不受影响。',
    requiredAction: '请重新选择有效的项目头像图片。',
  },
  INVALID_IMAGE_PATH: {
    status: 400,
    message: '图片路径不在受控头像目录内或格式无效。',
    impact: 'Cockpit 没有读取越界文件，项目代码不受影响。',
    requiredAction: '请重新选择有效的图片资源。',
  },
  IMAGE_TOO_LARGE: {
    status: 413,
    message: '选中的图片文件过大，无法作为头像加载。',
    impact: '项目代码和已有记录不受影响。',
    requiredAction: '请选择较小的图片（建议不超过 5MB）。',
  },
  INVALID_IMAGE_TYPE: {
    status: 415,
    message: '仅支持 PNG、JPG、JPEG、GIF、WebP 格式的安全位图图片。',
    impact: '项目代码和已有记录不受影响。',
    requiredAction: '请选择支持的图片格式，SVG 等可执行脚本格式已被安全策略拦截。',
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
  DISPATCH_GRANT_BINDING_MISMATCH: {
    status: 409,
    message: '当前 AI 会话所在的代码位置与接手记录不一致。',
    impact: '没有接手任务，也没有修改代码或项目绑定。',
    requiredAction: '请在正确的项目或开发空间文件夹中重试。',
  },
  DISPATCH_GRANT_BINDING_INVALID: {
    status: 409,
    message: '接手记录中的代码位置或绑定信息已失效。',
    impact: '没有接手任务，也没有修改代码。',
    requiredAction: '请在项目页重新发起分配并复制新消息。',
  },
  SESSION_ALREADY_BOUND: {
    status: 409,
    message: '这次 AI 会话已经绑定到了另一项任务。',
    impact: '没有覆盖已有会话，也没有修改代码。',
    requiredAction: '请使用新的会话编号或重新开始。',
  },
  SESSION_BINDING_MISMATCH: {
    status: 409,
    message: '这次 AI 会话绑定的工作副本不匹配。',
    impact: '没有执行操作，也没有修改代码。',
    requiredAction: '请确认在正确的代码位置执行。',
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
  RELAY_SUPERSEDED: {
    status: 409,
    message: '已有更新的接力记录，这个旧码不能再接手。',
    impact: '当前会话归属和代码保持不变。',
    requiredAction: '请使用最新接力消息；不要重试这个旧码。',
  },
  RELAY_CONFIRMATION_STALE: {
    status: 409,
    message: '接手确认与当前工作状态不一致。',
    impact: '没有切换聊天归属或修改代码。',
    requiredAction: '在当前聊天用原接力码重新查询；出现新的确认后请用户再次确认。',
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
  SESSION_CONTEXT_CONFIRMATION_STALE: {
    status: 409,
    message: '确认继续前，这个工作会话已经发生变化。',
    impact: '没有绑定新的聊天，也没有修改会话、写入权限或代码。',
    requiredAction: '请重新查询当前工作会话，确认最新状态后再继续。',
  },
  RELAY_TTL_TOO_LONG: {
    status: 400,
    message: '接力码有效期超过安全上限。',
    impact: '没有创建接力，也没有修改代码。',
    requiredAction: '请使用较短的有效期后重试。',
  },
  DIRECTORY_NOT_EMPTY: {
    status: 400,
    message: '所选文件夹不是空目录。',
    impact: '没有创建开发空间，也没有修改或删除该文件夹中的任何文件。',
    requiredAction: '请选择一个全新的完全空文件夹。',
  },
  NOT_A_DIRECTORY: {
    status: 400,
    message: '所选路径不是文件夹。',
    impact: '没有创建开发空间，也没有修改任何文件。',
    requiredAction: '请选择一个有效的文件夹。',
  },
  DIRECTORY_IDENTITY_CHANGED: {
    status: 409,
    message: '所选文件夹身份在确认后发生变化。',
    impact: '已停止创建，没有修改任何文件。',
    requiredAction: '请重新选择空文件夹并确认。',
  },
  DIRECTORY_VERIFICATION_FAILED: {
    status: 400,
    message: '所选空文件夹核验失败。',
    impact: '没有创建开发空间，也没有修改任何文件。',
    requiredAction: '请重新选择空文件夹并确认。',
  },
  WORKTREE_NOT_FOUND: {
    status: 404,
    message: '找不到指定的工作副本或开发空间。',
    impact: '没有创建任务，也没有修改代码。',
    requiredAction: '请检查工作副本记录或开发空间状态。',
  },
  SPACE_NOT_FOUND: {
    status: 404,
    message: '找不到这个开发空间。',
    impact: '没有创建任务，也没有修改代码。',
    requiredAction: '请刷新项目页，确认开发空间仍存在。',
  },
  SPACE_REVISION_CONFLICT: {
    status: 409,
    message: '这个开发空间刚刚发生了变化。',
    impact: '本次操作没有覆盖新的状态，原有代码和记录保持不变。',
    requiredAction: '请刷新开发空间列表，确认最新状态后再试。',
  },
  PROJECT_ARCHIVE_REVISION_CONFLICT: {
    status: 409,
    message: '项目的归档状态刚刚发生了变化。',
    impact: '本次操作没有覆盖新状态，项目代码不受影响。',
    requiredAction: '请刷新项目后重试。',
  },
  WORK_LINE_REVISION_CONFLICT: {
    status: 409,
    message: '这条工作线的结束标记刚刚发生了变化。',
    impact: '本次操作没有覆盖新状态，代码和会话不受影响。',
    requiredAction: '请刷新工作线后重试。',
  },
  WORK_LINE_NOT_FOUND: {
    status: 404,
    message: '没有找到这个项目下的工作线。',
    impact: '没有修改工作记录或项目代码。',
    requiredAction: '请刷新项目并重新选择工作线。',
  },
  MAIN_WORK_LINE_NOT_CLOSABLE: {
    status: 409,
    message: '主项目不使用分支的结束标记。',
    impact: '项目代码和会话没有改变。',
    requiredAction: '要收起整个项目，请使用归档项目。',
  },
  SPACE_NOT_REUSABLE: {
    status: 409,
    message: '这个开发空间现在还不能重新开始。',
    impact: '没有切换代码，也没有改动现有文件。',
    requiredAction: '请先结束或交接正在进行的工作，再重新开始。',
  },
  SPACE_NOT_REMOVABLE: {
    status: 409,
    message: '这个开发空间现在还不能删除。',
    impact: '本地文件夹和现有记录保持不变。',
    requiredAction: '请先结束或交接正在进行的工作，再删除这个空间。',
  },
  SPACE_HAS_ACTIVE_WORK: {
    status: 409,
    message: '这个开发空间仍有进行中的 AI 工作。',
    impact: '为了保留正在工作的代码，Cockpit 没有切换或删除该空间。',
    requiredAction: '请先完成、交接或明确结束这项工作，然后再试。',
  },
  WORKSPACE_HAS_CHANGES: {
    status: 409,
    message: '这个开发空间还有未保存到代码历史的改动。',
    impact: '这些文件保持原样；Cockpit 没有切换分支或删除目录。',
    requiredAction: '请先处理这些改动，再重新开始或删除空间。',
  },
  WORKSPACE_IDENTITY_MISMATCH: {
    status: 409,
    message: '这个开发空间已经不是登记时的那份代码。',
    impact: 'Cockpit 已停止操作，现有文件和记录没有被覆盖。',
    requiredAction: '请确认该文件夹的代码状态后再处理。',
  },
  WORKSPACE_INCOHERENT: {
    status: 409,
    message: '这个开发空间的代码正在变化。',
    impact: 'Cockpit 没有切换分支或删除目录。',
    requiredAction: '请等待当前修改结束，再刷新后重试。',
  },
  WORKSPACE_PROBE_FAILED: {
    status: 503,
    message: '暂时无法核验开发空间的代码状态。',
    impact: 'Cockpit 没有切换分支或删除目录。',
    requiredAction: '请确认本地文件夹和 Git 可访问后重试。',
  },
  WORKSPACE_SWITCH_FAILED: {
    status: 409,
    message: '暂时无法为这个空间开始新的代码工作线。',
    impact: 'Cockpit 没有确认新的工作线已经准备好。',
    requiredAction: '请刷新当前空间的代码状态后再试。',
  },
  WORKSPACE_REMOVE_FAILED: {
    status: 409,
    message: '暂时无法移除这个开发空间的本地文件夹。',
    impact: 'Cockpit 没有把该空间标记为已删除。',
    requiredAction: '请关闭可能正在使用该文件夹的程序后重试。',
  },
  WORKSPACE_RECOVERY_UNCERTAIN: WORKSPACE_PENDING_ERROR,
  WORKSPACE_LIFECYCLE_IN_PROGRESS: WORKSPACE_PENDING_ERROR,
  WORKSPACE_LIFECYCLE_AMBIGUOUS: {
    ...WORKSPACE_PENDING_ERROR,
    message: '这个项目存在多项尚未确认的开发空间操作。',
    requiredAction: '请核对原操作请求和代码现状，保留恢复材料；不要创建新的删除或重新开始请求。',
  },
  WORKSPACE_LIFECYCLE_CONFLICT: WORKSPACE_PENDING_ERROR,
  WORKSPACE_LIFECYCLE_RESERVATION_LOST: WORKSPACE_PENDING_ERROR,
  WORKSPACE_LIFECYCLE_RESERVATION_MISSING: WORKSPACE_PENDING_ERROR,
  WORKSPACE_OBSERVATION_STALE: {
    status: 409,
    message: '开发空间已发生变化，这次读取的代码状态已经过时。',
    impact: '这次请求没有取得新的代码写入权限。',
    requiredAction: '请重新读取当前开发空间后再接入工作。',
  },
  SPACE_ARCHIVED: {
    status: 409,
    message: '这个开发空间已经归档。',
    impact: '这次请求没有取得新的代码写入权限。',
    requiredAction: '请在项目中选择可用的开发空间。',
  },
  PROJECT_ARCHIVED: {
    status: 409,
    message: '这个项目已经归档。',
    impact: '这次请求没有启动新的开发空间操作。',
    requiredAction: '请先在项目列表恢复项目，再核对原操作状态。',
  },
  SPACE_ID_CONFLICT: {
    status: 409,
    message: '该开发空间标识已存在。',
    impact: '没有重复创建开发空间，也没有修改已有记录。',
    requiredAction: '请刷新页面后重试。',
  },
  WORKTREE_ALREADY_IN_USE: {
    status: 409,
    message: '该工作副本已绑定到另一个开发空间。',
    impact: '没有重复创建开发空间，也没有修改已有记录。',
    requiredAction: '请选择一个独立的工作副本或空目录。',
  },
  WORKTREE_BINDING_MISMATCH: {
    status: 409,
    message: '所选工作副本与项目或空间绑定不匹配。',
    impact: '没有分配任务，也没有修改代码。',
    requiredAction: '请确认工作副本属于当前项目且属于有效未归档开发空间。',
  },
  BASE_HEAD_STALE: {
    status: 409,
    message: '代码库状态刚刚发生了变化，当前基础版本与预期不一致。',
    impact: '没有创建新的开发空间，也没有修改代码。',
    requiredAction: '请刷新项目状态后重试。',
  },
  REPOSITORY_LOCKED: {
    status: 503,
    message: '代码仓库正在被另一项操作占用。',
    impact: '本次操作没有执行，代码没有被修改。',
    requiredAction: '请稍等片刻后重试。',
  },
  BRANCH_ALREADY_EXISTS: {
    status: 409,
    message: '该分支名称在代码仓库中已存在。',
    impact: '没有创建开发空间，也没有修改已有分支。',
    requiredAction: '请使用新的操作编号或选择不同的分支名称。',
  },
  WORKTREE_RECOVERY_UNCERTAIN: {
    status: 409,
    message: '目标目录状态需要人工确认，无法自动判定归属。',
    impact: '没有删除任何已有文件或工作副本。',
    requiredAction: '请检查目标目录中的 Git 状态，确认后再试。',
  },
  MAIN_WORKTREE_INVALID: {
    status: 409,
    message: '主工作副本状态不符合预期。',
    impact: '没有创建开发空间，也没有修改代码。',
    requiredAction: '请检查主工作副本路径与配置。',
  },
  MAIN_WORKTREE_INCOHERENT: {
    status: 409,
    message: '主工作副本代码正在变动中。',
    impact: '没有创建开发空间，也没有修改代码。',
    requiredAction: '请等待改动完成或刷新后重试。',
  },
  REPOSITORY_IDENTITY_MISMATCH: {
    status: 409,
    message: '工作副本与项目的代码仓库身份不一致。',
    impact: '没有绑定工作副本，也没有修改代码。',
    requiredAction: '请确认所选文件夹属于同一个代码仓库。',
  },
  FOLDER_GRANT_CONSUMED: {
    status: 409,
    message: '这次文件夹授权已经被使用。',
    impact: '没有重复创建开发空间，也没有修改文件。',
    requiredAction: '请重新选择空目录。',
  },
  BRANCH_CHECK_FAILED: {
    status: 503,
    message: '暂时无法确认新分支是否可用。',
    impact: '没有创建开发空间，也没有修改代码。',
    requiredAction: '请稍后重试；如果持续失败，请检查本机 Git 状态。',
  },
  GIT_WORKTREE_ADD_FAILED: {
    status: 409,
    message: 'Git 未能创建新的开发空间。',
    impact: '平台没有清理或覆盖目标目录；现有代码保持不变。',
    requiredAction: '请检查提示中的目标目录和 Git 状态，再使用新的操作重试。',
  },
  PROBE_FAILED: {
    status: 503,
    message: '暂时无法核验项目代码状态。',
    impact: '没有创建开发空间，也没有修改代码。',
    requiredAction: '请确认项目文件夹可访问后重试。',
  },
  WORKTREE_REGISTRATION_CONFLICT: {
    status: 409,
    message: '新工作副本与已有平台记录冲突。',
    impact: '平台没有覆盖已有记录，也没有清理目标目录。',
    requiredAction: '请在高级详情中核对代码位置，然后人工决定如何处理。',
  },
  SPACE_REGISTRATION_CONFLICT: {
    status: 409,
    message: '开发空间与已有平台记录冲突。',
    impact: '平台没有覆盖已有空间，也没有清理目标目录。',
    requiredAction: '请刷新项目页并核对该开发空间。',
  },
  WORKTREE_PATH_OVERLAP: {
    status: 409,
    message: '新开发空间不能放在现有工作副本内部。',
    impact: '没有创建分支或开发空间，也没有修改现有代码。',
    requiredAction: '请选择与现有项目代码位置并列或完全独立的空文件夹。',
  },
  DEVELOPMENT_SPACE_REQUIRED: {
    status: 409,
    message: '只有平台创建的开发空间可以送交主项目审核。',
    impact: '没有保存、提交或上传任何新内容。',
    requiredAction: '请在对应开发空间的 AI 会话中调用 $cockpit-submit。',
  },
  REVISION_CONFLICT: {
    status: 409,
    message: '这项工作已经有更新的状态。',
    impact: '本次送审没有继续执行，现有代码保持不变。',
    requiredAction: '请刷新最近一次 revision 后重新发起。',
  },
  SUBMISSION_REVISION_CONFLICT: {
    status: 409,
    message: '这项审核待办已经有新的版本。',
    impact: '旧审核请求没有覆盖新的送审状态，也没有修改代码。',
    requiredAction: '请只使用返回的最新 submission revision，并生成新的 clientRequestId 重试。',
  },
  PUSH_REMOTE_MISSING: {
    status: 409,
    message: '这个项目还没有可用的远端代码位置。',
    impact: '没有创建新提交，也没有上传代码。',
    requiredAction: '请先为仓库配置 origin，再使用新的送审请求。',
  },
  PUSH_REMOTE_AMBIGUOUS: {
    status: 409,
    message: '项目有多个远端位置，但没有名为 origin 的默认目标。',
    impact: '没有创建新提交，也没有上传代码。',
    requiredAction: '请明确配置 origin 后，使用新的送审请求。',
  },
  COMMIT_IDENTITY_MISSING: {
    status: 409,
    message: '这个仓库还没有配置本地提交者姓名和邮箱。',
    impact: '没有创建新提交，也没有上传代码。',
    requiredAction: '请在该仓库配置本地 user.name 和 user.email 后，用同一请求重试。',
  },
  NO_CHANGES_TO_SUBMIT: {
    status: 409,
    message: '这个开发空间没有可送审的新成果。',
    impact: '没有创建提交或审核待办。',
    requiredAction: '请确认功能改动已经保存在当前开发空间。',
  },
  GIT_FILTER_UNSUPPORTED: {
    status: 409,
    message: '当前版本暂不支持包含 Git filter 或 LFS 的自动送审。',
    impact: '没有暂存、提交或上传文件。',
    requiredAction: '请保留现状，改用人工 Git 流程并等待平台后续支持。',
  },
  SUBMODULE_UNSUPPORTED: {
    status: 409,
    message: '当前版本暂不支持包含 submodule 的自动送审。',
    impact: '没有暂存、提交或上传文件。',
    requiredAction: '请保留现状，改用人工 Git 流程并等待平台后续支持。',
  },
  COMMIT_FAILED: {
    status: 409,
    message: '本地成果暂时没有保存成提交。',
    impact: '文件内容仍在开发空间中；平台没有 reset、清理或删除文件。',
    requiredAction: '请根据 Git 提示修正后，用完全相同的送审请求重试。',
  },
  PUSH_FAILED: {
    status: 200,
    message: '本地成果已经保存，但尚未送达远端。',
    impact: '本地提交保持完整；平台没有回退或重写历史。',
    requiredAction: '请检查网络或远端权限后，用完全相同的送审请求重试。',
  },
  SOURCE_MOVED: {
    status: 409,
    message: '开发空间在送审过程中又产生了新的提交。',
    impact: '平台没有覆盖或回退这些变化。',
    requiredAction: '请核对当前成果后，重新发起一次新的送审。',
  },
  SOURCE_CHANGED_AFTER_SAVE: {
    status: 409,
    message: '本地保存后开发空间又发生了变化。',
    impact: '已保存的提交和新增改动都保留，平台没有覆盖任何内容。',
    requiredAction: '请核对新增改动，再重新发起送审。',
  },
  SOURCE_HISTORY_DIVERGED: {
    status: 409,
    message: '开发分支已经偏离创建时的基础版本。',
    impact: '平台没有 rebase、reset 或改写历史。',
    requiredAction: '请人工检查分支历史后决定如何处理。',
  },
  SUBMIT_FAILED: {
    status: 503,
    message: '本次送审未能完成。',
    impact: '平台没有自动清理、回退或覆盖代码。',
    requiredAction: '请查看开发空间状态并重试；若持续失败，请人工核对 Git 状态。',
  },
  SUBMISSION_NOT_FOUND: {
    status: 404,
    message: '找不到这条送审记录。',
    impact: '没有领取审核，也没有修改代码。',
    requiredAction: '请核对送审编号后重试。',
  },
  MAIN_SESSION_REQUIRED: {
    status: 409,
    message: '这项审核必须从主项目的 AI 工作会话开始。',
    impact: '没有领取审核，也没有修改任何代码。',
    requiredAction: '请在主项目中开启或继续一条 AI 工作会话，再粘贴审核提示词。',
  },
  SUBMISSION_NOT_REVIEWABLE: {
    status: 409,
    message: '这个功能当前不在可领取审核的状态。',
    impact: '没有重复领取，也没有修改代码。',
    requiredAction: '请刷新项目页，查看它当前的审核结果或处理人。',
  },
  SUBMISSION_CLOSED: {
    status: 409,
    message: '这项审核待办已经关闭，旧结论不能再写入。',
    impact: '旧请求没有覆盖关闭状态，也没有修改代码。',
    requiredAction: '请刷新项目页，确认是否已有新的送审版本；不要用旧版本继续审核。',
  },
  SUBMISSION_ALREADY_CLAIMED: {
    status: 409,
    message: '这个功能已经由另一条主项目会话领取审核。',
    impact: '没有启动第二次审核，也没有修改代码。',
    requiredAction: '请回到项目页查看当前审核者；如需更换审核者，请由当前会话或用户明确撤回后再领取。',
  },
  CLAIM_NOT_FOUND: {
    status: 404,
    message: '找不到这次审核领取记录。',
    impact: '没有写入审核结论，也没有修改代码。',
    requiredAction: '请从项目页复制当前待办的审核指令后重试。',
  },
  CLAIM_NOT_ACTIVE: {
    status: 409,
    message: '这次审核领取已经被明确撤回或结束。',
    impact: '旧审核结论没有写入，也没有修改代码。',
    requiredAction: '请刷新项目页；如果有新的送审版本，请使用新待办和新的 clientRequestId。',
  },
  CLAIMANT_MISMATCH: {
    status: 409,
    message: '当前 AI 会话不是这次审核领取的处理人。',
    impact: '没有写入审核结论，也没有替换当前审核者。',
    requiredAction: '请回到当前审核会话继续；更换处理人必须由用户明确撤回后再领取。',
  },
  MAIN_HAS_CHANGES: {
    status: 409,
    message: '主项目当前有尚未保存的本地改动。',
    impact: '平台没有覆盖这些改动，也没有执行合并。',
    requiredAction: '请先确认并处理主项目自己的改动，再重新审核或合并。',
  },
  MAIN_BRANCH_CHANGED: {
    status: 409,
    message: '主项目当前不在送审时记录的工作线上。',
    impact: '平台没有切换工作线，也没有执行合并。',
    requiredAction: '请确认主项目代码位置和当前工作线后重新开始审核。',
  },
  TARGET_HEAD_STALE: {
    status: 409,
    message: '主项目在送审后已经向前变化。',
    impact: '平台没有自动 rebase、reset 或覆盖新代码。',
    requiredAction: '请刷新待办，重新评估这个功能与最新主项目的兼容性。',
  },
  SOURCE_COMMIT_MISMATCH: {
    status: 409,
    message: '审核使用的代码保存点已经改变。',
    impact: '旧审核结论没有覆盖新的代码版本，也没有修改代码。',
    requiredAction: '请停止旧审核，刷新待办并使用固定的新版本重新开始。',
  },
  TARGET_HEAD_MISMATCH: {
    status: 409,
    message: '审核使用的主项目基线已经改变。',
    impact: '旧审核结论没有覆盖新的主项目版本，也没有修改代码。',
    requiredAction: '请停止旧审核，使用新待办返回的固定目标版本重新开始。',
  },
  TARGET_WORKTREE_MISMATCH: {
    status: 409,
    message: '审核绑定的主项目代码位置已经改变。',
    impact: '没有写入审核结论，也没有修改代码位置绑定。',
    requiredAction: '请回项目页确认当前主项目代码位置，再使用新的审核指令。',
  },
  INTEGRATION_BINDING_MISMATCH: {
    status: 409,
    message: '审核会话、待办和审核领取记录不是同一项工作。',
    impact: '没有写入审核结论，也没有修改代码。',
    requiredAction: '请使用同一待办复制的完整审核指令，不要手动替换 ID。',
  },
  DELIVERY_MERGE_CONFLICT: {
    status: 409,
    message: '送审版本存在未解决的合并冲突。',
    impact: '审核结论没有写入，也没有执行合并。',
    requiredAction: '请先按提示人工处理冲突，再以新版本重新送审。',
  },
  SOURCE_NOT_FAST_FORWARD: {
    status: 409,
    message: '这个功能不能安全地直接接入当前主项目。',
    impact: '平台没有改写历史，也没有执行合并。',
    requiredAction: '请人工处理分支差异并重新送审。',
  },
  REVIEW_APPROVAL_REQUIRED: {
    status: 409,
    message: '只有明确审核通过的功能才能合入主项目。',
    impact: '没有执行合并或推送。',
    requiredAction: '请先完成审核并记录 approved 结果。',
  },
  INTEGRATION_REVISION_CONFLICT: {
    status: 409,
    message: '审核事项刚刚发生了变化。',
    impact: '旧请求没有覆盖最新审核状态，也没有执行合并。',
    requiredAction: '请使用工具返回的最新 revision 重新确认。',
  },
  CLAIM_EXPIRED: {
    status: 409,
    message: '这次审核领取已被明确关闭，审核领取不会因时间流逝自动失效。',
    impact: '审核结论没有写入，代码没有修改。',
    requiredAction: '请刷新项目页；如果有新的送审版本，请使用新待办和新的 clientRequestId。',
  },
  INTEGRATION_PUSH_FAILED: {
    status: 200,
    message: '功能已经安全接入本地主项目，但尚未推送到远端。',
    impact: '本地主项目的新保存点保持完整；平台没有回退或重写历史。',
    requiredAction: '请检查网络或远端权限后，用完全相同的合并请求重试。',
  },
  MAIN_CHANGED_AFTER_INTEGRATION: {
    status: 409,
    message: '本地接入完成后，主项目又发生了变化。',
    impact: '平台没有覆盖、回退或强推这些新变化。',
    requiredAction: '请人工确认当前主项目状态后再决定是否继续。',
  },
  MAIN_WORKTREE_CHANGED: {
    status: 409,
    message: '主项目代码位置已不是平台记录的那一份。',
    impact: '平台已停止审核或合并，没有修改代码。',
    requiredAction: '请回项目页重新确认代码位置。',
  },
  NOTE_NOT_FOUND: {
    status: 404,
    message: '没有找到这条工作说明。',
    impact: '代码和已有记录都没有被修改。',
    requiredAction: '请确认说明编号是否正确，或刷新项目页面查看收件箱。',
  },
  NOTE_REVISION_CONFLICT: {
    status: 409,
    message: '这条工作说明刚刚被其他操作更新。',
    impact: '本次状态更新被拒绝，没有覆盖新的状态。',
    requiredAction: '请重新读取该说明获取最新版本后重试。',
  },
  PROJECT_MISMATCH: {
    status: 403,
    message: '无权跨项目查看或更新工作说明。',
    impact: '没有修改任何记录，代码不受影响。',
    requiredAction: '请切换到该说明所属的项目工作目录后再试。',
  },
  DELIVERY_PROJECT_AMBIGUOUS: {
    status: 409,
    message: '当前工作目录对应多个已登记项目，暂时无法确定所属项目。',
    impact: '没有发布工作说明，也没有修改代码。',
    requiredAction: '请在 UGK Cockpit 平台核对项目对应关系，不要猜测目标。',
  },
};

function id(prefix, value) {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function connectionHandleSignature(nonce, apiToken) {
  return createHmac('sha256', apiToken)
    .update(`${MCP_CONNECTION_HANDLE_DOMAIN}\0${nonce}`)
    .digest('base64url');
}

function issueConnectionHandle(apiToken) {
  const nonce = randomBytes(32).toString('base64url');
  const signature = connectionHandleSignature(nonce, apiToken);
  return {
    handle: `v1.${nonce}.${signature}`,
    connectionPrincipalHash: createHash('sha256')
      .update(`ugk-cockpit:mcp-connection-principal:v1\0${nonce}`)
      .digest('hex'),
  };
}

function verifyConnectionHandle(handle, apiToken) {
  if (typeof handle !== 'string') return null;
  const match = handle.match(MCP_CONNECTION_HANDLE_PATTERN);
  if (!match) return null;
  const [, nonce, signature] = match;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(connectionHandleSignature(nonce, apiToken));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return {
    connectionPrincipalHash: createHash('sha256')
      .update(`ugk-cockpit:mcp-connection-principal:v1\0${nonce}`)
      .digest('hex'),
  };
}

function diagnosticOperation(pathname) {
  const operations = {
    '/api/v1/mcp/session': 'mcp.session',
    '/api/v1/mcp/work/context': 'mcp.context',
    '/api/v1/mcp/work/init': 'mcp.init',
    '/api/v1/mcp/work/accept': 'mcp.accept',
    '/api/v1/mcp/work/resume': 'mcp.resume',
    '/api/v1/mcp/work/takeover': 'mcp.takeover',
    '/api/v1/mcp/work/relay': 'mcp.relay',
    '/api/v1/mcp/work/progress': 'mcp.progress',
    '/api/v1/mcp/work/begin': 'mcp.begin',
    '/api/v1/mcp/work/finish': 'mcp.finish',
    '/api/v1/mcp/work/handoff': 'mcp.handoff',
    '/api/v1/mcp/work/submit-note': 'mcp.submit_note',
    '/api/v1/mcp/submit-notes/get': 'mcp.submit_note_get',
    '/api/v1/mcp/submit-notes/update': 'mcp.submit_note_update',
    '/api/v1/mcp/integration/begin': 'mcp.integration_begin',
    '/api/v1/mcp/integration/review': 'mcp.integration_review',
    '/api/v1/mcp/integration/merge': 'mcp.integration_merge',
  };
  return operations[pathname] ?? 'request';
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

function integrationReviewPrompt(submission) {
  return [
    '请在当前主项目的 active Cockpit 会话中审核并处理这个待办。',
    `submissionId: "${submission.submissionId}"`,
    `expectedSubmissionRevision: ${submission.revision}`,
    `本次代码保存点：${submission.sourceCommit}；目标基线：${submission.targetHead}。`,
    '审核领取不会因时间流逝自动失效；可以隔几天再继续，但固定版本一旦改变就必须停止并报告冲突。',
    '先调用 `ugk_integration_begin` 领取并锁定审核对象；使用当前会话已有的 sessionId、最新 session revision 和新的 clientRequestId，不要传路径、项目 ID、工作副本 ID 或 token。',
    '然后只针对工具返回的固定 sourceCommit 与 targetHead 审查代码差异并运行必要验证；若 sourceCommit、targetHead、目标代码位置或送审版本改变，停止旧审核，不要继续提交旧结论。',
    '审查完成后调用 `ugk_integration_review`，如实提交 verdict、summary，并且必须传 findings 与 checks（即使为空数组也要显式传入）。',
    '如果响应不确定，请使用同一个 clientRequestId 和完整相同的 payload 重试，不要生成第二个审核请求。只有明确的版本冲突才使用响应返回的最新 revision，并同时生成新的 clientRequestId。',
    '审核通过不等于合并授权。只有用户明确要求合并且 verdict 为 approved 时，才用 review 返回的最新 submissionRevision、claimRevision 调用 `ugk_integration_merge`。',
    '不得自行 rebase、reset、force push、切换分支或清理开发空间；若工具返回冲突或待人工处理，停止并把影响和下一步告诉我。',
  ].join('\n');
}

function integrationErrorExtra(body, result = {}) {
  const extra = {
    sessionId: body.sessionId,
    submissionId: result.submissionId ?? body.submissionId,
  };
  if (result.claimId ?? body.claimId) extra.claimId = result.claimId ?? body.claimId;
  if (result.status !== undefined) extra.status = result.status;
  if (result.activeClaimId !== undefined) extra.activeClaimId = result.activeClaimId;

  // Keep the three revision domains explicit.  The generic currentRevision
  // field in older core responses is interpreted only according to the
  // operation's entity and is never presented as a session revision when it
  // belongs to a submission/claim.
  if (result.currentSessionRevision !== undefined) {
    extra.currentSessionRevision = result.currentSessionRevision;
  }
  if (result.expectedSessionRevision !== undefined) {
    extra.expectedSessionRevision = result.expectedSessionRevision;
  }
  if (result.currentSubmissionRevision !== undefined) {
    extra.currentSubmissionRevision = result.currentSubmissionRevision;
  }
  if (result.expectedSubmissionRevision !== undefined) {
    extra.expectedSubmissionRevision = result.expectedSubmissionRevision;
  }
  if (result.currentClaimRevision !== undefined) {
    extra.currentClaimRevision = result.currentClaimRevision;
  }
  if (result.expectedClaimRevision !== undefined) {
    extra.expectedClaimRevision = result.expectedClaimRevision;
  }
  if (result.code === 'REVISION_CONFLICT' && result.currentSessionRevision === undefined
    && result.currentClaimRevision === undefined) {
    // Compatibility for a core response produced before the named fields
    // existed: begin's generic conflict is a session conflict, while review
    // is a claim conflict.  Never copy a bare revision into both domains.
    if (body.claimId) {
      extra.currentClaimRevision = result.currentRevision;
      extra.expectedClaimRevision = result.expectedRevision;
    } else {
      extra.currentSessionRevision = result.currentRevision;
      extra.expectedSessionRevision = result.expectedRevision;
    }
  }
  if (result.code === 'SUBMISSION_REVISION_CONFLICT'
    && result.currentSubmissionRevision === undefined && result.currentRevision !== undefined) {
    extra.currentSubmissionRevision = result.currentRevision;
    extra.expectedSubmissionRevision = result.expectedRevision;
  }

  // These are immutable entity identifiers or safe state details; paths,
  // tokens and arbitrary backend error fields are intentionally excluded.
  for (const key of [
    'currentHead', 'currentSourceCommit', 'expectedSourceCommit',
    'currentTargetHead', 'expectedTargetHead', 'currentTargetWorktreeId',
    'expectedTargetWorktreeId', 'retryable', 'humanActionRequired',
  ]) {
    if (result[key] !== undefined) extra[key] = result[key];
  }
  return extra;
}

function safeSessionId(value) {
  return typeof value === 'string' && SAFE_SESSION_ID_PATTERN.test(value) ? value : null;
}

function safeRevision(value) {
  return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function normalizeConversationErrorContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return {};
  const normalized = {};
  const sessionId = safeSessionId(context.sessionId ?? context.session_id);
  if (sessionId) normalized.sessionId = sessionId;
  const revision = [context.revision, context.currentRevision, context.current_revision]
    .map(safeRevision)
    .find((value) => value !== null);
  if (revision !== undefined) normalized.revision = revision;
  const bindingReason = context.bindingReason ?? context.reason;
  if (typeof bindingReason === 'string' && SAFE_BINDING_REASONS.has(bindingReason)) {
    normalized.bindingReason = bindingReason;
  }
  if (typeof context.status === 'string' && SAFE_STATUS_VALUES.has(context.status)) {
    normalized.status = context.status;
  }
  if (typeof context.bindingStatus === 'string' && SAFE_BINDING_STATUS_VALUES.has(context.bindingStatus)) {
    normalized.bindingStatus = context.bindingStatus;
  }
  if (typeof context.canContinue === 'boolean') normalized.canContinue = context.canContinue;
  if (typeof context.requiresUserConfirmation === 'boolean') {
    normalized.requiresUserConfirmation = context.requiresUserConfirmation;
  }
  // These locations are attached only after reading this exact session from
  // the database, never copied from arbitrary request/error objects.
  if (context.sessionValidated === true) {
    for (const field of ['projectId', 'worktreeId']) {
      const value = safeSessionId(context[field]);
      if (value) normalized[field] = value;
    }
    if (context.recoveryAction === 'open_workbench_transfer') normalized.recoveryAction = context.recoveryAction;
    if (context.owner) normalized.owner = Object.fromEntries([
      'host', 'conversationLocator', 'holderType', 'bindingPersistence', 'boundAt', 'lastActivityAt',
    ].map(field => [field, context.owner[field] ?? null]));
    if (context.latestNode) normalized.latestNode = Object.fromEntries([
      'id', 'type', 'predecessorId', 'actorKind', 'actorHost', 'actorConversationId', 'summary', 'createdAt',
    ].map(field => [field, context.latestNode[field] ?? null]));
  }
  return normalized;
}

function diagnosticSessionDetails(response, body) {
  const candidate = response.__ugkDiagnosticContext?.sessionId
    ?? body?.sessionId
    ?? body?.session_id;
  const sessionId = safeSessionId(candidate);
  const db = response.__ugkDiagnosticDb;
  if (!sessionId || !db) return null;
  try {
    const state = readExactSessionState(db, sessionId);
    if (!state || state.sessionId !== sessionId) return null;
    return { sessionId, revision: state.revision };
  } catch {
    return null;
  }
}

function sendJson(response, statusCode, body) {
  const diagnosticId = response.__ugkDiagnosticId;
  const payload = JSON.stringify(body?.canContinue === false && response.__ugkBindingReport && diagnosticId
    ? { ...body, diagnosticId } : body);
  if (diagnosticId) {
    response.setHeader('x-ugk-diagnostic-id', diagnosticId);
  }
  const diagnosticSession = diagnosticSessionDetails(response, body);
  try {
    response.__ugkDiagnosticLogger?.record({
      ...response.__ugkDiagnosticContext,
      result: body?.status === 'recovery_pending' || body?.code?.endsWith?.('_UNCERTAIN')
        ? 'uncertain'
        : (body?.ok === false || body?.code || statusCode >= 400 ? 'rejected' : 'success'),
      code: body?.code,
      sessionId: diagnosticSession?.sessionId,
      revision: safeRevision(response.__ugkDiagnosticContext?.revision)
        ?? safeRevision(body?.revision)
        ?? diagnosticSession?.revision,
      bindingReason: body?.bindingReason ?? body?.reason,
    });
  } catch {
    // Diagnostic persistence is deliberately best effort and cannot alter the
    // response or a business result.
  }
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

function sendError(response, code, { commandId = null, extra = {}, context = null } = {}) {
  const definition = PUBLIC_ERRORS[code] ?? PUBLIC_ERRORS.REQUEST_FAILED;
  const contextFields = normalizeConversationErrorContext(context);
  if (context?.sessionValidated === true && contextFields.sessionId) {
    response.__ugkDiagnosticContext = {
      ...response.__ugkDiagnosticContext,
      sessionId: contextFields.sessionId,
      revision: contextFields.revision,
    };
  }
  const contextReason = contextFields.bindingReason;
  const requestedReason = extra?.reason;
  const reason = typeof requestedReason === 'string' && SAFE_BINDING_REASON_PATTERN.test(requestedReason)
    ? requestedReason
    : contextReason ?? code;
  sendJson(response, definition.status, {
    code: PUBLIC_ERRORS[code] ? code : 'REQUEST_FAILED',
    message: definition.message,
    impact: definition.impact,
    required_action: definition.requiredAction,
    next_command: null,
    warnings: [],
    command_id: commandId,
    ...contextFields,
    ...extra,
    ...(response.__ugkBindingReport ?? {}),
    reason,
    ...(response.__ugkDiagnosticId ? { diagnosticId: response.__ugkDiagnosticId } : {}),
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
  if (body.runId !== undefined && typeof body.runId !== 'string') {
    const error = new Error('Invalid runId');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
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
  if (body.spaceId !== undefined && (typeof body.spaceId !== 'string' || !body.spaceId.trim())) {
    const error = new Error('Invalid spaceId');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
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


function validateMcpIntegrationBody(body, operation) {
  requireString(body, 'sessionId');
  requireString(body, 'clientRequestId');
  requireString(body, 'submissionId');
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) {
    const error = new Error('Invalid integration session revision.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  const common = ['sessionId', 'clientRequestId', 'expectedRevision', 'submissionId'];
  const allowed = operation === 'begin'
    ? [...common, 'expectedSubmissionRevision']
    : operation === 'review'
      ? [...common, 'claimId', 'expectedClaimRevision', 'verdict', 'summary', 'findings', 'checks']
      : [...common, 'claimId', 'expectedSubmissionRevision', 'expectedClaimRevision', 'summary'];
  rejectUnexpectedMcpFields(body, new Set(allowed), `integration ${operation}`);
  if (operation !== 'review'
    && (!Number.isInteger(body.expectedSubmissionRevision) || body.expectedSubmissionRevision < 0)) {
    const error = new Error('Invalid submission revision.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (operation !== 'begin') {
    requireString(body, 'claimId');
    requireString(body, 'summary');
    if (!Number.isInteger(body.expectedClaimRevision) || body.expectedClaimRevision < 0
      || body.summary.length > 1000) {
      const error = new Error('Invalid integration review fields.');
      error.code = 'INVALID_REQUEST';
      throw error;
    }
  }
  if (operation === 'review') {
    if (!['approved', 'changes_requested', 'rejected'].includes(body.verdict)) {
      const error = new Error('Invalid integration verdict.');
      error.code = 'INVALID_REQUEST';
      throw error;
    }
    for (const key of ['findings', 'checks']) {
      if (!Array.isArray(body[key]) || body[key].length > 20
        || body[key].some((item) => typeof item !== 'string' || !item.trim() || item.length > 500)) {
        const error = new Error(`Invalid integration ${key}.`);
        error.code = 'INVALID_REQUEST';
        throw error;
      }
    }
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
  'confirmationRequestId',
  'expectedRevision',
  // The stdio adapter adds this binding-only field before calling HTTP.
  'mcpWorkingDirectory',
]);

const MCP_TAKEOVER_KEYS = new Set([
  'sessionId',
  'clientRequestId',
  'transferCode',
  // The stdio adapter adds this binding-only field before calling HTTP.
  'mcpWorkingDirectory',
]);

const MCP_CONTEXT_KEYS = new Set([
  'mcpWorkingDirectory',
  'confirmSessionId',
  'expectedRevision',
  // This field is injected by the stdio bridge and is not exposed in the
  // model-facing tool schema.  It carries only the bridge's process-local
  // binding generation; it is never persisted.
  'bridgeBinding',
]);

const MCP_CONTEXT_BINDING_KEYS = new Set([
  'sessionId',
  'worktreeId',
  'relayId',
  'relaySequence',
  'acceptedRevision',
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
  if ((body.confirmationRequestId !== undefined) !== (body.expectedRevision !== undefined)
    || (body.confirmationRequestId !== undefined && (typeof body.confirmationRequestId !== 'string'
      || !body.confirmationRequestId.trim() || body.confirmationRequestId === body.clientRequestId
      || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1))) {
    throw Object.assign(new Error('Invalid resume confirmation pair.'), { code: 'INVALID_REQUEST' });
  }
}

function validateMcpTakeoverBody(body) {
  if (!body?.transferCode) throw Object.assign(new Error('Platform authorization required'), {
    code: 'CONVERSATION_PLATFORM_AUTHORIZATION_REQUIRED',
  });
  rejectUnexpectedMcpFields(body, MCP_TAKEOVER_KEYS, 'conversation takeover');
  requireString(body, 'sessionId');
  requireString(body, 'clientRequestId');
  requireString(body, 'mcpWorkingDirectory');
  requireString(body, 'transferCode');
}

function validateMcpContextBody(body) {
  rejectUnexpectedMcpFields(body, MCP_CONTEXT_KEYS, 'context');
  requireString(body, 'mcpWorkingDirectory');
  const hasConfirmSession = body.confirmSessionId !== undefined;
  const hasExpectedRevision = body.expectedRevision !== undefined;
  if (hasConfirmSession !== hasExpectedRevision) {
    const error = new Error('Context confirmation requires confirmSessionId and expectedRevision together.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (hasConfirmSession) {
    requireString(body, 'confirmSessionId');
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) {
      const error = new Error('Invalid context expectedRevision.');
      error.code = 'INVALID_REQUEST';
      throw error;
    }
  }
  if (body.bridgeBinding !== undefined) {
    if (!body.bridgeBinding || typeof body.bridgeBinding !== 'object' || Array.isArray(body.bridgeBinding)) {
      const error = new Error('Invalid context bridge binding.');
      error.code = 'INVALID_REQUEST';
      throw error;
    }
    rejectUnexpectedMcpFields(body.bridgeBinding, MCP_CONTEXT_BINDING_KEYS, 'context bridge binding');
    requireString(body.bridgeBinding, 'sessionId');
    requireString(body.bridgeBinding, 'worktreeId');
    const generationFields = ['relayId', 'relaySequence', 'acceptedRevision'];
    const generationPresent = generationFields.some((field) => body.bridgeBinding[field] !== undefined);
    // Relay provenance is optional; an acceptance revision also belongs to an
    // explicit takeover. Neither field is an independent authorization grant.
    const { relayId, relaySequence, acceptedRevision } = body.bridgeBinding;
    const noRelay = relayId === null && relaySequence === null;
    const validRelay = typeof relayId === 'string' && relayId.trim()
      && Number.isInteger(relaySequence) && relaySequence >= 1;
    const validAcceptance = (noRelay && acceptedRevision === null)
      || (Number.isInteger(acceptedRevision) && acceptedRevision >= 1);
    if (generationPresent && (!(noRelay || validRelay) || !validAcceptance)) {
      const error = new Error('Invalid context bridge generation.');
      error.code = 'INVALID_REQUEST';
      throw error;
    }
  }
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

function relayGenerationRow(row) {
  if (!row) return null;
  return {
    relayId: row.id,
    sequence: row.sequence,
    acceptedRevision: row.accepted_revision,
  };
}

function readSessionRelayState(db, sessionId, now = Date.now()) {
  const waiting = db.prepare(`
    SELECT id, sequence, state, accepted_revision, expires_at
    FROM relays
    WHERE session_id = ? AND state = 'active' AND expires_at > ?
    ORDER BY sequence DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(sessionId, now) ?? null;
  const accepted = db.prepare(`
    SELECT id, sequence, state, accepted_revision, expires_at
    FROM relays
    WHERE session_id = ? AND state = 'accepted'
    ORDER BY sequence DESC, accepted_revision DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(sessionId) ?? null;
  return {
    waiting: waiting ? {
      relayId: waiting.id,
      sequence: waiting.sequence,
      status: waiting.state,
      expiresAt: waiting.expires_at,
    } : null,
    generation: relayGenerationRow(accepted),
  };
}

function readWorktreeSessionState(db, worktreeId, now = Date.now()) {
  const rows = db.prepare(`
    SELECT assignments.id AS assignment_id,
           assignments.project_id,
           assignments.worktree_id,
           assignments.session_id,
           assignments.status AS assignment_status,
           assignments.revision AS assignment_revision,
           assignments.updated_at AS assignment_updated_at,
           assignments.created_at AS assignment_created_at,
           runs.lifecycle AS run_lifecycle,
           runs.revision AS run_revision
    FROM assignments
    LEFT JOIN runs ON runs.id = assignments.session_id
    WHERE assignments.worktree_id = ? AND assignments.session_id IS NOT NULL
    ORDER BY assignments.updated_at DESC, assignments.created_at DESC, assignments.id DESC
  `).all(worktreeId);
  const activeRows = rows.filter((row) => row.run_lifecycle === 'active'
    && ['accepted', 'active'].includes(row.assignment_status));
  if (activeRows.length > 1) {
    return {
      status: 'ambiguous',
      sessions: activeRows.map((row) => readSessionStateRow(db, row, now)),
    };
  }
  const selected = activeRows[0] ?? rows[0] ?? null;
  if (!selected) return { status: 'no_session', sessions: [] };
  return {
    status: 'session',
    session: readSessionStateRow(db, selected, now),
  };
}

function readSessionStateRow(db, row, now = Date.now()) {
  const context = readSessionContext(db, row.session_id);
  if (!context?.ok) {
    return {
      ok: false,
      projectId: row.project_id,
      worktreeId: row.worktree_id,
      assignmentId: row.assignment_id,
      sessionId: row.session_id,
      status: 'session_not_found',
      revision: null,
      assignmentRevision: row.assignment_revision,
      runRevision: row.run_revision,
      leaseHeld: false,
      relay: null,
      generation: null,
    };
  }
  const relay = readSessionRelayState(db, row.session_id, now);
  const lease = db.prepare(`
    SELECT run_id, generation FROM write_leases WHERE worktree_id = ?
  `).get(row.worktree_id) ?? null;
  const leaseHeld = Boolean(
    context.run
    && context.run.lifecycle === 'active'
    && lease
    && lease.run_id === row.session_id
    && lease.generation === context.run.leaseGeneration,
  );
  const revision = context.revision ?? null;
  const revisionsAligned = !context.run || context.run.revision === context.revision;
  let status = context.status;
  if (!context.run) {
    status = context.status === 'active' ? 'stale_write_lease' : context.status;
  } else if (context.run.lifecycle !== 'active') {
    status = context.run.lifecycle ?? context.status;
  } else if (!['accepted', 'active'].includes(context.status)) {
    status = context.status;
  } else if (!revisionsAligned) {
    status = 'inconsistent';
  } else if (!leaseHeld) {
    status = 'stale_write_lease';
  } else if (relay.waiting) {
    status = 'awaiting_resume';
  } else {
    status = 'active';
  }
  return {
    ok: true,
    projectId: context.projectId,
    projectName: context.projectName ?? null,
    worktreeId: context.worktreeId,
    assignmentId: context.assignmentId,
    sessionId: context.sessionId,
    agent: context.agentId ?? null,
    task: context.run?.goal ?? context.taskId ?? null,
    status,
    lifecycle: context.run?.lifecycle ?? null,
    health: context.run?.health ?? null,
    revision,
    assignmentRevision: context.revision ?? null,
    runRevision: context.run?.revision ?? null,
    leaseHeld,
    relay: relay.waiting,
    generation: relay.generation,
    lastActivityAt: context.run?.lastHeartbeatAt ?? context.lastHeartbeatAt ?? context.updatedAt ?? null,
  };
}

function readExactSessionState(db, sessionId) {
  const row = db.prepare('SELECT *, id AS assignment_id, revision AS assignment_revision FROM assignments WHERE session_id = ?').get(sessionId);
  return row ? readSessionStateRow(db, row) : null;
}

function publicSessionState(state) {
  if (!state) return null;
  return {
    sessionId: state.sessionId,
    assignmentId: state.assignmentId,
    projectId: state.projectId,
    projectName: state.projectName,
    worktreeId: state.worktreeId,
    agent: state.agent,
    task: state.task,
    status: state.status,
    revision: state.revision,
    assignmentRevision: state.assignmentRevision,
    runRevision: state.runRevision,
    leaseHeld: state.leaseHeld,
    relay: state.relay,
    relayGeneration: state.generation,
    lastActivityAt: state.lastActivityAt,
  };
}

function publicConversationOwner(owner, state) {
  if (!owner || !state) return null;
  return {
    bindingPersistence: owner.bindingKind === 'host' ? 'durable' : 'connection_only',
    holderType: owner.bindingKind === 'host' ? 'durable_chat' : 'previous_mcp_connection',
    host: owner.ownerHost ?? null,
    conversationLocator: owner.ownerLocator ?? null,
    task: state.task,
    agent: state.agent,
    lastActivityAt: state.lastActivityAt,
    boundAt: owner.boundAt,
  };
}

function publicBridgeBinding(state) {
  if (!state) return null;
  return {
    sessionId: state.sessionId,
    worktreeId: state.worktreeId,
    relayId: state.generation?.relayId ?? null,
    relaySequence: state.generation?.sequence ?? null,
    acceptedRevision: state.generation?.acceptedRevision ?? null,
  };
}

function publicStoredBinding(binding) {
  return {
    sessionId: binding.sessionId,
    worktreeId: binding.worktreeId,
    relayId: binding.relayId,
    relaySequence: binding.relaySequence,
    acceptedRevision: binding.acceptedRevision,
  };
}

function readLatestConversationNode(db, sessionId) {
  const node = db.prepare(`SELECT n.*,
      json_extract(c.response_json, '$.eventId') AS event_id,
      json_extract(c.response_json, '$.summary') AS response_summary,
      json_extract(c.response_json, '$.note') AS response_note
    FROM work_session_nodes n
    JOIN commands c ON c.id = n.command_id WHERE n.session_id = ? ORDER BY n.sequence DESC LIMIT 1`).get(sessionId);
  if (node) {
    // Resolve only this command's event. Never borrow the previous owner's
    // latest progress when a new takeover node has no business summary.
    const event = db.prepare(`SELECT summary, note FROM progress_events
      WHERE session_id = ? AND (id = ? OR client_request_id = ?) LIMIT 1`)
      .get(sessionId, typeof node.event_id === 'string' ? node.event_id : null, node.command_id);
    const summary = [event?.summary, event?.note, node.response_summary, node.response_note]
      .find((value) => typeof value === 'string' && value.trim());
    return { id: node.id, type: node.type, predecessorId: node.predecessor_id,
      actorKind: node.actor_kind, actorHost: node.actor_host, actorConversationId: node.actor_conversation_id,
      summary: summary ? summary.slice(0, 500) : null,
      createdAt: node.created_at };
  }
  const historical = db.prepare(`SELECT id, summary, created_at FROM progress_events
    WHERE session_id = ? ORDER BY revision DESC, created_at DESC LIMIT 1`).get(sessionId);
  return historical ? { id: historical.id, type: 'historical', historical: true,
    actorKind: 'unattributed', actorHost: null, actorConversationId: null,
    summary: historical.summary, createdAt: historical.created_at } : null;
}

function currentConversationAuthorization(db, binding, result = {}) {
  if (!binding?.key) return null;
  const sessionId = result?.sessionId ?? result?.session_id;
  const worktreeId = result?.worktreeId ?? result?.worktree_id;
  if (!safeSessionId(sessionId) || typeof worktreeId !== 'string' || !worktreeId.trim()) {
    return {
      known: false,
      canContinue: false,
      writable: false,
    };
  }
  const current = readExactSessionState(db, sessionId);
  const authorization = readConversationAuthorization(db, binding.key, current);
  const writable = authorization.authorized && current.worktreeId === worktreeId;
  return {
    known: true,
    sessionId: current?.sessionId ?? null,
    revision: current?.revision ?? null,
    status: current?.status ?? null,
    generation: current?.generation ?? null,
    owner: authorization.owner?.conversationKey ?? null,
    canContinue: writable,
    writable,
  };
}

function bindingReport(binding, result = {}, currentAuthorization = null) {
  const bindingKind = binding?.bindingKind ?? 'legacy';
  const bindingPersistence = bindingKind === 'host'
    ? 'durable'
    : bindingKind === 'connection' ? 'connection_only' : 'legacy';
  const resultCanContinue = Object.prototype.hasOwnProperty.call(result, 'canContinue')
    ? result.canContinue === true
    : (result.status === 'active' && result.ok === true && bindingKind !== 'legacy');
  const canUseCurrentBinding = currentAuthorization
    ? currentAuthorization.canContinue === true
    : !binding?.key;
  const canContinue = resultCanContinue && canUseCurrentBinding && bindingKind === 'host';
  const writable = canContinue
    && result.status === 'active'
    && (currentAuthorization ? currentAuthorization.writable === true : !binding?.key);
  return {
    bindingKind,
    bindingPersistence,
    capabilities: {
      readContext: true,
      continueSession: canContinue,
      writeSession: writable,
      prepareRelay: writable,
      resumeRelay: bindingKind !== 'legacy',
      requestTakeover: false,
      consumeTransfer: bindingKind === 'host',
    },
  };
}

function withBindingReport(result, binding, currentAuthorization = null) {
  return result && typeof result === 'object'
    ? { ...result, ...bindingReport(binding, result, currentAuthorization) }
    : result;
}

// Only pre-migration, unidentified clients use a supplied bridge snapshot.
// Authenticated owners are checked against the database, never Relay history.
function legacyBridgeBindingMatches(state, binding) {
  if (!state || !binding || binding.revoked
    || binding.sessionId !== state.sessionId
    || binding.worktreeId !== state.worktreeId) return false;
  const current = state.generation;
  const bound = binding.relayId === null || binding.relayId === undefined
    ? null
    : {
      relayId: binding.relayId,
      sequence: binding.relaySequence,
      acceptedRevision: binding.acceptedRevision,
    };
  if (!current || !bound) return !current && !bound;
  return current.relayId === bound.relayId
    && current.sequence === bound.sequence
    && current.acceptedRevision === bound.acceptedRevision;
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

async function readAvatarUploadBody(request, maxBytes = MAX_AVATAR_FILE_SIZE) {
  // The JSON path carries base64 (4/3 size inflation), so the transport-level
  // cap must allow an encoded 5MB image; the decoded buffer is still enforced
  // against maxBytes below before any storage or processing happens.
  const hardLimit = maxBytes * 2 + 128 * 1024;
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > hardLimit) {
      const error = new Error('所选头像超过 5MB。');
      error.code = 'IMAGE_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const rawBuffer = Buffer.concat(chunks);
  const contentType = request.headers['content-type'] || '';

  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    const webReq = new Request(`http://${request.headers.host || '127.0.0.1'}${request.url}`, {
      method: request.method,
      headers: request.headers,
      body: rawBuffer,
    });
    const formData = await webReq.formData();
    const file = formData.get('file') || formData.get('avatar');
    if (!file || typeof file.arrayBuffer !== 'function') {
      const error = new Error('未提供有效的头像文件。');
      error.code = 'INVALID_IMAGE_PATH';
      throw error;
    }
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > maxBytes) {
      const error = new Error('所选头像超过 5MB。');
      error.code = 'IMAGE_TOO_LARGE';
      throw error;
    }
    return {
      content: buf,
      originalName: file.name || '',
      mimeType: file.type || '',
    };
  }

  if (contentType.toLowerCase().startsWith('application/json')) {
    if (rawBuffer.length === 0) {
      const error = new Error('未提供有效的头像文件。');
      error.code = 'INVALID_IMAGE_PATH';
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(rawBuffer.toString('utf8'));
    } catch {
      const error = new Error('提交的信息不完整或格式不正确。');
      error.code = 'INVALID_REQUEST';
      throw error;
    }
    if (parsed.content || parsed.data) {
      const b64 = parsed.content || parsed.data;
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > maxBytes) {
        const error = new Error('所选头像超过 5MB。');
        error.code = 'IMAGE_TOO_LARGE';
        throw error;
      }
      return {
        content: buf,
        originalName: parsed.originalName || parsed.filename || parsed.fileName || '',
        mimeType: parsed.mimeType || parsed.type || '',
      };
    }
    const error = new Error('未提供有效的头像文件。');
    error.code = 'INVALID_IMAGE_PATH';
    throw error;
  }

  if (rawBuffer.length > maxBytes) {
    const error = new Error('所选头像超过 5MB。');
    error.code = 'IMAGE_TOO_LARGE';
    throw error;
  }

  // Raw binary (e.g. image/png, application/octet-stream, etc.)
  return {
    content: rawBuffer,
    mimeType: contentType,
  };
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
        // Keep the bearer-derived principal for existing folder/grant callers.
        // Conversation continuity uses the separately derived connection
        // principal below, which remains stable when the scoped token rotates.
        principalHash: createHash('sha256').update(`mcp:${candidate}`).digest('hex'),
        connectionPrincipalHash: session.connectionPrincipalHash
          ?? createHash('sha256').update(`mcp:${candidate}`).digest('hex'),
        connectionHandleRecognized: session.connectionHandleRecognized === true,
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
    ...(Number.isInteger(probe.lifecycleEpoch) ? { lifecycleEpoch: probe.lifecycleEpoch } : {}),
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
  imagePicker = null,
  avatarStorageRoot = path.join(path.dirname(dbPath), 'project-avatars'),
  folderGrants = null,
  emptyFolderGrants = null,
  webRoot = DEFAULT_WEB_ROOT,
  serveWebAsset = defaultServeWebAsset,
  faultInjector,
  createGitWorktree,
  checkBranchExists,
  diagnosticLogDirectory = path.join(path.dirname(dbPath), 'logs'),
}) {
  if (!token || token.length < 32) throw new Error('A local API token of at least 32 characters is required.');
  const db = openCockpitDatabase(dbPath);
  const activeFolderGrants = folderGrants ?? new FolderGrantStore({ db });
  const activeEmptyFolderGrants = emptyFolderGrants ?? new EmptyFolderGrantStore({ db });
  const browserSessionToken = randomBytes(32).toString('base64url');
  const mcpSessions = new Map();
  const diagnosticLogger = createDiagnosticLogger({ directory: diagnosticLogDirectory });

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

  async function prepareEmptyFolderSelection(selectedPath, principalHash) {
    if (!selectedPath) return { ok: true, cancelled: true };
    const binding = authorizeEmptyDirectory(selectedPath, selectedPath);
    revalidateEmptyDirectory(binding);
    const grant = activeEmptyFolderGrants.issue(binding, principalHash);
    return {
      ok: true,
      cancelled: false,
      grantId: grant.grantId,
      folderName: path.basename(binding.candidateReal),
      folderPath: binding.candidateReal,
      expiresAt: grant.expiresAt,
      promise: '只在空目录中创建托管开发空间；不会清理、覆盖、提交、上传或删除其他文件。',
    };
  }

  async function observeRegisteredProject(projectId, expected = null) {
    const project = readProjectContext(db, projectId);
    if (!project) {
      const error = new Error('Project not found.');
      error.code = 'PROJECT_NOT_FOUND';
      throw error;
    }
    const targetWorktreeId = expected?.worktreeId ?? project.worktree_id;
    let authorizedRoot;
    let expectedCanonicalPath;
    let expectedWorktreeIdentity;
    let spaceRow = null;

    if (targetWorktreeId === project.worktree_id) {
      authorizedRoot = project.authorized_root;
      expectedCanonicalPath = project.canonical_path;
      expectedWorktreeIdentity = project.identity_fingerprint;
    } else {
      spaceRow = db.prepare(`
        SELECT development_spaces.*,
               worktrees.canonical_path, worktrees.repository_identity,
               worktrees.identity_fingerprint
        FROM development_spaces
        JOIN worktrees ON worktrees.id = development_spaces.worktree_id
        WHERE development_spaces.worktree_id = ? AND development_spaces.project_id = ?
      `).get(targetWorktreeId, projectId);
      if (!spaceRow) {
        const error = new Error('Development space worktree not found.');
        error.code = 'WORKTREE_NOT_FOUND';
        throw error;
      }
      if (spaceRow.status === 'archived') {
        const error = new Error('Development space is archived.');
        error.code = 'WORKTREE_NOT_FOUND';
        throw error;
      }
      authorizedRoot = spaceRow.canonical_path;
      expectedCanonicalPath = spaceRow.canonical_path;
      expectedWorktreeIdentity = spaceRow.identity_fingerprint;
    }

    const binding = authorizeExistingPath(expectedCanonicalPath, authorizedRoot);
    const lifecycleEpoch = db.prepare('SELECT lifecycle_epoch FROM worktrees WHERE id = ?')
      .get(targetWorktreeId)?.lifecycle_epoch ?? 0;
    const observation = { ...await probe(
      binding.candidateReal,
      expected?.baselineHead ? { expectedBaselineHead: expected.baselineHead } : undefined,
    ), lifecycleEpoch };
    revalidateAuthorizedPath(binding);
    authorizeObservation(observation, [authorizedRoot, project.authorized_root]);
    if (
      observation.canonicalPath !== expectedCanonicalPath
      || observation.repositoryIdentity !== project.repository_identity
      || observation.worktreeIdentity !== expectedWorktreeIdentity
      || (expected && (
        (expected.projectId && expected.projectId !== project.id)
        || (expected.worktreeId && expected.worktreeId !== targetWorktreeId)
        || (expected.repositoryIdentity && expected.repositoryIdentity !== project.repository_identity)
        || (expected.worktreeIdentity && expected.worktreeIdentity !== expectedWorktreeIdentity)
      ))
    ) {
      const error = new Error('Registered project or space identity changed.');
      error.code = 'WORKTREE_IDENTITY_CHANGED';
      throw error;
    }
    return { project, space: spaceRow, observation, worktreeId: targetWorktreeId };
  }

  function isUnusableMcpWorkingCandidate(error) {
    return [
      'ENOENT',
      'PATH_OUTSIDE_SCOPE',
      'PATH_NOT_AUTHORIZED',
      'REPARSE_POINT',
      'PATH_NOT_FOUND',
    ].includes(error?.code);
  }

  async function resolveMcpWorkingProject(workingDirectory) {
    if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) {
      const error = new Error('MCP working directory is unavailable.');
      error.code = 'PROJECT_NOT_FOUND';
      throw error;
    }
    const candidates = db.prepare(`
      SELECT * FROM (
        SELECT projects.id AS project_id, projects.worktree_id AS worktree_id, worktrees.canonical_path AS canonical_path
        FROM projects
        JOIN worktrees ON worktrees.id = projects.worktree_id
        UNION ALL
        SELECT development_spaces.project_id AS project_id, development_spaces.worktree_id AS worktree_id, worktrees.canonical_path AS canonical_path
        FROM development_spaces
        JOIN worktrees ON worktrees.id = development_spaces.worktree_id
        WHERE development_spaces.status != 'archived'
      )
      ORDER BY length(canonical_path) DESC
    `).all();
    for (const candidate of candidates) {
      try {
        const binding = authorizeExistingPath(workingDirectory, candidate.canonical_path);
        revalidateAuthorizedPath(binding);
        return observeRegisteredProject(candidate.project_id, { worktreeId: candidate.worktree_id });
      } catch (error) {
        if (isUnusableMcpWorkingCandidate(error)) continue;
        throw error;
      }
    }
    const error = new Error('The MCP working project is not registered.');
    error.code = 'PROJECT_NOT_FOUND';
    throw error;
  }

  async function resolveMcpWorkingCandidates(workingDirectory) {
    if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) {
      const error = new Error('MCP working directory is unavailable.');
      error.code = 'PROJECT_NOT_FOUND';
      throw error;
    }
    const candidates = db.prepare(`
      SELECT * FROM (
        SELECT projects.id AS project_id, projects.worktree_id AS worktree_id,
               worktrees.canonical_path AS canonical_path
        FROM projects
        JOIN worktrees ON worktrees.id = projects.worktree_id
        UNION ALL
        SELECT development_spaces.project_id AS project_id,
               development_spaces.worktree_id AS worktree_id,
               worktrees.canonical_path AS canonical_path
        FROM development_spaces
        JOIN worktrees ON worktrees.id = development_spaces.worktree_id
        WHERE development_spaces.status != 'archived'
      )
      ORDER BY length(canonical_path) DESC, canonical_path ASC,
               project_id ASC, worktree_id ASC
    `).all();
    const pathMatches = [];
    for (const candidate of candidates) {
      try {
        const binding = authorizeExistingPath(workingDirectory, candidate.canonical_path);
        revalidateAuthorizedPath(binding);
        pathMatches.push(candidate);
      } catch (error) {
        if (isUnusableMcpWorkingCandidate(error)) continue;
        throw error;
      }
    }
    if (pathMatches.length === 0) return [];
    const ordered = [...pathMatches].sort((left, right) => {
      const lengthDifference = right.canonical_path.length - left.canonical_path.length;
      return lengthDifference
        || left.project_id.localeCompare(right.project_id)
        || left.worktree_id.localeCompare(right.worktree_id);
    });
    const mostSpecificLength = ordered[0].canonical_path.length;
    const selected = ordered.filter((candidate) => candidate.canonical_path.length === mostSpecificLength);
    const matches = [];
    const seen = new Set();
    for (const candidate of selected) {
      const key = `${candidate.project_id}\0${candidate.worktree_id}`;
      if (seen.has(key)) continue;
      const working = await observeRegisteredProject(candidate.project_id, {
        worktreeId: candidate.worktree_id,
      });
      seen.add(key);
      matches.push(working);
    }
    return matches;
  }

  async function readMcpWorkContext(body, key = null, conversationBinding = null) {
    const safety = {
      impact: '本次查询没有修改代码、平台会话、写入归属、租约、心跳或 revision。',
      required_action: '请根据 status、bindingStatus 和 canContinue 处理；不要猜测编号或自动接管。',
      next_command: null,
      warnings: [],
    };
    const matches = await resolveMcpWorkingCandidates(body.mcpWorkingDirectory);
    if (matches.length === 0) {
      return {
        ok: true,
        ...safety,
        canContinue: false,
        requiresUserConfirmation: false,
        bindingStatus: body.bridgeBinding ? 'stale' : 'unbound',
        status: 'no_session',
        sessionId: null,
        revision: null,
        candidates: [],
        message: body.bridgeBinding
          ? '当前目录没有找到旧绑定对应的已授权工作会话；没有刷新旧绑定。'
          : '当前目录没有找到已登记的工作会话；没有创建新会话。',
      };
    }

    const ordered = [...matches].sort((left, right) => {
      const leftLength = left.observation.canonicalPath.length;
      const rightLength = right.observation.canonicalPath.length;
      return rightLength - leftLength
        || left.project.id.localeCompare(right.project.id)
        || left.worktreeId.localeCompare(right.worktreeId);
    });
    const mostSpecificLength = ordered[0].observation.canonicalPath.length;
    const specific = ordered.filter((candidate) => candidate.observation.canonicalPath.length === mostSpecificLength);
    const states = specific.map((candidate) => ({
      candidate,
      state: readWorktreeSessionState(db, candidate.worktreeId),
    }));
    // Once identified, restore the bound session, not whichever session at the
    // same code location happens to be newest (e.g. active + standby).
    if (key && states.length === 1) {
      const binding = readConversationBinding(db, key, states[0].candidate.worktreeId);
      if (binding) states[0].state = { status: 'session', session: readExactSessionState(db, binding.sessionId) };
    }
    if (states.length !== 1) {
      return {
        ok: true,
        ...safety,
        canContinue: false,
        requiresUserConfirmation: false,
        bindingStatus: 'ambiguous',
        status: 'ambiguous',
        sessionId: null,
        revision: null,
        candidates: states.flatMap(({ state }) => state.status === 'ambiguous'
          ? state.sessions.map(publicSessionState)
          : [publicSessionState(state.session)]),
        message: '当前代码目录对应多个已登记工作位置；没有猜测会话归属，也没有修改平台记录。',
      };
    }

    const [{ state }] = states;
    if (state.status === 'ambiguous') {
      return {
        ok: true,
        ...safety,
        canContinue: false,
        requiresUserConfirmation: false,
        bindingStatus: 'ambiguous',
        status: 'ambiguous',
        sessionId: null,
        revision: null,
        candidates: state.sessions.map(publicSessionState),
        message: '当前代码目录存在多个 active 工作会话；没有猜测会话归属，也没有修改平台记录。',
      };
    }

    const current = state.session;
    if (!current) {
      return {
        ok: true,
        ...safety,
        canContinue: false,
        requiresUserConfirmation: false,
        bindingStatus: body.bridgeBinding ? 'stale' : 'unbound',
        status: 'no_session',
        sessionId: null,
        revision: null,
        candidates: [],
        message: '当前代码目录尚无可继续的工作会话；没有创建新会话。',
      };
    }

    const authorization = readConversationAuthorization(db, key, current);
    if (key) body = { ...body, bridgeBinding: authorization.binding };
    const owner = authorization.owner;
    const ownedElsewhere = owner && owner.conversationKey !== key;
    const base = {
      ...publicSessionState(current),
      latestNode: readLatestConversationNode(db, current.sessionId),
      owner: publicConversationOwner(owner, current),
      candidates: [publicSessionState(current)],
      requiresUserConfirmation: false,
      canContinue: false,
      bindingStatus: body.bridgeBinding ? 'stale' : 'unbound',
      bindingPersistence: conversationBinding?.bindingKind === 'host' ? 'durable' : 'connection_only',
    };

    if (current.status !== 'active') {
      return {
        ok: true,
        ...safety,
        ...base,
        message: current.status === 'awaiting_resume'
          ? '当前会话正在等待新的 AI 会话接手；查询没有取得写入权限。'
          : '当前工作会话已经结束或不具备安全继续条件；没有创建新会话。',
      };
    }

    const hasBinding = Boolean(body.bridgeBinding);
    if (authorization.reason === 'transfer_pending') {
      return { ok: true, ...safety, ...base, bindingReason: 'transfer_pending',
        recoveryAction: 'open_workbench_transfer', transfer: readTransferState(db, current.sessionId),
        message: '用户已在工作台授权转交，此工作链暂停旧聊天推进。代码未被修改；请使用工作台接手指令，或由用户取消转交。' };
    }
    const matchesBinding = key ? authorization.authorized : legacyBridgeBindingMatches(current, body.bridgeBinding);
    if (hasBinding && matchesBinding && !ownedElsewhere) {
      return {
        ok: true,
        ...safety,
        ...base,
        canContinue: true,
        bindingStatus: 'bound',
        binding: key ? publicStoredBinding(authorization.binding) : publicBridgeBinding(current),
        message: '已核对当前 bridge 绑定；返回的是平台最新 revision，查询没有修改平台状态。',
      };
    }

    if (ownedElsewhere) {
      return {
        ok: true,
        ...safety,
        ...base,
        bindingStatus: hasBinding ? 'stale' : 'unbound',
        bindingReason: hasBinding ? 'replaced' : 'held_by_another_chat',
        recoveryAction: 'open_workbench_transfer',
        generationScope: 'session_history_not_current_chat',
        requiresUserConfirmation: false,
        owner: publicConversationOwner(owner, current),
        availableActions: ['return_to_owner', 'open_workbench_transfer'],
        message: hasBinding
          ? '当前聊天已被替代，当前持有人及最新节点已显示。代码未被修改；请回到持有聊天，或由用户在工作台授权转交。'
          : '此工作链由此前持有人继续，身份与最新节点已显示。代码未被修改；请回到持有聊天，或由用户在工作台授权转交。',
      };
    }

    if (hasBinding) {
      return {
        ok: true,
        ...safety,
        ...base,
        bindingStatus: 'stale',
        bindingReason: key ? authorization.reason : 'replaced',
        recoveryAction: key ? 'inspect_binding' : 'use_latest_relay',
        generationScope: 'session_history_not_current_chat',
        requiresUserConfirmation: false,
        message: key
          ? '当前绑定未通过数据库归属核验，不能继续写入。代码未被修改，请保留诊断信息排查，不要反复接手。'
          : '这个聊天已被其他接手聊天替代，不能自动取回归属。请使用最新接力消息。',
      };
    }

    if (body.confirmSessionId !== undefined) {
      if (body.confirmSessionId !== current.sessionId || body.expectedRevision !== current.revision) {
        const error = new Error('Context confirmation no longer matches the current session.');
        error.code = 'SESSION_CONTEXT_CONFIRMATION_STALE';
        error.context = { ...base, sessionValidated: true };
        throw error;
      }
      if (key) withImmediateTransaction(db, () => bindConversation(
        db,
        key,
        publicBridgeBinding(current),
        { owner: conversationBinding },
      ));
      return {
        ok: true,
        ...safety,
        ...base,
        canContinue: true,
        requiresUserConfirmation: false,
        bindingStatus: 'bound',
        bindingEstablished: true,
        binding: publicBridgeBinding(current),
        message: '已按用户确认绑定当前 bridge；未改变平台写入归属、租约或 revision。',
      };
    }

    return {
      ok: true,
      ...safety,
      ...base,
      requiresUserConfirmation: true,
      message: '已找到当前目录唯一 active 工作会话；请先向用户确认“继续此工作会话”，再用返回的 sessionId 与 revision 调用 context 确认。',
    };
  }

  function assertConversationWrite(key, sessionId, allowedStatuses = ['active']) {
    if (!sessionId) return;
    const context = readSessionContext(db, sessionId);
    if (!context?.ok) return; // Existing route reports the precise missing-session error.
    const current = readExactSessionState(db, sessionId);
    const authorization = readConversationAuthorization(db, key, current, allowedStatuses);
    const owner = authorization.owner;
    if (!key && !owner) return; // Existing clients keep working until this session is explicitly migrated.
    const bindingReason = authorization.reason;
    if (bindingReason) {
      throw Object.assign(new Error('Conversation binding is missing or stale.'), {
        code: 'CONVERSATION_BINDING_CONFLICT',
        context: {
          sessionId: current?.sessionId ?? null,
          projectId: context.projectId,
          worktreeId: current?.worktreeId ?? context.worktreeId,
          owner: publicConversationOwner(owner, current),
          latestNode: current ? readLatestConversationNode(db, current.sessionId) : null,
          recoveryAction: 'open_workbench_transfer',
          revision: current?.revision ?? context.revision ?? null,
          status: current?.status ?? context.status ?? null,
          bindingStatus: 'stale',
          bindingReason,
          canContinue: false,
          requiresUserConfirmation: false,
          sessionValidated: Boolean(current?.sessionId === sessionId),
        },
      });
    }
  }

  function rememberConversation(key, result, conversationBinding = null) {
    if (!key || !result?.ok) return result;
    const current = readExactSessionState(db, result.sessionId);
    if (!current || current.sessionId !== result.sessionId || current.generation) {
      throw Object.assign(new Error('An old initialization cannot replace a relay binding.'), { code: 'CONVERSATION_BINDING_CONFLICT' });
    }
    withImmediateTransaction(db, () => bindConversation(
      db,
      key,
      publicBridgeBinding(current),
      { owner: conversationBinding },
    ));
    return result;
  }

  const server = createServer((request, response) => withCommandActor({ kind: 'unattributed' }, async () => {
    try {
      const currentPort = server.address().port;
      const url = new URL(request.url, `http://${host}:${currentPort}`);
      const requestedDiagnosticId = request.headers['x-ugk-diagnostic-id'];
      const diagnosticId = typeof requestedDiagnosticId === 'string'
        && DIAGNOSTIC_ID_PATTERN.test(requestedDiagnosticId)
        ? requestedDiagnosticId
        : `diag_${randomBytes(12).toString('hex')}`;
      response.__ugkDiagnosticId = diagnosticId;
      response.__ugkDiagnosticLogger = diagnosticLogger;
      response.__ugkDiagnosticDb = db;
      response.__ugkDiagnosticContext = {
        operation: diagnosticOperation(url.pathname),
        diagnosticId,
        identitySource: 'none',
        identityRecognized: false,
      };
      let key = null;
      let identity = null;
      if (request.headers['x-ugk-conversation']) {
        try {
          identity = JSON.parse(Buffer.from(request.headers['x-ugk-conversation'], 'base64url').toString('utf8'));
          key = conversationKey(conversationIdentity({ 'io.ugk.cockpit/conversation': identity }));
        } catch {
          sendError(response, 'INVALID_REQUEST');
          return;
        }
      }
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

      if (url.pathname === '/') {
        sendError(response, 'SERVICE_UNAVAILABLE');
        return;
      }

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
        const handleCapable = body.connectionHandleVersion === 'v1' || body.connectionHandle !== undefined;
        let connection;
        if (body.connectionHandle !== undefined) {
          connection = verifyConnectionHandle(body.connectionHandle, token);
          if (!connection) {
            response.__ugkDiagnosticContext = {
              ...response.__ugkDiagnosticContext,
              identitySource: 'connection_handle',
              credentialEvent: 'refresh_rejected',
              bindingReason: 'connection_handle_rejected',
            };
            sendError(response, 'MCP_CONNECTION_HANDLE_INVALID', {
              extra: { reason: 'connection_handle_rejected' },
            });
            return;
          }
          response.__ugkDiagnosticContext = {
            ...response.__ugkDiagnosticContext,
            identitySource: 'connection_handle',
            identityRecognized: true,
            credentialEvent: 'resumed',
          };
        } else {
          connection = issueConnectionHandle(token);
          response.__ugkDiagnosticContext = {
            ...response.__ugkDiagnosticContext,
            identitySource: 'anonymous_bridge',
            credentialEvent: 'issued',
            anonymousBridgeStart: true,
          };
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
        mcpSessions.set(scopedToken, {
          expiresAt,
          connectionPrincipalHash: handleCapable ? connection.connectionPrincipalHash : null,
          connectionHandleRecognized: handleCapable,
        });
        sendJson(response, 201, {
          ok: true,
          token: scopedToken,
          expiresAt: new Date(expiresAt).toISOString(),
          connectionHandle: connection.handle ?? body.connectionHandle,
        });
        return;
      }
      const authentication = authenticate(request, token, browserSessionToken, mcpSessions);
      if (!authentication) {
        sendError(response, 'AUTH_REQUIRED');
        return;
      }
      const conversationBinding = identity
        ? {
          key,
          bindingKind: 'host',
          host: identity.host,
          locator: identity.id,
        }
        : authentication.kind === 'mcp'
          ? {
            key: conversationKey({
              host: 'ugk-mcp-connection',
              id: authentication.connectionHandleRecognized
                ? authentication.connectionPrincipalHash
                : authentication.principalHash,
            }),
            bindingKind: 'connection',
            host: null,
            locator: null,
          }
          : null;
      if (url.pathname.startsWith('/api/v1/mcp/')) {
        response.__ugkBindingReport = bindingReport(conversationBinding);
      }
      response.__ugkDiagnosticContext = {
        ...response.__ugkDiagnosticContext,
        identitySource: identity
          ? 'host_metadata'
          : authentication.kind === 'mcp'
            ? (authentication.connectionHandleRecognized ? 'connection_handle' : 'legacy_token')
            : authentication.kind === 'bearer' ? 'legacy_token' : 'none',
        identityRecognized: Boolean(
          identity || (authentication.kind === 'mcp' && authentication.connectionHandleRecognized),
        ),
      };
      key = conversationBinding?.key ?? key;
      setCommandActor(identity
        ? { kind: 'ai', host: identity.host, conversationId: identity.id }
        : { kind: authentication.kind === 'browser' ? 'user' : 'unattributed', host: null, conversationId: null });
      const reportCurrentBinding = (result) => {
        const reported = withBindingReport(result, conversationBinding,
          currentConversationAuthorization(db, conversationBinding, result));
        if (authentication.kind === 'mcp' && !identity && (result?.canContinue || result?.requiresUserConfirmation)) {
          return { ...reported, canContinue: false, requiresUserConfirmation: false,
            bindingReason: 'identity_required', recoveryAction: 'upgrade_host_identity',
            message: '当前宿主未提供稳定会话 ID。历史记录已保留，不能继续新增 AI 工作节点；请升级宿主接入后由用户在工作台授权转交。' };
        }
        return reported;
      };
      if (
        authentication.kind === 'browser'
        && request.method !== 'GET'
        && (
          !request.headers.origin
          || request.headers['sec-fetch-site'] !== 'same-origin'
          || (
            !request.headers['content-type']?.toLowerCase().startsWith('application/json')
            && !(
              request.method === 'POST'
              && /^\/api\/v1\/projects\/[^/]+\/avatar\/upload$/.test(url.pathname)
              && request.headers['content-type']?.toLowerCase().startsWith('multipart/form-data')
            )
          )
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
      // Historical unknown actors remain readable. New AI workflow writes must
      // have the host's per-request identity, never just a connection credential.
      if (authentication.kind === 'mcp' && !identity && request.method !== 'GET'
        && !['/api/v1/mcp/work/context', '/api/v1/mcp/work/submit/preflight',
          '/api/v1/mcp/submit-notes/get'].includes(url.pathname)) {
        sendError(response, 'CONVERSATION_IDENTITY_REQUIRED'); return;
      }

      const controlMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/conversation-control(?:\/([^/]+)\/(transfer|cancel))?$/);
      if (controlMatch) {
        const projectId = decodeURIComponent(controlMatch[1]);
        if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) {
          sendError(response, 'PROJECT_NOT_FOUND'); return;
        }
        if (request.method === 'GET' && !controlMatch[2]) {
          const chains = db.prepare(`SELECT DISTINCT session_id FROM assignments
            WHERE project_id = ? AND session_id IS NOT NULL ORDER BY created_at DESC`).all(projectId)
            .map(({ session_id: sessionId }) => {
              const current = readExactSessionState(db, sessionId);
              if (!current) return null;
              const pending = readTransferState(db, sessionId);
              return { sessionId, worktreeId: current.worktreeId, task: current.task,
                status: current.status, revision: current.revision,
                owner: publicConversationOwner(readConversationOwner(db, sessionId), current),
                latestNode: readLatestConversationNode(db, sessionId),
                transfer: pending ? { ...pending, status: pending.expired ? 'expired' : 'pending',
                  expiresAt: new Date(pending.expiresAt).toISOString() } : null };
            }).filter(Boolean);
          sendJson(response, 200, { ok: true, chains }); return;
        }
        if (request.method !== 'POST' || !controlMatch[2]) { sendError(response, 'NOT_FOUND'); return; }
        if (authentication.kind !== 'browser') { sendError(response, 'AUTH_REQUIRED'); return; }
        const sessionId = decodeURIComponent(controlMatch[2]);
        const context = readSessionContext(db, sessionId);
        if (!context.ok || context.projectId !== projectId) { sendError(response, 'NOT_FOUND'); return; }
        const body = await readJson(request);
        const allowed = new Set(controlMatch[3] === 'transfer'
          ? ['clientRequestId', 'expectedRevision', 'targetHost', 'targetConversationId']
          : ['clientRequestId', 'expectedRevision', 'restorePreviousOwner']);
        rejectUnexpectedMcpFields(body, allowed, 'platform transfer');
        requireString(body, 'clientRequestId');
        if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) {
          sendError(response, 'INVALID_REQUEST'); return;
        }
        if (body.targetHost !== undefined || body.targetConversationId !== undefined) {
          try { conversationIdentity({ 'io.ugk.cockpit/conversation': { host: body.targetHost, id: body.targetConversationId } }); }
          catch { sendError(response, 'INVALID_REQUEST'); return; }
        }
        const result = controlMatch[3] === 'transfer'
          ? issueConversationTransfer(db, { ...body, sessionId }, { authorizationKey: token, faultInjector })
          : cancelConversationTransfer(db, { ...body, sessionId }, { faultInjector });
        if (!result.ok) { sendError(response, result.code, { extra: { sessionId, revision: result.revision ?? context.revision } }); return; }
        sendJson(response, 200, result.transferCode ? {
          ...result, expiresAt: new Date(result.expiresAt).toISOString(),
          continueMessage: `请在目标项目的聊天中使用工作台授权接手，调用 ugk_work_takeover，参数为 sessionId: "${sessionId}"、transferCode: "${result.transferCode}"，并生成新的 clientRequestId。不要重新 init，不清理或覆盖代码。成功后先查询 ugk_work_context({})，报告平台返回的会话 ID、revision 和 canContinue，等待用户安排。`,
        } : result);
        return;
      }

      if (request.method === 'POST' && (
        url.pathname === '/api/v1/folders/select-empty'
        || (url.pathname === '/api/v1/folders/select' && (url.searchParams.get('type') === 'empty' || url.searchParams.get('mode') === 'empty'))
      )) {
        const selectedPath = await folderPicker();
        sendJson(response, 200, await prepareEmptyFolderSelection(selectedPath, authentication.principalHash));
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

      const projectRefreshMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/refresh$/);
      if (request.method === 'POST' && projectRefreshMatch) {
        const projectId = decodeURIComponent(projectRefreshMatch[1]);
        const body = await readJson(request);
        requireString(body, 'commandId');
        if (Object.keys(body).some((key) => key !== 'commandId')) {
          sendError(response, 'INVALID_REQUEST');
          return;
        }
        const { observation } = await observeRegisteredProject(projectId);
        const result = refreshProject(db, {
          commandId: body.commandId,
          projectId,
          observation,
        });
        if (result.ok) sendJson(response, 200, result);
        else sendError(response, result.code, { commandId: body.commandId });
        return;
      }

      const projectSpacesMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/spaces$/);
      if (request.method === 'GET' && projectSpacesMatch) {
        const projectId = decodeURIComponent(projectSpacesMatch[1]);
        const project = readProjectContext(db, projectId);
        if (!project) {
          sendError(response, 'PROJECT_NOT_FOUND');
          return;
        }
        const status = url.searchParams.get('status') || undefined;
        const spaces = listDevelopmentWorkspaces(db, { projectId, status });
        sendJson(response, 200, {
          ok: true,
          projectId,
          spaces,
        });
        return;
      }

      if (request.method === 'POST' && projectSpacesMatch) {
        const projectId = decodeURIComponent(projectSpacesMatch[1]);
        const body = await readJson(request);
        requireString(body, 'commandId');
        requireString(body, 'grantId');
        requireString(body, 'expectedBaseHead');
        if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
          sendError(response, 'INVALID_REQUEST');
          return;
        }
        const allowedKeys = new Set(['commandId', 'grantId', 'expectedBaseHead', 'name']);
        for (const key of Object.keys(body)) {
          if (!allowedKeys.has(key)) {
            sendError(response, 'INVALID_REQUEST');
            return;
          }
        }
        const existingCmd = readCommand(db, body.commandId);
        const isReplay = existingCmd?.kind === 'workspace.create' && ['committed', 'failed'].includes(existingCmd.state);
        const result = await createDevelopmentWorkspace(db, {
          commandId: body.commandId,
          projectId,
          grantId: body.grantId,
          expectedBaseHead: body.expectedBaseHead,
          name: body.name?.trim() || '',
          principalHash: authentication.principalHash,
        }, {
          probe,
          createGitWorktree,
          checkBranchExists,
          grantStore: activeEmptyFolderGrants,
        });
        if (result.ok) {
          sendJson(response, (isReplay || result.alreadyExists) ? 200 : 201, {
            ...result,
            ...(isReplay ? { alreadyExists: true } : {}),
          });
        } else {
          sendError(response, result.code, {
            commandId: body.commandId,
            extra: {
              space_id: result.spaceId ?? null,
              worktree_id: result.worktreeId ?? null,
            },
          });
        }
        return;
      }

      const projectSpaceActionMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/spaces\/([^/]+)\/(reuse|remove)$/);
      if (request.method === 'POST' && projectSpaceActionMatch) {
        const projectId = decodeURIComponent(projectSpaceActionMatch[1]);
        const spaceId = decodeURIComponent(projectSpaceActionMatch[2]);
        const action = projectSpaceActionMatch[3];
        const body = await readJson(request);
        requireString(body, 'commandId');
        if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
          sendError(response, 'INVALID_REQUEST');
          return;
        }
        const allowedKeys = action === 'reuse'
          ? new Set(['commandId', 'expectedRevision', 'expectedBaseHead'])
          : new Set(['commandId', 'expectedRevision']);
        if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
          sendError(response, 'INVALID_REQUEST');
          return;
        }
        if (action === 'reuse') requireString(body, 'expectedBaseHead');

        const result = action === 'reuse'
          ? await reuseDevelopmentWorkspace(db, {
              commandId: body.commandId,
              projectId,
              spaceId,
              expectedRevision: body.expectedRevision,
              expectedBaseHead: body.expectedBaseHead,
            }, { probe, checkBranchExists, faultInjector })
          : await removeDevelopmentWorkspace(db, {
              commandId: body.commandId,
              projectId,
              spaceId,
              expectedRevision: body.expectedRevision,
            }, { probe, faultInjector });
        if (result.ok) {
          sendJson(response, 200, result);
        } else {
          const command = readCommand(db, body.commandId);
          // An error response alone does not establish whether Git changed.
          // Only a terminal failed journal entry confirms failure; all other
          // outcomes retain the exact request for recovery.
          const confirmedFailure = command?.state === 'failed'
            && result.outcome !== 'unknown' && result.retryable !== true;
          const outcome = confirmedFailure ? 'confirmed_failure' : 'unknown';
          sendError(response, result.code, {
            commandId: body.commandId,
            extra: {
              space_id: spaceId,
              outcome,
              state: command?.state ?? 'received',
              retryable: !confirmedFailure,
              ...(!confirmedFailure ? {
                impact: WORKSPACE_PENDING_ERROR.impact,
                required_action: WORKSPACE_PENDING_ERROR.requiredAction,
              } : {}),
            },
          });
        }
        return;
      }

      const projectArchiveMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/archive$/);
      const workLineStateMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/work-lines\/([^/]+)\/state$/);
      if (request.method === 'POST' && (projectArchiveMatch || workLineStateMatch)) {
        const match = projectArchiveMatch || workLineStateMatch;
        const projectId = decodeURIComponent(match[1]);
        const body = await readJson(request);
        requireString(body, 'commandId');
        const flag = projectArchiveMatch ? 'archived' : 'closed';
        const allowedKeys = new Set(['commandId', 'expectedRevision', flag]);
        if (Object.keys(body).some((key) => !allowedKeys.has(key))
          || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0
          || typeof body[flag] !== 'boolean') {
          sendError(response, 'INVALID_REQUEST');
          return;
        }
        const recordRequest = { commandId: body.commandId, projectId, expectedRevision: body.expectedRevision };
        const result = projectArchiveMatch
          ? setProjectArchived(db, { ...recordRequest, archived: body.archived })
          : setWorkLineClosed(db, { ...recordRequest, worktreeId: decodeURIComponent(match[2]), closed: body.closed });
        if (result.ok) sendJson(response, 200, result);
        else sendError(response, result.code, { commandId: body.commandId });
        return;
      }

      const projectDiagnosticsMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/session-diagnostics$/);
      if (request.method === 'GET' && projectDiagnosticsMatch) {
        const projectId = decodeURIComponent(projectDiagnosticsMatch[1]);
        const project = readProjectContext(db, projectId);
        if (!project) {
          sendError(response, 'PROJECT_NOT_FOUND');
          return;
        }
        const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
        const sessionIds = db.prepare(`
          SELECT DISTINCT session_id
          FROM assignments
          WHERE project_id = ? AND session_id IS NOT NULL
          ORDER BY updated_at DESC, id DESC
        `).all(projectId).map((row) => row.session_id);
        sendJson(response, 200, {
          ok: true,
          projectId,
          entries: readRecentSessionDiagnostics({
            directory: diagnosticLogDirectory,
            sessionIds,
            limit,
          }),
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
        const developmentSpaces = listDevelopmentSpaces(db, { projectId }).map((space) => ({
          spaceId: space.spaceId,
          name: space.name || '通用开发空间',
          branch: space.branch,
          baseCommit: space.baseCommit,
          worktreeId: space.worktreeId,
          status: space.status,
          statusReason: space.statusReason,
          revision: space.revision,
          createdAt: space.createdAt,
          updatedAt: space.updatedAt,
          archivedAt: space.archivedAt,
        }));
        const submissions = listSubmissions(db, { projectId }).map((submission) => ({
          submissionId: submission.submissionId,
          spaceId: submission.spaceId,
          spaceName: submission.spaceName || '通用开发空间',
          title: submission.title,
          description: submission.description,
          status: submission.status,
          statusReason: submission.statusReason,
          revision: submission.revision,
          sourceCommit: submission.sourceCommit,
          targetHead: submission.targetHead,
          sourceBranch: submission.sourceBranch,
          deliveryVersion: submission.deliveryVersion,
          conflicts: submission.delivery.conflicts ?? [],
          fastForward: submission.delivery.fastForward ?? null,
          pullRequestUrl: submission.delivery.pullRequestUrl ?? null,
          pullRequestVerified: false,
          activeClaim: submission.activeClaim ? {
            claimId: submission.activeClaim.claimId,
            status: submission.activeClaim.status,
            expiresAt: submission.activeClaim.expiresAt,
          } : null,
          latestReceipt: submission.latestReceipt ? {
            receiptId: submission.latestReceipt.receiptId,
            outcome: submission.latestReceipt.outcome,
            integratedCommit: submission.latestReceipt.integratedCommit,
          } : null,
          reviewPrompt: ['pending', 'claimed', 'conflict'].includes(submission.status)
            ? integrationReviewPrompt(submission)
            : null,
          createdAt: submission.createdAt,
          updatedAt: submission.updatedAt,
        }));
        const submitNotes = listSubmitNotes(db, { projectId, limit: 30, offset: 0 });
        sendJson(response, 200, {
          ok: true,
          refreshedAt: new Date().toISOString(),
          ...detail,
          workLineContexts: readWorkLineContexts(db, projectId),
          workLineStates: readWorkLineStates(db, projectId),
          developmentSpaces,
          submissions,
          submitNotes,
        });
        return;
      }

      const projectAvatarUploadMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/avatar\/(upload|select)$/);
      if (request.method === 'POST' && projectAvatarUploadMatch) {
        const projectId = decodeURIComponent(projectAvatarUploadMatch[1]);
        const project = readProjectContext(db, projectId);
        if (!project) {
          sendError(response, 'PROJECT_NOT_FOUND');
          return;
        }

        const isExplicitUpload = projectAvatarUploadMatch[2] === 'upload';
        const contentType = request.headers['content-type'] || '';
        const hasUploadContent = contentType.toLowerCase().startsWith('multipart/form-data')
          || contentType.toLowerCase().startsWith('image/')
          || contentType.toLowerCase().startsWith('application/octet-stream');

        if (isExplicitUpload || hasUploadContent || typeof imagePicker !== 'function') {
          let upload;
          try {
            upload = await readAvatarUploadBody(request);
          } catch (err) {
            sendError(response, err.code || 'INVALID_IMAGE_PATH', {
              extra: { message: err.message },
            });
            return;
          }

          const queryFileName = url.searchParams.get('filename') || url.searchParams.get('name');
          const headerFileName = request.headers['x-filename'];
          const originalName = upload.originalName || queryFileName || headerFileName || '';

          let staged;
          try {
            staged = stageProjectAvatar({
              content: upload.content,
              originalName,
              mimeType: upload.mimeType,
              storageRoot: avatarStorageRoot,
              projectId,
            });
          } catch (err) {
            sendError(response, err.code || 'INVALID_IMAGE_PATH', {
              extra: { message: err.message },
            });
            return;
          }

          sendJson(response, 200, {
            ok: true,
            cancelled: false,
            projectId,
            avatarPath: staged.avatarPath,
            mimeType: staged.mimeType,
            size: staged.size,
          });
          return;
        }

        let selectedPath;
        try {
          selectedPath = await imagePicker();
        } catch (err) {
          sendError(response, err.code || 'IMAGE_PICKER_UNAVAILABLE', {
            extra: { message: err.message },
          });
          return;
        }

        if (!selectedPath) {
          sendJson(response, 200, { ok: true, cancelled: true, projectId });
          return;
        }

        let staged;
        try {
          staged = stageProjectAvatar({
            sourcePath: selectedPath,
            storageRoot: avatarStorageRoot,
            projectId,
          });
        } catch (err) {
          sendError(response, err.code || 'INVALID_IMAGE_PATH', {
            extra: { message: err.message },
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          cancelled: false,
          projectId,
          avatarPath: staged.avatarPath,
          mimeType: staged.mimeType,
          size: staged.size,
        });
        return;
      }

      const projectAvatarMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/avatar$/);
      if ((request.method === 'GET' || request.method === 'HEAD') && projectAvatarMatch) {
        const projectId = decodeURIComponent(projectAvatarMatch[1]);
        const project = readProjectContext(db, projectId);
        if (!project) {
          sendError(response, 'PROJECT_NOT_FOUND');
          return;
        }
        const requestedPath = url.searchParams.get('path') || project.avatar_path;
        if (!requestedPath) {
          sendError(response, 'IMAGE_NOT_FOUND');
          return;
        }

        let resolved;
        try {
          resolved = resolveProjectAvatar({
            storageRoot: avatarStorageRoot,
            projectId,
            avatarPath: requestedPath,
          });
        } catch (err) {
          sendError(response, err.code || 'INVALID_IMAGE_PATH', {
            extra: { message: err.message },
          });
          return;
        }

        response.writeHead(200, {
          'content-type': resolved.mimeType,
          'content-length': resolved.size,
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-cache',
        });
        if (request.method === 'HEAD') {
          response.end();
          return;
        }
        const stream = createReadStream(resolved.filePath);
        stream.on('error', () => {
          if (!response.headersSent) {
            sendError(response, 'IMAGE_NOT_FOUND');
          } else {
            response.destroy();
          }
        });
        stream.pipe(response);
        return;
      }

      const projectEditMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)(?:\/edit)?$/);
      if ((request.method === 'POST' || request.method === 'PATCH') && projectEditMatch) {
        const projectId = decodeURIComponent(projectEditMatch[1]);
        const body = await readJson(request);
        requireString(body, 'commandId');

        try {
          const result = updateProject(db, {
            commandId: body.commandId,
            projectId,
            name: body.name,
            avatarPath: body.avatarPath,
          }, { avatarStorageRoot });

          if (result.ok) {
            sendJson(response, 200, result);
          } else {
            sendError(response, result.code, {
              commandId: body.commandId,
              extra: { message: result.message },
            });
          }
        } catch (err) {
          if (err.code === 'COMMAND_CONFLICT') {
            sendError(response, 'COMMAND_CONFLICT', {
              commandId: body.commandId,
              extra: { message: err.message },
            });
            return;
          }
          throw err;
        }
        return;
      }

      const projectSubmitNotesMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/submit-notes$/);
      if (request.method === 'GET' && projectSubmitNotesMatch) {
        const projectId = decodeURIComponent(projectSubmitNotesMatch[1]);
        const project = readProjectContext(db, projectId);
        if (!project) {
          sendError(response, 'PROJECT_NOT_FOUND');
          return;
        }
        const statusParam = url.searchParams.get('status');
        let status = null;
        if (statusParam) {
          if (!['pending', 'handled', 'archived'].includes(statusParam)) {
            sendError(response, 'INVALID_REQUEST');
            return;
          }
          status = statusParam;
        }
        const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

        const countRows = db.prepare(`
          SELECT status, COUNT(*) AS count
          FROM submit_notes
          WHERE project_id = ?
          GROUP BY status
        `).all(projectId);

        const counts = { pending: 0, handled: 0, archived: 0 };
        for (const row of countRows) {
          if (row.status in counts) {
            counts[row.status] = row.count;
          }
        }

        const total = status ? (counts[status] ?? 0) : (counts.pending + counts.handled + counts.archived);
        const items = listSubmitNotes(db, { projectId, limit, offset, status });
        const hasMore = offset + items.length < total;

        sendJson(response, 200, {
          ok: true,
          items,
          total,
          hasMore,
          counts,
        });
        return;
      }

      const submitNoteStatusMatch = url.pathname.match(/^\/api\/v1\/submit-notes\/([^/]+)\/status$/);
      if (request.method === 'POST' && submitNoteStatusMatch) {
        const noteId = decodeURIComponent(submitNoteStatusMatch[1]);
        const body = await readJson(request);
        try {
          validateBrowserStatusBody(body);
          const result = await updateSubmitNote(db, {
            noteId,
            clientRequestId: body.clientRequestId,
            expectedRevision: body.expectedRevision,
            status: body.status,
            handlingNote: body.handlingNote,
          }, { skipPathCheck: true, faultInjector });
          sendJson(response, 200, { ok: true, note: result });
        } catch (error) {
          sendError(response, error.code ?? 'REQUEST_FAILED', {
            extra: {
              noteId,
              currentRevision: error.currentRevision ?? null,
              expectedRevision: error.expectedRevision ?? null,
              ...(error.publicMessage ? { message: error.publicMessage } : {}),
            },
          });
        }
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
        let targetWorktreeId;
        let targetSpace = null;
        if (body.spaceId) {
          targetSpace = readDevelopmentSpace(db, body.spaceId);
          if (!targetSpace || targetSpace.projectId !== projectId || targetSpace.status === 'archived') {
            sendError(response, 'WORKTREE_BINDING_MISMATCH');
            return;
          }
          targetWorktreeId = targetSpace.worktreeId;
        }
        await observeRegisteredProject(projectId, targetWorktreeId ? { worktreeId: targetWorktreeId } : undefined);
        const seedScope = body.spaceId ? `${projectId}:${body.spaceId}` : projectId;
        const assignmentId = id('assignment', `${seedScope}:${body.clientRequestId}`);
        const grantId = id('dispatch', `${seedScope}:${body.clientRequestId}`);
        const dispatchCode = createHmac('sha256', token)
          .update(`dispatch:${seedScope}:${body.clientRequestId}`)
          .digest('base64url');
        const task = body.mode === 'handoff'
          ? '读取最后一次交接并等待用户安排'
          : (body.mode === 'init'
            ? (body.task?.trim() || '接入项目并继续当前对话中的工作')
            : body.task.trim());
        const result = createAssignment(db, {
          commandId: id('assignment_create', `${seedScope}:${body.clientRequestId}`),
          assignmentId,
          grantId,
          projectId,
          ...(body.spaceId ? { spaceId: body.spaceId } : {}),
          ...(targetWorktreeId ? { worktreeId: targetWorktreeId } : {}),
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
          projectId,
          spaceId: result.spaceId ?? body.spaceId ?? null,
          worktreeId: result.worktreeId,
          canonicalPath: result.canonicalPath,
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
        if (body.spaceId !== undefined && (typeof body.spaceId !== 'string' || !body.spaceId.trim())) {
          sendError(response, 'INVALID_REQUEST');
          return;
        }

        let targetWorktreeId;
        let targetSpace = null;
        if (body.spaceId) {
          targetSpace = readDevelopmentSpace(db, body.spaceId);
          if (!targetSpace || targetSpace.projectId !== projectId || targetSpace.status === 'archived') {
            sendError(response, 'NOT_FOUND');
            return;
          }
          targetWorktreeId = targetSpace.worktreeId;
        }

        const observedTarget = await observeRegisteredProject(
          projectId,
          targetWorktreeId ? { worktreeId: targetWorktreeId } : undefined,
        );
        targetWorktreeId = observedTarget.worktreeId;

        let sql = `
          SELECT * FROM assignments
          WHERE project_id = ? AND worktree_id = ? AND status = 'pending'
        `;
        const params = [projectId, targetWorktreeId];
        sql += ' ORDER BY created_at DESC, id DESC';

        const pendingAssignments = db.prepare(sql).all(...params);
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
          projectId,
          spaceId: targetSpace?.id ?? grant.spaceId ?? null,
          worktreeId: assignment.worktree_id,
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
          archivedProjects: readDashboard(db, { archived: true }),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/context') {
        const body = await readJson(request);
        validateMcpContextBody(body);
        if (body.confirmSessionId !== undefined && authentication.kind === 'mcp' && !identity) {
          sendError(response, 'CONVERSATION_IDENTITY_REQUIRED'); return;
        }
        try {
          sendJson(response, 200, reportCurrentBinding(
            await readMcpWorkContext(body, key, conversationBinding),
          ));
        } catch (error) {
          if (error?.code === 'SESSION_CONTEXT_CONFIRMATION_STALE') {
            sendError(response, error.code, {
              extra: {
                status: error.context?.status ?? null,
                bindingStatus: error.context?.bindingStatus ?? null,
                canContinue: false,
                requiresUserConfirmation: true,
              },
              context: error.context,
            });
            return;
          }
          throw error;
        }
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
          sendJson(response, 200, reportCurrentBinding(rememberConversation(key, {
            ok: true,
            assignmentId: accepted.assignmentId,
            sessionId: accepted.sessionId,
            worktreeId: accepted.worktreeId,
            agent: accepted.agentId,
            task: accepted.taskId,
            status: 'waiting_for_instruction',
            revision: accepted.revision,
            acceptedAt: accepted.acceptedAt,
            latestHandoff,
            message: latestHandoff
              ? '已读取最后一次交接；当前没有写入权限，请向用户复述现状并等待安排。'
              : '这个项目还没有交接手册；当前没有写入权限，请告知用户并等待安排。',
          }, conversationBinding)));
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
        sendJson(response, 200, reportCurrentBinding(rememberConversation(key, {
          ok: true,
          assignmentId: accepted.assignmentId,
          sessionId: accepted.sessionId,
          worktreeId: accepted.worktreeId,
          agent: accepted.agentId,
          task: accepted.taskId,
          status: 'active',
          revision: current.revision,
          leaseGeneration: started.leaseGeneration,
          acceptedAt: accepted.acceptedAt,
          latestHandoff,
        }, conversationBinding)));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/begin') {
        const body = await readJson(request);
        validateMcpBeginBody(body);
        assertConversationWrite(key, body.sessionId, ['active', 'accepted']);
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
          || working.worktreeId !== context.worktreeId) {
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
        sendJson(response, 200, reportCurrentBinding(rememberConversation(key, {
          ok: true,
          assignmentId: accepted.assignmentId,
          sessionId: accepted.sessionId,
          worktreeId: accepted.worktreeId,
          agent: accepted.agentId,
          task: body.currentTask.trim(),
          status: 'active',
          revision: initialized.revision,
          leaseGeneration: started.leaseGeneration,
          baselineAt: started.startedAt,
          preexistingChangesPreserved: Boolean(observation.after?.hasChanges),
          latestHandoff,
          message: '当前项目已接入 Cockpit；已有改动已作为接入基线保留。',
        }, conversationBinding)));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/relay') {
        const body = await readJson(request);
        validateMcpRelayBody(body);
        assertConversationWrite(key, body.sessionId, ['active', 'awaiting_resume']);
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
        assertConversationWrite(key, body.sessionId, ['active', 'awaiting_resume']);
        const result = createRelay(db, {
          ...body,
          ...gitEvidence,
          // Derive the one-time secret from the persistent service token so a
          // lost HTTP response can be safely retried with the same payload.
          // Only its digest is persisted by the core relay implementation.
          continueCode: relayContinueCode(token, body.sessionId, body.clientRequestId),
        }, { faultInjector });
        if (result.ok) sendJson(response, 200, reportCurrentBinding(result));
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
          conversationKey: key,
          projectId: working.project.id,
          worktreeId: working.worktreeId,
          canonicalPath: working.observation.canonicalPath,
          repositoryIdentity: working.observation.repositoryIdentity,
          worktreeIdentity: working.observation.worktreeIdentity,
        }, { faultInjector, conversationBinding, allowExpiredConfirmation: false });
        if (result.ok) sendJson(response, 200, reportCurrentBinding(result));
        else sendError(response, result.code, {
          extra: {
            session_id: result.sessionId ?? null,
            relay_id: result.relayId ?? null,
            revision: result.revision ?? null,
          },
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/takeover') {
        const body = await readJson(request);
        validateMcpTakeoverBody(body);
        if (conversationBinding?.bindingKind !== 'host') {
          sendError(response, 'CONVERSATION_IDENTITY_REQUIRED');
          return;
        }
        const working = await resolveMcpWorkingProject(body.mcpWorkingDirectory);
        const context = readSessionContext(db, body.sessionId);
        if (!context.ok) {
          sendError(response, context.code);
          return;
        }
        if (context.projectId !== working.project.id || context.worktreeId !== working.worktreeId) {
          sendError(response, 'RELAY_BINDING_MISMATCH', {
            extra: { session_id: body.sessionId, revision: context.revision ?? null },
          });
          return;
        }
        const result = consumeConversationTransfer(db, {
          sessionId: body.sessionId, transferCode: body.transferCode, clientRequestId: body.clientRequestId,
          conversationKey: key,
          binding: conversationBinding,
        });
        if (result.ok) sendJson(response, 200, reportCurrentBinding(result));
        else sendError(response, result.code, {
          extra: {
            session_id: result.sessionId ?? body.sessionId,
            revision: result.revision ?? null,
          },
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/progress') {
        const body = await readJson(request);
        validateMcpProgressBody(body);
        assertConversationWrite(key, body.sessionId);
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
        assertConversationWrite(key, body.sessionId);
        const result = recordProgress(db, { ...body, ...gitEvidence });
        if (result.ok) sendJson(response, 200, result);
        else sendError(response, result.code, {
          extra: { session_id: body.sessionId, revision: result.revision ?? null },
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/submit/preflight') {
        const body = await readJson(request);
        const invalid = validateDeliveryRequest(body, 'preflight', { bridge: true });
        if (invalid) { sendError(response, 'INVALID_REQUEST'); return; }
        assertConversationWrite(key, body.sessionId);
        let source = null;
        try {
          const registeredSources = db.prepare('SELECT id FROM delivery_sources').all();
          const matchedSources = [];
          for (const row of registeredSources) {
            const candidate = readDeliverySource(db, row.id);
            try { assertDeliveryCwd(candidate, body.mcpWorkingDirectory); } catch { continue; }
            await observeDeliverySource(db, row.id);
            matchedSources.push(candidate);
          }
          if (matchedSources.length > 1) throw Object.assign(new Error('Ambiguous delivery project'), { code: 'DELIVERY_PROJECT_AMBIGUOUS' });
          source = matchedSources[0] ?? null;
          if (!source) {
            let working = null;
            try { working = await resolveMcpWorkingProject(body.mcpWorkingDirectory); }
            catch (error) { if (!['PROJECT_NOT_FOUND', 'PATH_NOT_AUTHORIZED'].includes(error.code)) throw error; }
            if (working) {
              source = await registerDeliveryLocation(db, { observation: working.observation,
                authorizedRoot: working.space ? working.observation.canonicalPath : working.project.authorized_root,
                projectId: working.project.id });
            } else if (body.selectFolder) {
              const selected = await folderPicker();
              if (!selected) { sendJson(response, 200, { ok: true, ready: false, cancelled: true }); return; }
              const binding = authorizeExistingPath(body.mcpWorkingDirectory, selected);
              await checkUnsupportedFeatures(binding.rootReal);
              const observation = await probe(binding.rootReal);
              revalidateAuthorizedPath(binding);
              const roots = db.prepare('SELECT authorized_root FROM projects').all().map((row) => row.authorized_root);
              authorizeDeliveryObservation(observation, [binding.rootReal, ...roots]);
              source = await registerDeliveryLocation(db, { observation, authorizedRoot: binding.rootReal });
            } else {
              sendJson(response, 200, deliveryResponse({ ok: false, code: 'DELIVERY_FOLDER_REQUIRED', localSaved: false, pushed: false }));
              return;
            }
          }
          const result = await prepareDelivery(db, {
            commandId: id('delivery_preflight', `${source.id}:${body.clientRequestId}`), sourceId: source.id,
            ...(body.sessionId ? { sessionId: body.sessionId, expectedRevision: body.expectedRevision } : {}),
            ...(body.files !== undefined ? { files: body.files } : {}),
          }, { assertSessionWrite: (sessionId) => assertConversationWrite(key, sessionId) });
          sendJson(response, 200, deliveryResponse(result));
        } catch (error) {
          sendJson(response, 200, deliveryResponse({
            ok: false,
            code: typeof error.code === 'string' ? error.code : 'DELIVERY_CHECK_FAILED',
            ...(error.details !== undefined ? { details: error.details } : {}),
            localSaved: false,
            pushed: false,
          }));
        }
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/submit') {
        const body = await readJson(request);
        const invalid = validateDeliveryRequest(body, 'submit', { bridge: true });
        if (invalid) {
          sendJson(response, 200, deliveryResponse({ ok: false, code: body.preflightId ? 'INVALID_REQUEST' : 'DELIVERY_PREFLIGHT_REQUIRED', localSaved: false, pushed: false }));
          return;
        }
        const preparedSession = db.prepare('SELECT session_id FROM delivery_preflights WHERE id = ?').get(body.preflightId);
        assertConversationWrite(key, preparedSession?.session_id);
        const result = await submitDelivery(db, { ...body,
          commandId: id('delivery_submit', `${body.preflightId}:${body.clientRequestId}`),
        }, { faultInjector, assertSessionWrite: (sessionId) => assertConversationWrite(key, sessionId) });
        sendJson(response, 200, deliveryResponse(result));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/submit-note') {
        const body = await readJson(request);
        try {
          validateSubmitNoteBody(body);
          const result = await createSubmitNote(db, body, { faultInjector, conversationKey: key });
          sendJson(response, 200, result);
        } catch (error) {
          sendError(response, error.code ?? 'REQUEST_FAILED', {
            extra: {
              ...(error.publicMessage ? { message: error.publicMessage } : {}),
            },
          });
        }
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/submit-notes/get') {
        const body = await readJson(request);
        try {
          validateSubmitNoteGetBody(body);
          const result = await readSubmitNote(db, body);
          sendJson(response, 200, result);
        } catch (error) {
          sendError(response, error.code ?? 'REQUEST_FAILED', {
            extra: {
              noteId: body?.noteId ?? null,
              ...(error.publicMessage ? { message: error.publicMessage } : {}),
            },
          });
        }
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/submit-notes/update') {
        const body = await readJson(request);
        try {
          validateSubmitNoteUpdateBody(body);
          const result = await updateSubmitNote(db, body, { faultInjector });
          sendJson(response, 200, result);
        } catch (error) {
          sendError(response, error.code ?? 'REQUEST_FAILED', {
            extra: {
              noteId: body?.noteId ?? null,
              currentRevision: error.currentRevision ?? null,
              expectedRevision: error.expectedRevision ?? null,
              ...(error.publicMessage ? { message: error.publicMessage } : {}),
            },
          });
        }
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/integration/begin') {
        const body = await readJson(request);
        validateMcpIntegrationBody(body, 'begin');
        assertConversationWrite(key, body.sessionId);
        const result = await beginIntegrationReview(db, {
          ...body,
          commandId: id('integration_begin', `${body.sessionId}:${body.clientRequestId}`),
        }, { faultInjector, assertSessionWrite: (sessionId) => assertConversationWrite(key, sessionId) });
        if (result.ok) sendJson(response, 200, result);
        else sendError(response, result.code, { extra: integrationErrorExtra(body, result) });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/integration/review') {
        const body = await readJson(request);
        validateMcpIntegrationBody(body, 'review');
        assertConversationWrite(key, body.sessionId);
        const result = await recordSessionIntegrationReview(db, {
          ...body,
          commandId: id('integration_review', `${body.sessionId}:${body.clientRequestId}`),
        }, { faultInjector, assertSessionWrite: (sessionId) => assertConversationWrite(key, sessionId) });
        if (result.ok) sendJson(response, 200, result);
        else sendError(response, result.code, { extra: integrationErrorExtra(body, result) });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/integration/merge') {
        const body = await readJson(request);
        validateMcpIntegrationBody(body, 'merge');
        assertConversationWrite(key, body.sessionId);
        const result = await mergeApprovedSubmission(db, {
          ...body,
          commandId: id('integration_merge', `${body.sessionId}:${body.clientRequestId}`),
        }, { faultInjector, assertSessionWrite: (sessionId) => assertConversationWrite(key, sessionId) });
        if (result.ok) sendJson(response, 200, result);
        else sendError(response, result.code, {
          extra: {
            ...integrationErrorExtra(body, result),
            localIntegrated: Boolean(result.localIntegrated),
            pushed: Boolean(result.pushed),
            integratedCommit: result.integratedCommit ?? null,
          },
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/mcp/work/finish') {
        const body = await readJson(request);
        validateMcpFinishBody(body);
        assertConversationWrite(key, body.sessionId, ['active', 'completed', 'blocked', 'abandoned']);
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
        assertConversationWrite(key, body.sessionId, ['active', 'completed', 'blocked', 'abandoned']);
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
        assertConversationWrite(key, body.sessionId, ['active', 'completed', 'blocked', 'abandoned']);
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
        assertConversationWrite(key, body.sessionId, ['active', 'completed', 'blocked', 'abandoned']);
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
        const lifecycleEpoch = db.prepare('SELECT lifecycle_epoch FROM worktrees WHERE canonical_path = ?')
          .get(binding.candidateReal)?.lifecycle_epoch ?? 0;
        const observation = { ...await probe(binding.candidateReal), lifecycleEpoch };
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
        assertConversationWrite(key, body.sessionId);
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
      // A response may already be streaming when an unexpected error lands
      // here (for example after a partial write). Sending another response
      // would throw ERR_HTTP_HEADERS_SENT and turn this handler's promise
      // into an unhandled rejection that kills the whole service process.
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const sqliteBusy = (
        error?.code === 'ERR_SQLITE_ERROR'
        && /busy|locked/i.test(error?.message ?? '')
      );
      const code = error instanceof SyntaxError
        ? 'INVALID_REQUEST'
        : (sqliteBusy ? 'DATABASE_BUSY' : error?.code);
      sendError(response, PUBLIC_ERRORS[code] ? code : 'REQUEST_FAILED', {
        context: error?.context,
      });
    }
  }));

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
      if (folderPicker === selectFolder) {
        try { await closeFolderPicker(); } catch {}
      } else if (typeof folderPicker?.close === 'function') {
        try { await folderPicker.close(); } catch {}
      }
      db.close();
    },
  };
}
