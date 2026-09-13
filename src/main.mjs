import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { backupBeforeMigration } from './core/backup.mjs';
import { resolveDataDirectory } from './core/data-directory.mjs';
import { SUPPORTED_SCHEMA_VERSION } from './core/database.mjs';
import { acquireInstanceLock } from './core/single-instance.mjs';
import { loadOrCreateToken } from './core/token-file.mjs';
import { createCockpitHttpServer } from './service/http-server.mjs';

const dataDir = resolveDataDirectory({ argv: process.argv });
// Launchers pass an explicit port for isolated verification runs; the normal
// entry keeps the fixed well-known port.
const portIndex = process.argv.indexOf('--port');
const port = portIndex === -1 ? 41737 : Number(process.argv[portIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port requires an integer between 1 and 65535.');
mkdirSync(dataDir, { recursive: true });
const lock = acquireInstanceLock(path.join(dataDir, 'service.lock'));
try {
  const token = loadOrCreateToken(path.join(dataDir, 'api-token'));
  const dbPath = path.join(dataDir, 'cockpit.db');
  await backupBeforeMigration({
    sourcePath: dbPath,
    backupDirectory: path.join(dataDir, 'backups'),
    targetVersion: SUPPORTED_SCHEMA_VERSION,
  });
  const service = await createCockpitHttpServer({
    dbPath,
    token,
    host: '127.0.0.1',
    port,
    onShutdown: () => stop(),
  });
  process.stdout.write(`UGK Cockpit Phase 0 service: http://${service.host}:${service.port}\n`);
  let stopping = false;
  const stop = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    try {
      await service.close();
    } finally {
      // A failed close must not skip releasing the instance lock; otherwise
      // the next start has to go through stale-lock recovery for nothing.
      lock.release();
      process.exit(exitCode);
    }
  };
  // Node passes the signal name as the first listener argument; wrap so stop
  // always sees its exit-code parameter instead of e.g. 'SIGINT'.
  process.once('SIGINT', () => stop());
  process.once('SIGTERM', () => stop());
  // Last-resort guard: an escaped async error must not kill the service
  // silently. Log what happened, then shut down through the normal path.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[ugk-cockpit] unhandled rejection: ${reason?.stack ?? reason}\n`);
  });
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[ugk-cockpit] uncaught exception: ${error?.stack ?? error}\n`);
    stop(1);
  });
} catch (error) {
  lock.release();
  throw error;
}
