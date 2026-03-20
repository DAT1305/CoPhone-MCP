import { createHash } from "node:crypto";
import http from "node:http";

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function sha1(value) {
  return createHash("sha1").update(value).digest("base64");
}

function encodeFrame(opcode, payloadBuffer) {
  const len = payloadBuffer.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuffer]);
}

function decodeFrames(state, chunk, onFrame) {
  state.buffer = Buffer.concat([state.buffer, chunk]);

  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (!fin) {
      throw new Error("Fragmented WebSocket frames are not supported.");
    }

    if (length === 126) {
      if (state.buffer.length < 4) {
        return;
      }
      length = state.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (state.buffer.length < 10) {
        return;
      }
      length = Number(state.buffer.readBigUInt64BE(2));
      offset = 10;
    }

    const maskLength = masked ? 4 : 0;
    if (state.buffer.length < offset + maskLength + length) {
      return;
    }

    const mask = masked ? state.buffer.subarray(offset, offset + 4) : null;
    const payloadStart = offset + maskLength;
    const payloadEnd = payloadStart + length;
    const payload = Buffer.from(state.buffer.subarray(payloadStart, payloadEnd));

    if (masked && mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    state.buffer = state.buffer.subarray(payloadEnd);
    onFrame(opcode, payload);
  }
}

function createClient(socket) {
  const state = { buffer: Buffer.alloc(0) };
  const listeners = {
    message: new Set(),
    close: new Set(),
  };

  const client = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sendJson(message) {
      const payload = Buffer.from(JSON.stringify(message), "utf8");
      socket.write(encodeFrame(0x1, payload));
    },
    close(code = 1000, reason = "") {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      socket.write(encodeFrame(0x8, payload));
      socket.end();
    },
    on(event, handler) {
      listeners[event].add(handler);
    },
  };

  socket.on("data", (chunk) => {
    decodeFrames(state, chunk, (opcode, payload) => {
      if (opcode === 0x1) {
        const message = JSON.parse(payload.toString("utf8"));
        for (const handler of listeners.message) {
          handler(message);
        }
      } else if (opcode === 0x8) {
        socket.end();
      } else if (opcode === 0x9) {
        socket.write(encodeFrame(0xA, payload));
      }
    });
  });

  socket.on("close", () => {
    for (const handler of listeners.close) {
      handler();
    }
  });

  socket.on("error", () => {
    socket.destroy();
  });

  return client;
}

export function createWebSocketBridgeServer({ host, port, logger = console, onClient }) {
  const clients = new Set();
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404).end();
  });

  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = sha1(`${key}${WS_MAGIC}`);
    const responseHeaders = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ];
    socket.write(responseHeaders.join("\r\n"));
    const client = createClient(socket);
    clients.add(client);
    client.on("close", () => {
      clients.delete(client);
    });
    onClient(client, request);
  });

  return {
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          logger.error?.(`Bridge server listening on ws://${host}:${port}`);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        for (const client of clients) {
          try {
            client.close();
          } catch {
            // Ignore close races while draining the client set.
          }
        }
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    server,
  };
}
