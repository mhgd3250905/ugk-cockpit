import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { backup } from 'node:sqlite';

export async function createConsistentBackup(db, destinationPath) {
  mkdirSync(dirname(destinationPath), { recursive: true });
  await backup(db, destinationPath, { rate: 64 });
  return destinationPath;
}

