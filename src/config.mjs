export function readConfig(env = process.env) {
  return {
    bridgeHost: env.BRIDGE_HOST || "0.0.0.0",
    bridgePort: Number(env.BRIDGE_PORT || 8787),
    pairingToken: env.PAIRING_TOKEN || "dev-token",
    auditLogPath: env.AUDIT_LOG_PATH || "runtime/audit.log",
  };
}
