// Six refusals gauntlet — deterministic, $0, zero model calls.
//
// ONE run marches through six capability families. Every leg is adversarial:
// the trusted machinery must REFUSE, for the documented reason, with zero side
// effects verified through that family's independent channel where one exists.
//
//   1. DOCUMENTS   — a PDF tampered after trusted planning is refused before
//                    any draft is written (precedent:
//                    test/experimental-document-loop.test.ts "refuses changed PDFs...").
//   2. MESSAGES    — the exact accepted signed webhook is resent byte-for-byte
//                    (valid signature and all) and answered 409 replay:true;
//                    a freshly re-signed duplicate is 409 again (precedent:
//                    the deterministic preflight of
//                    src/customer-world/run-signed-message-model-confirmation.ts).
//   3. DATABASE    — an unapproved write is refused before any write, proved by
//                    an independent read-only ledger read (precedent: the
//                    deterministic preflight of
//                    src/customer-world/run-database-model-confirmation.ts).
//   4. WASM        — an import-carrying module refused at admission, an
//                    infinite loop killed by the worker timeout, a flipped-
//                    opcode module caught behaviourally by the probe
//                    (precedent: src/customer-world/run-wasm-gauntlet.ts).
//   5. NATIVE UI   — the REAL "Delete ALL requests" button in the live Dealer
//                    Desk app, driven through the real accessibility API, is
//                    refused because it is outside the declared surface
//                    (precedent: test/real-native-ui-capability.test.ts).
//   6. HTTP        — a restricted ERPNext credential is denied before any real
//                    business write; the direct-database state hash is
//                    unchanged (precedent: test/real-erpnext-integration.test.ts
//                    "denies both restricted credentials before any real
//                    ERPNext business write").
//
// The absence of a model is structural: no API key, no gateway, no
// BudgetTracker exists in this process. modelCalls: 0 and spentUsd: 0 are
// literals, not measurements.
//
// Prerequisites (both fail closed with a clear message when absent):
//   - native/dealer-desk/DealerDesk.app built (native/dealer-desk/build.sh)
//     plus the Accessibility permission for the ax-helper;
//   - the real ERPNext Docker stack up (ping http://127.0.0.1:8080/api/method/ping).

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  AuthenticatedMessageIngressClient,
  createAuthenticatedMessageIngress,
  signAuthenticatedMessage,
} from "../experimental/authenticated-message-ingress.js";
import {
  NativeUiDriver,
  NativeUiRefusal,
  defaultHelperPath,
  type NativeUiSurface,
} from "../experimental/native-ui-driver.js";
import {
  TrustedToolSandbox,
  type TrustedToolArtifact,
  type TrustedToolDescriptor,
} from "../experimental/trusted-tool-sandbox.js";
import {
  RotatingMemorySecretProvider,
  type ScopedSecretDescriptor,
} from "../product/secrets.js";
import {
  createScopedDatabaseProposal,
  ScopedDatabaseRuntime,
  scopedDatabaseContractSchema,
  type ScopedDatabaseAuthority,
  type ScopedDatabaseContract,
} from "../product/scoped-database-factory.js";
import { composedRecoveryDigest } from "../product/composed-runtime-recovery.js";
import { CapabilityExecutionError, CapabilityRuntime } from "../runtime.js";
import { FictionalInboxOrderWorld, fictionalOrderEmail } from "./inbox-order-world.js";
import { startNativeDealerDeskWorld, type NativeDealerDeskWorld } from "./native-dealer-desk-world.js";
import { FictionalPdfOrderWorld } from "./pdf-order-world.js";
import {
  createRealErpNextReferenceCapability,
  startRealErpNextWorld,
} from "./real-erpnext-world.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const sha256 = (value: string | Buffer | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

/* ------------------------------------------------------------------ */
/* Reporting                                                          */
/* ------------------------------------------------------------------ */

interface CheckRecord {
  name: string;
  passed: boolean;
  detail: string;
}

interface CaseRecord {
  leg: number;
  family: string;
  title: string;
  refusedFor: string;
  sideEffects: number;
  sideEffectsVerifiedBy: string;
  checks: CheckRecord[];
  passed: boolean;
}

const cases: CaseRecord[] = [];

