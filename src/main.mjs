import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { backupBeforeMigration } from './core/backup.mjs';
import { SUPPORTED_SCHEMA_VERSION } from './core/database.mjs';
import { acquireInstanceLock } from './core/single-instance.mjs';
import { createCockpitHttpServer } from './service/http-server.mjs';

function dataDirectory() {
  const base = process.env.LOCALAPPDATA;
  if (!base) throw new Error('LOCALAPPDATA is required on Windows.');
  return path.join(base, 'UGK Cockpit');
}

function loadOrCreateToken(filePath) {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(filePath, `${token}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows ACL inheritance remains the primary protection on this host.
  }
  return token;
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
