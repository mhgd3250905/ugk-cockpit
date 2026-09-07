import { createServiceHandlers } from './service-client.mjs';
import { createMcpStdioServer } from './stdio-protocol.mjs';

// A client and the service can see different files at the same AppData path.
// Use the service's loopback MCP credential; refresh after expiry/restart without
// changing durable conversation bindings or replayed command payloads.
const shutdownController = new AbortController();
createMcpStdioServer({
  handlers: createServiceHandlers({
    workingDirectory: process.cwd(),
    shutdownSignal: shutdownController.signal,
  }),
  onShutdown: () => shutdownController.abort(new Error('MCP stdio server closed.')),
});
