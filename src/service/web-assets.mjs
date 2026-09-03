import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
]);

const SOURCE_WEB_ROOT = fileURLToPath(new URL('../../web', import.meta.url));
const SOURCE_PUBLIC_ROOT = fileURLToPath(new URL('../../web/public', import.meta.url));

function securityHeaders(contentType) {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
}

async function resolveAssetCandidate(webRoot, relativePath) {
  try {
    const root = await realpath(webRoot);
    const candidate = await realpath(path.join(root, relativePath));
    const relative = path.relative(root, candidate);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return candidate;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  try {
    if (relativePath === 'index.html') {
      const root = await realpath(SOURCE_WEB_ROOT);
      const candidate = await realpath(path.join(root, 'index.html'));
      return candidate;
    }
    if (relativePath.startsWith('assets/')) {
      const root = await realpath(SOURCE_PUBLIC_ROOT);
      const candidate = await realpath(path.join(root, relativePath));
      const relative = path.relative(root, candidate);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        return candidate;
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  return null;
}

export async function serveWebAsset({ request, response, pathname, webRoot, sessionToken }) {
  if (request.method !== 'GET') return false;
  let relativePath;
  if (pathname === '/') relativePath = 'index.html';
  else if (/^\/assets\/[a-zA-Z0-9._-]+$/.test(pathname)) relativePath = pathname.slice(1);
  else return false;

  const candidate = await resolveAssetCandidate(webRoot, relativePath);
  if (!candidate) return false;

  try {
    const body = await readFile(candidate);
    const headers = {
      ...securityHeaders(MIME.get(path.extname(candidate)) ?? 'application/octet-stream'),
      'content-length': body.length,
    };
    if (relativePath === 'index.html') {
      headers['set-cookie'] = `ugk_cockpit_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`;
    }
    response.writeHead(200, headers);
    response.end(body);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

