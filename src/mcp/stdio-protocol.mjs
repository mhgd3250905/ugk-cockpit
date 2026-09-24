import readline from 'node:readline';
import { Transform } from 'node:stream';
import { conversationIdentity } from './conversation-identity.mjs';
import { VERSION } from '../version.mjs';
import { validateDeliveryRequest } from '../core/delivery-contract.mjs';
import { sanitizeIntegrationErrorPayload } from './service-client.mjs';
import { normalizeReferences } from '../core/submit-notes-contract.mjs';
import { PROGRESS_STATUSES } from '../core/assignments-contract.mjs';

// 与服务端 HTTP MCP 路由的 18MB 请求体上限对齐：stdio 桥进程不能被一条无上限
// 的入站行无限缓冲。超限即 fail-closed 关停，stderr 留下可诊断的说明。
const MCP_STDIO_LINE_LIMIT = 18 * 1024 * 1024;
const EMPTY_BUFFER = Buffer.alloc(0);
const LINE_SEPARATOR_BYTES = Buffer.from('\\u2028', 'utf8');
const PARAGRAPH_SEPARATOR_BYTES = Buffer.from('\\u2029', 'utf8');

// Rewrites raw U+2028/U+2029 into their JSON escape text. On the way in this
// keeps readline's LF-only framing intact; on the way out it keeps one response
// in one line. Both are semantics-preserving for valid JSON, because these two
// characters may only ever appear inside a string there.
function escapeWireSeparators(input) {
  const parts = [];
  let last = 0;
  for (let index = 0; index + 2 < input.length; index += 1) {
    if (input[index] !== 0xe2 || input[index + 1] !== 0x80) continue;
    if (input[index + 2] !== 0xa8 && input[index + 2] !== 0xa9) continue;
    parts.push(input.subarray(last, index));
    parts.push(input[index + 2] === 0xa8 ? LINE_SEPARATOR_BYTES : PARAGRAPH_SEPARATOR_BYTES);
    index += 2;
    last = index + 1;
  }
  if (parts.length === 0) return input;
  parts.push(input.subarray(last));
  return Buffer.concat(parts);
}

const DEFAULT_PROTOCOL_VERSION = '2025-11-25';
const STRUCTURED_TOOL_NAMES = new Set([
  'ugk_integration_begin',
  'ugk_integration_review',
  'ugk_integration_merge',
  'ugk_work_submit_note',
  'ugk_submit_note_get',
  'ugk_submit_note_update',
]);
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  DEFAULT_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

