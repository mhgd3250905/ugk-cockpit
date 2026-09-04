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

function validateExtension(filePath) {
  const extension = filePath.startsWith('.')
    ? filePath.toLowerCase()
    : path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES.get(extension);
  if (!mimeType) {
    throw avatarError('INVALID_IMAGE_TYPE', '仅支持 PNG、JPG、JPEG、GIF 或 WebP 图片。');
  }
  return { extension, mimeType };
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

export function stageProjectAvatar({ sourcePath, storageRoot, projectId }) {
  validateProjectId(projectId);
  if (typeof storageRoot !== 'string' || !storageRoot.trim()) {
    throw avatarError('INVALID_IMAGE_PATH', '头像存储路径无效。');
  }
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
    throw avatarError('INVALID_IMAGE_PATH', '系统选择器没有返回有效的图片文件。');
  }
  const { extension, mimeType } = validateExtension(sourcePath);
  const content = readBoundedImage(sourcePath);
  const digest = createHash('sha256').update(content).digest('hex');
  const fileName = `${digest}${extension}`;
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
    writeFileSync(destination, content, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    rejectSymbolicPath(destination);
  }
  return {
    avatarPath: `${projectId}/${fileName}`,
    mimeType,
    size: content.length,
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
