import test from "node:test";
import assert from "node:assert/strict";

import { handleRpcRequest } from "../src/mcp-server.mjs";

function createContext() {
  const commands = [];
  const registry = {
    listDevices() {
      return [{ deviceId: "pixel-1", connectionState: "online" }];
    },
    getDeviceStatus(deviceId) {
      return { deviceId, connectionState: "online" };
    },
    createPendingAction(payload) {
      return { actionId: "pending-1", ...payload, status: "pending" };
    },
    async confirmPendingAction(actionId, approved) {
      return { actionId, status: approved ? "executed" : "cancelled" };
    },
    async invokeDeviceCommand(deviceId, commandName, args) {
      commands.push({ deviceId, commandName, args });
      return { ok: true };
    },
  };

  return {
    registry,
    commands,
    auditLog: { write() {} },
  };
}

test("initialize returns tool capability", async () => {
  const result = await handleRpcRequest({ method: "initialize" }, createContext());
  assert.equal(result.capabilities.tools.listChanged, false);
});

test("list_devices returns device list", async () => {
  const result = await handleRpcRequest({ method: "tools/call", params: { name: "list_devices", arguments: {} } }, createContext());
  assert.equal(result.structuredContent.devices.length, 1);
});

test("launch_app is deferred pending confirmation", async () => {
  const context = createContext();
  const result = await handleRpcRequest({
    method: "tools/call",
    params: { name: "launch_app", arguments: { device_id: "pixel-1", package_name: "com.bank.app" } },
  }, context);

  assert.equal(result.structuredContent.pending_action.actionId, "pending-1");
  assert.equal(context.commands.length, 0);
});

test("safe read command is forwarded immediately", async () => {
  const context = createContext();
  const result = await handleRpcRequest({
    method: "tools/call",
    params: { name: "get_ui_tree", arguments: { device_id: "pixel-1" } },
  }, context);

  assert.equal(context.commands[0].commandName, "get_ui_tree");
  assert.deepEqual(result.structuredContent.result, { ok: true });
});
