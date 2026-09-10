import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { backupBeforeMigration } from './core/backup.mjs';
import { SUPPORTED_SCHEMA_VERSION } from './core/database.mjs';
import { acquireInstanceLock } from './core/single-instance.mjs';
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

function loadOrCreateToken(filePath) {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('base64url');
  // Write to a temporary file and rename, so a crash mid-write can never
  // leave a truncated token that would brick the next service start.
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const descriptor = openSync(temporaryPath, 'wx', 0o600);
  try {
    writeSync(descriptor, `${token}\n`, null, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    throw error;
  }
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
