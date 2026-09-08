export const WORKSPACE_ACTION_RECOVERY_STORAGE_KEY = 'ugk-cockpit-workspace-action-recovery-v1';
export const WORKSPACE_ACTION_RECOVERY_VERSION = 1;

const WORKSPACE_ACTION_KINDS = new Set(['reuse', 'remove']);
const WORKSPACE_ACTION_STATES = new Set(['pending', 'unknown']);

export class WorkspaceActionRecoveryStorageError extends Error {
  constructor(cause) {
    super('无法保存开发空间操作的恢复材料。', { cause });
    this.name = 'WorkspaceActionRecoveryStorageError';
    this.code = 'WORKSPACE_ACTION_RECOVERY_STORAGE_UNAVAILABLE';
  }
}

export class WorkspaceActionRecoveryDataError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'WorkspaceActionRecoveryDataError';
    this.code = 'WORKSPACE_ACTION_RECOVERY_INVALID_DATA';
  }
}

export class WorkspaceActionRecoveryConflictError extends Error {
  constructor(existing, incoming) {
    super('该开发空间已经有一项待核对的操作。');
    this.name = 'WorkspaceActionRecoveryConflictError';
    this.code = 'WORKSPACE_ACTION_RECOVERY_CONFLICT';
    this.projectId = incoming.projectId;
    this.spaceId = incoming.spaceId;
    this.existingCommandId = existing?.commandId ?? null;
    this.incomingCommandId = incoming.commandId;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function hasValidRevision(value) {
  return Number.isInteger(value) && value >= 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeRequest(kind, request) {
  if (!isRecord(request) || !isNonEmptyString(request.commandId) || !hasValidRevision(request.expectedRevision)) {
    return null;
  }

  if (kind === 'reuse') {
    if (!isNonEmptyString(request.expectedBaseHead)) return null;
    if (Object.keys(request).some((key) => !['commandId', 'expectedRevision', 'expectedBaseHead'].includes(key))) {
      return null;
    }
    return {
      commandId: request.commandId,
      expectedRevision: request.expectedRevision,
      expectedBaseHead: request.expectedBaseHead,
    };
  }

  if (Object.keys(request).some((key) => !['commandId', 'expectedRevision'].includes(key))) {
    return null;
  }
  return {
    commandId: request.commandId,
    expectedRevision: request.expectedRevision,
  };
}

function normalizeLastError(error) {
  if (!isRecord(error)) return null;
  return {
    code: isNonEmptyString(error.code) ? error.code : null,
    outcome: isNonEmptyString(error.outcome) ? error.outcome : null,
    retryable: typeof error.retryable === 'boolean' ? error.retryable : null,
    state: isNonEmptyString(error.state) ? error.state : null,
  };
}

function normalizeStoredAction(value) {
  if (!isRecord(value)) return null;
  if (value.version !== WORKSPACE_ACTION_RECOVERY_VERSION) return null;
  if (!WORKSPACE_ACTION_KINDS.has(value.kind)) return null;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.projectId) || !isNonEmptyString(value.spaceId)) {
    return null;
  }
  if (!WORKSPACE_ACTION_STATES.has(value.state)) return null;
  const request = normalizeRequest(value.kind, value.request);
  if (!request || request.commandId !== value.commandId) return null;

  return {
    version: WORKSPACE_ACTION_RECOVERY_VERSION,
    id: value.id,
    kind: value.kind,
    projectId: value.projectId,
    spaceId: value.spaceId,
    spaceName: typeof value.spaceName === 'string' ? value.spaceName : '',
    commandId: value.commandId,
    request,
    state: value.state,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    lastError: normalizeLastError(value.lastError),
  };
}

function normalizeStoredActions(value) {
  const rawActions = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.records)
      ? value.records
      : [];
  const byId = new Map();
  for (const rawAction of rawActions) {
    const action = normalizeStoredAction(rawAction);
    if (action) byId.set(action.id, action);
  }
  return [...byId.values()];
}

function sameActionRecord(left, right) {
  return Boolean(left && right)
    && left.id === right.id
    && left.commandId === right.commandId
    && JSON.stringify(left.request) === JSON.stringify(right.request);
}

