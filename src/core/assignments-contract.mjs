// Shared progress-status contract.
//
// This module exists as a separate file so the packaged stdio bridge can share
// the definition without shipping the core: `scripts/build-codex-plugin.mjs`
// copies `src/mcp/**` plus an explicit allow-list of `*-contract.mjs` modules
// and nothing else from `src/`, so any part of the bridge that needs a value
// owned by the core must live in one of these contract modules. Importing
// `assignments.mjs` from the bridge instead would break the installed plugin at
// runtime with ERR_MODULE_NOT_FOUND (the packaging test reproduces exactly
// that).
//
// The HTTP service, the MCP gate and the core all read this one definition, so
// the status enum can no longer be enforced in the bridge while the HTTP
// boundary — the real trust boundary — accepts anything the core does not
// happen to reject.
export const PROGRESS_STATUSES = Object.freeze(['working', 'in_progress']);