export const TOOLS = [
  {
    name: 'ugk_work_context',
    description: 'Read the current Cockpit work session for this project directory; this is read-only and never acquires a lease or changes session state',
    inputSchema: {
      type: 'object',
      properties: {
        confirmSessionId: {
          type: 'string',
          description: 'Only after the user explicitly confirms continuing this candidate session; copy the sessionId returned by the previous context query',
        },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'The exact revision returned with confirmSessionId by the previous context query',
        },
        declaredWorkspace: {
          type: 'string',
          description: 'Only for hosts whose bridge cannot resolve a working directory (the tool reports an unrecognizable working directory): the absolute path of your current project directory, as stated in the access instruction. It is validated against the registered project and never overrides a resolvable working directory',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ugk_work_accept',
    description: 'Only call after the user explicitly instructs accepting this dispatch and provides its code; initialize or resume the AI session',
    inputSchema: {
      type: 'object',
      properties: {
        dispatchCode: {
          type: 'string',
          description: 'The dispatch code provided for accepting the work'
        },
        clientRequestId: {
          type: 'string',
          description: 'Idempotency key / client request identifier'
        }
      },
      required: ['dispatchCode', 'clientRequestId'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_work_progress',
    description: 'The only MCP operation eligible for implicit invocation: record non-terminal progress and state updates for an active session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'The identifier of the active work session'
        },
        clientRequestId: {
          type: 'string',
          description: 'Idempotency key / client request identifier'
        },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'Expected optimistic concurrency revision number'
        },
        status: {
          type: 'string',
          enum: PROGRESS_STATUSES,
          description: 'Non-terminal progress only; this operation never ends the phase or creates a handoff.'
        },
        summary: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          description: 'Concise, verifiable single-sentence summary of what was accomplished'
        },
        details: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 500
          },
          maxItems: 8,
          description: 'Optional supporting details, evidence, or key artifacts'
        },
        note: {
          type: 'string',
          maxLength: 4000,
          description: 'Legacy informational note or progress details'
        }
      },
      required: ['sessionId', 'clientRequestId', 'expectedRevision', 'status'],
      anyOf: [
        { required: ['summary'] },
        { required: ['note'] }
      ],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_work_submit_preflight',
    description: '[旧代码交付预检，普通工作说明请直接使用 ugk_work_submit_note] After explicit submit intent, verify the registered project, authorized current directory, selected changes and latest remote target without changing user code. No init required. selectFolder opens a user-controlled folder authorization dialog.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        sessionId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 },
        files: { type: 'array', maxItems: 200, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 1024 }, description: 'Exact relative files selected from the returned changes; omit to discover scope first; [] submits committed work only.' },
        selectFolder: { type: 'boolean', description: 'Only with user agreement: open the native folder picker to authorize this current code location.' }
      },
      required: ['clientRequestId'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_work_submit',
    description: '[旧代码交付工具，普通工作说明请使用 ugk_work_submit_note] Explicitly save, normally push and register a fixed-version review task after a valid MCP preflight; no prior init or development-space session required. Never merge automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        preflightId: { type: 'string', description: 'Unexpired identifier returned by ugk_work_submit_preflight for this directory and selected content' },
        allowConflicts: { type: 'boolean', description: 'Only true after explicit user confirmation to save a conflict-marked delivery' },
        pullRequestUrl: { type: 'string', description: 'Optional GitHub PR reference; not a verified approval or merge receipt' },
        clientRequestId: {
          type: 'string',
          description: 'Stable idempotency key for this submission attempt'
        },
        summary: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          description: 'Concise feature-delivery summary used for the saved change and review request'
        }
      },
      required: ['preflightId', 'clientRequestId', 'summary'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_work_submit_note',
    description: '向已确定的所属主项目发布工作说明（如本地提交、PR审核或工作摘要），轻量发布，不搬运或修改代码。',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: {
          type: 'string',
          description: '客户端幂等请求标识符'
        },
        body: {
          type: 'string',
          minLength: 1,
          maxLength: 20000,
          description: '工作说明正文内容（非空）'
        },
        title: {
          type: 'string',
          maxLength: 200,
          description: '可选的工作说明标题'
        },
        references: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              target: { type: 'string', minLength: 1, maxLength: 1024, description: '1..1024非空原始定位字符串' },
              type: { type: 'string', maxLength: 64, description: '可选类型，默认reference' },
              commit: { type: 'string', maxLength: 128, description: '可选关联commit' },
              title: { type: 'string', maxLength: 200, description: '可选标题' },
              note: { type: 'string', maxLength: 1000, description: '可选备注说明' },
            },
            required: ['target'],
            additionalProperties: false,
          },
          description: '可选的引用结构列表'
        }
      },
      required: ['clientRequestId', 'body'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_submit_note_get',
    description: '按当前工作目录授权项目读取指定工作说明的最新状态与复制处理内容，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: {
          type: 'string',
          description: '工作说明编号'
        }
      },
      required: ['noteId'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_submit_note_update',
    description: '更新指定工作说明的状态（pending|handled|archived）与处理备注，使用消息 revision 进行乐观并发控制。',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: {
          type: 'string',
          description: '工作说明编号'
        },
        clientRequestId: {
          type: 'string',
          description: '客户端幂等请求标识符'
        },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: '消息当前的 revision 版本号'
        },
        status: {
          type: 'string',
          enum: ['pending', 'handled', 'archived'],
          description: '更新后的消息状态'
        },
        handlingNote: {
          type: 'string',
          maxLength: 4000,
          description: '可选的处理备注说明'
        }
      },
      required: ['noteId', 'clientRequestId', 'expectedRevision', 'status'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_integration_begin',
    description: 'Begin review of one fixed development-space submission from an active main-project session; never call implicitly',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        clientRequestId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 },
        submissionId: { type: 'string' },
        expectedSubmissionRevision: { type: 'integer', minimum: 0 }
      },
      required: ['sessionId', 'clientRequestId', 'expectedRevision', 'submissionId', 'expectedSubmissionRevision'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_integration_review',
    description: 'Record the main Agent review verdict and evidence for the fixed claimed submission; never call implicitly',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        clientRequestId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 },
        submissionId: { type: 'string' },
        claimId: { type: 'string' },
        expectedClaimRevision: { type: 'integer', minimum: 0 },
        verdict: { type: 'string', enum: ['approved', 'changes_requested', 'rejected'] },
        summary: { type: 'string', minLength: 1, maxLength: 1000 },
        findings: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 }, maxItems: 20 },
        checks: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 }, maxItems: 20 }
      },
      required: ['sessionId', 'clientRequestId', 'expectedRevision', 'submissionId', 'claimId', 'expectedClaimRevision', 'verdict', 'summary', 'findings', 'checks'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_integration_merge',
    description: 'After an approved fixed-SHA review, safely fast-forward and normally push main with a durable receipt; never call implicitly',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        clientRequestId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 },
        submissionId: { type: 'string' },
        claimId: { type: 'string' },
        expectedSubmissionRevision: { type: 'integer', minimum: 0 },
        expectedClaimRevision: { type: 'integer', minimum: 0 },
        summary: { type: 'string', minLength: 1, maxLength: 1000 }
      },
      required: ['sessionId', 'clientRequestId', 'expectedRevision', 'submissionId', 'claimId', 'expectedSubmissionRevision', 'expectedClaimRevision', 'summary'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_work_finish',
    description: 'Only call after the user explicitly asks to end the current phase; complete the active session with an outcome and summary',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'The identifier of the active work session'
        },
        clientRequestId: {
          type: 'string',
          description: 'Idempotency key / client request identifier'
        },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'Expected optimistic concurrency revision number'
        },
        outcome: {
          type: 'string',
          enum: ['completed', 'blocked', 'abandoned'],
          description: 'Outcome of the work (e.g. completed, blocked)'
        },
        summary: {
          type: 'string',
          description: 'Summary of what was achieved or encountered'
        },
        nextStep: {
          type: 'string',
          description: 'Recommended next step'
        },
        acknowledgements: {
          type: 'array',
          maxItems: 100,
          items: {
              type: 'string',
              maxLength: 4000
          },
          description: 'Optional list of acknowledgements or receipts'
        }
      },
      required: ['sessionId', 'clientRequestId', 'expectedRevision', 'outcome', 'summary', 'nextStep'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_work_handoff',
    description: 'Only call after the user explicitly asks to end the current phase; record terminal handoff details for the next agent session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'The identifier of the active work session'
        },
        clientRequestId: {
          type: 'string',
          description: 'Idempotency key / client request identifier'
        },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'Expected optimistic concurrency revision number'
        },
        outcome: {
          type: 'string',
          enum: ['completed', 'blocked', 'abandoned'],
          description: 'Outcome of the work (completed, blocked, abandoned)'
        },
        nextSessionFocus: {
          type: 'string',
          description: 'Recommended focus area for the next session'
        },
        summary: {
          type: 'string',
          description: 'Summary of what was achieved or encountered'
        },
        currentState: {
          type: 'string',
          description: 'Current state of the project/task at handoff'
        },
        completedItems: {
          type: 'array',
          maxItems: 100,
          items: {
              type: 'string',
              maxLength: 4000
          },
          description: 'List of completed items'
        },
        pendingItems: {
          type: 'array',
          maxItems: 100,
          items: {
              type: 'string',
              maxLength: 4000
          },
          description: 'List of pending items'
        },
        decisions: {
          type: 'array',
          maxItems: 100,
          items: {
              type: 'string',
              maxLength: 4000
          },
          description: 'List of key decisions made'
        },
        artifactRefs: {
          type: 'array',
          maxItems: 100,
          items: {
              type: 'string',
              maxLength: 4000
          },
          description: 'List of artifact references or paths'
        },
        risks: {
          type: 'array',
          maxItems: 100,
          items: {
              type: 'string',
              maxLength: 4000
          },
          description: 'List of identified risks or caveats'
        },
        suggestedSkills: {
          type: 'array',
          maxItems: 100,
          items: {
              type: 'string',
              maxLength: 4000
          },
          description: 'List of suggested skills for next session'
        },
        acknowledgements: {
          type: 'array',
          maxItems: 100,
          items: {
              type: 'string',
              maxLength: 4000
          },
          description: 'Optional verified commit:<sha> references or unattributed_changes confirmation'
        }
      },
      required: [
        'sessionId',
        'clientRequestId',
        'expectedRevision',
        'outcome',
        'nextSessionFocus',
        'summary',
        'currentState',
        'completedItems',
        'pendingItems',
        'decisions',
        'artifactRefs',
        'risks',
        'suggestedSkills'
      ],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_work_begin',
    description: 'Only call after the user explicitly instructs beginning work; begin an accepted session by specifying task details',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'The identifier of the active work session'
        },
        clientRequestId: {
          type: 'string',
          description: 'Idempotency key / client request identifier'
        },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'Expected optimistic concurrency revision number'
        },
        task: {
          type: 'string',
          description: 'The task description or scope for this work session'
        }
      },
      required: ['sessionId', 'clientRequestId', 'expectedRevision', 'task'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_work_init',
    description: 'Only call after the user explicitly instructs initialization; initialize the current project as an active Cockpit session without changing project files',
    inputSchema: {
      type: 'object',
      properties: {
        initCode: {
          type: 'string',
          description: 'One-time project init code generated by UGK Cockpit'
        },
        clientRequestId: {
          type: 'string',
          description: 'Idempotency key generated by the Agent'
        },
        currentTask: {
          type: 'string',
          description: 'Concise description of the current or intended work'
        },
        currentState: {
          type: 'string',
          description: 'Concise starting state, progress, and relevant context'
        },
        declaredWorkspace: {
          type: 'string',
          description: 'Only for hosts whose bridge cannot resolve a working directory: the absolute path of your current project directory, as stated in the access instruction (项目目录)'
        }
      },
      required: ['initCode', 'clientRequestId', 'currentTask', 'currentState'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_work_relay',
    description: 'Only call when the user explicitly asks to switch AI conversations; prepare a non-terminal one-time conversation relay while keeping the same active Cockpit session and write lease',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'The identifier of the active work session'
        },
        clientRequestId: {
          type: 'string',
          description: 'Idempotency key / client request identifier'
        },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'Expected optimistic concurrency revision number'
        },
        nextSessionFocus: {
          type: 'string',
          description: 'Recommended focus area for the next AI conversation'
        },
        summary: {
          type: 'string',
          description: 'Summary of work completed or encountered'
        },
        currentState: {
          type: 'string',
          description: 'Current state of the project/task'
        },
        completedItems: {
          type: 'array',
          maxItems: 100, items: { type: 'string', maxLength: 4000 },
          description: 'List of completed items'
        },
        pendingItems: {
          type: 'array',
          maxItems: 100, items: { type: 'string', maxLength: 4000 },
          description: 'List of pending items'
        },
        decisions: {
          type: 'array',
          maxItems: 100, items: { type: 'string', maxLength: 4000 },
          description: 'List of key decisions'
        },
        artifactRefs: {
          type: 'array',
          maxItems: 100, items: { type: 'string', maxLength: 4000 },
          description: 'List of artifact references or paths'
        },
        risks: {
          type: 'array',
          maxItems: 100, items: { type: 'string', maxLength: 4000 },
          description: 'List of identified risks or caveats'
        },
        suggestedSkills: {
          type: 'array',
          maxItems: 100, items: { type: 'string', maxLength: 4000 },
          description: 'List of suggested skills for the next conversation'
        }
      },
      required: [
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
        'suggestedSkills'
      ],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_work_takeover',
    description: 'Consume a one-time transferCode explicitly issued by the user in the Cockpit workbench. Chat confirmation alone cannot authorize takeover. The host must provide a stable conversation identity. Never initialize or clear the workspace to recover.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'The active sessionId returned by the context query'
        },
        clientRequestId: {
          type: 'string',
          description: 'A new idempotency key for this request'
        },
        transferCode: {
          type: 'string',
          description: 'The one-time authorization from the workbench; never invent or reuse another chat’s authorization'
        },
        declaredWorkspace: {
          type: 'string',
          description: 'Only for hosts whose bridge cannot resolve a working directory: the absolute path of your current project directory, as stated in the transfer instruction'
        }
      },
      required: ['sessionId', 'clientRequestId', 'transferCode'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_work_resume',
    description: 'Only when the user explicitly requests resuming with a continueCode. An expired code requires a new authorization in the Cockpit workbench, never chat-only confirmation. Historical uncertain requests may be replayed unchanged; do not invent confirmation fields.',
    inputSchema: {
      type: 'object',
      properties: {
        continueCode: {
          type: 'string',
          description: 'One-time relay code returned by ugk_work_relay'
        },
        clientRequestId: {
          type: 'string',
          description: 'Idempotency key / client request identifier'
        },
        declaredWorkspace: {
          type: 'string',
          description: 'Only for hosts whose bridge cannot resolve a working directory: the absolute path of your current project directory, as stated in the relay instruction (项目目录)'
        }
      },
      required: ['continueCode', 'clientRequestId'],
      additionalProperties: false
    }
  }
];

