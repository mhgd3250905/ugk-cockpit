import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { backupBeforeMigration } from './core/backup.mjs';
import { SUPPORTED_SCHEMA_VERSION } from './core/database.mjs';
import { acquireInstanceLock } from './core/single-instance.mjs';
import { loadOrCreateToken } from './core/token-file.mjs';
import { createCockpitHttpServer } from './service/http-server.mjs';

function dataDirectory() {
  const index = process.argv.indexOf('--data-directory');
  if (index !== -1) {
    const directory = process.argv[index + 1];
    if (!directory || !path.isAbsolute(directory)) throw new Error('--data-directory requires an absolute path.');
    return path.resolve(directory);
  }
  const base = process.env.LOCALAPPDATA;
  if (!base) throw new Error('LOCALAPPDATA is required on Windows.');
  return path.join(base, 'UGK Cockpit');
}

const dataDir = dataDirectory();
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
    port: 41737,
  });
  process.stdout.write(`UGK Cockpit Phase 0 service: http://${service.host}:${service.port}\n`);
  const stop = async () => {
    await service.close();
    lock.release();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  lock.release();
  throw error;
}
