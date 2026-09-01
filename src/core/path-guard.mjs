import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export class PathScopeError extends Error {
  constructor(message, code = 'PATH_OUTSIDE_SCOPE') {
    super(message);
    this.name = 'PathScopeError';
    this.code = code;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function containsSymbolicSegment(rootReal, candidateInput) {
  const relativeInput = path.relative(rootReal, path.resolve(candidateInput));
  if (relativeInput.startsWith('..') || path.isAbsolute(relativeInput)) return false;
  let cursor = rootReal;
  for (const segment of relativeInput.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (lstatSync(cursor).isSymbolicLink()) return true;
  }
  return false;
}

export function authorizeExistingPath(candidatePath, grantedRoot, { allowInternalLinks = false } = {}) {
  const rootReal = realpathSync.native(grantedRoot);
  const candidateReal = realpathSync.native(candidatePath);
  if (!isWithin(rootReal, candidateReal)) {
    throw new PathScopeError('所选路径跳出了已授权文件夹，已停止访问。');
  }
  if (!allowInternalLinks && containsSymbolicSegment(rootReal, candidatePath)) {
    throw new PathScopeError('所选路径经过了链接或 junction，默认不继续访问。', 'REPARSE_POINT');
  }
  return Object.freeze({ rootReal, candidateReal });
}

export function revalidateAuthorizedPath(binding) {
  const current = realpathSync.native(binding.candidateReal);
  if (current !== binding.candidateReal || !isWithin(binding.rootReal, current)) {
    throw new PathScopeError('路径在确认后发生变化，已停止访问。', 'PATH_CHANGED');
  }
  return current;
}