function rawActionList(value) {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && value.version === WORKSPACE_ACTION_RECOVERY_VERSION && Array.isArray(value.records)) {
    return value.records;
  }
  return null;
}

function readRawStrict(storage) {
  if (!storage || typeof storage.getItem !== 'function') {
    throw new WorkspaceActionRecoveryStorageError();
  }

  let raw;
  try {
    raw = storage.getItem(WORKSPACE_ACTION_RECOVERY_STORAGE_KEY);
  } catch (error) {
    throw new WorkspaceActionRecoveryStorageError(error);
  }
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WorkspaceActionRecoveryDataError('开发空间操作恢复材料无法读取。', error);
  }

  const rawActions = rawActionList(parsed);
  if (!rawActions) {
    throw new WorkspaceActionRecoveryDataError('开发空间操作恢复材料版本无效。');
  }
  const normalized = rawActions.map((item) => normalizeStoredAction(item));
  if (normalized.some((item) => !item)) {
    throw new WorkspaceActionRecoveryDataError('开发空间操作恢复材料内容无效。');
  }
  const ids = new Set(normalized.map((item) => item.id));
  if (ids.size !== normalized.length) {
    throw new WorkspaceActionRecoveryDataError('开发空间操作恢复材料包含重复记录。');
  }
  return normalized;
}

function readRaw(storage) {
  try {
    return readRawStrict(storage);
  } catch {
    // UI reads are best effort. Mutations use readRawStrict so a corrupt or
    // inaccessible store can never be replaced by an empty list.
    return [];
  }
}

function writeRaw(storage, actions) {
  if (!storage || typeof storage.setItem !== 'function') {
    throw new WorkspaceActionRecoveryStorageError();
  }
  const normalized = normalizeStoredActions(actions);
  try {
    storage.setItem(
      WORKSPACE_ACTION_RECOVERY_STORAGE_KEY,
      JSON.stringify({ version: WORKSPACE_ACTION_RECOVERY_VERSION, records: normalized }),
    );
  } catch (error) {
    throw new WorkspaceActionRecoveryStorageError(error);
  }
  return normalized;
}

export function getWorkspaceActionStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function workspaceActionRecordId({ kind, projectId, spaceId }) {
  if (!WORKSPACE_ACTION_KINDS.has(kind) || !isNonEmptyString(projectId) || !isNonEmptyString(spaceId)) {
    throw new TypeError('A workspace action requires a kind, projectId, and spaceId.');
  }
  return `${kind}:${projectId}:${spaceId}`;
}

