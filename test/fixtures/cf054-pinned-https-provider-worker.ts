import { createServer } from "node:https";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface State {
  sequence: number;
  writes: number;
  records: Record<string, { order_ref: string; sku: string; quantity: number; status: "draft"; observed_at: string }>;
}

const [planeArgument, keyPathArgument, certificatePathArgument, statePathArgument] = process.argv.slice(2);
const tokenArgument = process.env.CF054_PROCESS_TOKEN;
const observerTokenArgument = process.env.CF054_OBSERVER_TOKEN;
if ((planeArgument !== "action" && planeArgument !== "observer" && planeArgument !== "combined") || !keyPathArgument || !certificatePathArgument || !statePathArgument || !tokenArgument || (planeArgument === "combined" && !observerTokenArgument)) throw new Error("CF-054 provider worker requires plane, TLS material, state and process-local token(s).");
const plane: "action" | "observer" | "combined" = planeArgument;
const keyPath = keyPathArgument, certificatePath = certificatePathArgument, statePath = statePathArgument, token = tokenArgument, observerToken = observerTokenArgument;

function readState(): State {
  return JSON.parse(readFileSync(statePath, "utf8")) as State;
}

function saveState(state: State): void {
  const next = join(dirname(statePath), `state.${process.pid}.next`);
  writeFileSync(next, JSON.stringify(state), { mode: 0o600 });
  renameSync(next, statePath);
}

function respond(response: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)), ...headers });
  response.end(encoded);
}

const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath) }, (request, response) => {
  const target = new URL(request.url ?? "/", "https://localhost");
  const expectedToken = plane === "combined" && target.pathname === "/v1/audit/orders" ? observerToken : token;
  if (request.headers.authorization !== `Bearer ${expectedToken}`) { respond(response, 401, { error: "unauthorized" }); return; }
  if (target.pathname === "/v1/redirect") { response.writeHead(307, { location: "/v1/orders" }); response.end(); return; }
  if (target.pathname === "/v1/oversized") { respond(response, 200, { payload: "x".repeat(32_768) }); return; }
  if (target.pathname === "/v1/slow") { setTimeout(() => respond(response, 200, { delayed: true }), 1_000); return; }
  if (target.pathname === "/v1/plain") { const body = "plain"; response.writeHead(200, { "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)) }); response.end(body); return; }

  if ((plane === "action" || plane === "combined") && request.method === "POST" && target.pathname === "/v1/orders") {
    const chunks: Buffer[] = []; let bytes = 0;
    request.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes <= 64 * 1024) chunks.push(Buffer.from(chunk)); });
    request.on("end", () => {
      try {
        if (bytes > 64 * 1024) throw new Error("body-bound");
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { order_ref?: unknown; sku?: unknown; quantity?: unknown };
        if (typeof input.order_ref !== "string" || typeof input.sku !== "string" || !Number.isInteger(input.quantity) || Number(input.quantity) < 1) throw new Error("invalid-input");
        const state = readState(), existing = state.records[input.order_ref];
        const candidate = { order_ref: input.order_ref, sku: input.sku, quantity: Number(input.quantity), status: "draft" as const, observed_at: new Date().toISOString() };
        if (existing && (existing.sku !== candidate.sku || existing.quantity !== candidate.quantity)) { respond(response, 409, { error: "identity-conflict" }); return; }
        if (!existing) { state.sequence += 1; state.writes += 1; state.records[input.order_ref] = candidate; saveState(state); }
        respond(response, existing ? 200 : 201, { accepted: true, sequence: state.sequence });
      } catch { respond(response, 400, { error: "invalid-request" }); }
    });
    return;
  }

  if ((plane === "observer" || plane === "combined") && request.method === "GET" && target.pathname === "/v1/audit/orders") {
    const reference = target.searchParams.get("order_ref"), state = readState(), record = reference ? state.records[reference] : undefined;
    respond(response, 200, { items: record ? [record] : [], server_time: record?.observed_at ?? new Date().toISOString(), collateral_clean: Object.keys(state.records).every((key) => key === reference) });
    return;
  }

  respond(response, 404, { error: "not-found" });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CF-054 provider worker did not bind a TCP port.");
  process.stdout.write(`${JSON.stringify({ plane, pid: process.pid, serverUrl: `https://localhost:${address.port}/v1` })}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
