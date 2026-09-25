import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactEncryptedModelContent } from "../src/model-gateway.js";

const root = path.resolve("artifacts", "product-live");
if (!fs.existsSync(root)) process.exit(0);

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const filename = path.join(root, entry.name, "trace.jsonl");
  if (!fs.existsSync(filename)) continue;
  const before = fs.readFileSync(filename, "utf8");
  let redactions = 0;
  const lines = before.split(/\r?\n/).map((line) => {
    if (!line) return line;
    const event = JSON.parse(line) as Record<string, unknown>;
    const serialized = JSON.stringify(event);
    const matches = serialized.match(/"encrypted_content":/g)?.length ?? 0;
    redactions += matches;
    return JSON.stringify(redactEncryptedModelContent(event));
  });
  if (redactions === 0) continue;
  const after = lines.join("\n");
  const record = {
    schemaVersion: "1",
    reason: "Removed opaque encrypted model content from private trace; output_text and event metadata remain.",
    redactions,
    beforeSha256: createHash("sha256").update(before).digest("hex"),
    afterSha256: createHash("sha256").update(after).digest("hex"),
    sanitizedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filename, after, "utf8");
  fs.writeFileSync(path.join(root, entry.name, "trace-redaction.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}
