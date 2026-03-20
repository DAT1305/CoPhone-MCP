import test from "node:test";
import assert from "node:assert/strict";

import { DeviceRegistry } from "../src/device-registry.mjs";

function createFakeClient() {
  return {
    sent: [],
    sendJson(message) {
      this.sent.push(message);
    },
    closeCalled: false,
    close() {
      this.closeCalled = true;
    },
  };
}

test("device registry pairs a device and returns status", () => {
  const registry = new DeviceRegistry({ pairingToken: "dev-token" });
  const client = createFakeClient();

  registry.handleClientMessage(client, {
    type: "hello",
    deviceId: "pixel-1",
    deviceName: "Pixel",
    pairingToken: "dev-token",
    capabilities: ["tap", "get_ui_tree"],
    screenSize: { width: 1080, height: 2400 },
    androidVersion: "14",
  });

  assert.equal(client.sent[0].type, "pair_confirm");
  const status = registry.getDeviceStatus("pixel-1");
  assert.equal(status.deviceId, "pixel-1");
  assert.equal(status.deviceName, "Pixel");
  assert.equal(status.connectionState, "online");
});

test("device registry invokes commands and resolves results", async () => {
  const registry = new DeviceRegistry({ pairingToken: "dev-token" });
  const client = createFakeClient();

  registry.handleClientMessage(client, {
    type: "hello",
    deviceId: "pixel-1",
    deviceName: "Pixel",
    pairingToken: "dev-token",
  });

  const pending = registry.invokeDeviceCommand("pixel-1", "get_ui_tree", {});
  const command = client.sent[1];
  assert.equal(command.type, "command");
  assert.equal(command.commandName, "get_ui_tree");

  registry.handleClientMessage(client, {
    type: "command_result",
    requestId: command.requestId,
    ok: true,
    result: { root: { text: "Hello" } },
  });

  const result = await pending;
  assert.deepEqual(result, { root: { text: "Hello" } });
});

test("device registry can defer and approve pending actions", async () => {
  const registry = new DeviceRegistry({ pairingToken: "dev-token" });
  const client = createFakeClient();

  registry.handleClientMessage(client, {
    type: "hello",
    deviceId: "pixel-1",
    pairingToken: "dev-token",
  });

  const pending = registry.createPendingAction({
    deviceId: "pixel-1",
    commandName: "launch_app",
    args: { packageName: "com.example" },
    reason: "sensitive",
  });

  const approvalPromise = registry.confirmPendingAction(pending.actionId, true);
  const command = client.sent[1];
  assert.equal(command.commandName, "launch_app");
  assert.equal(command.args.confirm, true);

  registry.handleClientMessage(client, {
    type: "command_result",
    requestId: command.requestId,
    ok: true,
    result: { launched: true },
  });

  const result = await approvalPromise;
  assert.equal(result.status, "executed");
});
