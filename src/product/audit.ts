import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CapabilityEvent } from "./contracts.js";
import type { CapabilityEventSink } from "./coordinator.js";
import { redactValue } from "./redaction.js";

/** Local append-only reference journal. Production requires durable remote integrity controls. */
export class FileCapabilityEventJournal implements CapabilityEventSink {
  constructor(private readonly rootDirectory: string) {
    fs.mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  }

  record(event: CapabilityEvent): void {
    const sanitized = redactValue(event) as CapabilityEvent;
    fs.appendFileSync(this.filename(event.tenantId), `${JSON.stringify(sanitized)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  read(tenantId: string): CapabilityEvent[] {
    const filename = this.filename(tenantId);
    if (!fs.existsSync(filename)) return [];
    return fs
      .readFileSync(filename, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CapabilityEvent);
  }

  private filename(tenantId: string): string {
    const digest = createHash("sha256").update(tenantId).digest("hex");
    return path.join(this.rootDirectory, `${digest}.jsonl`);
  }
}
