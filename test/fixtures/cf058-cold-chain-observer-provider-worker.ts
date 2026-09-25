import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";

interface Directive { directive_ref: string; lot_code: string; hold_quantity?: number; reason_confirmed?: boolean; status: "quarantined" | "partial"; version: number; updated_at: string }
interface World { schemaVersion: "1.0"; sequence: number; writes: number; precommitDrops: number; postcommitDrops: number; directives: Record<string, Directive>; faultByDirective: Record<string, string> }
const [rawKeyPath, rawCertificatePath, rawStatePath] = process.argv.slice(2);
const observerToken = process.env.CF058_OBSERVER_TOKEN;
if (!rawKeyPath || !rawCertificatePath || !rawStatePath || !observerToken) throw new Error("CF-058 observer provider launch material is incomplete.");
const keyPath = rawKeyPath, certificatePath = rawCertificatePath, statePath = rawStatePath;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
function world(): World { const envelope = JSON.parse(readFileSync(statePath, "utf8")) as { body: World; digest: string }; if (envelope.digest !== digest(envelope.body)) throw new Error("CF-058 observer rejected fictional world integrity."); return envelope.body; }
function respond(response: import("node:http").ServerResponse, status: number, body: unknown): void { const bytes = Buffer.from(JSON.stringify(body)); response.statusCode = status; response.setHeader("content-type", "application/json"); response.setHeader("content-length", bytes.byteLength); response.end(bytes); }
const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath), minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, (request, response) => {
  try {
    if (request.headers.authorization !== `Bearer ${observerToken}`) return respond(response, 401, { error: "unauthorized" });
    if (request.method !== "GET") return respond(response, 405, { error: "read-only-observer" });
    const url = new URL(request.url ?? "/", "https://localhost");
    if (url.pathname !== "/v2/compliance-audit/quarantine-directives") return respond(response, 404, { error: "not-found" });
    const directiveRef = url.searchParams.get("directive_ref"); if (!directiveRef) return respond(response, 422, { error: "missing-directive-ref" });
    const state = world(), item = state.directives[directiveRef], items = item ? [item] : [];
    respond(response, 200, { items, server_time: new Date().toISOString(), server_version: state.sequence, collateral_clean: true, duplicate_count: items.length });
  } catch (error) { respond(response, 500, { error: error instanceof Error ? error.message : String(error) }); }
});
server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") throw new Error("CF-058 observer provider did not bind TCP."); process.stdout.write(`${JSON.stringify({ serverUrl: `https://localhost:${address.port}`, pid: process.pid, plane: "observer" })}\n`); });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
