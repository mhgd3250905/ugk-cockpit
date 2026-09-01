import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export async function createConsistentBackup(db, destinationPath) {
  mkdirSync(dirname(destinationPath), { recursive: true });
  await backup(db, destinationPath, { rate: 64 });
  return destinationPath;
}

export async function backupBeforeMigration({ sourcePath, backupDirectory, targetVersion }) {
  if (!existsSync(sourcePath)) return null;
  const source = new DatabaseSync(sourcePath, { readOnly: true, allowExtension: false });
  try {
    const sourceVersion = Number(source.prepare('PRAGMA user_version').get().user_version);
    if (sourceVersion >= targetVersion) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destinationPath = path.join(
      backupDirectory,
      `cockpit-schema-${sourceVersion}-before-${targetVersion}-${stamp}.db`,
    );
    await createConsistentBackup(source, destinationPath);
    const restored = new DatabaseSync(destinationPath, { readOnly: true, allowExtension: false });
    try {
      if (
        restored.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
        || restored.prepare('PRAGMA foreign_key_check').all().length !== 0
        || Number(restored.prepare('PRAGMA user_version').get().user_version) !== sourceVersion
      ) {
        throw new Error('Pre-migration backup verification failed.');
      }
    } finally {
      restored.close();
    }
    return destinationPath;
  } finally {
    source.close();
  }
}
