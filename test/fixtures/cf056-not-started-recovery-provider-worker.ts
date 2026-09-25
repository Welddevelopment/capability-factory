import { createServer } from "node:https";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface State {
  sequence: number;
  writes: number;
  precommitDrops: number;
  records: Record<string, { order_ref: string; sku: string; quantity: number; status: "draft"; observed_at: string }>;
}

const [keyPath, certificatePath, statePath] = process.argv.slice(2);
const actionToken = process.env.CF056_ACTION_TOKEN, observerToken = process.env.CF056_OBSERVER_TOKEN;
if (!keyPath || !certificatePath || !statePath || !actionToken || !observerToken) throw new Error("CF-056 provider requires TLS material, state and separate action/observer tokens.");

function readState(): State { return JSON.parse(readFileSync(statePath!, "utf8")) as State; }
function saveState(state: State): void {
  const next = join(dirname(statePath!), `state.${process.pid}.next`);
  writeFileSync(next, JSON.stringify(state), { mode: 0o600 });
  renameSync(next, statePath!);
}
function respond(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) });
  response.end(encoded);
}

const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath) }, (request, response) => {
  const target = new URL(request.url ?? "/", "https://localhost");
  const expected = target.pathname === "/v1/audit/orders" ? observerToken : actionToken;
  if (request.headers.authorization !== `Bearer ${expected}`) { respond(response, 401, { error: "unauthorized" }); return; }
  if (request.method === "POST" && target.pathname === "/v1/orders") {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const state = readState();
      if (state.precommitDrops === 0) {
        state.precommitDrops = 1;
        saveState(state);
        request.socket.destroy();
        return;
      }
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { order_ref?: unknown; sku?: unknown; quantity?: unknown };
        if (typeof input.order_ref !== "string" || typeof input.sku !== "string" || !Number.isInteger(input.quantity) || Number(input.quantity) < 1) throw new Error("invalid");
        const existing = state.records[input.order_ref];
        if (!existing) {
          state.sequence += 1; state.writes += 1;
          state.records[input.order_ref] = { order_ref: input.order_ref, sku: input.sku, quantity: Number(input.quantity), status: "draft", observed_at: new Date().toISOString() };
          saveState(state);
        }
        respond(response, existing ? 200 : 201, { accepted: true, sequence: state.sequence });
      } catch { respond(response, 400, { error: "invalid-request" }); }
    });
    return;
  }
  if (request.method === "GET" && target.pathname === "/v1/audit/orders") {
    const reference = target.searchParams.get("order_ref"), state = readState(), record = reference ? state.records[reference] : undefined;
    respond(response, 200, { items: record ? [record] : [], server_time: new Date().toISOString(), collateral_clean: Object.keys(state.records).every((key) => key === reference) });
    return;
  }
  respond(response, 404, { error: "not-found" });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CF-056 provider did not bind.");
  process.stdout.write(`${JSON.stringify({ serverUrl: `https://localhost:${address.port}/v1` })}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
