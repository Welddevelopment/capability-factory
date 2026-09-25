// src/customer-world/fictional-courier-delegate-service.ts
// A localhost signed digital service to delegate to: the counterparty the family
// currently lacks. Entirely fictional courier-pickup booking; disposable world in
// the style of src/customer-world/inbox-order-world.ts and
// src/customer-world/signed-agent-delegate-world.ts.
//
// Trust boundary: this file contains (a) the COUNTERPARTY (its own keypair, its own
// sqlite state, an HTTP surface), (b) the trusted HTTP ADAPTER that the CF SDK
// drives, and (c) the trusted INDEPENDENT VERIFIER that reads the counterparty's
// persisted state directly and never trusts an HTTP response. No model code here.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, generateKeyPairSync, sign as signReceipt } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
// INTEGRATION-CHECK: all five names below verified as exports of
// src/experimental/agent-delegation-capability-sdk.ts (read 2026-08-24):
//   canonicalDelegateReceiptBytes (line 174), types AgentDelegateAdapter (60),
//   AgentDelegateContract (23), AgentDelegateOutcomeVerifier (74),
//   SignedDelegateReceipt (58), SignedDelegateReceiptBody (53).
// Relative path assumes this file lands in src/customer-world/.
import {
  canonicalDelegateReceiptBytes,
  type AgentDelegateAdapter,
  type AgentDelegateContract,
  type AgentDelegateOutcomeVerifier,
  type SignedDelegateReceipt,
  type SignedDelegateReceiptBody,
} from "../experimental/agent-delegation-capability-sdk.js";

const IDENTIFIER = /^[a-zA-Z0-9_.-]{1,180}$/;

export const COURIER_DELEGATE_ID = "fictional-courier-booking-service";
export const COURIER_DELEGATE_VERSION = "1_0_0";
export const COURIER_TASK_KEY = "create-pickup-booking";
export const COURIER_APPROVAL_KEY = "delegate-courier-pickup-booking";
export const COURIER_PROBE_KEY = "courier-delegate-probe";
export const COURIER_OUTCOME_VERIFIER_KEY = "independent-courier-database-observer";

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