const FORBIDDEN_KEYS = new Set(['path', 'projectId', 'worktreeId', 'token']);

const HANDOFF_ARRAY_FIELDS = [
  'completedItems',
  'pendingItems',
  'decisions',
  'artifactRefs',
  'risks',
  'suggestedSkills'
];

// Relay and handoff list fields follow the core persistence contract
// (MAX_LIST_ITEMS / MAX_ITEM_LENGTH in src/core/relays.mjs and handoffs.mjs).
// The MCP gate must stay exactly as wide: a persisted request whose reply was
// lost has to replay verbatim through validation into the idempotency layer —
// any narrower bound would make an old 101+-item or long-item payload
// permanently unrecoverable, and trimming it would break the frozen digest.
const ARRAY_FIELD_MAX_ITEMS = 100;
const ARRAY_ITEM_MAX_LENGTH = 4_000;

function isStringArray(val) {
  return Array.isArray(val)
    && val.length <= ARRAY_FIELD_MAX_ITEMS
    && val.every((item) => typeof item === 'string' && item.length <= ARRAY_ITEM_MAX_LENGTH);
}

function validateAcceptArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return `Forbidden property: ${key}`;
    }
    if (key !== 'dispatchCode' && key !== 'clientRequestId') {
      return `Unexpected property: ${key}`;
    }
  }
  if (typeof args.dispatchCode !== 'string' || args.dispatchCode.trim() === '') {
    return 'Missing or invalid required field: dispatchCode (must be non-empty string)';
  }
  if (typeof args.clientRequestId !== 'string' || args.clientRequestId.trim() === '') {
    return 'Missing or invalid required field: clientRequestId (must be non-empty string)';
  }
  return null;
}

