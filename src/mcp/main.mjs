import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServiceHandlers } from './service-client.mjs';
import { createMcpStdioServer } from './stdio-protocol.mjs';

const dataRoot = process.env.LOCALAPPDATA;
function readLocalToken() {
  if (!dataRoot) return null;
  try {
    return readFileSync(path.join(dataRoot, 'UGK Cockpit', 'api-token'), 'utf8').trim();
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) throw error;
    return null;
  }
}

createMcpStdioServer({
  handlers: createServiceHandlers({
    token: readLocalToken(), refreshToken: readLocalToken, workingDirectory: process.cwd(),
  }),
});
