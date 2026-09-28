import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

// A deliberately small feedback set, not a partition or replacement of full
// discovery. Add files only after measuring their cost and checking isolation.
export const QUICK_TEST_FILES = Object.freeze([
  'test/phase0/version.test.mjs',
  'test/test-quick.test.mjs',
  'test/deadline.test.mjs',
  'test/core/data-directory.test.mjs',
  'test/cockpit-skills.test.mjs',
  'test/codex-plugin.test.mjs',
  'test/zcode-plugin.test.mjs',
  'test/setup-codex.test.mjs',
  'test/setup-zcode.test.mjs',
  'test/zcode-conversation-identity.test.mjs',
  'test/mcp-service-client.test.mjs',
  'test/submit-notes-mcp.test.mjs',
  'test/assignment-copy-flow.test.mjs',
  'test/copy-note-text.test.mjs',
  'test/avatar-color.test.mjs',
  'test/timeline-geometry.test.mjs',
  'test/conversation-control-state.test.mjs',
  'test/conversation-control-ui.test.mjs',
  'test/workspace-action-recovery-ui.test.mjs',
  'test/audit-2026-09-28-detail-poll-coverage.test.mjs',
  'test/audit-2026-09-28-note-status-notice.test.mjs',
  'test/audit-2026-09-28-service-shutdown-recheck.test.mjs',
  'test/phase0/theme-boot.test.mjs',
]);

export function runQuickTests({ root = repositoryRoot, run = spawnSync, log = console.log } = {}) {
  if (new Set(QUICK_TEST_FILES).size !== QUICK_TEST_FILES.length) throw new Error('Duplicate quick test file');
  for (const file of QUICK_TEST_FILES) {
    if (!statSync(path.join(root, file)).isFile()) throw new Error(`Missing quick test file: ${file}`);
  }
  log(`QUICK feedback only: ${QUICK_TEST_FILES.length} files, 2 isolated file processes. This is NOT the full test gate.`);
  const result = run(process.execPath, ['--test', '--test-concurrency=2', ...QUICK_TEST_FILES], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Quick tests terminated by ${result.signal}`);
  return result.status ?? 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length > 2) throw new Error('Quick uses a fixed file list; use npm test -- test/example.test.mjs for targeted tests.');
    process.exitCode = runQuickTests();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
