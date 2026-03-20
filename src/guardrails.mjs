const RISKY_TEXT = /\b(send|pay|buy|delete|confirm|transfer|submit|checkout|place order|remove|wipe)\b/i;
const SECRET_HINT = /\b(password|otp|pin|secret|token|verification)\b/i;
const DIGIT_OTP = /^\d{4,8}$/;

export const SAFE_TOOLS = new Set([
  "list_devices",
  "connect_device",
  "get_device_status",
  "capture_screen",
  "get_accessibility_snapshot",
  "get_actionable_elements",
  "get_visible_text",
  "get_ui_tree",
  "wait_for_actionable_element",
  "wait_for_ui",
  "find_element",
  "get_notifications",
  "confirm_pending_action",
]);

export const SENSITIVE_TOOLS = new Set([
  "tap",
  "swipe",
  "type_text",
  "type_into_actionable_element",
  "press_key",
  "launch_app",
  "open_deeplink",
  "tap_element",
  "perform_actionable_element",
]);

function collectSelectorText(selector = {}) {
  return [
    selector.text,
    selector.content_description,
    selector.resource_id,
    selector.package_name,
    selector.class_name,
  ]
    .filter(Boolean)
    .join(" ");
}

export function requiresConfirmation(toolName, args = {}) {
  if (!SENSITIVE_TOOLS.has(toolName) || args.confirm === true) {
    return { required: false };
  }

  if (toolName === "launch_app") {
    return { required: true, reason: "Launching another app is treated as a sensitive action." };
  }

  if (toolName === "open_deeplink") {
    return { required: true, reason: "Opening deeplinks is treated as a sensitive action." };
  }

  if (toolName === "type_text") {
    const text = String(args.text || "");
    const hint = String(args.fieldHint || "");
    if (SECRET_HINT.test(hint) || DIGIT_OTP.test(text)) {
      return { required: true, reason: "Typing secrets, OTPs, or credentials requires confirmation." };
    }
  }

  if (toolName === "type_into_actionable_element") {
    const text = String(args.text || "");
    const hint = String(args.field_hint || args.fieldHint || args.element_label || "");
    if (SECRET_HINT.test(hint) || DIGIT_OTP.test(text)) {
      return { required: true, reason: "Typing secrets, OTPs, or credentials into an actionable element requires confirmation." };
    }
  }

  if (toolName === "tap_element") {
    const selectorText = collectSelectorText(args.selector);
    if (RISKY_TEXT.test(selectorText)) {
      return { required: true, reason: "The target element looks destructive or transactional." };
    }
  }

  if (toolName === "perform_actionable_element") {
    const label = String(args.element_label || args.label || args.targetHint || "");
    if (RISKY_TEXT.test(label)) {
      return { required: true, reason: "The target actionable element looks destructive or transactional." };
    }
  }

  if (toolName === "tap" || toolName === "swipe") {
    const hint = String(args.targetHint || "");
    if (RISKY_TEXT.test(hint)) {
      return { required: true, reason: "The hinted target looks destructive or transactional." };
    }
  }

  if (toolName === "press_key" && String(args.key || "").toLowerCase() === "power") {
    return { required: true, reason: "Power key actions require confirmation." };
  }

  return { required: false };
}

export function sanitizeArgs(toolName, args = {}) {
  if (toolName !== "type_text" && toolName !== "type_into_actionable_element") {
    return args;
  }

  const text = String(args.text || "");
  return {
    ...args,
    text: text ? `[redacted:${text.length}]` : "",
  };
}
