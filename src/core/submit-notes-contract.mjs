export const MAX_BODY_CHARS = 20_000;
export const MAX_TITLE_CHARS = 200;
export const MAX_REFERENCES_COUNT = 20;
export const MAX_HANDLING_NOTE_CHARS = 4_000;

export const REFERENCE_ALLOWED_KEYS = new Set(['target', 'type', 'commit', 'title', 'note']);
export const SUBMIT_NOTE_ALLOWED_KEYS = new Set(['clientRequestId', 'body', 'title', 'references', 'mcpWorkingDirectory', 'bridgeBinding']);
export const SUBMIT_NOTE_GET_ALLOWED_KEYS = new Set(['noteId', 'mcpWorkingDirectory']);
export const SUBMIT_NOTE_UPDATE_ALLOWED_KEYS = new Set(['noteId', 'clientRequestId', 'expectedRevision', 'status', 'handlingNote', 'mcpWorkingDirectory']);
export const BROWSER_STATUS_ALLOWED_KEYS = new Set(['clientRequestId', 'expectedRevision', 'status', 'handlingNote']);

export function normalizeReferences(references) {
  if (references === undefined) return [];
  if (!Array.isArray(references)) {
    const error = new Error('references must be an array');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (references.length > MAX_REFERENCES_COUNT) {
    const error = new Error(`references cannot exceed ${MAX_REFERENCES_COUNT} items`);
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  return references.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      const error = new Error(`reference[${index}] must be an object`);
      error.code = 'INVALID_REQUEST';
      throw error;
    }
    for (const key of Object.keys(item)) {
      if (!REFERENCE_ALLOWED_KEYS.has(key)) {
        const error = new Error(`reference[${index}] contains unknown property: ${key}`);
        error.code = 'INVALID_REQUEST';
        throw error;
      }
    }
    if (typeof item.target !== 'string' || !item.target.trim()) {
      const error = new Error(`reference[${index}].target must be a non-empty string`);
      error.code = 'INVALID_REQUEST';
      throw error;
    }
    if (item.target.length > 1024) {
      const error = new Error(`reference[${index}].target exceeds maximum length of 1024 characters`);
      error.code = 'INVALID_REQUEST';
      throw error;
    }
    const normalized = { target: item.target };

    if (item.type !== undefined) {
      if (typeof item.type !== 'string' || item.type.length > 64) {
        const error = new Error(`reference[${index}].type must be a string up to 64 characters`);
        error.code = 'INVALID_REQUEST';
        throw error;
      }
      normalized.type = item.type;
    } else {
      normalized.type = 'reference';
    }

    if (item.commit !== undefined) {
      if (typeof item.commit !== 'string' || item.commit.length > 128) {
        const error = new Error(`reference[${index}].commit must be a string up to 128 characters`);
        error.code = 'INVALID_REQUEST';
        throw error;
      }
      normalized.commit = item.commit;
    }

    if (item.title !== undefined) {
      if (typeof item.title !== 'string' || item.title.length > 200) {
        const error = new Error(`reference[${index}].title must be a string up to 200 characters`);
        error.code = 'INVALID_REQUEST';
        throw error;
      }
      normalized.title = item.title;
    }

    if (item.note !== undefined) {
      if (typeof item.note !== 'string' || item.note.length > 1000) {
        const error = new Error(`reference[${index}].note must be a string up to 1000 characters`);
        error.code = 'INVALID_REQUEST';
        throw error;
      }
      normalized.note = item.note;
    }

    return normalized;
  });
}

