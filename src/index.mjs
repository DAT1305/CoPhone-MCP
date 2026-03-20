import { AuditLog } from "./audit-log.mjs";
import { readConfig } from "./config.mjs";
import { DeviceRegistry } from "./device-registry.mjs";
import { handleRpcRequest } from "./mcp-server.mjs";
import { StdioJsonRpcServer } from "./stdio-jsonrpc.mjs";
import { createWebSocketBridgeServer } from "./ws-bridge-server.mjs";

const config = readConfig();
const auditLog = new AuditLog(config.auditLogPath);
const registry = new DeviceRegistry({
  pairingToken: config.pairingToken,
  logger: console,
  auditLog,
});

const bridge = createWebSocketBridgeServer({
  host: config.bridgeHost,
  port: config.bridgePort,
  logger: console,
  onClient: (client) => {
    client.on("message", (message) => {
      registry.handleClientMessage(client, message);
    });
    client.on("close", () => {
      registry.disconnectClient(client);
    });
  },
});

await bridge.listen();

const stdio = new StdioJsonRpcServer({
  input: process.stdin,
  output: process.stdout,
  logger: console,
  onRequest: (request) => handleRpcRequest(request, { registry, auditLog }),
});

stdio.start();
