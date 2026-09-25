import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import https from "node:https";

interface Directive {
  directive_ref: string;
  lot_code: string;
  hold_quantity?: number;
  reason_confirmed?: boolean;
  status: "quarantined" | "partial";
  version: number;
  updated_at: string;
}

interface World {
  schemaVersion: "1.0";
  sequence: number;
  writes: number;
  precommitDrops: number;
  postcommitDrops: number;
  directives: Record<string, Directive>;
  faultByDirective: Record<string, "precommit-drop" | "postcommit-drop">;
}

const [rawKeyPath, rawCertificatePath, rawStatePath] = process.argv.slice(2);
const actionToken = process.env.CF058_ACTION_TOKEN;
if (!rawKeyPath || !rawCertificatePath || !rawStatePath || !actionToken) throw new Error("CF-058 action provider launch material is incomplete.");
const keyPath = rawKeyPath, certificatePath = rawCertificatePath, statePath = rawStatePath;

const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
    : JSON.stringify(value);
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

function assertWorld(world: World): void {
  if (world.schemaVersion !== "1.0" || !Number.isInteger(world.sequence) || world.sequence < 0 || !Number.isInteger(world.writes) || world.writes < 0 || !Number.isInteger(world.precommitDrops) || world.precommitDrops < 0 || !Number.isInteger(world.postcommitDrops) || world.postcommitDrops < 0 || !world.directives || Array.isArray(world.directives) || !world.faultByDirective || Array.isArray(world.faultByDirective)) throw new Error("CF-058 fictional world is malformed.");
  if (world.writes !== Object.values(world.directives).filter((item) => item.status === "quarantined").length) throw new Error("CF-058 fictional world write count is inconsistent.");
}

function readWorld(): World {
  const envelope = JSON.parse(readFileSync(statePath, "utf8")) as { body: World; digest: string };
  if (envelope.digest !== digest(envelope.body)) throw new Error("CF-058 fictional world integrity failed.");
  assertWorld(envelope.body);
  return envelope.body;
}

function saveWorld(world: World): void {
  assertWorld(world);
  const next = `${statePath}.${process.pid}.next`;
  const descriptor = openSync(next, "wx", 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify({ body: world, digest: digest(world) })}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(next, statePath);
  const directory = openSync(dirname(statePath), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function respond(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", bytes.byteLength);
  response.end(bytes);
}

const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath), minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, (request, response) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  request.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes <= 65_536) chunks.push(chunk); });
  request.on("end", () => {
    try {
      if (request.headers.authorization !== `Bearer ${actionToken}`) return respond(response, 401, { error: "unauthorized" });
      if (request.method !== "PUT") return respond(response, 405, { error: "method-not-allowed" });
      const match = /^\/v2\/lots\/([^/]+)\/quarantine-directives\/([^/]+)$/.exec(new URL(request.url ?? "/", "https://localhost").pathname);
      if (!match) return respond(response, 404, { error: "not-found" });
      if (bytes > 65_536) return respond(response, 413, { error: "request-too-large" });
      const lotCode = decodeURIComponent(match[1]!), directiveRef = decodeURIComponent(match[2]!);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (Object.keys(body).sort().join(",") !== "hold_quantity,reason_confirmed" || !Number.isFinite(body.hold_quantity) || Number(body.hold_quantity) <= 0 || Number(body.hold_quantity) > 500 || body.reason_confirmed !== true) return respond(response, 422, { error: "invalid-directive" });
      const world = readWorld(), existing = world.directives[directiveRef];
      if (existing && (existing.lot_code !== lotCode || existing.hold_quantity !== body.hold_quantity || existing.reason_confirmed !== true)) return respond(response, 409, { error: "stable-identity-conflict" });
      if (existing) return respond(response, 200, { directive_ref: directiveRef, status: existing.status, version: existing.version });
      const fault = world.faultByDirective[directiveRef];
      if (fault === "precommit-drop") {
        delete world.faultByDirective[directiveRef]; world.precommitDrops += 1; saveWorld(world); request.socket.destroy(); return;
      }
      world.sequence += 1;
      world.writes += 1;
      world.directives[directiveRef] = { directive_ref: directiveRef, lot_code: lotCode, hold_quantity: Number(body.hold_quantity), reason_confirmed: true, status: "quarantined", version: world.sequence, updated_at: new Date().toISOString() };
      if (fault === "postcommit-drop") { delete world.faultByDirective[directiveRef]; world.postcommitDrops += 1; saveWorld(world); request.socket.destroy(); return; }
      saveWorld(world);
      respond(response, 201, { directive_ref: directiveRef, status: "quarantined", version: world.sequence });
    } catch (error) { respond(response, 500, { error: error instanceof Error ? error.message : String(error) }); }
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CF-058 action provider did not bind TCP.");
  process.stdout.write(`${JSON.stringify({ serverUrl: `https://localhost:${address.port}`, pid: process.pid, plane: "action" })}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
