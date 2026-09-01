import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServiceHandlers } from './service-client.mjs';
import { createMcpStdioServer } from './stdio-protocol.mjs';

const dataRoot = process.env.LOCALAPPDATA;
if (!dataRoot) throw new Error('LOCALAPPDATA is required on Windows.');
const token = readFileSync(path.join(dataRoot, 'UGK Cockpit', 'api-token'), 'utf8').trim();

createMcpStdioServer({ handlers: createServiceHandlers({ token }) });
