import { createHash } from 'node:crypto';
import {
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { rejectSymbolicPath } from './path-guard.mjs';

export const MAX_AVATAR_FILE_SIZE = 5 * 1024 * 1024;

const IMAGE_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

const MIME_TO_EXTENSION = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
]);

function avatarError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateProjectId(projectId) {
  if (typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(projectId) || projectId === '.' || projectId === '..') {
    throw avatarError('INVALID_IMAGE_PATH', '项目头像标识无效。');
  }
}

function resolveImageFormat({ sourcePath, originalName, extension, mimeType } = {}) {
  const nameCandidate = originalName || sourcePath;
  if (nameCandidate && typeof nameCandidate === 'string') {
    const rawExt = nameCandidate.startsWith('.') ? nameCandidate.toLowerCase() : path.extname(nameCandidate).toLowerCase();
    const resolvedMime = IMAGE_MIME_TYPES.get(rawExt);
    if (resolvedMime) {
      return { extension: rawExt, mimeType: resolvedMime };
    }
  }
  if (extension && typeof extension === 'string') {
    const rawExt = extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
    const resolvedMime = IMAGE_MIME_TYPES.get(rawExt);
    if (resolvedMime) {
      return { extension: rawExt, mimeType: resolvedMime };
    }
  }
  if (mimeType && typeof mimeType === 'string') {
    const normalizedMime = mimeType.split(';')[0].trim().toLowerCase();
    const resolvedExt = MIME_TO_EXTENSION.get(normalizedMime);
    if (resolvedExt) {
      return { extension: resolvedExt, mimeType: normalizedMime === 'image/jpg' ? 'image/jpeg' : normalizedMime };
    }
  }
  throw avatarError('INVALID_IMAGE_TYPE', '仅支持 PNG、JPG、JPEG、GIF 或 WebP 图片。');
}

function validateExtension(filePath) {
  return resolveImageFormat({ sourcePath: filePath });
}

function readBoundedImage(sourcePath) {
  let descriptor;
  try {
    rejectSymbolicPath(sourcePath);
    descriptor = openSync(sourcePath, 'r');
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw avatarError('INVALID_IMAGE_PATH', '所选头像不是普通文件。');
    if (stat.size <= 0) throw avatarError('INVALID_IMAGE_PATH', '所选头像文件为空。');
    if (stat.size > MAX_AVATAR_FILE_SIZE) {
      throw avatarError('IMAGE_TOO_LARGE', '所选头像超过 5MB。');
    }
    const content = readFileSync(descriptor);
    if (content.length <= 0 || content.length > MAX_AVATAR_FILE_SIZE) {
      throw avatarError(content.length > MAX_AVATAR_FILE_SIZE ? 'IMAGE_TOO_LARGE' : 'INVALID_IMAGE_PATH', '所选头像大小无效。');
    }
    return content;
  } catch (error) {
    if (error?.code && ['INVALID_IMAGE_PATH', 'INVALID_IMAGE_TYPE', 'IMAGE_TOO_LARGE', 'REPARSE_POINT'].includes(error.code)) throw error;
    throw avatarError('IMAGE_NOT_FOUND', '无法读取所选头像文件。');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function stageProjectAvatar({
  sourcePath,
  content,
  originalName,
  extension,
  mimeType,
  storageRoot,
  projectId,
}) {
  validateProjectId(projectId);
  if (typeof storageRoot !== 'string' || !storageRoot.trim()) {
    throw avatarError('INVALID_IMAGE_PATH', '头像存储路径无效。');
  }

  let fileContent;
  let format;

  if (content !== undefined && content !== null) {
    if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
      throw avatarError('INVALID_IMAGE_PATH', '所选头像大小无效。');
    }
    if (content.length <= 0) {
      throw avatarError('INVALID_IMAGE_PATH', '所选头像文件为空。');
    }
    if (content.length > MAX_AVATAR_FILE_SIZE) {
      throw avatarError('IMAGE_TOO_LARGE', '所选头像超过 5MB。');
    }
    format = resolveImageFormat({ originalName, extension, mimeType, sourcePath });
    fileContent = Buffer.isBuffer(content) ? content : Buffer.from(content);
  } else {
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
      throw avatarError('INVALID_IMAGE_PATH', '系统选择器没有返回有效的图片文件。');
    }
    format = validateExtension(sourcePath);
    fileContent = readBoundedImage(sourcePath);
  }

  const digest = createHash('sha256').update(fileContent).digest('hex');
  const fileName = `${digest}${format.extension}`;
  const projectRoot = path.join(storageRoot, projectId);
  mkdirSync(projectRoot, { recursive: true });
  rejectSymbolicPath(projectRoot);
  const storageReal = realpathSync.native(path.resolve(storageRoot));
  const projectReal = realpathSync.native(projectRoot);
  if (!isWithin(storageReal, projectReal) || storageReal === projectReal) {
    throw avatarError('INVALID_IMAGE_PATH', '头像存储位置无效。');
  }
  const destination = path.join(projectReal, fileName);
  try {
    writeFileSync(destination, fileContent, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    rejectSymbolicPath(destination);
  }
  return {
    avatarPath: `${projectId}/${fileName}`,
    mimeType: format.mimeType,
    size: fileContent.length,
  };
}

export function resolveProjectAvatar({ storageRoot, projectId, avatarPath }) {
  validateProjectId(projectId);
  if (typeof storageRoot !== 'string' || !storageRoot.trim()) {
    throw avatarError('INVALID_IMAGE_PATH', '头像存储路径无效。');
  }
  if (typeof avatarPath !== 'string') {
    throw avatarError('INVALID_IMAGE_PATH', '项目头像设置无效。');
  }
  const normalized = avatarPath.replaceAll('\\', '/');
  const match = normalized.match(/^([a-zA-Z0-9_-]{1,64})\/([a-f0-9]{64})(\.(?:png|jpe?g|gif|webp))$/i);
  if (!match || match[1] !== projectId || normalized !== avatarPath) {
    throw avatarError('INVALID_IMAGE_PATH', '项目头像设置无效。');
  }
  const { mimeType } = validateExtension(match[3]);
  const root = path.resolve(storageRoot);
  const candidate = path.join(root, projectId, `${match[2]}${match[3].toLowerCase()}`);
  try {
    rejectSymbolicPath(candidate);
    const rootReal = realpathSync.native(root);
    const fileReal = realpathSync.native(candidate);
    if (!isWithin(rootReal, fileReal) || rootReal === fileReal) {
      throw avatarError('INVALID_IMAGE_PATH', '项目头像存储位置无效。');
    }
    const descriptor = openSync(fileReal, 'r');
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size <= 0) throw avatarError('IMAGE_NOT_FOUND', '找不到项目头像文件。');
      if (stat.size > MAX_AVATAR_FILE_SIZE) throw avatarError('IMAGE_TOO_LARGE', '项目头像文件超过 5MB。');
      return { filePath: fileReal, avatarPath, mimeType, size: stat.size };
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error?.code && ['INVALID_IMAGE_PATH', 'INVALID_IMAGE_TYPE', 'IMAGE_TOO_LARGE', 'REPARSE_POINT'].includes(error.code)) throw error;
    throw avatarError('IMAGE_NOT_FOUND', '找不到项目头像文件。');
  }
}