/** Must match the private inputDigest in agent-delegation-capability-sdk.ts (line 170). */
function sortedInputDigest(values: Record<string, string>): string {
  return sha256(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * What the counterparty advertises about itself. This is model-visible input.
 * Deliberately contains NO key material: the public key is enrolled out of band
 * by trusted code and pinned into the contract there.
 */
export interface CourierServiceDescription {
  serviceKind: "fictional-courier-booking";
  delegateId: string;
  version: string;
  tasks: Array<{
    taskKey: string;
    description: string;
    inputFields: Array<{ name: string; description: string }>;
  }>;
  evidence: string;
}

export class FictionalCourierDelegateService {
  private readonly database: DatabaseSync;
  private readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  private server: Server | undefined;
  private boundPort = 0;

  constructor(
    readonly databasePath: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    const pair = generateKeyPairSync("ed25519");
    this.privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    this.publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS pickup_bookings (
        operation_key TEXT PRIMARY KEY,
        booking_ref TEXT NOT NULL,
        timeslot TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'booked')
      );
      CREATE TABLE IF NOT EXISTS service_receipts (
        operation_key TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS protected_service_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO protected_service_settings (setting_key, setting_value)
      VALUES ('depot', 'LDN-EAST-1');
    `);
  }

  description(): CourierServiceDescription {
    return {
      serviceKind: "fictional-courier-booking",
      delegateId: COURIER_DELEGATE_ID,
      version: COURIER_DELEGATE_VERSION,
      tasks: [
        {
          taskKey: COURIER_TASK_KEY,
          description: "Create exactly one fictional courier pickup booking for a reference and timeslot.",
          inputFields: [
            { name: "bookingRef", description: "Caller-owned booking reference, one per operation." },
            { name: "timeslot", description: "Requested pickup timeslot label, for example friday-am." },
          ],
        },
      ],
      evidence:
        "Each completed task returns an ed25519-signed completion receipt; the booking row persists in the service database for independent observation.",
    };
  }

  async listen(): Promise<{ baseUrl: string; port: number }> {
    if (this.server) throw new Error("The fictional courier service is already listening.");
    const server = createServer((request, response) => {
      this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "internal" }));
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The service did not bind a loopback port.");
    this.boundPort = address.port;
    return { baseUrl: `http://127.0.0.1:${address.port}`, port: address.port };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.boundPort}`);
    const segments = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && url.pathname === "/service-description") {
      return json(200, this.description());
    }
    if (request.method === "GET" && segments[0] === "probe" && segments.length === 2) {
      const taskKey = segments[1]!;
      const passed = taskKey === COURIER_TASK_KEY;
      return json(200, {
        passed,
        detail: passed
          ? "The exact advertised courier task is available."
          : "The requested task is not advertised by this service.",
      });
    }
    if (segments[0] === "operations" && segments.length === 2) {
      const operationKey = segments[1]!;
      if (!IDENTIFIER.test(operationKey)) return json(400, { error: "invalid operation key" });
      if (request.method === "GET") {
        const stored = this.storedReceipt(operationKey);
        return stored
          ? json(200, { status: "completed", receipt: stored })
          : json(404, { status: "not-started" });
      }
      if (request.method === "POST") {
        const body = await readBody(request);
        let parsed: { taskKey?: unknown; values?: unknown };
        try {
          parsed = JSON.parse(body) as { taskKey?: unknown; values?: unknown };
        } catch {
          return json(400, { error: "invalid json" });
        }
        if (parsed.taskKey !== COURIER_TASK_KEY) return json(422, { error: "task outside the advertised catalogue" });
        const values = parsed.values;
        if (!values || typeof values !== "object" || Array.isArray(values)) return json(400, { error: "invalid values" });
        const record = values as Record<string, unknown>;
        const bookingRef = record.bookingRef;
        const timeslot = record.timeslot;
        if (typeof bookingRef !== "string" || typeof timeslot !== "string" || !bookingRef || !timeslot) {
          return json(422, { error: "bookingRef and timeslot are required strings" });
        }
        return json(200, this.executeBooking(operationKey, { bookingRef, timeslot }));
      }
    }
    return json(404, { error: "not found" });
  }

  private storedReceipt(operationKey: string): SignedDelegateReceipt | undefined {
    const row = this.database
      .prepare("SELECT receipt_json FROM service_receipts WHERE operation_key = ?")
      .get(operationKey) as { receipt_json: string } | undefined;
    return row ? (JSON.parse(row.receipt_json) as SignedDelegateReceipt) : undefined;
  }

  /** Idempotent: replays the stored receipt rather than double-booking. */
  private executeBooking(operationKey: string, values: { bookingRef: string; timeslot: string }): SignedDelegateReceipt {
    const existing = this.storedReceipt(operationKey);
    if (existing) return existing;
    this.database
      .prepare("INSERT INTO pickup_bookings (operation_key, booking_ref, timeslot, status) VALUES (?, ?, ?, 'booked')")
      .run(operationKey, values.bookingRef, values.timeslot);
    const resultRow = this.database
      .prepare("SELECT operation_key, booking_ref, timeslot, status FROM pickup_bookings WHERE operation_key = ?")
      .get(operationKey);
    // INTEGRATION-CHECK: field order below MUST match signedDelegateReceiptBodySchema's
    // shape order (agent-delegation-capability-sdk.ts lines 42-52). verifyReceipt
    // re-serialises the zod-parsed body with JSON.stringify, and zod emits keys in
    // schema-shape order, so signing bytes only match if this object is built in the
    // same order. LocalSignedShipmentDelegate (signed-agent-delegate-world.ts lines
    // 99-109) follows the same rule.
    const receiptBody: SignedDelegateReceiptBody = {
      schemaVersion: "1.0",
      delegateId: COURIER_DELEGATE_ID,
      delegateVersion: COURIER_DELEGATE_VERSION,
      operationKey,
      taskKey: COURIER_TASK_KEY,
      inputDigest: sortedInputDigest({ bookingRef: values.bookingRef, timeslot: values.timeslot }),
      status: "completed",
      completedAt: this.now(),
      resultDigest: sha256(resultRow),
    };
    const receipt: SignedDelegateReceipt = {
      ...receiptBody,
      signatureBase64: signReceipt(null, canonicalDelegateReceiptBytes(receiptBody), this.privateKeyPem).toString("base64"),
    };
    this.database
      .prepare("INSERT INTO service_receipts (operation_key, receipt_json) VALUES (?, ?)")
      .run(operationKey, JSON.stringify(receipt));
    return receipt;
  }

  countBookings(): number {
    return (this.database.prepare("SELECT COUNT(*) AS count FROM pickup_bookings").get() as { count: number }).count;
  }

  protectedStateDigest(): string {
    return sha256(
      this.database.prepare("SELECT setting_key, setting_value FROM protected_service_settings ORDER BY setting_key").all(),
    );
  }

  /**
   * Trusted demo harness only — NOT an HTTP endpoint. Corrupts the persisted
   * booking so the refusal take can show "counterparty evidence tampered":
   * the stored signed receipt still verifies, but the independent observer must
   * reject the delegated outcome and the SDK must quarantine the route.
   */
  tamperBookingForRefusalTake(operationKey: string, forgedTimeslot: string): void {
    const changed = this.database
      .prepare("UPDATE pickup_bookings SET timeslot = ? WHERE operation_key = ?")
      .run(forgedTimeslot, operationKey);
    if (Number(changed.changes) !== 1) throw new Error("Tamper take found no booking to corrupt.");
  }

  async close(): Promise<void> {
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    this.database.close();
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > 64_000) throw new Error("Request body exceeds the fictional service limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Trusted-side adapter: drives the counterparty over loopback HTTP through the
 * exact AgentDelegateAdapter seam the SDK already verifies against
 * (agent-delegation-capability-sdk.ts lines 60-72). The SDK itself is unchanged.
 */
export class HttpSignedDelegateAdapter implements AgentDelegateAdapter {
  constructor(
    readonly contract: AgentDelegateContract,
    private readonly baseUrl: string,
  ) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    // The SDK also wraps every adapter call in withTimeout(contract.timeoutMs);
    // this inner bound just prevents a dangling socket outliving the race.
    return fetch(new URL(path, this.baseUrl), {
      ...init,
      signal: AbortSignal.timeout(this.contract.timeoutMs),
    });
  }

  async probe(taskKey: string): Promise<{ passed: boolean; detail: string }> {
    const response = await this.request(`/probe/${encodeURIComponent(taskKey)}`);
    if (!response.ok) return { passed: false, detail: `Probe endpoint returned ${response.status}.` };
    const body = (await response.json()) as { passed?: unknown; detail?: unknown };
    return {
      passed: body.passed === true,
      detail: typeof body.detail === "string" ? body.detail : "Probe response lacked detail.",
    };
  }

  async reconcile(operationKey: string): Promise<
    | { status: "not-started" | "unknown" }
    | { status: "completed"; receipt: SignedDelegateReceipt }
  > {
    let response: Response;
    try {
      response = await this.request(`/operations/${encodeURIComponent(operationKey)}`);
    } catch {
      return { status: "unknown" };
    }
    if (response.status === 404) return { status: "not-started" };
    if (!response.ok) return { status: "unknown" };
    const body = (await response.json()) as { status?: unknown; receipt?: unknown };
    if (body.status !== "completed" || !body.receipt) return { status: "unknown" };
    // The receipt is untrusted bytes here; the SDK's verifyReceipt performs the
    // schema parse and pinned-signature check against the trusted contract key.
    return { status: "completed", receipt: body.receipt as SignedDelegateReceipt };
  }

  async execute(input: { operationKey: string; taskKey: string; values: Record<string, string> }): Promise<SignedDelegateReceipt> {
    const response = await this.request(`/operations/${encodeURIComponent(input.operationKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskKey: input.taskKey, values: input.values }),
    });
    if (!response.ok) throw new Error(`The delegated service refused execution with status ${response.status}.`);
    return (await response.json()) as SignedDelegateReceipt;
  }
}

/**
 * Independent outcome verifier: opens the counterparty's database read-only and
 * checks exactly one intended booking plus unchanged protected settings. Mirrors
 * IndependentShipmentOutcomeVerifier (signed-agent-delegate-world.ts lines 132-166).
 * It never reads the HTTP surface, so a lying service cannot satisfy it.
 */
export class IndependentCourierOutcomeVerifier implements AgentDelegateOutcomeVerifier {
  readonly key = COURIER_OUTCOME_VERIFIER_KEY;

  constructor(
    private readonly databasePath: string,
    private readonly protectedDigest: string,
  ) {}

  async verifyOutcome(operationKey: string, input: Record<string, string>) {
    const observer = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      const rows = observer
        .prepare("SELECT operation_key, booking_ref, timeslot, status FROM pickup_bookings WHERE operation_key = ?")
        .all(operationKey) as unknown as Array<{ operation_key: string; booking_ref: string; timeslot: string; status: string }>;
      const protectedRows = observer
        .prepare("SELECT setting_key, setting_value FROM protected_service_settings ORDER BY setting_key")
        .all();
      const exact =
        rows.length === 1 &&
        rows[0]!.booking_ref === input.bookingRef &&
        rows[0]!.timeslot === input.timeslot &&
        rows[0]!.status === "booked";
      const protectedUnchanged = sha256(protectedRows) === this.protectedDigest;
      const passed = exact && protectedUnchanged;
      return {
        passed,
        incorrectSideEffects: passed ? 0 : 1,
        stateDigest: sha256({ rows, protectedRows }),
        detail: passed
          ? "A separate read-only observer found exactly one intended courier booking and unchanged protected settings."
          : "Independent courier state did not satisfy the exact delegated contract.",
      };
    } finally {
      observer.close();
    }
  }
}
