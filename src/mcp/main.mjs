import { createServiceHandlers } from './service-client.mjs';
import { createMcpStdioServer } from './stdio-protocol.mjs';

// A client and the service can see different files at the same AppData path.
// Use the service's loopback MCP credential; refresh after expiry/restart without
// changing the process-local work-session binding or replayed command payload.
createMcpStdioServer({
  handlers: createServiceHandlers({ workingDirectory: process.cwd() }),
});
