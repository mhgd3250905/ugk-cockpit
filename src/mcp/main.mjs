import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServiceHandlers } from './service-client.mjs';
import { createMcpStdioServer } from './stdio-protocol.mjs';

const dataRoot = process.env.LOCALAPPDATA;
let token = null;
if (dataRoot) {
  try {
    token = readFileSync(path.join(dataRoot, 'UGK Cockpit', 'api-token'), 'utf8').trim();
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) throw error;
  }
}

createMcpStdioServer({
  handlers: createServiceHandlers({ token, workingDirectory: process.cwd() }),
});
