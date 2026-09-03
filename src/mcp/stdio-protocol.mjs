import readline from 'node:readline';
import { VERSION } from '../version.mjs';
import { validateDeliveryRequest } from '../core/delivery-contract.mjs';

const DEFAULT_PROTOCOL_VERSION = '2025-11-25';
const PROGRESS_STATUSES = ['working', 'in_progress'];
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  DEFAULT_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

export const TOOLS = [
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
    description: 'After explicit submit intent, verify the registered project, authorized current directory, selected changes and latest remote target without changing user code. No init required. selectFolder opens a user-controlled folder authorization dialog.',
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
    description: 'Explicitly save, normally push and register a fixed-version review task after a valid MCP preflight; no prior init or development-space session required. Never merge automatically.',
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
          items: {
            type: 'string'
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
          items: {
            type: 'string'
          },
          description: 'List of completed items'
        },
        pendingItems: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'List of pending items'
        },
        decisions: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'List of key decisions made'
        },
        artifactRefs: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'List of artifact references or paths'
        },
        risks: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'List of identified risks or caveats'
        },
        suggestedSkills: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'List of suggested skills for next session'
        },
        acknowledgements: {
          type: 'array',
          items: {
            type: 'string'
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
          items: { type: 'string' },
          description: 'List of completed items'
        },
        pendingItems: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of pending items'
        },
        decisions: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of key decisions'
        },
        artifactRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of artifact references or paths'
        },
        risks: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of identified risks or caveats'
        },
        suggestedSkills: {
          type: 'array',
          items: { type: 'string' },
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
    name: 'ugk_work_resume',
    description: 'Only call when the user explicitly instructs resuming with a provided continueCode; consume a one-time conversation relay code and continue the same active Cockpit session',
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

function isStringArray(val) {
  return Array.isArray(val) && val.every((item) => typeof item === 'string');
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
  const allowedKeys = ['initCode', 'clientRequestId', 'currentTask', 'currentState'];
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) return `Forbidden property: ${key}`;
    if (!allowedKeys.includes(key)) return `Unexpected property: ${key}`;
  }
  for (const field of allowedKeys) {
    if (typeof args[field] !== 'string' || args[field].trim() === '') {
      return `Missing or invalid required field: ${field} (must be non-empty string)`;
    }
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

function validateResumeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object';
  }
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) return `Forbidden property: ${key}`;
    if (!['continueCode', 'clientRequestId'].includes(key)) {
      return `Unexpected property: ${key}`;
    }
  }
  if (typeof args.continueCode !== 'string' || args.continueCode.trim() === '') {
    return 'Missing or invalid required field: continueCode (must be non-empty string)';
  }
  if (typeof args.clientRequestId !== 'string' || args.clientRequestId.trim() === '') {
    return 'Missing or invalid required field: clientRequestId (must be non-empty string)';
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

  // Handle notifications: notifications do not have an `id` property or are notifications/initialized
  const isNotification = message.id === undefined || message.method === 'notifications/initialized';
  if (isNotification && message.method === 'notifications/initialized') {
    return null;
  }
  if (isNotification) {
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
      if (toolName === 'ugk_work_accept') {
        validationError = validateAcceptArgs(toolArgs);
      } else if (toolName === 'ugk_work_progress') {
        validationError = validateProgressArgs(toolArgs);
      } else if (toolName === 'ugk_work_submit') {
        validationError = validateDeliveryRequest(toolArgs, 'submit');
      } else if (toolName === 'ugk_work_submit_preflight') {
        validationError = validateDeliveryRequest(toolArgs, 'preflight');
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
        const handlerResult = await handler(toolArgs);
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
        if (stderr?.write) {
          try {
            stderr.write(`[ugk-mcp] Handler error for ${toolName}: ${err?.message || err}\n`);
          } catch {}
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

export function createMcpServer({ stdin, stdout, stderr, handlers = {} } = {}) {
  const inStream = stdin || process.stdin;
  const outStream = stdout || process.stdout;
  const errStream = stderr || process.stderr;

  const rl = readline.createInterface({
    input: inStream,
    crlfDelay: Infinity,
    terminal: false
  });

  const writeResponse = (response) => {
    if (response) {
      const line = JSON.stringify(response);
      outStream.write(`${line}\n`);
    }
  };

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
    },
    dispatchMessage(msg) {
      return dispatchMessage(msg, { handlers, stderr: errStream });
    },
    tools: TOOLS
  };
}

export { createMcpServer as createMcpStdioServer };
