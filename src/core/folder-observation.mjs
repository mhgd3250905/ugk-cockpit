import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileIdentity } from '../git/probe.mjs';

export async function hasOwnGitMetadata(directory) {
  try {
    await lstat(path.join(directory, '.git'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Identity-only observation: no content scan, Git initialization, or invented
// clean state. The existing directory authorization remains at the caller.
export async function probeFolder(directory) {
  const canonicalPath = await realpath(directory);
  if (!(await stat(canonicalPath)).isDirectory()) {
    throw Object.assign(new Error('Selected path is not a directory.'), { code: 'NOT_A_DIRECTORY' });
  }
  const identity = await fileIdentity(canonicalPath);
  const state = {
    head: null, branch: null, indexFingerprint: null,
    worktreeFingerprint: null, hasChanges: null,
  };
  return {
    canonicalPath,
    repositoryIdentity: `folder:${identity.fingerprint}`,
    worktreeIdentity: identity.fingerprint,
    observedAt: new Date().toISOString(),
    coherence: 'unknown', headRelation: 'unknown',
    before: { ...state }, after: { ...state },
  };
}
