import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { DeviceRegistry } from "../src/device-registry.mjs";
import { requiresConfirmation, sanitizeArgs } from "../src/guardrails.mjs";
import { handleRpcRequest } from "../src/mcp-server.mjs";
import { StdioJsonRpcServer } from "../src/stdio-jsonrpc.mjs";
import { createWebSocketBridgeServer } from "../src/ws-bridge-server.mjs";

function createFakeClient() {
  return {
    sent: [],
    sendJson(message) {
      this.sent.push(message);
    },
    close() {},
  };
}

async function run(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

function createMcpContext() {
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

  return { registry, commands, auditLog: { write() {} } };
}

await run("device registry pairs a device", async () => {
  const registry = new DeviceRegistry({ pairingToken: "dev-token" });
  const client = createFakeClient();
  registry.handleClientMessage(client, {
    type: "hello",
    deviceId: "pixel-1",
    deviceName: "Pixel",
    pairingToken: "dev-token",
  });
  assert.equal(client.sent[0].type, "pair_confirm");
  assert.equal(registry.getDeviceStatus("pixel-1").connectionState, "online");
});

await run("device registry command roundtrip", async () => {
  const registry = new DeviceRegistry({ pairingToken: "dev-token" });
  const client = createFakeClient();
  registry.handleClientMessage(client, {
    type: "hello",
    deviceId: "pixel-1",
    pairingToken: "dev-token",
  });

  const pending = registry.invokeDeviceCommand("pixel-1", "get_ui_tree", {});
  const command = client.sent[1];
  registry.handleClientMessage(client, {
    type: "command_result",
    requestId: command.requestId,
    ok: true,
    result: { root: true },
  });
  assert.deepEqual(await pending, { root: true });
});

await run("guardrails catch risky actions", async () => {
  assert.equal(requiresConfirmation("open_deeplink", { url: "https://example.com" }).required, true);
  assert.equal(requiresConfirmation("tap_element", { selector: { text: "Delete account" } }).required, true);
  assert.equal(requiresConfirmation("perform_actionable_element", { element_label: "Delete account" }).required, true);
  assert.equal(
    requiresConfirmation("type_into_actionable_element", { text: "123456", field_hint: "otp field" }).required,
    true,
  );
  assert.deepEqual(sanitizeArgs("type_text", { text: "123456", fieldHint: "otp" }), {
    text: "[redacted:6]",
    fieldHint: "otp",
  });
  assert.deepEqual(sanitizeArgs("type_into_actionable_element", { text: "123456", field_hint: "otp" }), {
    text: "[redacted:6]",
    field_hint: "otp",
  });
});

await run("mcp routes safe reads and defers launches", async () => {
  const context = createMcpContext();
  const init = await handleRpcRequest({ method: "initialize" }, context);
  assert.equal(init.capabilities.tools.listChanged, false);

  const list = await handleRpcRequest({ method: "tools/call", params: { name: "list_devices", arguments: {} } }, context);
  assert.equal(list.structuredContent.devices.length, 1);

  const launch = await handleRpcRequest({
    method: "tools/call",
    params: { name: "launch_app", arguments: { device_id: "pixel-1", package_name: "com.bank.app" } },
  }, context);
  assert.equal(launch.structuredContent.pending_action.actionId, "pending-1");

  const tree = await handleRpcRequest({
    method: "tools/call",
    params: { name: "get_ui_tree", arguments: { device_id: "pixel-1" } },
  }, context);
  assert.equal(context.commands[0].commandName, "get_ui_tree");
  assert.deepEqual(tree.structuredContent.result, { ok: true });

  const visibleText = await handleRpcRequest({
    method: "tools/call",
    params: { name: "get_visible_text", arguments: { device_id: "pixel-1" } },
  }, context);
  assert.equal(context.commands[1].commandName, "get_visible_text");
  assert.deepEqual(visibleText.structuredContent.result, { ok: true });

  const snapshot = await handleRpcRequest({
    method: "tools/call",
    params: { name: "get_accessibility_snapshot", arguments: { device_id: "pixel-1", max_nodes: 80 } },
  }, context);
  assert.equal(context.commands[2].commandName, "get_accessibility_snapshot");
  assert.deepEqual(snapshot.structuredContent.result, { ok: true });

  const actionable = await handleRpcRequest({
    method: "tools/call",
    params: { name: "get_actionable_elements", arguments: { device_id: "pixel-1", max_elements: 20 } },
  }, context);
  assert.equal(context.commands[3].commandName, "get_actionable_elements");
  assert.deepEqual(actionable.structuredContent.result, { ok: true });

  const waitActionable = await handleRpcRequest({
    method: "tools/call",
    params: {
      name: "wait_for_actionable_element",
      arguments: { device_id: "pixel-1", selector: { label: "Login", clickable: true }, timeout_ms: 4000 },
    },
  }, context);
  assert.equal(context.commands[4].commandName, "wait_for_actionable_element");
  assert.deepEqual(waitActionable.structuredContent.result, { ok: true });

  const perform = await handleRpcRequest({
    method: "tools/call",
    params: {
      name: "perform_actionable_element",
      arguments: { device_id: "pixel-1", element_ref: "0.1.2", action: "click", element_label: "Open menu" },
    },
  }, context);
  assert.equal(context.commands[5].commandName, "perform_actionable_element");
  assert.deepEqual(perform.structuredContent.result, { ok: true });

  const typeInto = await handleRpcRequest({
    method: "tools/call",
    params: {
      name: "type_into_actionable_element",
      arguments: { device_id: "pixel-1", element_ref: "0.2.0", text: "user@example.com", element_label: "Email" },
    },
  }, context);
  assert.equal(context.commands[6].commandName, "type_into_actionable_element");
  assert.deepEqual(typeInto.structuredContent.result, { ok: true });

  const riskyPerform = await handleRpcRequest({
    method: "tools/call",
    params: {
      name: "perform_actionable_element",
      arguments: { device_id: "pixel-1", element_ref: "0.3.4", action: "click", element_label: "Delete account" },
    },
  }, context);
  assert.equal(riskyPerform.structuredContent.pending_action.actionId, "pending-1");

  const riskyType = await handleRpcRequest({
    method: "tools/call",
    params: {
      name: "type_into_actionable_element",
      arguments: { device_id: "pixel-1", element_ref: "0.2.1", text: "123456", field_hint: "OTP code" },
    },
  }, context);
  assert.equal(riskyType.structuredContent.pending_action.actionId, "pending-1");
});

await run("websocket bridge relays device commands", async () => {
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

    assert.deepEqual(await pending, { root: true });
    ws.close();
  } finally {
    await bridge.close();
  }
});

await run("stdio MCP parser accepts LF-only framing", async () => {
  const requests = [];
  const input = new PassThrough();
  const chunks = [];
  const output = new PassThrough();
  output.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });

  const server = new StdioJsonRpcServer({
    input,
    output,
    onRequest(request) {
      requests.push(request);
      return { ok: true };
    },
  });

  server.start();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  input.write(Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\n\n${body}`, "utf8"));
  input.end();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "initialize");
  const response = Buffer.concat(chunks).toString("utf8");
  assert.match(response, /Content-Length:/);
  assert.match(response, /"ok":true/);
});

await run("stdio MCP parser accepts newline-delimited JSON", async () => {
  const requests = [];
  const input = new PassThrough();
  const chunks = [];
  const output = new PassThrough();
  output.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });

  const server = new StdioJsonRpcServer({
    input,
    output,
    onRequest(request) {
      requests.push(request);
      return { ok: true };
    },
  });

  server.start();
  input.write(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`, "utf8"));
  input.end();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "initialize");
  const response = Buffer.concat(chunks).toString("utf8");
  assert.match(response, /^\{"jsonrpc":"2\.0","id":1,"result":\{"ok":true\}\}\n$/);
});
