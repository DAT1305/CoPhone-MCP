import fs from "node:fs";
import path from "node:path";

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export class AuditLog {
  constructor(filePath, now = () => new Date().toISOString()) {
    this.filePath = filePath;
    this.now = now;
  }

  write(entry) {
    ensureParentDir(this.filePath);
    const line = JSON.stringify({
      ts: this.now(),
      ...entry,
    });
    fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
  }
}
