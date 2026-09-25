import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  ExperimentalBrowserCapability,
  ExperimentalBrowserOutcomeVerifier,
  ExperimentalBrowserTarget,
} from "../experimental/browser-driver.js";
import {
  buildBrowserCapabilityFromUiContract,
  defineTrustedBrowserUiContract,
} from "../experimental/browser-ui-contract.js";

export type BrowserPortalMode =
  | "normal"
  | "lost-response-after-complete"
  | "partial-outcome"
  | "incorrect-outcome"
  | "ui-drift"
  | "ui-drift-repairable"
  | "mfa-gate"
  | "popup-escape"
  | "download-escape"
  | "redirect-escape"
  | "write-during-verification"
  | "duplicate-network-write"
  | "secret-echo";

export interface BrowserPortalExpectedOutcome {
  operationKey: string;
  reference: string;
  quantity: number;
}

interface BrowserPortalRow {
  operation_key: string;
  reference: string;
  quantity: number | null;
  status: "complete" | "partial" | "incorrect";
}

const testId = (value: string) => ({ kind: "test-id" as const, value });

export const BROWSER_PORTAL_UI_CONTRACT = defineTrustedBrowserUiContract({
  schemaVersion: "1.0",
  contractId: "dealer-restock-portal-ui-v2",
  capabilityId: "dealer-restock-browser-v2",
  needKey: "create-dealer-restock-request",
  targetAlias: "dealer_portal",
  outcomeVerifierKey: "dealer-portal-direct-db-v1",
  authentication: { kind: "none" },
  workPage: {
    path: "/portal/orders/new",
    assertions: [{ locator: testId("page-title"), expectedText: "Create restock request" }],
    fields: [
      { source: "secret", locator: testId("portal-key"), secretAlias: "dealer_portal_key" },
      { source: "input", locator: testId("operation-key"), inputKey: "operationKey" },
      { source: "input", locator: testId("order-reference"), inputKey: "reference" },
      { source: "input", locator: testId("quantity"), inputKey: "quantity" },
    ],
    submit: testId("submit-order"),
    approvalKey: "create-restock-request",
    confirmation: {
      locator: testId("confirmation"),
      expectedText: "Created",
      outputKey: "confirmation",
    },
  },
});

export const BROWSER_PORTAL_UI_CONTRACT_HASH = BROWSER_PORTAL_UI_CONTRACT.contractHash;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalPortalHtml(
  submitControl: string,
  options: {
    automaticWrite?: boolean;
    duplicateWrite?: boolean;
    echoSecret?: boolean;
    submitTestId?: string;
  } = {},
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:">
    <link rel="icon" href="data:,">
    <title>Dealer restock portal</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 40px; background: #f5f6f8; color: #111; }
      main { max-width: 560px; padding: 28px; background: white; border: 1px solid #ccd1d8; }
      label { display: block; margin: 14px 0; }
      input { display: block; width: 100%; box-sizing: border-box; padding: 8px; }
      button, a { display: inline-block; margin-top: 16px; padding: 10px 16px; }
    </style>
  </head>
  <body>
    <main>
      <h1 data-testid="page-title">Create restock request</h1>
      <label>Portal key<input type="password" autocomplete="off" data-testid="portal-key"></label>
      <label>Operation key<input data-testid="operation-key"></label>
      <label>Reference<input data-testid="order-reference"></label>
      <label>Quantity<input type="number" min="1" data-testid="quantity"></label>
      ${submitControl}
      <p aria-live="polite" data-testid="confirmation">Not submitted</p>
    </main>
    <script>
      const control = document.querySelector('[data-testid="${options.submitTestId ?? "submit-order"}"]');
      if (control && control.tagName === 'BUTTON') {
        control.addEventListener('click', async () => {
          const confirmation = document.querySelector('[data-testid="confirmation"]');
          confirmation.textContent = 'Submitting';
          try {
            const send = () => fetch('/portal/api/orders', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-portal-key': document.querySelector('[data-testid="portal-key"]').value,
              },
              body: JSON.stringify({
                operationKey: document.querySelector('[data-testid="operation-key"]').value,
                reference: document.querySelector('[data-testid="order-reference"]').value,
                quantity: Number(document.querySelector('[data-testid="quantity"]').value),
              }),
            });
            const responses = await Promise.all(Array.from({ length: ${options.duplicateWrite ? 2 : 1} }, send));
            if (responses.some((response) => !response.ok)) throw new Error('request failed');
            confirmation.textContent = ${options.echoSecret
              ? "document.querySelector('[data-testid=\"portal-key\"]').value"
              : "'Created'"};
          } catch {
            confirmation.textContent = 'Connection lost';
          }
        });
      }
      ${options.automaticWrite ? "void fetch('/portal/api/orders', { method: 'POST' }).catch(() => undefined);" : ""}
    </script>
  </body>