// Fallback workspace for hosts whose bridge cwd resolves to no project (a
// single global daemon spawned from the host install directory). The value
// is validated against registered authorized roots server-side and cross
// checked against the one-time code's project; it never overrides a
// resolvable cwd.
function validDeclaredWorkspaceArg(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 1024 && !value.includes('\0');
}

const DECLARED_WORKSPACE_ERROR = 'Invalid declaredWorkspace (must be the absolute path of your current project directory, max 1024 chars)';

function validateContextArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return `Forbidden property: ${key}`;
    }
    if (!['confirmSessionId', 'expectedRevision', 'declaredWorkspace'].includes(key)) {
      return `Unexpected property: ${key}`;
    }
  }
  if (args.declaredWorkspace !== undefined && !validDeclaredWorkspaceArg(args.declaredWorkspace)) {
    return DECLARED_WORKSPACE_ERROR;
  }
  const hasSession = args.confirmSessionId !== undefined;
  const hasRevision = args.expectedRevision !== undefined;
  if (hasSession !== hasRevision) {
    return 'confirmSessionId and expectedRevision must be provided together';
  }
  if (hasSession && (typeof args.confirmSessionId !== 'string' || args.confirmSessionId.trim() === '')) {
    return 'Invalid confirmSessionId (must be non-empty string)';
  }
  if (hasRevision && (!Number.isInteger(args.expectedRevision) || args.expectedRevision < 1)) {
    return 'Invalid expectedRevision (must be a positive integer)';
  }
  return null;
}

function validateBeginArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return `Forbidden property: ${key}`;
    }
    if (!['sessionId', 'clientRequestId', 'expectedRevision', 'task'].includes(key)) {
      return `Unexpected property: ${key}`;
    }
  }
  if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') {
    return 'Missing or invalid required field: sessionId (must be non-empty string)';
  }
  if (typeof args.clientRequestId !== 'string' || args.clientRequestId.trim() === '') {
    return 'Missing or invalid required field: clientRequestId (must be non-empty string)';
  }
  if (typeof args.expectedRevision !== 'number' || !Number.isInteger(args.expectedRevision) || args.expectedRevision < 1) {
    return 'Missing or invalid required field: expectedRevision (must be a positive integer)';
  }
  if (typeof args.task !== 'string' || args.task.trim() === '') {
    return 'Missing or invalid required field: task (must be non-empty string)';
  }
  return null;
}

function validateProgressArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  const allowedKeys = ['sessionId', 'clientRequestId', 'expectedRevision', 'status', 'summary', 'details', 'note'];
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return `Forbidden property: ${key}`;
    }
    if (!allowedKeys.includes(key)) {
      return `Unexpected property: ${key}`;
    }
  }
  if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') {
    return 'Missing or invalid required field: sessionId (must be non-empty string)';
  }
  if (typeof args.clientRequestId !== 'string' || args.clientRequestId.trim() === '') {
    return 'Missing or invalid required field: clientRequestId (must be non-empty string)';
  }
  if (typeof args.expectedRevision !== 'number' || !Number.isInteger(args.expectedRevision) || args.expectedRevision < 1) {
    return 'Missing or invalid required field: expectedRevision (must be a positive integer)';
  }
  if (!PROGRESS_STATUSES.includes(args.status)) {
    return 'Invalid status: progress is non-terminal; use finish or handoff to end the session';
  }

  let hasSummary = false;
  if (args.summary !== undefined) {
    if (typeof args.summary !== 'string' || args.summary.trim() === '' || args.summary.length > 160) {
      return 'Invalid field: summary (must be non-empty string up to 160 characters)';
    }
    hasSummary = true;
  }

  if (args.details !== undefined) {
    if (!Array.isArray(args.details)
      || args.details.length > 8
      || args.details.some((item) => typeof item !== 'string' || item.trim() === '' || item.length > 500)) {
      return 'Invalid field: details (must be an array of up to 8 non-empty strings each up to 500 characters)';
    }
  }

  let hasNote = false;
  if (args.note !== undefined) {
    if (typeof args.note !== 'string' || args.note.length > 4000) {
      return 'Invalid field: note (must be string up to 4000 characters)';
    }
    if (args.note.trim() !== '') {
      hasNote = true;
    }
  }

  if (!hasSummary && !hasNote) {
    return 'Missing required field: at least one of summary or note is required';
  }

  return null;
}


function validateIntegrationArgs(args, operation) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Arguments must be an object';
  const common = ['sessionId', 'clientRequestId', 'expectedRevision', 'submissionId'];
  const allowed = operation === 'begin'
    ? [...common, 'expectedSubmissionRevision']
    : operation === 'review'
      ? [...common, 'claimId', 'expectedClaimRevision', 'verdict', 'summary', 'findings', 'checks']
      : [...common, 'claimId', 'expectedSubmissionRevision', 'expectedClaimRevision', 'summary'];
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) return `Forbidden property: ${key}`;
    if (!allowed.includes(key)) return `Unexpected property: ${key}`;
  }
  for (const key of ['sessionId', 'clientRequestId', 'submissionId']) {
    if (typeof args[key] !== 'string' || !args[key].trim()) return `Missing or invalid required field: ${key}`;
  }
  if (!Number.isInteger(args.expectedRevision) || args.expectedRevision < 1) return 'Missing or invalid required field: expectedRevision';
  if (operation !== 'begin' && (typeof args.claimId !== 'string' || !args.claimId.trim())) return 'Missing or invalid required field: claimId';
  if (operation !== 'review' && (!Number.isInteger(args.expectedSubmissionRevision) || args.expectedSubmissionRevision < 0)) {
    return 'Missing or invalid required field: expectedSubmissionRevision';
  }
  if (operation !== 'begin' && (!Number.isInteger(args.expectedClaimRevision) || args.expectedClaimRevision < 0)) {
    return 'Missing or invalid required field: expectedClaimRevision';
  }
  if (operation === 'review') {
    if (!['approved', 'changes_requested', 'rejected'].includes(args.verdict)) return 'Missing or invalid required field: verdict';
    for (const key of ['findings', 'checks']) {
      if (!Array.isArray(args[key]) || args[key].length > 20
        || args[key].some((item) => typeof item !== 'string' || !item.trim() || item.length > 500)) {
        return `Missing or invalid required field: ${key}`;
      }
    }
  }
  if (operation !== 'begin' && (typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 1000)) {
    return 'Missing or invalid required field: summary';
  }
  return null;
}

function validateFinishArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return `Forbidden property: ${key}`;
    }
    if (!['sessionId', 'clientRequestId', 'expectedRevision', 'outcome', 'summary', 'nextStep', 'acknowledgements'].includes(key)) {
      return `Unexpected property: ${key}`;
    }
  }
  if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') {
    return 'Missing or invalid required field: sessionId (must be non-empty string)';
  }
  if (typeof args.clientRequestId !== 'string' || args.clientRequestId.trim() === '') {
    return 'Missing or invalid required field: clientRequestId (must be non-empty string)';
  }
  if (typeof args.expectedRevision !== 'number' || !Number.isInteger(args.expectedRevision) || args.expectedRevision < 1) {
    return 'Missing or invalid required field: expectedRevision (must be a positive integer)';
  }
  if (!['completed', 'blocked', 'abandoned'].includes(args.outcome)) {
    return 'Missing or invalid required field: outcome';
  }
  if (typeof args.summary !== 'string' || args.summary.trim() === '') {
    return 'Missing or invalid required field: summary (must be non-empty string)';
  }
  if (typeof args.nextStep !== 'string' || args.nextStep.trim() === '') {
    return 'Missing or invalid required field: nextStep (must be non-empty string)';
  }
  if (
    args.acknowledgements !== undefined
    && !isStringArray(args.acknowledgements)
  ) {
    return 'Invalid field: acknowledgements (must be a string array if provided)';
  }
  return null;
}

function validateHandoffArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  const allowedKeys = [
    'sessionId',
    'clientRequestId',
    'expectedRevision',
    'outcome',
    'nextSessionFocus',
    'summary',
    'currentState',
    'completedItems',
    'pendingItems',
    'decisions',
    'artifactRefs',
    'risks',
    'suggestedSkills',
    'acknowledgements'
  ];
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return `Forbidden property: ${key}`;
    }
    if (!allowedKeys.includes(key)) {
      return `Unexpected property: ${key}`;
    }
  }
  if (typeof args.clientRequestId !== 'string' || args.clientRequestId.trim() === '') {
    return 'Missing or invalid required field: clientRequestId (must be non-empty string)';
  }
  if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') {
    return 'Missing or invalid required field: sessionId (must be non-empty string)';
  }
  if (typeof args.expectedRevision !== 'number'
    || !Number.isInteger(args.expectedRevision)
    || args.expectedRevision < 1) {
    return 'Missing or invalid required field: expectedRevision (must be a positive integer)';
  }
  if (!['completed', 'blocked', 'abandoned'].includes(args.outcome)) {
    return 'Missing or invalid required field: outcome';
  }
  if (typeof args.nextSessionFocus !== 'string' || args.nextSessionFocus.trim() === '') {
    return 'Missing or invalid required field: nextSessionFocus (must be non-empty string)';
  }
  if (typeof args.summary !== 'string' || args.summary.trim() === '') {
    return 'Missing or invalid required field: summary (must be non-empty string)';
  }
  if (typeof args.currentState !== 'string' || args.currentState.trim() === '') {
    return 'Missing or invalid required field: currentState (must be non-empty string)';
  }
  for (const field of HANDOFF_ARRAY_FIELDS) {
    if (!isStringArray(args[field])) {
      return `Missing or invalid required field: ${field} (must be an array of strings)`;
    }
  }
  if (args.acknowledgements !== undefined && !isStringArray(args.acknowledgements)) {
    return 'Invalid field: acknowledgements (must be a string array if provided)';
  }
  return null;
}

function validateInitArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  const allowedKeys = ['initCode', 'clientRequestId', 'currentTask', 'currentState', 'declaredWorkspace'];
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) return `Forbidden property: ${key}`;
    if (!allowedKeys.includes(key)) return `Unexpected property: ${key}`;
  }
  for (const field of ['initCode', 'clientRequestId', 'currentTask', 'currentState']) {
    if (typeof args[field] !== 'string' || args[field].trim() === '') {
      return `Missing or invalid required field: ${field} (must be non-empty string)`;
    }
  }
  if (args.declaredWorkspace !== undefined && !validDeclaredWorkspaceArg(args.declaredWorkspace)) {
    return DECLARED_WORKSPACE_ERROR;
  }
  return null;
}

function validateRelayArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  const allowedKeys = [
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
    'suggestedSkills'
  ];
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) return `Forbidden property: ${key}`;
    if (!allowedKeys.includes(key)) return `Unexpected property: ${key}`;
  }
  if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') {
    return 'Missing or invalid required field: sessionId (must be non-empty string)';
  }
  if (typeof args.clientRequestId !== 'string' || args.clientRequestId.trim() === '') {
    return 'Missing or invalid required field: clientRequestId (must be non-empty string)';
  }
  if (typeof args.expectedRevision !== 'number'
    || !Number.isInteger(args.expectedRevision)
    || args.expectedRevision < 1) {
    return 'Missing or invalid required field: expectedRevision (must be a positive integer)';
  }
  for (const field of ['nextSessionFocus', 'summary', 'currentState']) {
    if (typeof args[field] !== 'string' || args[field].trim() === '') {
      return `Missing or invalid required field: ${field} (must be non-empty string)`;
    }
  }
  for (const field of HANDOFF_ARRAY_FIELDS) {
    if (!isStringArray(args[field])) {
      return `Missing or invalid required field: ${field} (must be an array of strings)`;
    }
  }
  return null;
}

function validateTakeoverArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  const allowedKeys = ['sessionId', 'clientRequestId', 'transferCode', 'declaredWorkspace'];
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) return `Forbidden property: ${key}`;
    if (!allowedKeys.includes(key)) return `Unexpected property: ${key}`;
  }
  if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') {
    return 'Missing or invalid required field: sessionId (must be non-empty string)';
  }
  if (typeof args.clientRequestId !== 'string' || args.clientRequestId.trim() === '') {
    return 'Missing or invalid required field: clientRequestId (must be non-empty string)';
  }
  if (typeof args.transferCode !== 'string' || !args.transferCode.trim()) {
    return 'Platform authorization required: obtain transferCode from the Cockpit workbench; chat confirmation cannot authorize takeover';
  }
  if (args.declaredWorkspace !== undefined && !validDeclaredWorkspaceArg(args.declaredWorkspace)) {
    return DECLARED_WORKSPACE_ERROR;
  }
  return null;
}

function validateResumeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) return `Forbidden property: ${key}`;
    if (key === 'confirmationRequestId' || key === 'expectedRevision') {
      // The in-chat two-step confirmation for an expired relay was retired: a
      // resume of an expired code is answered with a workbench authorization
      // requirement before any offer is produced, so this client could never
      // reach the step these parameters belong to. Reject them here with the
      // reason instead of forwarding a request that can only fail remotely.
      return `Unsupported property: ${key} - an expired relay code cannot be confirmed in chat; `
        + 'ask the user to authorize the handover in the UGK Cockpit workbench, then use ugk_work_takeover with the transferCode';
    }
    if (!['continueCode', 'clientRequestId', 'declaredWorkspace'].includes(key)) {
      return `Unexpected property: ${key}`;
    }
  }
  if (typeof args.continueCode !== 'string' || args.continueCode.trim() === '') {
    return 'Missing or invalid required field: continueCode (must be non-empty string)';
  }
  if (typeof args.clientRequestId !== 'string' || args.clientRequestId.trim() === '') {
    return 'Missing or invalid required field: clientRequestId (must be non-empty string)';
  }
  if (args.declaredWorkspace !== undefined && !validDeclaredWorkspaceArg(args.declaredWorkspace)) {
    return DECLARED_WORKSPACE_ERROR;
  }
  return null;
}

function validateSubmitNoteArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  const allowed = ['clientRequestId', 'body', 'title', 'references'];
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) return `Forbidden property: ${key}`;
    if (!allowed.includes(key)) return `Unexpected property: ${key}`;
  }
  if (typeof args.clientRequestId !== 'string' || !args.clientRequestId.trim()) {
    return 'Missing or invalid required field: clientRequestId (must be non-empty string)';
  }
  if (typeof args.body !== 'string' || !args.body.trim()) {
    return 'Missing or invalid required field: body (must be non-empty string)';
  }
  if (args.body.length > 20000) {
    return 'Invalid field: body exceeds maximum length of 20000 characters';
  }
  if (args.title !== undefined && (typeof args.title !== 'string' || args.title.length > 200)) {
    return 'Invalid field: title (must be string up to 200 characters)';
  }
  if (args.references !== undefined) {
    try {
      normalizeReferences(args.references);
    } catch (err) {
      return err.message;
    }
  }
  return null;
}

function validateSubmitNoteGetArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) return `Forbidden property: ${key}`;
    if (key !== 'noteId') return `Unexpected property: ${key}`;
  }
  if (typeof args.noteId !== 'string' || !args.noteId.trim()) {
    return 'Missing or invalid required field: noteId (must be non-empty string)';
  }
  return null;
}

function validateSubmitNoteUpdateArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  const allowed = ['noteId', 'clientRequestId', 'expectedRevision', 'status', 'handlingNote'];
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) return `Forbidden property: ${key}`;
    if (!allowed.includes(key)) return `Unexpected property: ${key}`;
  }
  if (typeof args.noteId !== 'string' || !args.noteId.trim()) {
    return 'Missing or invalid required field: noteId (must be non-empty string)';
  }
  if (typeof args.clientRequestId !== 'string' || !args.clientRequestId.trim()) {
    return 'Missing or invalid required field: clientRequestId (must be non-empty string)';
  }
  if (!Number.isInteger(args.expectedRevision) || args.expectedRevision < 1) {
    return 'Missing or invalid required field: expectedRevision (must be a positive integer)';
  }
  if (!['pending', 'handled', 'archived'].includes(args.status)) {
    return "Missing or invalid required field: status (must be 'pending', 'handled', or 'archived')";
  }
  if (args.handlingNote !== undefined && (typeof args.handlingNote !== 'string' || args.handlingNote.length > 4000)) {
    return 'Invalid field: handlingNote (must be string up to 4000 characters)';
  }
  return null;
}

