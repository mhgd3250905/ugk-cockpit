import { createHash } from 'node:crypto';
import { authorizeExistingPath, revalidateAuthorizedPath } from './path-guard.mjs';
import { readProjectContext, worktreeIdFor } from './projects.mjs';
import { withImmediateTransaction } from './database.mjs';
import { probeGitWorktree } from '../git/probe.mjs';
import { readDeliveryLocation, checkUnsupportedFeatures } from '../git/delivery-ops.mjs';

export const deliveryId = (prefix, value) => `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
export const deliveryError = (code) => Object.assign(new Error(code), { code });
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export function authorizeDeliveryObservation(observation, roots) {
  const locations = [observation.canonicalPath, observation.gitDirectory, observation.repositoryCommonDir,
    observation.indexPath, ...(observation.objectDirectories ?? [])].filter(Boolean);
  for (const location of locations) {
    const permitted = roots.some((root) => {
      try { revalidateAuthorizedPath(authorizeExistingPath(location, root)); return true; } catch { return false; }
    });
    if (!permitted) throw deliveryError('PATH_OUTSIDE_SCOPE');
  }
  if (observation.coherence !== 'coherent') throw deliveryError('SOURCE_STATE_CHANGED');
}

function primaryRemote(location) {
  const remote = location.remotes.find((item) => item.name === 'origin')
    ?? (location.remotes.length === 1 ? location.remotes[0] : null);
  if (!remote) throw deliveryError('PUSH_REMOTE_AMBIGUOUS');
  return remote;
}

export function readDeliverySource(db, sourceId) {
  return db.prepare(`SELECT delivery_sources.*, worktrees.canonical_path,
    worktrees.repository_identity, worktrees.identity_fingerprint
    FROM delivery_sources JOIN worktrees ON worktrees.id = delivery_sources.worktree_id
    WHERE delivery_sources.id = ?`).get(sourceId) ?? null;
}

export async function observeDeliverySource(db, sourceId) {
  const source = readDeliverySource(db, sourceId);
  if (!source) throw deliveryError('DELIVERY_SOURCE_NOT_FOUND');
  const project = readProjectContext(db, source.project_id);
  if (!project) throw deliveryError('PROJECT_NOT_FOUND');
  const sourceBinding = authorizeExistingPath(source.canonical_path, source.authorized_root);
  const targetBinding = authorizeExistingPath(project.canonical_path, project.authorized_root);
  await Promise.all([checkUnsupportedFeatures(sourceBinding.candidateReal), checkUnsupportedFeatures(targetBinding.candidateReal)]);
  const [observation, target] = await Promise.all([
    probeGitWorktree(sourceBinding.candidateReal), probeGitWorktree(targetBinding.candidateReal),
  ]);
  revalidateAuthorizedPath(sourceBinding);
  revalidateAuthorizedPath(targetBinding);
  authorizeDeliveryObservation(observation, [source.authorized_root, project.authorized_root]);
  authorizeDeliveryObservation(target, [project.authorized_root]);
  if (!samePath(observation.canonicalPath, source.canonical_path)
    || observation.worktreeIdentity !== source.identity_fingerprint || observation.repositoryIdentity !== source.repository_identity
    || !samePath(target.canonicalPath, project.canonical_path) || target.worktreeIdentity !== project.identity_fingerprint
    || target.repositoryIdentity !== project.repository_identity) throw deliveryError('WORKTREE_IDENTITY_CHANGED');
  return { source, project, observation, target };
}

// No arbitrary path authorization: callers must supply the native-picker binding,
// or a previously registered source/space/project whose binding was revalidated.
export async function registerDeliveryLocation(db, { observation, authorizedRoot, projectId = null }) {
  const sourceLocation = await readDeliveryLocation(observation.canonicalPath);
  const candidates = projectId ? [readProjectContext(db, projectId)]
    : db.prepare('SELECT id FROM projects').all().map((row) => readProjectContext(db, row.id));
  const matches = [];
  for (const project of candidates.filter(Boolean)) {
    try {
    const binding = authorizeExistingPath(project.canonical_path, project.authorized_root);
    await checkUnsupportedFeatures(binding.candidateReal);
    const target = await probeGitWorktree(binding.candidateReal);
    revalidateAuthorizedPath(binding);
    authorizeDeliveryObservation(target, [project.authorized_root]);
    if (target.worktreeIdentity !== project.identity_fingerprint || target.repositoryIdentity !== project.repository_identity) {
      if (projectId) throw deliveryError('WORKTREE_IDENTITY_CHANGED');
      continue;
    }
    const targetLocation = await readDeliveryLocation(project.canonical_path);
    const targetRemote = primaryRemote(targetLocation);
    if (sourceLocation.remotes.some((remote) => remote.identity === targetRemote.identity)) {
      matches.push({ project, targetRemote });
    }
    } catch (error) { if (projectId) throw error; }
  }
  if (matches.length !== 1) throw deliveryError(matches.length ? 'DELIVERY_PROJECT_AMBIGUOUS' : 'PROJECT_NOT_FOUND');
  const { project, targetRemote } = matches[0];
  authorizeDeliveryObservation(observation, [authorizedRoot, project.authorized_root]);
  const sourceRemote = primaryRemote(sourceLocation);
  const worktreeId = worktreeIdFor(observation.worktreeIdentity);
  const sourceId = deliveryId('delivery_source', `${project.id}:${worktreeId}`);
  return withImmediateTransaction(db, () => {
    const byPath = db.prepare('SELECT * FROM worktrees WHERE canonical_path = ?').get(observation.canonicalPath);
    if (byPath && (byPath.identity_fingerprint !== observation.worktreeIdentity
      || byPath.repository_identity !== observation.repositoryIdentity)) throw deliveryError('WORKTREE_IDENTITY_CHANGED');
    const byIdentity = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(worktreeId);
    if (byIdentity && !samePath(byIdentity.canonical_path, observation.canonicalPath)) throw deliveryError('WORKTREE_IDENTITY_CHANGED');
    db.prepare(`INSERT OR IGNORE INTO worktrees (id,canonical_path,repository_identity,identity_fingerprint,created_at)
      VALUES (?,?,?,?,?)`).run(worktreeId, observation.canonicalPath, observation.repositoryIdentity, observation.worktreeIdentity, new Date().toISOString());
    const existing = readDeliverySource(db, sourceId);
    if (existing && (existing.source_remote_identity !== sourceRemote.identity || existing.target_remote_identity !== targetRemote.identity)) {
      throw deliveryError('DELIVERY_REMOTE_CHANGED');
    }
    db.prepare(`INSERT OR IGNORE INTO delivery_sources
      (id,project_id,worktree_id,authorized_root,source_remote_identity,target_remote_identity,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(sourceId, project.id, worktreeId, authorizedRoot, sourceRemote.identity, targetRemote.identity, new Date().toISOString());
    return readDeliverySource(db, sourceId);
  });
}

export function assertDeliveryCwd(source, cwd) {
  if (!source) throw deliveryError('DELIVERY_SOURCE_NOT_FOUND');
  try { revalidateAuthorizedPath(authorizeExistingPath(cwd, source.canonical_path)); }
  catch { throw deliveryError('DELIVERY_DIRECTORY_MISMATCH'); }
}