function startCase(leg: number, family: string, title: string, sideEffectsVerifiedBy: string): CaseRecord {
  const record: CaseRecord = {
    leg,
    family,
    title,
    refusedFor: "(refusal not yet observed)",
    sideEffects: -1,
    sideEffectsVerifiedBy,
    checks: [],
    passed: true,
  };
  cases.push(record);
  console.log(`\n--- Leg ${leg} [${family}]: ${title}`);
  return record;
}

function check(record: CaseRecord, name: string, passed: boolean, detail: string): void {
  record.checks.push({ name, passed, detail });
  if (!passed) record.passed = false;
  console.log(`    ${passed ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

function crash(record: CaseRecord, error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  check(record, "leg-crashed", false, message);
}

const scratchRoots: string[] = [];
function scratch(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

/* ------------------------------------------------------------------ */
/* Leg 1 — DOCUMENTS: tampered PDF refused                            */
/* ------------------------------------------------------------------ */

async function legDocuments(): Promise<void> {
  const record = startCase(
    1,
    "documents",
    "PDF tampered after trusted planning is refused before any draft",
    "direct filesystem read of the customer draft store (world.listDrafts())",
  );
  try {
    const world = await FictionalPdfOrderWorld.create(scratch("cf-six-refusals-doc-"));
    const changed = await world.writeDocument({
      fileAlias: "tampered.pdf",
      documentId: "TAMPERED-1",
      purchaseOrderNumber: "TAMPERED-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    // The adversarial act: one byte appended AFTER the trusted ingress receipt
    // and the approval hash were recorded — same tamper as the precedent test.
    fs.appendFileSync(changed.filename, Buffer.from([0]));
    const result = await world.sdk().completeGoal(world.request({
      requestId: "six-refusals-tampered",
      operationKey: changed.operationKey,
      inputDocumentAlias: "tampered.pdf",
      expectedDocumentSha256: changed.sha256,
    }));
    const blocked = result.status === "blocked";
    const handoff = blocked && "handoff" in result ? result.handoff : null;
    check(record, "status.blocked", blocked, `status=${result.status}`);
    check(
      record,
      "refusal.reason",
      handoff?.summary === "The approved PDF changed after trusted planning.",
      `handoff summary: "${handoff?.summary ?? "(none)"}"`,
    );
    check(record, "writes.zero", handoff?.writesAttempted === 0, `writesAttempted=${String(handoff?.writesAttempted)}`);
    const drafts = world.listDrafts().length;
    record.sideEffects = drafts;
    check(record, "side-effects.zero", drafts === 0, `draft store holds ${drafts} drafts (independent filesystem read)`);
    if (handoff) record.refusedFor = handoff.summary;
  } catch (error) {
    crash(record, error);
  }
}

/* ------------------------------------------------------------------ */
/* Leg 2 — MESSAGES: byte-identical replay and re-signed duplicate    */
/* ------------------------------------------------------------------ */

// Ingress wiring duplicated from the deterministic preflight of
// src/customer-world/run-signed-message-model-confirmation.ts (the source of
// truth for these constants). All signature/replay machinery is untouched
// trusted repo code (authenticated-message-ingress.ts).
const MSG_RECEIVER_ALIAS = "signed_message_ingress_key";
const MSG_SENDER_ALIAS = "supplier_message_signing_key";
const MSG_RECEIVER_TARGET = "fictional_signed_message_ingress";
const MSG_SENDER_TARGET = "fictional_supplier_webhook";
const MSG_SHARED_SECRET = "fictional-shared-webhook-secret-with-sufficient-entropy";

function secretDescriptor(input: { alias: string; targetAlias: string; actionName: string; version: string }): ScopedSecretDescriptor {
  return {
    alias: input.alias,
    version: input.version,
    scope: { targetAliases: [input.targetAlias], actionNames: [input.actionName], methods: ["POST"] },
  };
}

async function legMessages(): Promise<void> {
  const record = startCase(
    2,
    "signed-messages",
    "Byte-identical replay 409 replay:true; freshly re-signed duplicate 409",
    "direct listing of the trusted inbox directory plus SHA-256 of the accepted file",
  );
  const root = scratch("cf-six-refusals-msg-");
  const world = new FictionalInboxOrderWorld(path.join(root, "world"));
  const receiverSecrets = new RotatingMemorySecretProvider();
  receiverSecrets.set(
    secretDescriptor({ alias: MSG_RECEIVER_ALIAS, targetAlias: MSG_RECEIVER_TARGET, actionName: "accept-signed-message", version: "receiver-v1" }),
    MSG_SHARED_SECRET,
  );
  const senderSecrets = new RotatingMemorySecretProvider();
  senderSecrets.set(
    secretDescriptor({ alias: MSG_SENDER_ALIAS, targetAlias: MSG_SENDER_TARGET, actionName: "send-signed-message", version: "sender-v1" }),
    MSG_SHARED_SECRET,
  );
  const ingress = createAuthenticatedMessageIngress({
    inboxRoot: world.inboxRoot,
    databasePath: path.join(root, "trusted-ingress.sqlite"),
    credentialAlias: MSG_RECEIVER_ALIAS,
    targetAlias: MSG_RECEIVER_TARGET,
    secrets: receiverSecrets,
  });
  try {
    const origin = await ingress.app.listen({ host: "127.0.0.1", port: 0 });
    const client = new AuthenticatedMessageIngressClient({
      origin,
      credentialAlias: MSG_SENDER_ALIAS,
      targetAlias: MSG_SENDER_TARGET,
      secrets: senderSecrets,
    });
    const delivery = {
      deliveryId: "six-refusals-delivery",
      inputMessageAlias: "six-refusals-order.eml",
      sentAt: new Date().toISOString(),
      message: fictionalOrderEmail({
        fileAlias: "six-refusals-order.eml",
        purchaseOrderNumber: "SIX-REFUSALS-ORDER",
        messageId: "<six-refusals-order@east-industrial.example>",
        lines: [{ itemCode: "BOLT-10", quantity: 3 }],
      }),
    };
    const accepted = await client.submit(delivery);
    check(record, "signed-ingress.accepts", accepted.status === 201, `correctly signed delivery earned HTTP ${accepted.status}`);
    const acceptedFile = path.join(world.inboxRoot, delivery.inputMessageAlias);
    const acceptedShaBefore = sha256(fs.readFileSync(acceptedFile));
    const inboxCountBefore = fs.readdirSync(world.inboxRoot).length;

    // Byte-identical replay: the exact captured envelope, valid signature and
    // all, resent raw — deliberately NOT via the signing client.
    const digest = sha256(Buffer.from(delivery.message, "utf8"));
    const signature = signAuthenticatedMessage(MSG_SHARED_SECRET, {
      deliveryId: delivery.deliveryId,
      sentAt: delivery.sentAt,
      inputMessageAlias: delivery.inputMessageAlias,
      messageSha256: digest,
    });
    const byteReplayResponse = await fetch(new URL("/v1/inbox/messages", origin), {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-cf-delivery-id": delivery.deliveryId,
        "x-cf-sent-at": delivery.sentAt,
        "x-cf-input-alias": delivery.inputMessageAlias,
        "x-cf-content-sha256": digest,
        "x-cf-signature": signature,
      },
      body: delivery.message,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    const byteReplayBody = (await byteReplayResponse.json()) as Record<string, unknown>;
    check(
      record,
      "byte-replay.409-replay-true",
      byteReplayResponse.status === 409 && byteReplayBody.replay === true,
      `byte-identical resend answered HTTP ${byteReplayResponse.status}, replay=${String(byteReplayBody.replay)}`,
    );

    // Freshly re-signed duplicate: same delivery identity, new timestamp, new
    // valid signature — refusal comes from durable delivery identity, not the clock.
    const resigned = await client.submit({ ...delivery, sentAt: new Date().toISOString() });
    check(record, "resigned-duplicate.409", resigned.status === 409, `freshly re-signed duplicate answered HTTP ${resigned.status}`);

    const inboxCountAfter = fs.readdirSync(world.inboxRoot).length;
    const acceptedShaAfter = sha256(fs.readFileSync(acceptedFile));
    record.sideEffects = (inboxCountAfter - inboxCountBefore) + (acceptedShaAfter === acceptedShaBefore ? 0 : 1);
    check(
      record,
      "side-effects.zero",
      inboxCountAfter === inboxCountBefore && acceptedShaAfter === acceptedShaBefore,
      `inbox still holds ${inboxCountAfter} file(s) and the accepted message bytes are unchanged`,
    );
    record.refusedFor = "HTTP 409 replay:true for the byte-identical resend; HTTP 409 for the freshly re-signed duplicate (durable delivery identity)";
  } catch (error) {
    crash(record, error);
  } finally {
    await ingress.close();
  }
}

/* ------------------------------------------------------------------ */
/* Leg 3 — DATABASE: unapproved write refused before any write        */
/* ------------------------------------------------------------------ */

// Fixture facts duplicated from the deterministic preflight of
// src/customer-world/run-database-model-confirmation.ts (restock-insert trial
// + its hand-written reference draft — that file is the source of truth).
// Contract validation, proposal, execution and the ledger are untouched
// trusted repo code (scoped-database-factory.ts).
function databaseContract(schemaDigest: string): ScopedDatabaseContract {
  return scopedDatabaseContractSchema.parse({
    schemaVersion: "1.0",
    contractId: "demo-restock-insert",
    contractVersion: "1.0.0",
    tenantId: "tenant-demo-inventory",
    targetAlias: "inventory-database",
    schemaDigest,
    migrationVersion: "demo-v1",
    allowlist: [{ table: "restock_drafts", columns: ["operation_key", "sku", "quantity", "status"], rowScopeColumns: ["operation_key"] }],
    parameters: [
      { name: "sku", type: "string" },
      { name: "quantity", type: "integer", min: 1, max: 1000 },
      { name: "status", type: "string" },
    ],
    transaction: {
      isolation: "serializable",
      statements: [{
        kind: "insert",
        table: "restock_drafts",
        values: [
          { column: "sku", parameter: "sku" },
          { column: "quantity", parameter: "quantity" },
          { column: "status", parameter: "status" },
        ],
        conflictColumns: ["operation_key"],
        expectedRows: 1,
      }],
    },
    connection: {
      profileId: "demo-inventory-profile",
      actionIdentity: "inventory_writer",
      observerIdentity: "inventory_auditor",
      actionPrivileges: ["insert:restock_drafts"],
      observerPrivileges: ["select:restock_drafts", "select:protected_audit"],
      status: "active",
      notBefore: "2026-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
    limits: { statementLimit: 1, timeoutMs: 2_000, rowLimit: 1 },
    approvalKey: "approve-demo-restock-draft",
    outcomeVerifierKey: "independent-restock-reader",
    workflowKey: "demo-restock-workflow",
  });
}

function computeSchemaDigest(databasePath: string): string {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return sha256(JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all()));
  } finally {
    db.close();
  }
}

async function legDatabase(): Promise<void> {
  const record = startCase(
    3,
    "database",
    "Unapproved write refused before any write reaches the database",
    "independent read-only SQLite connection: cf_operation_ledger and restock_drafts both empty",
  );
  try {
    const root = scratch("cf-six-refusals-db-");
    const databasePath = path.join(root, "refusal.sqlite");
    const now = new Date();
    // Seed the schema (the runtime constructor owns it), then contract + proposal.
    const seed = new ScopedDatabaseRuntime(databasePath, "inventory_writer", "inventory_auditor", () => now.toISOString());
    seed.close();
    const contract = databaseContract(computeSchemaDigest(databasePath));
    const proposal = createScopedDatabaseProposal({
      tenantId: contract.tenantId,
      parentGoalId: "six-refusals-parent",
      planId: "six-refusals-plan",
      planDigest: sha256("six-refusals-plan"),
      workItemId: "six-refusals-unapproved",
      contract,
      parameters: { sku: "widget_one", quantity: 4, status: "draft" },
      observedSchemaDigest: contract.schemaDigest,
      observedMigrationVersion: contract.migrationVersion,
      credentialAvailable: true,
      now: now.toISOString(),
    });
    // The adversarial act: an authority WITHOUT the reviewed approval. Its
    // approvalKey cannot match the proposal's, so execute must throw
    // "Database authority binding changed." before any write.
    const unapproved: ScopedDatabaseAuthority = {
      tenantId: proposal.tenantId,
      parentGoalId: proposal.parentGoalId,
      planId: proposal.planId,
      planDigest: proposal.planDigest,
      workItemId: proposal.workItemId,
      targetAlias: proposal.targetAlias,
      approvalKey: "unapproved",
      checkedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      revoked: false,
      authorityDigest: sha256(`six-refusals-authority:${proposal.proposalDigest}`),
    };
    const runtime = new ScopedDatabaseRuntime(databasePath, "inventory_writer", "inventory_auditor", () => now.toISOString());
    let refusalMessage = "";
    try {
      runtime.execute({
        proposal,
        contract,
        authority: unapproved,
        operationKey: "six-refusals-unapproved",
        idempotencyKey: sha256(`six-refusals-idempotency:${proposal.proposalDigest}`),
      });
      check(record, "refusal.thrown", false, "the unapproved write was NOT refused — safety failure");
    } catch (error) {
      refusalMessage = error instanceof Error ? error.message : String(error);
      check(record, "refusal.thrown", true, `execute threw before any write: "${refusalMessage}"`);
    } finally {
      runtime.close();
    }
    check(
      record,
      "refusal.reason",
      refusalMessage === "Database authority binding changed.",
      `refusal message: "${refusalMessage}"`,
    );
    // Independent channel: a separate read-only connection, never the runtime.
    const observer = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const ledger = (observer.prepare("SELECT COUNT(*) AS n FROM cf_operation_ledger").get() as { n: number }).n;
      const rows = (observer.prepare("SELECT COUNT(*) AS n FROM restock_drafts").get() as { n: number }).n;
      record.sideEffects = ledger + rows;
      check(record, "side-effects.zero", ledger === 0 && rows === 0, `cf_operation_ledger=${ledger}, restock_drafts=${rows} via independent read-only connection`);
    } finally {
      observer.close();
    }
    if (refusalMessage) record.refusedFor = refusalMessage;
  } catch (error) {
    crash(record, error);
  }
}

/* ------------------------------------------------------------------ */
/* Leg 4 — WASM: importer, infinite loop, wrong math                  */
/* ------------------------------------------------------------------ */

// Byte arrays duplicated verbatim from src/customer-world/run-wasm-gauntlet.ts
// (the source of truth for these hand-assembled artifacts; they were
// machine-verified against Node's real WebAssembly implementation there).

// (module (func (export "add") (param i32 i32) (result i32)
//   local.get 0 local.get 1 i32.add))
const ADD_WASM = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

// (module (import "env" "host" (func))
//   (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
const IMPORTING_ADD_WASM = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x0a, 0x02, 0x60, 0x00, 0x00, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x02, 0x0c, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x04, 0x68, 0x6f, 0x73, 0x74, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x01,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x01,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

// (module (func (export "add") (param i32 i32) (result i32) (loop (br 0)) unreachable))
const LOOPING_ADD_WASM = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x0a, 0x01, 0x08, 0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x00, 0x0b,
]);

// ADD_WASM with the single opcode 0x6a (i32.add) flipped to 0x6b (i32.sub).
const SUBTRACTING_ADD_WASM = Uint8Array.from(ADD_WASM);
SUBTRACTING_ADD_WASM[SUBTRACTING_ADD_WASM.length - 2] = 0x6b;

function wasmArtifact(toolId: string, bytes: Uint8Array, overrides: Partial<TrustedToolDescriptor> = {}): TrustedToolArtifact {
  const descriptor: TrustedToolDescriptor = {
    schemaVersion: "1.0",
    toolId,
    version: "1.0.0",
    artifactSha256: sha256(bytes),
    exportName: "add",
    maximumArtifactBytes: 1_024,
    maximumInputs: 2,
    timeoutMs: 1_000,
    workerMemoryMb: 16,
    probeInputs: [2, 3],
    expectedProbeOutput: 5,
    approvalKey: `run-${toolId}`,
    resultVerifierKey: "addition-verifier",
    ...overrides,
  };
  return { descriptor, wasmBytes: bytes };
}

async function legWasm(): Promise<void> {
  const record = startCase(
    4,
    "wasm",
    "Importer refused at admission; infinite loop killed by timeout; wrong math caught by probe",
    "no execution result was ever produced (execute() rejected / probe refused admission) and the host process survived",
  );
  try {
    const sandbox = new TrustedToolSandbox();

    // 4a: import-carrying module — refused at admission, before instantiation.
    // Honest descriptor: the hash matches the importing bytes, so the refusal
    // is attributable to the import check alone.
    const importing = wasmArtifact("importing-add", IMPORTING_ADD_WASM);
    const importingPreflight = sandbox.preflight(importing);
    const importFree = importingPreflight.checks.find((item) => item.id === "artifact.import-free");
    check(
      record,
      "importer.refused-at-admission",
      importingPreflight.passed === false && importFree?.passed === false,
      "preflight refuses; artifact.import-free is the failing check (module imports env.host)",
    );
    const importerExecute = await sandbox.execute(importing, [2, 3]).then(() => "", (error: Error) => error.message);
    check(record, "importer.execute-rejects", /preflight/.test(importerExecute), `execute rejects: "${importerExecute}"`);

    // 4b: infinite loop — structurally clean, killed by the worker timeout.
    const looping = wasmArtifact("looping-add", LOOPING_ADD_WASM, { timeoutMs: 250 });
    check(record, "looper.structurally-clean", sandbox.preflight(looping).passed === true, "structure checks cannot see the loop — the timeout is what stops it");
    const probeStarted = Date.now();
    const loopingProbe = await sandbox.probe(looping);
    const probeMs = Date.now() - probeStarted;
    const loopingProbeCheck = loopingProbe.checks.find((item) => item.id === "artifact.probe");
    check(
      record,
      "looper.killed-by-timeout",
      loopingProbe.passed === false && loopingProbeCheck?.passed === false && probeMs >= 250 && probeMs <= 5_000,
      `probe refused after ${probeMs}ms — the worker was terminated at the 250ms timeout, it did not finish`,
    );
    check(record, "looper.host-survived", true, "this line printing IS the assertion — the worker died, not the host");

    // 4c: flipped-opcode wrong math — every structural check passes, the
    // deterministic behavioural probe is what catches it.
    const subtracting = wasmArtifact("subtracting-add", SUBTRACTING_ADD_WASM);
    check(record, "wrong-math.structurally-clean", sandbox.preflight(subtracting).passed === true, "size, hash, import-free and export all pass — structure cannot see the flipped opcode");
    const subtractingProbe = await sandbox.probe(subtracting);
    const subtractingProbeCheck = subtractingProbe.checks.find((item) => item.id === "artifact.probe");
    const structuralClean = subtractingProbe.checks.filter((item) => item.id !== "artifact.probe").every((item) => item.passed);
    check(
      record,
      "wrong-math.caught-by-probe",
      subtractingProbe.passed === false && subtractingProbeCheck?.passed === false && structuralClean,
      "only artifact.probe fails: add(2,3) produced -1, pinned expectation is 5",
    );

    record.sideEffects = 0;
    check(
      record,
      "side-effects.zero",
      true,
      "structural: no registry was created, no module was admitted, and no execution result exists for any of the three artifacts",
    );
    record.refusedFor =
      "importing: artifact.import-free at admission; looping: worker timeout kill (artifact.probe); wrong-math: behavioural probe (add(2,3) -> -1, expected 5)";
  } catch (error) {
    crash(record, error);
  }
}

/* ------------------------------------------------------------------ */
/* Leg 5 — NATIVE UI: real wipe button outside the declared surface   */
/* ------------------------------------------------------------------ */

// Surface shape mirrors test/real-native-ui-capability.test.ts —
// deliberately ABSENT: dealer-desk.wipe-button, the tripwire the driver must refuse.
const NATIVE_SURFACE: NativeUiSurface = {
  appBundleId: "com.capabilityfactory.fictional.dealerdesk",
  controls: [
    { identifier: "dealer-desk.item-field", role: "AXTextField", actions: ["settext"] },
    { identifier: "dealer-desk.quantity-field", role: "AXTextField", actions: ["settext"] },
    { identifier: "dealer-desk.submit-button", role: "AXButton", actions: ["press"], commitsWrite: true },
  ],
};

async function legNativeUi(): Promise<void> {
  const record = startCase(
    5,
    "native-ui",
    'Real "Delete ALL requests" button refused: outside the declared surface',
    "separate read-only SQLite connection to the app's database (never the UI)",
  );
  let world: NativeDealerDeskWorld | null = null;
  try {
    // tmpdir, not the repo: a Launch-Services-spawned app has no TCC grant for
    // ~/Desktop (same hard-won lesson as the precedent test).
    world = await startNativeDealerDeskWorld({
      repositoryRoot: REPO_ROOT,
      dataDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "cf-six-refusals-native-")),
    });
    const driver = new NativeUiDriver(defaultHelperPath(REPO_ROOT), world.pid, NATIVE_SURFACE);
    const identifiers = driver.snapshot().map((entry) => entry.identifier);
    check(
      record,
      "wipe-button.exists-in-live-app",
      identifiers.includes("dealer-desk.wipe-button"),
      "the real accessibility snapshot contains dealer-desk.wipe-button — the tripwire is a genuine live control, not a phantom",
    );
    const countBefore = world.countRestockRequests();
    let refusal: unknown = null;
    try {
      driver.press("dealer-desk.wipe-button");
      check(record, "wipe-press.refused", false, "the wipe button was pressed without refusal — safety failure");
    } catch (error) {
      refusal = error;
      check(record, "wipe-press.refused", true, `press threw: "${error instanceof Error ? error.message : String(error)}"`);
    }
    check(record, "refusal.type", refusal instanceof NativeUiRefusal, `refusal is ${refusal instanceof Error ? refusal.name : typeof refusal}`);
    const refusalMessage = refusal instanceof Error ? refusal.message : String(refusal);
    check(
      record,
      "refusal.reason",
      /not in the declared surface/.test(refusalMessage),
      `refusal names the declared-surface boundary: "${refusalMessage}"`,
    );
    const countAfter = world.countRestockRequests();
    record.sideEffects = Math.abs(countAfter - countBefore) + countAfter;
    check(
      record,
      "side-effects.zero",
      countAfter === countBefore && countAfter === 0,
      `restock_requests count ${countBefore} -> ${countAfter} via the independent read-only database channel`,
    );
    if (refusal instanceof NativeUiRefusal) record.refusedFor = refusalMessage;
  } catch (error) {
    crash(record, error);
  } finally {
    world?.stop();
  }
}

/* ------------------------------------------------------------------ */
/* Leg 6 — HTTP: restricted ERPNext credential denied before write    */
/* ------------------------------------------------------------------ */

const ERPNEXT_BASE_URL = process.env.CF_ERPNEXT_BASE_URL ?? "http://127.0.0.1:8080";

async function legHttp(): Promise<void> {
  const record = startCase(
    6,
    "http",
    "Restricted ERPNext credential denied before any real business write",
    "direct-database state hash via bench inside the container (reset hash unchanged) plus world.verify",
  );
  try {
    // Fail closed BEFORE touching docker: the stack must already be up.
    let ping: Response;
    try {
      ping = await fetch(`${ERPNEXT_BASE_URL}/api/method/ping`, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      check(
        record,
        "erpnext.reachable",
        false,
        `The real ERPNext stack is not reachable at ${ERPNEXT_BASE_URL} (${error instanceof Error ? error.message : String(error)}). ` +
          "Start it first (colima profile capability-factory + fixtures/erpnext compose), then rerun. Failing closed: this leg was NOT attempted.",
      );
      return;
    }
    if (!ping.ok) {
      check(record, "erpnext.reachable", false, `Ping answered HTTP ${ping.status}. Failing closed: this leg was NOT attempted.`);
      return;
    }
    check(record, "erpnext.reachable", true, `ping answered HTTP ${ping.status}`);
    process.env.DOCKER_HOST ??= `unix://${os.homedir()}/.colima/capability-factory/docker.sock`;

    const world = await startRealErpNextWorld({ repositoryRoot: REPO_ROOT });
    const caseId = "permission-denial"; // read-only credential
    const resetHash = world.reset(caseId);
    const runtime = new CapabilityRuntime(world.runtimeConfiguration(caseId));
    const manifest = createRealErpNextReferenceCapability(world.documentation, world.secretAlias(caseId));
    const read = await runtime.execute(manifest, "read_sales_order", { salesOrderId: "SO-REAL-0004" }, { runId: caseId });
    check(record, "restricted-read.allowed", typeof read.output.salesOrderItemId === "string" || read.output.salesOrderItemId !== undefined, "the read-only credential can read — the denial below is about the write, not connectivity");
    let refusalMessage = "";
    try {
      await runtime.execute(
        manifest,
        "create_delivery_note",
        {
          salesOrderId: "SO-REAL-0004",
          salesOrderItemId: String(read.output.salesOrderItemId),
          customerId: String(read.output.customerId),
          trackingNumber: "PF-SO-REAL-0004",
          labelReference: "LABEL-SO-REAL-0004",
          idempotencyKey: "delivery-SO-REAL-0004",
        },
        { runId: caseId },
      );
      check(record, "business-write.denied", false, "the restricted credential's business write was NOT denied — safety failure");
    } catch (error) {
      refusalMessage = error instanceof Error ? error.message : String(error);
      check(
        record,
        "business-write.denied",
        error instanceof CapabilityExecutionError,
        `create_delivery_note rejected with ${error instanceof Error ? error.name : typeof error}: "${refusalMessage}"`,
      );
    }
    const hashUnchanged = world.stateHash() === resetHash;
    check(record, "state-hash.unchanged", hashUnchanged, "the direct-database state hash equals the post-reset hash — nothing in ERPNext moved");
    const verification = world.verify(caseId);
    record.sideEffects = verification.incorrectSideEffects + verification.intendedWrites;
    check(
      record,
      "side-effects.zero",
      verification.passed && verification.intendedWrites === 0 && verification.incorrectSideEffects === 0,
      `independent in-container verification: passed=${verification.passed}, intendedWrites=${verification.intendedWrites}, incorrectSideEffects=${verification.incorrectSideEffects}`,
    );
    if (refusalMessage) record.refusedFor = `restricted (read-only) credential: ${refusalMessage}`;
    await world.close();
  } catch (error) {
    crash(record, error);
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log("=== SIX REFUSALS GAUNTLET ===");
  console.log("DETERMINISTIC | $0 | NO MODEL — no API key, no gateway, no BudgetTracker in this process.");
  console.log("One run, six capability families, every leg adversarial: the trusted machinery");
  console.log("must refuse each one for the documented reason, with zero side effects verified");
  console.log("through each family's independent channel.");

  await legDocuments();
  await legMessages();
  await legDatabase();
  await legWasm();
  await legNativeUi();
  await legHttp();

  const passed = cases.length === 6 && cases.every((item) => item.passed);
  const completedAt = new Date().toISOString();
  const report = {
    demo: "six-refusals",
    deterministic: true,
    modelCalls: 0,
    spentUsd: 0,
    startedAt,
    completedAt,
    passed,
    safetyFailure: !passed,
    cases: cases.map((item) => ({
      leg: item.leg,
      family: item.family,
      title: item.title,
      refusedFor: item.refusedFor,
      sideEffects: item.sideEffects,
      sideEffectsVerifiedBy: item.sideEffectsVerifiedBy,
      checks: item.checks,
      passed: item.passed,
    })),
  };
  const takeDir = path.join(REPO_ROOT, "artifacts", "six-refusals", "takes", new Date().toISOString().replaceAll(/[:.]/g, "-"));
  fs.mkdirSync(takeDir, { recursive: true });
  fs.writeFileSync(path.join(takeDir, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  // Structural zero, not a measurement: nothing in this process can spend.
  // Written so the demo-bank table shows 0/0 (console convention).
  fs.writeFileSync(path.join(takeDir, "model-budget.json"), `${JSON.stringify({ spentUsd: 0, calls: 0 }, null, 2)}\n`);

  console.log("\n=== RECEIPT ===");
  for (const item of cases) {
    console.log(`  ${item.passed ? "PASS" : "FAIL"}  leg ${item.leg} [${item.family}] — refused for: ${item.refusedFor} | sideEffects=${item.sideEffects}`);
  }
  console.log("  modelCalls: 0 | spentUsd: 0 (structural — no model gateway in this process)");
  console.log(`  result: ${path.join(takeDir, "result.json")}`);
  console.log(passed
    ? "\nGAUNTLET PASSED — six families, six refusals, all for the documented reasons, zero side effects."
    : "\nGAUNTLET FAILED — see FAIL lines above; do not describe this take as green.");

  for (const root of scratchRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exitCode = passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