export async function dispatchMessage(message, { handlers = {}, stderr = null } = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Invalid Request'
      }
    };
  }

  // Notifications are exactly the messages without an `id` (JSON-RPC 2.0).
  // A message carrying an id is a request and must be answered, even when the
  // method name looks like a notification.
  if (message.id === undefined) {
    return null;
  }

  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return {
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: {
        code: -32600,
        message: 'Invalid Request'
      }
    };
  }

  const { method, id, params } = message;

  switch (method) {
    case 'initialize': {
      const requestedVersion = params?.protocolVersion;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
            ? requestedVersion
            : DEFAULT_PROTOCOL_VERSION,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'ugk-cockpit',
            version: VERSION
          }
        }
      };
    }

    case 'ping': {
      return {
        jsonrpc: '2.0',
        id,
        result: {}
      };
    }

    case 'tools/list': {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS
        }
      };
    }

    case 'tools/call': {
      if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: 'Missing or invalid tool name in params'
          }
        };
      }

      const toolName = params.name;
      const toolArgs = params.arguments || {};

      let validationError = null;
      if (toolName === 'ugk_work_context') {
        validationError = validateContextArgs(toolArgs);
      } else if (toolName === 'ugk_work_accept') {
        validationError = validateAcceptArgs(toolArgs);
      } else if (toolName === 'ugk_work_progress') {
        validationError = validateProgressArgs(toolArgs);
      } else if (toolName === 'ugk_work_submit') {
        validationError = validateDeliveryRequest(toolArgs, 'submit');
      } else if (toolName === 'ugk_work_submit_preflight') {
        validationError = validateDeliveryRequest(toolArgs, 'preflight');
      } else if (toolName === 'ugk_work_submit_note') {
        validationError = validateSubmitNoteArgs(toolArgs);
      } else if (toolName === 'ugk_submit_note_get') {
        validationError = validateSubmitNoteGetArgs(toolArgs);
      } else if (toolName === 'ugk_submit_note_update') {
        validationError = validateSubmitNoteUpdateArgs(toolArgs);
      } else if (toolName === 'ugk_integration_begin') {
        validationError = validateIntegrationArgs(toolArgs, 'begin');
      } else if (toolName === 'ugk_integration_review') {
        validationError = validateIntegrationArgs(toolArgs, 'review');
      } else if (toolName === 'ugk_integration_merge') {
        validationError = validateIntegrationArgs(toolArgs, 'merge');
      } else if (toolName === 'ugk_work_finish') {
        validationError = validateFinishArgs(toolArgs);
      } else if (toolName === 'ugk_work_handoff') {
        validationError = validateHandoffArgs(toolArgs);
      } else if (toolName === 'ugk_work_begin') {
        validationError = validateBeginArgs(toolArgs);
      } else if (toolName === 'ugk_work_init') {
        validationError = validateInitArgs(toolArgs);
      } else if (toolName === 'ugk_work_relay') {
        validationError = validateRelayArgs(toolArgs);
      } else if (toolName === 'ugk_work_takeover') {
        validationError = validateTakeoverArgs(toolArgs);
      } else if (toolName === 'ugk_work_resume') {
        validationError = validateResumeArgs(toolArgs);
      } else {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `Unknown tool: ${toolName}` }]
          }
        };
      }

      if (validationError) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: validationError }]
          }
        };
      }

      const handler = handlers[toolName];
      if (!handler || typeof handler !== 'function') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `Handler not implemented for tool: ${toolName}` }]
          }
        };
      }

      try {
        const handlerResult = await handler(toolArgs, { conversationIdentity: conversationIdentity(params?._meta) });
        if (STRUCTURED_TOOL_NAMES.has(toolName)) {
          const isFailed = (handlerResult?.ok === false
            || (Boolean(handlerResult?.code) && handlerResult?.ok !== true))
            && handlerResult?.isError === undefined;
          if (isFailed) {
            const safePayload = sanitizeIntegrationErrorPayload(handlerResult);
            return {
              jsonrpc: '2.0',
              id,
              result: {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(safePayload) }]
              }
            };
          }
        }
        let formattedResult;
        if (handlerResult && typeof handlerResult === 'object' && Array.isArray(handlerResult.content)) {
          formattedResult = handlerResult;
        } else if (handlerResult && typeof handlerResult === 'object' && handlerResult.isError !== undefined) {
          formattedResult = handlerResult;
        } else if (typeof handlerResult === 'string') {
          formattedResult = {
            content: [{ type: 'text', text: handlerResult }]
          };
        } else {
          formattedResult = {
            content: [{ type: 'text', text: JSON.stringify(handlerResult ?? { ok: true }) }]
          };
        }
        return {
          jsonrpc: '2.0',
          id,
          result: formattedResult
        };
      } catch (err) {
        if (err?.relayPayload || err?.takeoverPayload) {
          return { jsonrpc: '2.0', id, result: {
            isError: true, content: [{ type: 'text', text: JSON.stringify(err.relayPayload ?? err.takeoverPayload) }],
          } };
        }
        if (stderr?.write) {
          try {
            stderr.write(`[ugk-mcp] Handler error for ${toolName}: ${err?.message || err}\n`);
          } catch {}
        }
        if (STRUCTURED_TOOL_NAMES.has(toolName) || err?.isIntegrationError) {
          const safePayload = sanitizeIntegrationErrorPayload(
            err?.integrationPayload ?? err,
            err?.code ?? 'REQUEST_FAILED',
            err?.diagnosticId ?? null,
          );
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify(safePayload) }]
            }
          };
        }
        if (['code', 'reason', 'diagnosticId', 'impact', 'required_action', 'requiredAction']
          .some((field) => err?.[field] !== undefined)) {
          const safePayload = sanitizeIntegrationErrorPayload(
            err,
            err?.code ?? 'REQUEST_FAILED',
            err?.diagnosticId ?? null,
          );
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify(safePayload) }],
            },
          };
        }
        const publicMessage = typeof err?.publicMessage === 'string'
          ? err.publicMessage
          : 'UGK Cockpit 暂时无法完成这个工具调用，请查看本地服务状态。';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: publicMessage }]
          }
        };
      }
    }

    default: {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`
        }
      };
    }
  }
}

export function createMcpServer({ stdin, stdout, stderr, handlers = {}, onShutdown = null } = {}) {
  const inStream = stdin || process.stdin;
  const outStream = stdout || process.stdout;
  const errStream = stderr || process.stderr;

  // readline 会无条件缓冲整行，因此在上游加一层按行计数的限流：单行超过上限
  // 时立即销毁输入并触发同一条关停路径，避免桥进程被异常宿主无限喂大内存。
  let pendingLineBytes = 0;
  let separatorCarry = EMPTY_BUFFER;
  let failClosedInvoked = false;
  let readlineInterface = null;
  // 超限行与输入读取错误共用同一条 fail-closed 路径：拆管道、销毁守卫层与
  // 输入流、显式终结 readline —— rl 'close' 汇入唯一且幂等的 shutdown，
  // 因此 onShutdown 恰好执行一次，在途服务调用由此被调用方中止。
  const failClosedFromInput = (diagnostic) => {
    if (failClosedInvoked) return;
    failClosedInvoked = true;
    if (errStream?.write) {
      try {
        errStream.write(`[ugk-mcp] ${diagnostic}\n`);
      } catch {}
    }
    inStream.unpipe(lineLimitGuard);
    lineLimitGuard.destroy();
    inStream.destroy?.();
    // 输入被销毁不会自动终结 readline，显式关停以触发同一条 shutdown 路径。
    readlineInterface?.close();
  };
  const lineLimitGuard = new Transform({
    transform(chunk, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      // 每遇到一个换行就结算当前行的总长（含换行本身）；未终结的尾部累积
      // 计数。两条路径都查上限，完整长行和无限增长的前缀都无法绕过。
      let overLimit = false;
      let from = 0;
      for (;;) {
        const newline = bytes.indexOf(0x0a, from);
        if (newline === -1) break;
        const lineBytes = pendingLineBytes + (newline - from) + 1;
        pendingLineBytes = 0;
        from = newline + 1;
        if (lineBytes > MCP_STDIO_LINE_LIMIT) overLimit = true;
      }
      pendingLineBytes += bytes.length - from;
      if (pendingLineBytes > MCP_STDIO_LINE_LIMIT) overLimit = true;
      if (overLimit) {
        // 错误不在流机制内传播（同步写路径上的 error 事件会变成未捕获异常）：
        // 丢弃当前块，并在本次写入完成后走统一关停路径。
        pendingLineBytes = 0;
        queueMicrotask(() => failClosedFromInput(
          `stdio line exceeds the ${MCP_STDIO_LINE_LIMIT}-byte payload limit; closing the bridge.`));
        callback();
        return;
      }
      // JSON 允许 U+2028/U+2029 裸出现在字符串里，而 readline 把它们当行终止符。
      // 一个这样的字符会把一条合法请求切成两段无法解析的碎片，宿主因此收不到
      // 任何回执；出向同理会让一次已经写入成功的操作看起来像丢了。这里统一把
      // 它们改写成 JSON 转义文本，解析结果不变，分帧只认换行。
      const combined = separatorCarry.length === 0
        ? bytes
        : Buffer.concat([separatorCarry, bytes]);
      let cut = combined.length;
      if (cut >= 2 && combined[cut - 2] === 0xe2 && combined[cut - 1] === 0x80) cut -= 2;
      else if (cut >= 1 && combined[cut - 1] === 0xe2) cut -= 1;
      separatorCarry = cut === combined.length
        ? EMPTY_BUFFER
        : Buffer.from(combined.subarray(cut));
      const framed = escapeWireSeparators(combined.subarray(0, cut));
      if (framed.length === 0) callback();
      else callback(null, framed);
    },
    flush(callback) {
      // 流结束时残留的半个序列已经无法构成合法 JSON，按原样交出即可。
      if (separatorCarry.length === 0) {
        callback();
        return;
      }
      const rest = separatorCarry;
      separatorCarry = EMPTY_BUFFER;
      callback(null, rest);
    },
  });
  // 宿主管道的读取错误（如 EPIPE）同样必须进入统一关停：只拆限流层不会终结
  // readline，onShutdown 不执行，在途服务调用会挂到自身超时、进程滞留。
  inStream?.on?.('error', (error) => failClosedFromInput(
    `stdin read error (${error?.code ?? error?.message ?? 'unknown'}); closing the bridge.`));
  inStream.pipe(lineLimitGuard);

  const rl = readline.createInterface({
    input: lineLimitGuard,
    crlfDelay: Infinity,
    terminal: false
  });
  readlineInterface = rl;

  // The host can destroy the pipes at any moment (crash, restart, user
  // cancel). An 'error' event with no listener would escape the request queue
  // and take the whole bridge process down as an uncaught exception.
  outStream?.on?.('error', () => {});
  errStream?.on?.('error', () => {});

  const writeResponse = (response) => {
    try {
      outStream.write(`${JSON.stringify(response).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}\n`);
    } catch (writeErr) {
      // A lost response would leave the host waiting on its own timeout with
      // no signal at all. Surface the failure on stderr and answer with a
      // generic JSON-RPC error so the channel degrades loudly, not silently.
      try {
        errStream?.write?.(`[ugk-mcp] Failed to write response: ${writeErr?.message ?? writeErr}\n`);
        outStream.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } })}\n`);
      } catch {}
    }
  };

  // Hosts close stdin when the session ends. In-flight service calls must be
  // aborted so this process cannot linger on a stalled connection: wire the
  // readline 'close' event (EOF or close()) into the same shutdown path.
  let shutdownInvoked = false;
  const shutdown = () => {
    if (shutdownInvoked) return;
    shutdownInvoked = true;
    if (typeof onShutdown === 'function') {
      try { onShutdown(); } catch {}
    }
  };
  rl.on('close', shutdown);

  const handleLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (parseErr) {
      if (errStream?.write) {
        try {
          errStream.write(`[ugk-mcp] JSON parse error: ${parseErr.message}\n`);
        } catch {}
      }
      writeResponse({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error'
        }
      });
      return;
    }

    try {
      const response = await dispatchMessage(message, { handlers, stderr: errStream });
      if (response) {
        writeResponse(response);
      }
    } catch (dispatchErr) {
      if (errStream?.write) {
        try {
          errStream.write(`[ugk-mcp] Dispatch error: ${dispatchErr.message}\n`);
        } catch {}
      }
      if (message && typeof message === 'object' && message.id !== undefined) {
        writeResponse({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: 'Internal error'
          }
        });
      }
    }
  };

  let queue = Promise.resolve();

  rl.on('line', (line) => {
    queue = queue
      .then(() => handleLine(line))
      .catch((err) => {
        if (errStream?.write) {
          try {
            errStream.write(`[ugk-mcp] Unhandled error: ${err?.message || err}\n`);
          } catch {}
        }
      });
  });

  return {
    close() {
      rl.close();
      // 拆除限流管道并释放守卫流：否则持久的 pipe 引用会让进程事件循环永不
      // 排空，宿主（和测试运行器）在关停后仍无法退出。
      inStream.unpipe(lineLimitGuard);
      lineLimitGuard.destroy();
      // EOF and an explicit close() both converge on the same shutdown path;
      // whichever arrives first aborts in-flight service calls exactly once.
      shutdown();
    },
    dispatchMessage(msg) {
      return dispatchMessage(msg, { handlers, stderr: errStream });
    },
    tools: TOOLS
  };
}

export { createMcpServer as createMcpStdioServer };
