import test from "node:test";
import assert from "node:assert/strict";

import { DeviceRegistry } from "../src/device-registry.mjs";
import { createWebSocketBridgeServer } from "../src/ws-bridge-server.mjs";

test("websocket bridge accepts a device and relays commands", async () => {
  const registry = new DeviceRegistry({ pairingToken: "dev-token" });
  const bridge = createWebSocketBridgeServer({
    host: "127.0.0.1",
    port: 8790,
    onClient: (client) => {
      client.on("message", (message) => registry.handleClientMessage(client, message));
      client.on("close", () => registry.disconnectClient(client));
    },
    logger: { error() {} },
  });

  await bridge.listen();

  try {
    const ws = new WebSocket("ws://127.0.0.1:8790");
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });

    ws.send(JSON.stringify({
      type: "hello",
      deviceId: "pixel-1",
      pairingToken: "dev-token",
      deviceName: "Pixel",
    }));

    const firstMessage = await new Promise((resolve) => {
      ws.addEventListener("message", (event) => resolve(JSON.parse(event.data)), { once: true });
    });
    assert.equal(firstMessage.type, "pair_confirm");

    const pending = registry.invokeDeviceCommand("pixel-1", "get_ui_tree", {});
    const command = await new Promise((resolve) => {
      ws.addEventListener("message", (event) => resolve(JSON.parse(event.data)), { once: true });
    });
    assert.equal(command.commandName, "get_ui_tree");

    ws.send(JSON.stringify({
      type: "command_result",
      requestId: command.requestId,
      ok: true,
      result: { root: true },
    }));

    const result = await pending;
    assert.deepEqual(result, { root: true });
    ws.close();
  } finally {
    await bridge.close();
  }
});