</html>`;
}

function portalHtml(mode: BrowserPortalMode): string {
  if (mode === "mfa-gate") {
    return `<!doctype html><html lang="en"><head><title>Additional verification</title></head><body><main>
      <h1 data-testid="mfa-title">Additional verification required</h1>
      <label>Verification code<input autocomplete="one-time-code" data-testid="verification-code"></label>
      <button type="button" data-testid="verify-code">Verify code</button>
    </main></body></html>`;
  }
  if (mode === "popup-escape") {
    return normalPortalHtml('<a href="/portal/popup" target="_blank" data-testid="submit-order">Submit</a>');
  }
  if (mode === "download-escape") {
    return normalPortalHtml('<a href="/portal/download" download data-testid="submit-order">Submit</a>');
  }
  if (mode === "ui-drift") {
    return normalPortalHtml('<button type="button" data-testid="renamed-submit-control">Submit</button>');
  }
  if (mode === "ui-drift-repairable") {
    return normalPortalHtml(
      '<button type="button" data-testid="renamed-submit-control">Submit</button>',
      { submitTestId: "renamed-submit-control" },
    );
  }
  return normalPortalHtml(
    '<button type="button" data-testid="submit-order">Submit</button>',
    {
      automaticWrite: mode === "write-during-verification",
      duplicateWrite: mode === "duplicate-network-write",
      echoSecret: mode === "secret-echo",
    },
  );
}

export function trustedBrowserPortalCapability(): ExperimentalBrowserCapability {
  return buildBrowserCapabilityFromUiContract(BROWSER_PORTAL_UI_CONTRACT);
}

export class DisposableBrowserPortal {
  private readonly database: DatabaseSync;
  private readonly app: FastifyInstance;
  private mode: BrowserPortalMode = "normal";
  private originValue: string | null = null;

  constructor(databasePath: string, private readonly portalKey: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS browser_orders (
        operation_key TEXT PRIMARY KEY,
        reference TEXT NOT NULL,
        quantity INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.app = Fastify({ logger: false, bodyLimit: 16_384 });
    this.routes();
  }

  get origin(): string {
    if (!this.originValue) throw new Error("Disposable browser portal is not running.");
    return this.originValue;
  }

  target(): ExperimentalBrowserTarget {
    return {
      origin: this.origin,
      allowedNavigationPaths: [BROWSER_PORTAL_UI_CONTRACT.workPage.path],
      allowedRequests: [
        { path: "/portal/orders/new", method: "GET", purpose: "read", maxPerSession: 1 },
        { path: "/portal/api/orders", method: "POST", purpose: "business-write", maxPerSession: 1 },
      ],
      allowedLocators: [
        ...BROWSER_PORTAL_UI_CONTRACT.workPage.assertions.map((item) => item.locator),
        ...BROWSER_PORTAL_UI_CONTRACT.workPage.fields.map((item) => item.locator),
        BROWSER_PORTAL_UI_CONTRACT.workPage.submit,
        BROWSER_PORTAL_UI_CONTRACT.workPage.confirmation.locator,
      ].map((item) => ({ ...item })),
      timeoutMs: 4_000,
    };
  }

  discoveryTarget(): ExperimentalBrowserTarget {
    const existing = this.target();
    return {
      ...existing,
      allowedNavigationPaths: ["/portal/home", "/portal/orders", ...existing.allowedNavigationPaths],
      allowedRequests: [
        { path: "/portal/home", method: "GET", purpose: "read", maxPerSession: 1 },
        { path: "/portal/orders", method: "GET", purpose: "read", maxPerSession: 1 },
        ...existing.allowedRequests,
      ],
    };
  }

  setMode(mode: BrowserPortalMode): void {
    this.mode = mode;
  }

  reset(): void {
    this.database.exec("DELETE FROM browser_orders;");
    this.mode = "normal";
  }

  record(operationKey: string): BrowserPortalRow | undefined {
    return this.database.prepare(`
      SELECT operation_key, reference, quantity, status FROM browser_orders WHERE operation_key = ?
    `).get(operationKey) as unknown as BrowserPortalRow | undefined;
  }

  count(): number {
    return (this.database.prepare("SELECT COUNT(*) AS count FROM browser_orders").get() as { count: number }).count;
  }

  records(): BrowserPortalRow[] {
    return this.database.prepare(`
      SELECT operation_key, reference, quantity, status
      FROM browser_orders
      ORDER BY reference ASC
    `).all() as unknown as BrowserPortalRow[];
  }

  verifier(expected: BrowserPortalExpectedOutcome): ExperimentalBrowserOutcomeVerifier {
    return {
      key: "dealer-portal-direct-db-v1",
      verify: async (operationKey) => {
        if (operationKey !== expected.operationKey) {
          return { outcome: "unknown", detail: "The verifier received an unexpected operation identity." };
        }
        const row = this.record(operationKey);
        if (!row) {
          return { outcome: "not-started", detail: "No browser order exists for the operation key.", stateDigest: this.stateDigest(operationKey) };
        }
        if (row.status === "partial" || row.quantity === null) {
          return { outcome: "partial", detail: "A partial browser order exists and must not be retried blindly.", stateDigest: this.stateDigest(operationKey) };
        }
        if (
          row.status !== "complete" ||
          row.reference !== expected.reference ||
          row.quantity !== expected.quantity
        ) {
          return { outcome: "incorrect", detail: "The persisted browser order does not match the approved outcome.", stateDigest: this.stateDigest(operationKey) };
        }
        return { outcome: "complete", detail: "Direct SQLite state matches the approved browser operation.", stateDigest: this.stateDigest(operationKey) };
      },
    };
  }

  async start(): Promise<void> {
    const address = await this.app.listen({ host: "127.0.0.1", port: 0 });
    this.originValue = new URL(address).origin;
  }

  async close(): Promise<void> {
    await this.app.close();
    this.database.close();
  }

  private stateDigest(operationKey: string): string {
    return createHash("sha256").update(JSON.stringify(this.record(operationKey) ?? null)).digest("hex");
  }

  private routes(): void {
    this.app.get("/portal/home", async (_request, reply) => reply.type("text/html; charset=utf-8").send(`<!doctype html>
      <html lang="en"><head><title>Dealer operations</title></head><body><main>
        <h1 data-testid="home-title">Dealer operations</h1>
        <a href="/portal/orders" data-testid="orders-link">Review restock work</a>
      </main></body></html>`));
    this.app.get("/portal/orders", async (_request, reply) => reply.type("text/html; charset=utf-8").send(`<!doctype html>
      <html lang="en"><head><title>Restock work</title></head><body><main>
        <h1 data-testid="orders-title">Restock work requiring action</h1>
        <a href="/portal/orders/new" data-testid="new-order-link">Create restock request</a>
      </main></body></html>`));
    this.app.get("/portal/orders/new", async (_request, reply) => {
      if (this.mode === "redirect-escape") return reply.redirect("/portal/escape");
      return reply.type("text/html; charset=utf-8").send(portalHtml(this.mode));
    });
    this.app.get("/portal/popup", async (_request, reply) => reply.type("text/html").send("Popup blocked"));
    this.app.get("/portal/download", async (_request, reply) => reply
      .header("content-disposition", 'attachment; filename="blocked.txt"')
      .type("text/plain")
      .send("blocked"));
    this.app.get("/portal/escape", async (_request, reply) => reply.type("text/html").send("Not allowlisted"));
    this.app.post("/portal/api/orders", async (request, reply) => {
      const providedKey = request.headers["x-portal-key"];
      if (providedKey !== this.portalKey) return reply.code(401).send({ error: "unauthorized" });
      const body = request.body as Record<string, unknown>;
      const operationKey = typeof body.operationKey === "string" ? body.operationKey : "";
      const reference = typeof body.reference === "string" ? body.reference : "";
      const quantity = typeof body.quantity === "number" ? body.quantity : Number.NaN;
      if (!operationKey || !reference || !Number.isInteger(quantity) || quantity <= 0) {
        return reply.code(400).send({ error: "invalid request" });
      }
      const mode = this.mode;
      const storedQuantity = mode === "partial-outcome" ? null : mode === "incorrect-outcome" ? quantity + 1 : quantity;
      const status = mode === "partial-outcome" ? "partial" : mode === "incorrect-outcome" ? "incorrect" : "complete";
      this.database.prepare(`
        INSERT OR IGNORE INTO browser_orders (operation_key, reference, quantity, status, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(operationKey, reference, storedQuantity, status, new Date().toISOString());
      if (mode === "lost-response-after-complete") {
        reply.hijack();
        reply.raw.destroy();
        return reply;
      }
      if (mode === "partial-outcome") return reply.code(500).send({ error: "partial persistence" });
      return reply.code(201).send({ created: true, operationKey: escapeHtml(operationKey) });
    });
  }
}
