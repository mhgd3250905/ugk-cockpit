import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authorizeExistingPath, revalidateAuthorizedPath } from './path-guard.mjs';

export function createDeliveryCache(kind = 'cache') {
  if (!['cache', 'review'].includes(kind)) throw new Error('Invalid cache kind');
  const cachePath = mkdtempSync(path.join(os.tmpdir(), `ugk-delivery-${kind}-`));
  const cacheOwner = randomBytes(24).toString('hex');
  writeFileSync(path.join(cachePath, '.ugk-delivery-owner'), cacheOwner, { flag: 'wx' });
  return { cachePath, cacheOwner };
}

export function assertDeliveryCache(descriptor) {
  if (!descriptor?.cacheOwner || typeof descriptor.cachePath !== 'string'
    || !/^ugk-delivery-(cache|review)-[A-Za-z0-9]+$/.test(path.basename(descriptor.cachePath))
    || path.relative(os.tmpdir(), path.dirname(descriptor.cachePath)) !== '') {
    throw Object.assign(new Error('Not an owned delivery cache'), { code: 'DELIVERY_CACHE_INVALID' });
  }
  const binding = authorizeExistingPath(descriptor.cachePath, os.tmpdir());
  revalidateAuthorizedPath(binding);
  if (readFileSync(path.join(binding.candidateReal, '.ugk-delivery-owner'), 'utf8') !== descriptor.cacheOwner) {
    throw Object.assign(new Error('Delivery cache identity changed'), { code: 'DELIVERY_CACHE_INVALID' });
  }
  return binding.candidateReal;
}

export function discardDeliveryCache(descriptor) {
  try { const exact = assertDeliveryCache(descriptor); rmSync(exact, { recursive: true, force: true }); return true; }
  catch { return false; }
}
