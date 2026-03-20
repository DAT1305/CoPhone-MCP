import test from "node:test";
import assert from "node:assert/strict";

import { requiresConfirmation, sanitizeArgs } from "../src/guardrails.mjs";

test("guardrails require confirmation for deeplinks", () => {
  const result = requiresConfirmation("open_deeplink", { url: "https://example.com" });
  assert.equal(result.required, true);
});

test("guardrails require confirmation for risky selector taps", () => {
  const result = requiresConfirmation("tap_element", {
    selector: {
      text: "Delete account",
    },
  });
  assert.equal(result.required, true);
});

test("guardrails redact text before audit logging", () => {
  const result = sanitizeArgs("type_text", { text: "123456", fieldHint: "otp" });
  assert.deepEqual(result, { text: "[redacted:6]", fieldHint: "otp" });
});
