import readline from 'node:readline';
import { VERSION } from '../version.mjs';

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
    description: 'Accept a work dispatch and initialize or resume an AI session',
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
    description: 'Report progress and state updates for an active session',
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
          description: 'Non-terminal progress only. Use finish or handoff to end the session.'
        },
        note: {
          type: 'string',
          description: 'Informational note or progress details'
        }
      },
      required: ['sessionId', 'clientRequestId', 'expectedRevision', 'status', 'note'],
      additionalProperties: false
    }
  },
  {
    name: 'ugk_work_finish',
    description: 'Complete an active session with outcome and summary',
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
    description: 'Record session handoff details for the next agent session',
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
    description: 'Begin work on an accepted session by specifying task details',
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
    description: 'Initialize the current project as an active Cockpit session without changing project files',
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
  }
];

const FORBIDDEN_KEYS = new Set(['path', 'projectId', 'worktreeId']);

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
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return `Forbidden property: ${key}`;
    }
    if (!['sessionId', 'clientRequestId', 'expectedRevision', 'status', 'note'].includes(key)) {
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
  if (typeof args.note !== 'string') {
    return 'Missing or invalid required field: note (must be string)';
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
      } else if (toolName === 'ugk_work_finish') {
        validationError = validateFinishArgs(toolArgs);
      } else if (toolName === 'ugk_work_handoff') {
        validationError = validateHandoffArgs(toolArgs);
      } else if (toolName === 'ugk_work_begin') {
        validationError = validateBeginArgs(toolArgs);
      } else if (toolName === 'ugk_work_init') {
        validationError = validateInitArgs(toolArgs);
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
