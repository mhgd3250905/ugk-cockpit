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

export class EmptyFolderGrantStore {
  constructor({ db, ttlMs = 5 * 60_000, clock = Date.now }) {
    this.db = db;
    this.ttlMs = ttlMs;
    this.clock = clock;
  }

  issue(binding, principalHash) {
    const grantId = randomUUID();
    const expiresAt = this.clock() + this.ttlMs;
    const folderPath = binding.folderPath ?? binding.candidateReal ?? binding.candidateInput;
    const canonicalPath = binding.canonicalPath ?? binding.candidateReal ?? binding.candidateInput;
    const fileIdentity = binding.fileIdentity ?? '';

    this.db.prepare(`
      INSERT INTO empty_folder_grants (
        id, principal_hash, folder_path, canonical_path,
        file_identity, state, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      grantId,
      principalHash,
      folderPath,
      canonicalPath,
      fileIdentity,
      expiresAt,
      new Date(this.clock()).toISOString(),
    );
    return {
      grantId,
      folderPath,
      canonicalPath,
      fileIdentity,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  claim(grantId, commandId, principalHash) {
    return withImmediateTransaction(this.db, () => {
      const grant = this.db.prepare('SELECT * FROM empty_folder_grants WHERE id = ?').get(grantId);
      if (!grant) {
        const error = new Error('Empty folder grant is missing or expired.');
        error.code = 'FOLDER_GRANT_EXPIRED';
        throw error;
      }
      if (principalHash && grant.principal_hash !== principalHash) {
        const error = new Error('Empty folder grant is missing or expired.');
        error.code = 'FOLDER_GRANT_EXPIRED';
        throw error;
      }
      if (grant.claimed_by_command && grant.claimed_by_command !== commandId) {
        const error = new Error('Empty folder grant is already bound to another command.');
        error.code = 'FOLDER_GRANT_IN_USE';
        throw error;
      }
      if (grant.state === 'consumed') {
        const error = new Error('Empty folder grant has already been consumed.');
        error.code = 'FOLDER_GRANT_CONSUMED';
        throw error;
      }
      if (grant.state === 'claimed') {
        if (grant.claimed_by_command === commandId) {
          return grant;
        }
      }
      if (grant.state === 'active') {
        if (grant.expires_at <= this.clock()) {
          const error = new Error('Empty folder grant is missing or expired.');
          error.code = 'FOLDER_GRANT_EXPIRED';
          throw error;
        }
        this.db.prepare(`
          UPDATE empty_folder_grants SET state = 'claimed', claimed_by_command = ?
          WHERE id = ? AND state = 'active'
        `).run(commandId, grantId);
        return this.db.prepare('SELECT * FROM empty_folder_grants WHERE id = ?').get(grantId);
      }
      const error = new Error('Empty folder grant is missing or expired.');
      error.code = 'FOLDER_GRANT_EXPIRED';
      throw error;
    });
  }

  complete(grantId, commandId) {
    this.db.prepare(`
      UPDATE empty_folder_grants SET state = 'consumed'
      WHERE id = ? AND claimed_by_command = ? AND state = 'claimed'
    `).run(grantId, commandId);
  }

  unclaim(grantId, commandId) {
    return withImmediateTransaction(this.db, () => {
      const grant = this.db.prepare('SELECT * FROM empty_folder_grants WHERE id = ?').get(grantId);
      if (!grant) return false;
      if (grant.state === 'claimed' && grant.claimed_by_command === commandId) {
        this.db.prepare(`
          UPDATE empty_folder_grants SET state = 'active', claimed_by_command = NULL
          WHERE id = ? AND state = 'claimed' AND claimed_by_command = ?
        `).run(grantId, commandId);
        return true;
      }
      return false;
    });
  }

  release(grantId, commandId) {
    return this.unclaim(grantId, commandId);
  }

  read(grantId) {
    return this.db.prepare('SELECT * FROM empty_folder_grants WHERE id = ?').get(grantId) ?? null;
  }
}
