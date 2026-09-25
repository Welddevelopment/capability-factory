import fs from "node:fs";
import path from "node:path";

const secretKeyPattern = /authorization|api[-_]?key|secret|token/i;

function redact(value: unknown, secretValues: readonly string[]): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secretValues) {
      if (secret) result = result.replaceAll(secret, "[REDACTED]");
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secretValues));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretKeyPattern.test(key) ? "[REDACTED]" : redact(item, secretValues),
      ]),
    );
  }
  return value;
}

export interface RunEvent {
  sequence: number;
  timestamp: string;
  runId: string;
  type: string;
  data: unknown;
}

export class TraceWriter {
  private sequence = 0;
  readonly filename: string;

  constructor(
    private readonly runId: string,
    directory: string,
    private readonly secretValues: readonly string[] = [],
  ) {
    fs.mkdirSync(directory, { recursive: true });
    this.filename = path.join(directory, "trace.jsonl");
  }

  record(type: string, data: unknown): RunEvent {
    const event: RunEvent = {
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      runId: this.runId,
      type,
      data: redact(data, this.secretValues),
    };
    fs.appendFileSync(this.filename, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }
}

export function redactForReport(value: unknown, secretValues: readonly string[]): unknown {
  return redact(value, secretValues);
}
