import path from 'node:path';
import { runGit as git, readDeliveryLocation } from '../git/delivery-ops.mjs';
import { deliveryError } from './delivery-sources.mjs';
import { createDeliveryCache, assertDeliveryCache, discardDeliveryCache } from './delivery-cache.mjs';

const opts = { timeoutMs: 30_000, maxBuffer: 2 * 1024 * 1024 };
const safe = ['-c', 'protocol.ext.allow=never', '-c', 'core.sshCommand=ssh', '-c', 'ssh.variant=ssh'];

export async function verifyReviewDelivery(submission, project, { prepare = false, allowIntegrated = false, reuse = true } = {}) {
  if (!submission.delivery?.sourceId) return null;
  const metadata = submission.delivery;
  const location = await readDeliveryLocation(project.canonical_path);
  const remote = location.remotes.find((item) => item.name === 'origin') ?? (location.remotes.length === 1 ? location.remotes[0] : null);
  if (!remote || remote.identity !== metadata.targetRemoteIdentity) throw deliveryError('DELIVERY_REMOTE_CHANGED');
  const readRef = async (url, branch) => {
    try {
      const result = await git(project.canonical_path, [...safe, 'ls-remote', '--exit-code', '--refs', '--', url, `refs/heads/${branch}`], opts);
      return result.stdout.split(/\s/)[0];
    } catch (cause) { throw Object.assign(new Error('Review reference is unavailable', { cause }), { code: 'DELIVERY_REVIEW_REF_UNAVAILABLE' }); }
  };
  const [sourceHead, targetHead] = await Promise.all([
    readRef(metadata.sourceRemoteUrl, submission.sourceBranch), readRef(remote.url, submission.targetBranch),
  ]);
  if (sourceHead !== submission.sourceCommit) throw deliveryError('DELIVERY_SOURCE_UPDATED');
  if (targetHead !== submission.targetHead && !(allowIntegrated && targetHead === submission.sourceCommit)) throw deliveryError('TARGET_HEAD_STALE');
  if (!prepare) return { sourceHead, targetHead };
  if (reuse && metadata.reviewCache) {
    try {
      const root = assertDeliveryCache(metadata.reviewCache);
      const repository = path.join(root, 'review.git');
      if ((await git(repository, ['rev-parse', 'refs/heads/source'], opts)).stdout === sourceHead
        && (await git(repository, ['rev-parse', 'refs/heads/target'], opts)).stdout === targetHead) {
        return { repository, sourceHead, targetHead, cache: metadata.reviewCache };
      }
    } catch { /* Rebuild missing/expired internal cache; never trust it as authority. */ }
  }
  const cache = createDeliveryCache('review');
  const root = cache.cachePath;
  const repository = path.join(root, 'review.git');
  try {
  await git(root, [...safe, 'init', '--bare', repository], opts);
  await git(repository, [...safe, 'fetch', '--no-tags', '--no-write-fetch-head', '--', metadata.sourceRemoteUrl,
    `refs/heads/${submission.sourceBranch}:refs/heads/source`], opts);
  await git(repository, [...safe, 'fetch', '--no-tags', '--no-write-fetch-head', '--', remote.url,
    `refs/heads/${submission.targetBranch}:refs/heads/target`], opts);
  const fetchedSource = (await git(repository, ['rev-parse', 'refs/heads/source'], opts)).stdout;
  const fetchedTarget = (await git(repository, ['rev-parse', 'refs/heads/target'], opts)).stdout;
  if (fetchedSource !== sourceHead || fetchedTarget !== targetHead) throw deliveryError('DELIVERY_PREFLIGHT_STALE');
  return { repository, sourceHead, targetHead, cache };
  } catch (error) { discardDeliveryCache(cache); throw error; }
}

export async function importReviewedDelivery(submission, project) {
  const review = await verifyReviewDelivery(submission, project, { prepare: true, reuse: false });
  try {
    if (review) await git(project.canonical_path, [...safe, 'fetch', '--no-tags', '--no-write-fetch-head', '--',
      review.repository, submission.sourceCommit], opts);
  } finally { if (review) discardDeliveryCache(review.cache); }
}
