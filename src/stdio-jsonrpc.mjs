import fs from "node:fs";
import path from "node:path";

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}

function encodeLineMessage(message) {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

function parseHeaders(headerText) {
  const headers = new Map();
  for (const line of headerText.split(/\r?\n/)) {
    if (!line.includes(":")) {
      continue;
    }
    const [name, ...rest] = line.split(":");
    headers.set(name.toLowerCase(), rest.join(":").trim());
  }
  return headers;
}

function findHeaderSeparator(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");

  if (crlf === -1) {
    return lf === -1 ? null : { index: lf, length: 2 };
  }

  if (lf === -1 || crlf < lf) {
    return { index: crlf, length: 4 };
  }

  return { index: lf, length: 2 };
}

function appendDebugLog(filePath, message) {
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

export class StdioJsonRpcServer {
  constructor({ input, output, logger = console, onRequest }) {
    this.input = input;
    this.output = output;
    this.logger = logger;
    this.onRequest = onRequest;
    this.buffer = Buffer.alloc(0);
    this.debugLogPath = process.env.MCP_DEBUG_LOG_PATH || "";
    this.transportMode = "content-length";
  }

  start() {
    appendDebugLog(this.debugLogPath, "stdio.start");
    this.input.on("data", (chunk) => {
      appendDebugLog(this.debugLogPath, `stdin.data bytes=${chunk.length}`);
      appendDebugLog(
        this.debugLogPath,
        `stdin.preview=${JSON.stringify(chunk.toString("utf8").slice(0, 300))}`,
      );
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#drain();
    });
  }

  send(message) {
    appendDebugLog(
      this.debugLogPath,
      `stdout.send method=${message?.method || ""} id=${message?.id ?? ""} hasResult=${Object.prototype.hasOwnProperty.call(message || {}, "result")}`,
    );
    const payload = this.transportMode === "newline"
      ? encodeLineMessage(message)
      : encodeMessage(message);
    this.output.write(payload);
  }

  async #dispatch(request) {
    appendDebugLog(this.debugLogPath, `dispatch method=${request?.method || ""} id=${request?.id ?? ""}`);
    if (!request || typeof request !== "object") {
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(request, "id")) {
      try {
        await this.onRequest(request);
      } catch (error) {
        this.logger.error?.(error);
      }
      return;
    }

    try {
      const result = await this.onRequest(request);
      if (result !== null) {
        this.send({ jsonrpc: "2.0", id: request.id, result });
      }
    } catch (error) {
      const code = error?.data?.code || -32000;
      this.send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code,
          message: error?.message || "Internal server error",
          data: error?.data,
        },
      });
    }
  }

  #drain() {
    while (true) {
      const separator = findHeaderSeparator(this.buffer);
      if (!separator) {
        const newline = this.buffer.indexOf("\n");
        if (newline === -1) {
          return;
        }

        const line = this.buffer.subarray(0, newline).toString("utf8").trim();
        if (!line) {
          this.buffer = this.buffer.subarray(newline + 1);
          continue;
        }

        if (!line.startsWith("{") && !line.startsWith("[")) {
          return;
        }

        this.transportMode = "newline";
        this.buffer = this.buffer.subarray(newline + 1);
        const request = JSON.parse(line);
        void this.#dispatch(request);
        continue;
      }

      this.transportMode = "content-length";
      const headerText = this.buffer.subarray(0, separator.index).toString("utf8");
      const headers = parseHeaders(headerText);
      const contentLength = Number(headers.get("content-length"));
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        throw new Error("Invalid Content-Length header.");
      }

      const bodyStart = separator.index + separator.length;
      const totalLength = bodyStart + contentLength;
      if (this.buffer.length < totalLength) {
        return;
      }

      const body = this.buffer.subarray(bodyStart, totalLength);
      this.buffer = this.buffer.subarray(totalLength);
      const request = JSON.parse(body.toString("utf8"));
      void this.#dispatch(request);
    }
  }
}