export function createWorkspaceActionRecord({
  kind,
  projectId,
  spaceId,
  spaceName = '',
  request,
  now = new Date().toISOString(),
}) {
  const id = workspaceActionRecordId({ kind, projectId, spaceId });
  const normalizedRequest = normalizeRequest(kind, request);
  if (!normalizedRequest) {
    throw new TypeError('A workspace action must contain the exact valid request body.');
  }
  if (!isNonEmptyString(now)) throw new TypeError('A workspace action requires a timestamp.');

  return {
    version: WORKSPACE_ACTION_RECOVERY_VERSION,
    id,
    kind,
    projectId,
    spaceId,
    spaceName: typeof spaceName === 'string' ? spaceName : '',
    commandId: normalizedRequest.commandId,
    request: normalizedRequest,
    state: 'pending',
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
}

export function readWorkspaceActionRecords(storage = getWorkspaceActionStorage()) {
  return readRaw(storage);
}

export function readWorkspaceActionRecordsWithStatus(storage = getWorkspaceActionStorage()) {
  try {
    return { records: readRawStrict(storage), error: null };
  } catch (error) {
    return { records: [], error };
  }
}

export function writeWorkspaceActionRecords(actions, storage = getWorkspaceActionStorage()) {
  // Even an intentional list write must first prove that the existing store
  // is readable. This avoids silently deleting an unresolved record after a
  // transient browser storage/parse failure.
  readRawStrict(storage);
  return writeRaw(storage, actions);
}

export function upsertWorkspaceActionRecord(action, storage = getWorkspaceActionStorage()) {
  const normalized = normalizeStoredAction(action);
  if (!normalized) throw new TypeError('Invalid workspace action recovery record.');
  const actions = readRawStrict(storage);
  const conflicting = actions.find((item) => (
    item.projectId === normalized.projectId && item.spaceId === normalized.spaceId
    && !sameActionRecord(item, normalized)
  ));
  if (conflicting) {
    throw new WorkspaceActionRecoveryConflictError(conflicting, normalized);
  }
  const nextActions = actions.filter((item) => item.id !== normalized.id);
  nextActions.push(normalized);
  return writeRaw(storage, nextActions);
}

export function markWorkspaceActionPending(action, storage = getWorkspaceActionStorage(), now = new Date().toISOString()) {
  const normalized = normalizeStoredAction(action);
  if (!normalized || !isNonEmptyString(now)) throw new TypeError('Invalid workspace action recovery record.');
  const actions = readRawStrict(storage);
  const current = actions.find((item) => sameActionRecord(item, normalized));
  if (!current) {
    const competing = actions.find((item) => (
      item.projectId === normalized.projectId && item.spaceId === normalized.spaceId
    ));
    if (competing) throw new WorkspaceActionRecoveryConflictError(competing, normalized);
    // A record cleared by another tab must not be resurrected by a late retry.
    return actions;
  }
  const nextActions = actions.map((item) => sameActionRecord(item, normalized) ? {
    ...item,
    state: 'pending',
    updatedAt: now,
    lastError: null,
  } : item);
  return writeRaw(storage, nextActions);
}

export function markWorkspaceActionUnknown(
  action,
  error,
  storage = getWorkspaceActionStorage(),
  now = new Date().toISOString(),
) {
  const normalized = normalizeStoredAction(action);
  if (!normalized || !isNonEmptyString(now)) throw new TypeError('Invalid workspace action recovery record.');
  const actions = readRawStrict(storage);
  const current = actions.find((item) => sameActionRecord(item, normalized));
  if (!current) {
    const competing = actions.find((item) => (
      item.projectId === normalized.projectId && item.spaceId === normalized.spaceId
    ));
    if (competing) throw new WorkspaceActionRecoveryConflictError(competing, normalized);
    // A successful response in another tab may already have cleared it.
    return actions;
  }
  const nextActions = actions.map((item) => sameActionRecord(item, normalized) ? {
    ...item,
    state: 'unknown',
    updatedAt: now,
    lastError: normalizeLastError(error),
  } : item);
  return writeRaw(storage, nextActions);
}

export function removeWorkspaceActionRecord(action, storage = getWorkspaceActionStorage()) {
  const normalized = normalizeStoredAction(action);
  if (!normalized) throw new TypeError('Removing a workspace action requires the exact action record.');
  const actions = readRawStrict(storage);
  // Compare the full durable identity. A late response from an older request
  // must never clear a newer request that reused the same space and record id.
  const hasExactRecord = actions.some((item) => sameActionRecord(item, normalized));
  if (!hasExactRecord) return actions;
  return writeRaw(storage, actions.filter((item) => !sameActionRecord(item, normalized)));
}

export function findWorkspaceActionRecord(actions, { projectId, spaceId, kind } = {}) {
  return (Array.isArray(actions) ? actions : []).find((action) => (
    (!projectId || action.projectId === projectId)
    && (!spaceId || action.spaceId === spaceId)
    && (!kind || action.kind === kind)
  )) ?? null;
}

export function classifyWorkspaceActionError(error) {
  // The service's explicit outcome is authoritative. retryable wins over a
  // contradictory/mixed payload so a retryable reservation or lock can never
  // be discarded by the browser.
  if (error?.retryable === true) return 'unknown';
  if (error?.outcome === 'unknown') return 'unknown';
  if (error?.code === 'WORKSPACE_RECOVERY_UNCERTAIN') return 'unknown';
  if (error?.code === 'SERVICE_UNAVAILABLE' || error?.transport === true) return 'unknown';
  if (error?.outcome === 'confirmed_failure') return 'definitive';

  // A response without the explicit confirmation contract cannot prove that
  // the workspace operation did not happen. Preserve the original request.
  return 'unknown';
}
