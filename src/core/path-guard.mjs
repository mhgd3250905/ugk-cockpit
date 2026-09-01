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

function rejectSymbolicPath(inputPath) {
  const resolved = path.resolve(inputPath);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new PathScopeError('所选文件夹经过了链接或 junction，默认不继续访问。', 'REPARSE_POINT');
    }
  }
}

export function authorizeExistingPath(candidatePath, grantedRoot, { allowInternalLinks = false } = {}) {
  const rootInput = path.resolve(grantedRoot);
  const candidateInput = path.resolve(candidatePath);
  if (!allowInternalLinks) rejectSymbolicPath(rootInput);
  const rootReal = realpathSync.native(rootInput);
  const candidateReal = realpathSync.native(candidateInput);
  if (!isWithin(rootReal, candidateReal)) {
    throw new PathScopeError('所选路径跳出了已授权文件夹，已停止访问。');
  }
  if (!allowInternalLinks && containsSymbolicSegment(rootReal, candidatePath)) {
    throw new PathScopeError('所选路径经过了链接或 junction，默认不继续访问。', 'REPARSE_POINT');
  }
  return Object.freeze({ rootInput, candidateInput, rootReal, candidateReal });
}

export function revalidateAuthorizedPath(binding) {
  rejectSymbolicPath(binding.rootInput);
  if (binding.candidateInput !== binding.rootInput) rejectSymbolicPath(binding.candidateInput);
  const currentRoot = realpathSync.native(binding.rootInput);
  const current = realpathSync.native(binding.candidateInput);
  if (
    currentRoot !== binding.rootReal
    || current !== binding.candidateReal
    || !isWithin(binding.rootReal, current)
  ) {
    throw new PathScopeError('路径在确认后发生变化，已停止访问。', 'PATH_CHANGED');
  }
  return current;
}
