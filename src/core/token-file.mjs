import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

// Loads the persistent local API token, or creates it through a uniquely named
// temporary file plus fsync and rename. The random suffix keeps a temp file
// left behind by a killed process from failing a later start (its PID may have
// been reused), and any failure before the rename removes the temp file.
export function loadOrCreateToken(filePath) {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('base64url');
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  try {
    const descriptor = openSync(temporaryPath, 'wx', 0o600);
    created = true;
    try {
      writeSync(descriptor, `${token}\n`, null, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, filePath);
  } catch (error) {
    if (created) {
      try { unlinkSync(temporaryPath); } catch {
        // Best effort: the leftover is inert because the next attempt uses a
        // fresh random name.
      }
    }
    throw error;
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows ACL inheritance remains the primary protection on this host.
  }
  return token;
}
