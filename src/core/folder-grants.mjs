import { randomUUID } from 'node:crypto';
import { withImmediateTransaction } from './database.mjs';

export class FolderGrantStore {
  constructor({ db, ttlMs = 5 * 60_000, clock = Date.now }) {
    this.db = db;
    this.ttlMs = ttlMs;
    this.clock = clock;
  }

  issue(binding, principalHash) {
    const grantId = randomUUID();
    const expiresAt = this.clock() + this.ttlMs;
    this.db.prepare(`
      INSERT INTO folder_grants (
        id, principal_hash, folder_path, canonical_path,
        repository_identity, worktree_identity, state,
        expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      grantId, principalHash, binding.folderPath, binding.canonicalPath,
      binding.repositoryIdentity, binding.worktreeIdentity, expiresAt,
      new Date(this.clock()).toISOString(),
    );
    return { grantId, ...binding, expiresAt: new Date(expiresAt).toISOString() };
  }

  claim(grantId, commandId, principalHash) {
    return withImmediateTransaction(this.db, () => {
      const grant = this.db.prepare('SELECT * FROM folder_grants WHERE id = ?').get(grantId);
      if (!grant || grant.expires_at <= this.clock() || grant.principal_hash !== principalHash) {
        const error = new Error('Folder grant is missing or expired.');
        error.code = 'FOLDER_GRANT_EXPIRED';
        throw error;
      }
      if (grant.claimed_by_command && grant.claimed_by_command !== commandId) {
        const error = new Error('Folder grant is already bound to another command.');
        error.code = 'FOLDER_GRANT_IN_USE';
        throw error;
      }
      if (grant.state === 'active') {
        this.db.prepare(`
          UPDATE folder_grants SET state = 'claimed', claimed_by_command = ?
          WHERE id = ? AND state = 'active'
        `).run(commandId, grantId);
      }
      return this.db.prepare('SELECT * FROM folder_grants WHERE id = ?').get(grantId);
    });
  }

  complete(grantId, commandId) {
    this.db.prepare(`
      UPDATE folder_grants SET state = 'consumed'
      WHERE id = ? AND claimed_by_command = ? AND state = 'claimed'
    `).run(grantId, commandId);
  }
}
