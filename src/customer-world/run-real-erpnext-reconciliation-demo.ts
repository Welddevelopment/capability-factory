import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Starts one clean, recordable local demo take. Every process receives fresh
 * customer-local state and private credentials so a previous take cannot turn
 * the first acquisition into retained reuse or leak into the next take.
 */
process.env.CF_PILOT_DATA ??= mkdtempSync(join(tmpdir(), "cf-erpnext-reconciliation-demo-"));
process.env.CF_SIDECAR_TOKEN ??= randomBytes(32).toString("hex");
process.env.CF_CONTINUATION_AUTHORITY_SECRET ??= randomBytes(32).toString("hex");
process.env.CF_ERPNEXT_PILOT_RESET = "1";
process.env.CF_DEMO_LOST_RESPONSE = "1";

if (!process.env.CF_ERPNEXT_BASE_URL && process.env.CF_ERPNEXT_PORT) {
  process.env.CF_ERPNEXT_BASE_URL = `http://127.0.0.1:${process.env.CF_ERPNEXT_PORT}`;
}

await import("./run-real-erpnext-pilot-stack.js");
