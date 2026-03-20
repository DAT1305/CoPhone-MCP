import { randomUUID } from "node:crypto";

function makeError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error.data = data;
  return error;
}

export class DeviceRegistry {
  constructor({ pairingToken, logger = console, auditLog, now = () => Date.now() }) {
    this.pairingToken = pairingToken;
    this.logger = logger;
    this.auditLog = auditLog;
    this.now = now;
    this.devices = new Map();
    this.pendingActions = new Map();
  }

  handleClientMessage(client, message) {
    if (!message || typeof message !== "object") {
      return;
    }

    switch (message.type) {
      case "hello":
        this.#handleHello(client, message);
        return;
      case "device_state":
        this.#handleDeviceState(client, message);
        return;
      case "ack":
        return;
      case "command_result":
        this.#handleCommandResult(client, message);
        return;
      default:
        this.logger.warn?.(`Ignoring unknown device message type: ${message.type}`);
    }
  }

  disconnectClient(client) {
    const deviceId = client.deviceId;
    if (!deviceId) {
      return;
    }
    const entry = this.devices.get(deviceId);
    if (!entry || entry.connection !== client) {
      return;
    }
    entry.connection = null;
    entry.connectionState = "offline";
    entry.lastSeen = this.now();
    for (const [, request] of entry.inflight) {
      request.reject(makeError("DEVICE_OFFLINE", "Device disconnected before responding."));
    }
    entry.inflight.clear();
  }

  listDevices() {
    return [...this.devices.values()].map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      capabilities: device.capabilities,
      connectionState: device.connectionState,
      screenSize: device.screenSize,
      androidVersion: device.androidVersion,
      currentPackage: device.currentPackage || null,
      lastSeen: device.lastSeen,
    }));
  }

  getDeviceStatus(deviceId) {
    const entry = this.#requireDevice(deviceId);
    return {
      deviceId: entry.deviceId,
      deviceName: entry.deviceName,
      connectionState: entry.connectionState,
      capabilities: entry.capabilities,
      screenSize: entry.screenSize,
      androidVersion: entry.androidVersion,
      currentPackage: entry.currentPackage || null,
      lastSeen: entry.lastSeen,
    };
  }

  async invokeDeviceCommand(deviceId, commandName, args = {}, timeoutMs = 15_000) {
    const entry = this.#requireOnlineDevice(deviceId);
    const requestId = randomUUID();
    const payload = {
      type: "command",
      requestId,
      deviceId,
      commandName,
      args,
      timeoutMs,
    };

    this.auditLog?.write({
      event: "command_dispatched",
      deviceId,
      commandName,
      args,
      requestId,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.inflight.delete(requestId);
        reject(makeError("DEVICE_TIMEOUT", `Device did not respond to ${commandName} in time.`));
      }, timeoutMs);

      entry.inflight.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      try {
        entry.connection.sendJson(payload);
      } catch (error) {
        clearTimeout(timer);
        entry.inflight.delete(requestId);
        reject(makeError("DEVICE_SEND_FAILED", "Failed to send command to device.", { cause: error.message }));
      }
    });
  }

  createPendingAction({ deviceId, commandName, args, publicArgs = args, auditArgs = publicArgs, reason }) {
    this.#requireOnlineDevice(deviceId);
    const actionId = randomUUID();
    const pending = {
      actionId,
      deviceId,
      commandName,
      args: publicArgs,
      rawArgs: args,
      reason,
      createdAt: this.now(),
      status: "pending",
    };
    this.pendingActions.set(actionId, pending);
    this.auditLog?.write({
      event: "pending_action_created",
      actionId,
      deviceId,
      commandName,
      args: auditArgs,
      reason,
    });
    return pending;
  }

  async confirmPendingAction(actionId, approved) {
    const pending = this.pendingActions.get(actionId);
    if (!pending) {
      throw makeError("UNKNOWN_PENDING_ACTION", `Unknown pending action: ${actionId}`);
    }

    this.pendingActions.delete(actionId);
    this.auditLog?.write({
      event: approved ? "pending_action_approved" : "pending_action_rejected",
      actionId,
      deviceId: pending.deviceId,
      commandName: pending.commandName,
    });

    if (!approved) {
      return {
        actionId,
        status: "cancelled",
      };
    }

    const result = await this.invokeDeviceCommand(
      pending.deviceId,
      pending.commandName,
      { ...pending.rawArgs, confirm: true },
      15_000,
    );

    return {
      actionId,
      status: "executed",
      result,
    };
  }

  #handleHello(client, message) {
    if (message.pairingToken !== this.pairingToken) {
      client.sendJson?.({
        type: "error",
        code: "PAIRING_FAILED",
        message: "Pairing token is invalid.",
      });
      client.close?.(4001, "pairing failed");
      return;
    }

    const deviceId = message.deviceId || randomUUID();
    client.deviceId = deviceId;
    const entry = {
      deviceId,
      deviceName: message.deviceName || "Android Device",
      capabilities: Array.isArray(message.capabilities) ? message.capabilities : [],
      connectionState: "online",
      screenSize: message.screenSize || null,
      androidVersion: message.androidVersion || null,
      currentPackage: message.currentPackage || null,
      lastSeen: this.now(),
      connection: client,
      inflight: new Map(),
    };

    this.devices.set(deviceId, entry);
    client.sendJson?.({
      type: "pair_confirm",
      deviceId,
      accepted: true,
      serverTime: this.now(),
    });
  }

  #handleDeviceState(client, message) {
    const deviceId = client.deviceId;
    if (!deviceId) {
      return;
    }
    const entry = this.devices.get(deviceId);
    if (!entry) {
      return;
    }
    entry.currentPackage = message.currentPackage || entry.currentPackage;
    entry.lastSeen = this.now();
    entry.connectionState = "online";
  }

  #handleCommandResult(client, message) {
    const deviceId = client.deviceId;
    if (!deviceId) {
      return;
    }
    const entry = this.devices.get(deviceId);
    if (!entry) {
      return;
    }
    entry.lastSeen = this.now();
    const request = entry.inflight.get(message.requestId);
    if (!request) {
      return;
    }
    entry.inflight.delete(message.requestId);
    if (message.ok === false) {
      request.reject(makeError("DEVICE_COMMAND_FAILED", message.error || "Device command failed."));
      return;
    }
    request.resolve(message.result);
  }

  #requireDevice(deviceId) {
    const entry = this.devices.get(deviceId);
    if (!entry) {
      throw makeError("UNKNOWN_DEVICE", `Unknown device: ${deviceId}`);
    }
    return entry;
  }

  #requireOnlineDevice(deviceId) {
    const entry = this.#requireDevice(deviceId);
    if (!entry.connection || entry.connectionState !== "online") {
      throw makeError("DEVICE_OFFLINE", `Device is offline: ${deviceId}`);
    }
    return entry;
  }
}
