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
// Scope, stated precisely: this is the whitelist for a *progress report*, shared
// by the MCP gate and the HTTP endpoint so the two cannot drift apart. The core
// is deliberately wider — `appendProgressEvent` accepts any non-terminal status
// and `'adopted'` is a first-class status written by the service's own init path
// (`/api/v1/mcp/work/init`) and special-cased by the core and the timeline read
// model. The defect this module closes is narrower than "the core had no enum":
// the enum lived only in the bridge, so the HTTP progress endpoint — the real
// trust boundary — accepted `'adopted'` and arbitrary labels from any caller
// with a scoped token, which could fabricate an adoption event in the project
// timeline and bump the assignment and run revisions.
export const PROGRESS_STATUSES = Object.freeze(['working', 'in_progress']);