export function validateSubmitNoteBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Request body must be an object');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  for (const key of Object.keys(body)) {
    if (!SUBMIT_NOTE_ALLOWED_KEYS.has(key)) {
      const error = new Error(`Unknown property in request body: ${key}`);
      error.code = 'INVALID_REQUEST';
      throw error;
    }
  }
  if (typeof body.clientRequestId !== 'string' || !body.clientRequestId.trim()) {
    const error = new Error('clientRequestId is required and must be non-empty string');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (typeof body.body !== 'string' || !body.body.trim()) {
    const error = new Error('body is required and must be non-empty');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (body.body.length > MAX_BODY_CHARS) {
    const error = new Error(`body exceeds maximum length of ${MAX_BODY_CHARS} characters`);
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > MAX_TITLE_CHARS)) {
    const error = new Error(`title must be a string up to ${MAX_TITLE_CHARS} characters`);
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (body.mcpWorkingDirectory !== undefined && (typeof body.mcpWorkingDirectory !== 'string' || !body.mcpWorkingDirectory.trim())) {
    const error = new Error('mcpWorkingDirectory must be a non-empty string');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (body.references !== undefined) {
    normalizeReferences(body.references);
  }
}

export function validateSubmitNoteGetBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Request body must be an object');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  for (const key of Object.keys(body)) {
    if (!SUBMIT_NOTE_GET_ALLOWED_KEYS.has(key)) {
      const error = new Error(`Unknown property in request body: ${key}`);
      error.code = 'INVALID_REQUEST';
      throw error;
    }
  }
  if (typeof body.noteId !== 'string' || !body.noteId.trim()) {
    const error = new Error('noteId is required');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (body.mcpWorkingDirectory !== undefined && (typeof body.mcpWorkingDirectory !== 'string' || !body.mcpWorkingDirectory.trim())) {
    const error = new Error('mcpWorkingDirectory must be a non-empty string');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
}

export function validateSubmitNoteUpdateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Request body must be an object');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  for (const key of Object.keys(body)) {
    if (!SUBMIT_NOTE_UPDATE_ALLOWED_KEYS.has(key)) {
      const error = new Error(`Unknown property in request body: ${key}`);
      error.code = 'INVALID_REQUEST';
      throw error;
    }
  }
  if (typeof body.noteId !== 'string' || !body.noteId.trim()) {
    const error = new Error('noteId is required');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (typeof body.clientRequestId !== 'string' || !body.clientRequestId.trim()) {
    const error = new Error('clientRequestId is required');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) {
    const error = new Error('expectedRevision must be a positive integer');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (!['pending', 'handled', 'archived'].includes(body.status)) {
    const error = new Error("status must be 'pending', 'handled', or 'archived'");
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (body.handlingNote !== undefined) {
    if (typeof body.handlingNote !== 'string' || body.handlingNote.length > MAX_HANDLING_NOTE_CHARS) {
      const error = new Error(`handlingNote must be a string up to ${MAX_HANDLING_NOTE_CHARS} characters`);
      error.code = 'INVALID_REQUEST';
      throw error;
    }
  }
  if (body.mcpWorkingDirectory !== undefined && (typeof body.mcpWorkingDirectory !== 'string' || !body.mcpWorkingDirectory.trim())) {
    const error = new Error('mcpWorkingDirectory must be a non-empty string');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
}

export function validateBrowserStatusBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Request body must be an object');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  for (const key of Object.keys(body)) {
    if (!BROWSER_STATUS_ALLOWED_KEYS.has(key)) {
      const error = new Error(`Unknown property in request body: ${key}`);
      error.code = 'INVALID_REQUEST';
      throw error;
    }
  }
  if (typeof body.clientRequestId !== 'string' || !body.clientRequestId.trim()) {
    const error = new Error('clientRequestId is required');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) {
    const error = new Error('expectedRevision must be a positive integer');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (!['pending', 'handled', 'archived'].includes(body.status)) {
    const error = new Error("status must be 'pending', 'handled', or 'archived'");
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (body.handlingNote !== undefined) {
    if (typeof body.handlingNote !== 'string' || body.handlingNote.length > MAX_HANDLING_NOTE_CHARS) {
      const error = new Error(`handlingNote must be a string up to ${MAX_HANDLING_NOTE_CHARS} characters`);
      error.code = 'INVALID_REQUEST';
      throw error;
    }
  }
}
