import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authorizeExistingPath, revalidateAuthorizedPath } from './path-guard.mjs';

// POSIX 的系统临时目录（/tmp、/var）本身是符号链接，而路径授权按契约拒绝
// 穿越链接的路径；缓存必须创建并校验于同一真实路径下，否则送审保存在
// POSIX 上必然以 REPARSE_POINT 失败。
function tempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

export function createDeliveryCache(kind = 'cache') {
  if (!['cache', 'review'].includes(kind)) throw new Error('Invalid cache kind');
  const cachePath = mkdtempSync(path.join(tempRoot(), `ugk-delivery-${kind}-`));
  const cacheOwner = randomBytes(24).toString('hex');
  writeFileSync(path.join(cachePath, '.ugk-delivery-owner'), cacheOwner, { flag: 'wx' });
  return { cachePath, cacheOwner };
}

export function assertDeliveryCache(descriptor) {
  if (!descriptor?.cacheOwner || typeof descriptor.cachePath !== 'string'
    || !/^ugk-delivery-(cache|review)-[A-Za-z0-9]+$/.test(path.basename(descriptor.cachePath))
    || path.relative(tempRoot(), path.dirname(descriptor.cachePath)) !== '') {
    throw Object.assign(new Error('Not an owned delivery cache'), { code: 'DELIVERY_CACHE_INVALID' });
  }
  const binding = authorizeExistingPath(descriptor.cachePath, tempRoot());
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
