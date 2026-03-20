import { SAFE_TOOLS, SENSITIVE_TOOLS, requiresConfirmation, sanitizeArgs } from "./guardrails.mjs";

function ok(result) {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
}

function toolError(message, data) {
  const error = new Error(message);
  error.data = data;
  return error;
}

function schema(type, properties, required = []) {
  return { type, properties, required, additionalProperties: false };
}

export function createToolDefinitions() {
  return [
    { name: "list_devices", description: "List paired Android devices currently known to the bridge.", inputSchema: schema("object", {}) },
    { name: "connect_device", description: "Validate that a device is online and return its status.", inputSchema: schema("object", { device_id: { type: "string" } }, ["device_id"]) },
    { name: "get_device_status", description: "Return online state and metadata for a device.", inputSchema: schema("object", { device_id: { type: "string" } }, ["device_id"]) },
    { name: "capture_screen", description: "Request a fresh screenshot from the phone bridge. Use only when accessibility text is insufficient.", inputSchema: schema("object", { device_id: { type: "string" }, quality: { type: "number" } }, ["device_id"]) },
    { name: "get_accessibility_snapshot", description: "Return a compact semantic snapshot of the visible screen for agent reasoning.", inputSchema: schema("object", { device_id: { type: "string" }, max_nodes: { type: "number" } }, ["device_id"]) },
    { name: "get_actionable_elements", description: "Return only visible actionable elements with compact labels and coordinates for low-context planning.", inputSchema: schema("object", { device_id: { type: "string" }, max_elements: { type: "number" } }, ["device_id"]) },
    { name: "get_visible_text", description: "Return flattened visible text and labels extracted from accessibility nodes.", inputSchema: schema("object", { device_id: { type: "string" } }, ["device_id"]) },
    { name: "get_ui_tree", description: "Fetch the current accessibility UI tree.", inputSchema: schema("object", { device_id: { type: "string" } }, ["device_id"]) },
    { name: "wait_for_actionable_element", description: "Wait until an actionable element matching the selector appears and return its compact summary.", inputSchema: schema("object", { device_id: { type: "string" }, selector: { type: "object" }, timeout_ms: { type: "number" } }, ["device_id", "selector"]) },
    { name: "wait_for_ui", description: "Wait until a selector appears or timeout elapses.", inputSchema: schema("object", { device_id: { type: "string" }, selector: { type: "object" }, timeout_ms: { type: "number" } }, ["device_id", "selector"]) },
    { name: "find_element", description: "Find a single element in the current UI tree.", inputSchema: schema("object", { device_id: { type: "string" }, selector: { type: "object" } }, ["device_id", "selector"]) },
    { name: "tap", description: "Tap at absolute screen coordinates.", inputSchema: schema("object", { device_id: { type: "string" }, x: { type: "number" }, y: { type: "number" }, confirm: { type: "boolean" }, targetHint: { type: "string" } }, ["device_id", "x", "y"]) },
    { name: "swipe", description: "Perform a swipe gesture between two points.", inputSchema: schema("object", { device_id: { type: "string" }, x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" }, duration_ms: { type: "number" }, confirm: { type: "boolean" }, targetHint: { type: "string" } }, ["device_id", "x1", "y1", "x2", "y2"]) },
    { name: "type_text", description: "Type text into the focused or target field.", inputSchema: schema("object", { device_id: { type: "string" }, text: { type: "string" }, fieldHint: { type: "string" }, confirm: { type: "boolean" } }, ["device_id", "text"]) },
    { name: "type_into_actionable_element", description: "Type text into an actionable element returned by get_actionable_elements using its element_ref.", inputSchema: schema("object", { device_id: { type: "string" }, element_ref: { type: "string" }, text: { type: "string" }, field_hint: { type: "string" }, element_label: { type: "string" }, confirm: { type: "boolean" } }, ["device_id", "element_ref", "text"]) },
    { name: "press_key", description: "Send a global Android key action like back or home.", inputSchema: schema("object", { device_id: { type: "string" }, key: { type: "string" }, confirm: { type: "boolean" } }, ["device_id", "key"]) },
    { name: "perform_actionable_element", description: "Perform an action on an element returned by get_actionable_elements using its element_ref.", inputSchema: schema("object", { device_id: { type: "string" }, element_ref: { type: "string" }, action: { type: "string" }, element_label: { type: "string" }, confirm: { type: "boolean" } }, ["device_id", "element_ref"]) },
    { name: "launch_app", description: "Launch an installed Android package.", inputSchema: schema("object", { device_id: { type: "string" }, package_name: { type: "string" }, confirm: { type: "boolean" } }, ["device_id", "package_name"]) },
    { name: "open_deeplink", description: "Open a deeplink URL on the phone.", inputSchema: schema("object", { device_id: { type: "string" }, url: { type: "string" }, confirm: { type: "boolean" } }, ["device_id", "url"]) },
    { name: "tap_element", description: "Find an element by selector and tap its center.", inputSchema: schema("object", { device_id: { type: "string" }, selector: { type: "object" }, confirm: { type: "boolean" } }, ["device_id", "selector"]) },
    { name: "get_notifications", description: "Fetch the currently visible notification entries.", inputSchema: schema("object", { device_id: { type: "string" } }, ["device_id"]) },
    { name: "confirm_pending_action", description: "Approve or reject a previously deferred sensitive action.", inputSchema: schema("object", { action_id: { type: "string" }, approved: { type: "boolean" } }, ["action_id", "approved"]) },
  ];
}

function toDeviceArgs(toolName, args) {
  const common = { ...args };
  delete common.device_id;

  if (toolName === "launch_app") {
    common.packageName = common.package_name;
    delete common.package_name;
  }

  return common;
}

export async function handleToolCall(name, args, { registry, auditLog }) {
  if (name === "list_devices") {
    return ok({ devices: registry.listDevices() });
  }

  if (name === "connect_device" || name === "get_device_status") {
    return ok({ device: registry.getDeviceStatus(args.device_id) });
  }

  if (name === "confirm_pending_action") {
    return ok(await registry.confirmPendingAction(args.action_id, Boolean(args.approved)));
  }

  const toolName = name;
  if (!SAFE_TOOLS.has(toolName) && !SENSITIVE_TOOLS.has(toolName)) {
    throw toolError(`Unknown tool: ${name}`);
  }

  const deviceId = args.device_id;
  if (!deviceId) {
    throw toolError("device_id is required");
  }

  const bridgeArgs = toDeviceArgs(toolName, args);
  const confirmation = requiresConfirmation(toolName, bridgeArgs);
  if (confirmation.required) {
    const sanitizedArgs = sanitizeArgs(toolName, bridgeArgs);
    const pending = registry.createPendingAction({
      deviceId,
      commandName: toolName,
      args: bridgeArgs,
      publicArgs: sanitizedArgs,
      auditArgs: sanitizedArgs,
      reason: confirmation.reason,
    });
    auditLog?.write({
      event: "command_deferred",
      deviceId,
      commandName: toolName,
      args: sanitizedArgs,
      reason: confirmation.reason,
      actionId: pending.actionId,
    });
    return ok({ pending_action: pending });
  }

  const result = await registry.invokeDeviceCommand(deviceId, toolName, bridgeArgs, args.timeout_ms || 15_000);
  return ok({ result });
}

export async function handleRpcRequest(request, context) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "cophone-mcp", version: "0.1.0" },
        capabilities: { tools: { listChanged: false } },
      };
    case "notifications/initialized":
      return null;
    case "tools/list":
      return { tools: createToolDefinitions() };
    case "tools/call":
      return handleToolCall(request.params?.name, request.params?.arguments || {}, context);
    default:
      throw toolError(`Method not found: ${request.method}`, { code: -32601 });
  }
}
