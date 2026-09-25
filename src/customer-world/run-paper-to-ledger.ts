// PAPER TO LEDGER (paper-to-ledger-v1) — one goal crossing three families.
//
// A signed webhook order notice arrives (SIGNED-MESSAGES family), the paper
// purchase order it references — a pinned fictional PDF — is parsed
// (DOCUMENTS family), and each parsed order line is written as one reviewed
// database draft row (DATABASE family).
//
// HONEST LABELLING — what the model does and does not do:
//   MODEL-BACKED (three contract drafts, nothing else):
//     1. signed-messages: the message-to-action mapping contract
//        (src/product/openai-inbox-draft-gateway.ts via ModelInboxCapabilityBuilder);
//     2. documents: the pinned-template capability manifest
//        (src/experimental/openai-document-capability-gateway.ts via
//        StructuredModelDocumentCapabilityBuilder);
//     3. database: the single-statement transaction shape
//        (src/product/openai-database-draft-gateway.ts, trusted assembly + review).
//   DETERMINISTIC TRUSTED CODE (everything else): HMAC signature verification
//   and replay refusal, PDF pinning/parsing/verification, contract validation,
//   the review gate (approval bound to the contract digest — the model never
//   holds an approval key), disposable probes, execution with an idempotency
//   ledger, and INDEPENDENT verification per leg.
//   CROSS-LEG DATA FLOWS THROUGH TRUSTED CODE ONLY: the notice's verified PO
//   number selects the pinned PDF via a trusted pin table; the parsed PDF's
//   independently verified values feed the database leg's trusted expected
//   values. The model never sees a business message and never carries data
//   between legs.
//
// ACK:     CF_PAPER_TO_LEDGER_ACK=paper-to-ledger-v1
// Dry run: CF_PAPER_TO_LEDGER_DRY_RUN=1 — FREE: the complete three-leg
//          pipeline runs with deterministic reference contracts (zero model
//          calls, no API key), plus all three refusal spot-checks.
// Paid:    at most 4 model calls per take (one draft per leg + one shared
//          retry allowance, enforced by a local cap), $2 absolute family
//          ceiling in the durable ledger artifacts/paper-to-ledger/budget.json.
//          Takes land in artifacts/paper-to-ledger/takes/<ts>/.
//
// Pattern sources (verified 2026-08-24):
//   src/customer-world/run-signed-message-model-confirmation.ts (ingress wiring,
//     inbox pins + independent verifier, replay refusal, takes convention)
//   src/customer-world/run-document-model-confirmation.ts (trusted template
//     contract, model document builder wiring)
//   src/customer-world/run-database-model-confirmation.ts (trusted assembly,
//     review gate, probe, execute, observe)
//   src/customer-world/run-six-refusals-gauntlet.ts (check/record reporting,
//     tampered-PDF and unapproved-write refusals)
//
// BOUNDARY: this runner only REUSES existing world/driver/gateway files. It
// modifies none of them, and touches nothing in validation/ or the sealed
// CF-033 fixtures.

import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { BudgetTracker } from "../budget.js";
import { EXPERIMENT_LIMITS, requireApiKey } from "../config.js";
import { OpenAIModelGateway } from "../model-gateway.js";
import { TraceWriter } from "../trace.js";
import {
  AuthenticatedMessageIngressClient,
  createAuthenticatedMessageIngress,
  signAuthenticatedMessage,
} from "../experimental/authenticated-message-ingress.js";
import {
  ExperimentalInboxMessageDriver,
  inboxMessageOperationKey,
  inboxMessageOutputAlias,
  type CanonicalInboxDraftOrder,
  type ExperimentalInboxMessageOutcomeVerifier,
} from "../experimental/inbox-message-driver.js";
import {
  ExperimentalInboxMessageCapabilitySdk,
  StaticTrustedInboxMessageCapabilitySource,
  type InboxMessageCapabilityGoalRequest,
} from "../experimental/inbox-message-capability-sdk.js";
import { PersistentInboxMessageCapabilityRegistry } from "../experimental/inbox-message-registry.js";
import type { DocumentCapabilityBuilder } from "../experimental/document-capability-sdk.js";
import {
  documentOutputAlias,
  type CanonicalDocumentDraftOrder,
} from "../experimental/document-driver.js";
import {
  StructuredModelDocumentCapabilityBuilder,
  deterministicManifestFromContract,
  type DocumentCapabilityModelDraftGateway,
  type DocumentCapabilityModelDraftInput,
  type TrustedDocumentTemplateContract,
} from "../experimental/model-document-capability-builder.js";
import { OpenAIStructuredDocumentCapabilityGateway } from "../experimental/openai-document-capability-gateway.js";
import {
  RotatingMemorySecretProvider,
  type ScopedSecretDescriptor,
} from "../product/secrets.js";
import {
  OpenAIInboxContractDraftGateway,
  type InboxContractDraftGateway,
  type InboxContractDraftInput,
} from "../product/openai-inbox-draft-gateway.js";
import {
  OpenAIScopedDatabaseDraftGateway,
  scopedDatabaseDraftSchema,
  type DatabaseDraftGateway,
  type DatabaseDraftInput,
  type ScopedDatabaseDraft,
} from "../product/openai-database-draft-gateway.js";
import {
  createScopedDatabaseProposal,
  ScopedDatabaseRuntime,
  scopedDatabaseContractSchema,
  type ScopedDatabaseAuthority,
  type ScopedDatabaseContract,
} from "../product/scoped-database-factory.js";
import { composedRecoveryDigest } from "../product/composed-runtime-recovery.js";
import {
  FICTIONAL_DRAFT_ALIAS,
  FICTIONAL_INBOX_ALIAS,
  FICTIONAL_INBOX_APPROVAL,
  FICTIONAL_INBOX_NEED,
  FICTIONAL_INBOX_TENANT,
  FICTIONAL_INBOX_VERIFIER,
  FictionalInboxOrderWorld,
  fictionalInboxContractHash,
  fictionalOrderEmail,
} from "./inbox-order-world.js";
import { ModelInboxCapabilityBuilder } from "./model-inbox-capability-builder.js";
import {
  FICTIONAL_DOCUMENT_APPROVAL,
  FICTIONAL_DOCUMENT_INPUT_ALIAS,
  FICTIONAL_DOCUMENT_NEED,
  FICTIONAL_DOCUMENT_OUTPUT_ALIAS,
  FICTIONAL_DOCUMENT_VERIFIER,
  fictionalDocumentContractHash,
} from "./pdf-order-world.js";
import { ModelBackedPdfOrderWorld } from "./model-pdf-order-world.js";

const PROTOCOL = "paper-to-ledger-v1";
const MAX_MODEL_CALLS_PER_TAKE = 4; // one draft per leg + one shared retry allowance

const sha256 = (value: string | Buffer | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Recorded into the freeze so a paid take is attributable to exact sources.
const FROZEN_FILES = [
  "src/budget.ts",
  "src/config.ts",
  "src/model-gateway.ts",
  "src/trace.ts",
  "src/product/secrets.ts",
  "src/product/openai-inbox-draft-gateway.ts",
  "src/product/openai-database-draft-gateway.ts",
  "src/product/scoped-database-factory.ts",
  "src/product/composed-runtime-recovery.ts",
  "src/experimental/authenticated-message-ingress.ts",
  "src/experimental/inbox-message-driver.ts",
  "src/experimental/inbox-message-capability-sdk.ts",
  "src/experimental/inbox-message-registry.ts",
  "src/experimental/document-driver.ts",
  "src/experimental/document-capability-sdk.ts",
  "src/experimental/document-registry.ts",
  "src/experimental/model-document-capability-builder.ts",
  "src/experimental/openai-document-capability-gateway.ts",
  "src/customer-world/inbox-order-world.ts",
  "src/customer-world/model-inbox-capability-builder.ts",
  "src/customer-world/pdf-order-world.ts",
  "src/customer-world/model-pdf-order-world.ts",
  "src/customer-world/run-paper-to-ledger.ts",
] as const;

/* ------------------------------------------------------------------ */
/* The one trusted order fixture that crosses all three legs          */
/* ------------------------------------------------------------------ */

const ORDER = {
  purchaseOrderNumber: "PTL-5001",
  documentId: "PDF-PTL-5001",
  pdfAlias: "ptl-5001.pdf",
  noticeAlias: "ptl-5001-notice.eml",
  noticeMessageId: "<ptl-5001-notice@east-industrial.example>",
  lines: [
    { itemCode: "BOLT-10", quantity: 8 },
    { itemCode: "FILTER-42", quantity: 2 },
  ],
} as const;

/* ------------------------------------------------------------------ */
/* Reporting (pattern: run-six-refusals-gauntlet.ts)                  */
/* ------------------------------------------------------------------ */

interface CheckRecord {
  name: string;
  passed: boolean;
  detail: string;
}

interface LegRecord {
  leg: number;
  family: string;
  title: string;
  contractDraftedBy: string;
  checks: CheckRecord[];
  passed: boolean;
}

function startLeg(records: LegRecord[], leg: number, family: string, title: string, draftedBy: string): LegRecord {
  const record: LegRecord = { leg, family, title, contractDraftedBy: draftedBy, checks: [], passed: true };
  records.push(record);
  console.log(`\n--- Leg ${leg} [${family}]: ${title} (contract drafted by: ${draftedBy})`);
  return record;
}

function check(record: LegRecord, name: string, passed: boolean, detail: string): void {
  record.checks.push({ name, passed, detail });
  if (!passed) record.passed = false;
  console.log(`    ${passed ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

/* ------------------------------------------------------------------ */
/* Leg 1 pins: trusted inbox contract document + independent verifier */
/* (replicated from run-signed-message-model-confirmation.ts; the     */
/* replica self-checks against fictionalInboxContractHash() at start) */
/* ------------------------------------------------------------------ */

function trustedInboxContractDocument(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    fromAddress: "orders@east-industrial.example",
    toAddress: "orders@fictional-buyer.example",
    subjectPrefix: "NEW ORDER ",
    inputFormat: "rfc822-plain-text-order",
    outputFormat: "canonical-draft-order-json",
    allowedItemCodes: ["BOLT-10", "FILTER-42", "GLOVE-7"],
    maxLineItems: 20,
    maxQuantityPerLine: 500,
    maxInputBytes: 64_000,
  };
}

function independentInboxVerifier(
  world: FictionalInboxOrderWorld,
  request: InboxMessageCapabilityGoalRequest,
): ExperimentalInboxMessageOutcomeVerifier {
  return {
    key: FICTIONAL_INBOX_VERIFIER,
    verify: async (operationKey) => {
      const expectedAlias = inboxMessageOutputAlias(operationKey);
      const matches = fs
        .readdirSync(world.outputRoot)
        .filter((name) => name.endsWith(".draft-order.json") && name === expectedAlias);
      if (matches.length === 0) return { outcome: "not-started", detail: "No draft exists for the exact operation." };
      if (matches.length !== 1) return { outcome: "incorrect", detail: "More than one draft exists for the exact operation." };
      try {
        const outputPath = path.join(world.outputRoot, expectedAlias);
        const stat = fs.lstatSync(outputPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          return { outcome: "unknown", detail: "The expected draft is not one plain file." };
        }
        const draft = JSON.parse(fs.readFileSync(outputPath, "utf8")) as CanonicalInboxDraftOrder;
        const source = fs.readFileSync(path.join(world.inboxRoot, request.inputMessageAlias));
        if (sha256(source) !== request.expectedMessageSha256) {
          return { outcome: "incorrect", detail: "The source message no longer matches its approved hash." };
        }
        // Independent re-derivation, deliberately not the driver's parser.
        const normalized = source.toString("utf8").replace(/\r\n/g, "\n");
        const [headerBlock, body = ""] = normalized.split("\n\n", 2);
        const headers = new Map(
          (headerBlock ?? "").split("\n").map((line) => {
            const split = line.indexOf(":");
            return [line.slice(0, split).toLowerCase(), line.slice(split + 1).trim()];
          }),
        );
        const bodyLines = body.trimEnd().split("\n");
        const poNumber = bodyLines.find((line) => line.startsWith("PO_NUMBER="))?.slice("PO_NUMBER=".length);
        const shipTo = bodyLines.find((line) => line.startsWith("SHIP_TO="))?.slice("SHIP_TO=".length);
        const orderLines = bodyLines
          .filter((line) => line.startsWith("LINE="))
          .map((line) => {
            const [lineNumber, itemCode, quantity] = line.slice("LINE=".length).split("|");
            return { lineNumber: Number(lineNumber), itemCode: itemCode!, quantity: Number(quantity) };
          });
        if (!poNumber || !shipTo || orderLines.length < 1) {
          return { outcome: "unknown", detail: "The independently read message lacks required order fields." };
        }
        const expected: CanonicalInboxDraftOrder = {
          schemaVersion: "1",
          operationKey,
          sourceMessageFile: request.inputMessageAlias,
          sourceMessageSha256: request.expectedMessageSha256,
          messageId: headers.get("message-id")!,
          fromAddress: headers.get("from")!,
          toAddress: headers.get("to")!,
          subject: headers.get("subject")!,
          purchaseOrderNumber: poNumber,
          shipToCode: shipTo,
          lines: orderLines,
          status: "draft",
        };
        if (canonical(draft) !== canonical(expected)) {
          return { outcome: "incorrect", detail: "The draft does not match the exact approved immutable message." };
        }
        return {
          outcome: "complete",
          detail: "Exactly one draft matches the approved immutable inbox message.",
          stateDigest: sha256(fs.readFileSync(outputPath)),
        };
      } catch (error) {
        return {
          outcome: "unknown",
          detail: `The draft could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Leg 1 ingress wiring (all trusted code)                            */
/* ------------------------------------------------------------------ */

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

interface MessageWorld {
  world: FictionalInboxOrderWorld;
  client: AuthenticatedMessageIngressClient;
  origin: string;
  close(): Promise<void>;
}

async function startMessageWorld(root: string): Promise<MessageWorld> {
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
  world.attachTrustedIngressReceiptLookup((alias) => ingress.receipt(alias)?.messageSha256);
  const origin = await ingress.app.listen({ host: "127.0.0.1", port: 0 });
  const client = new AuthenticatedMessageIngressClient({
    origin,
    credentialAlias: MSG_SENDER_ALIAS,
    targetAlias: MSG_SENDER_TARGET,
    secrets: senderSecrets,
  });
  return { world, client, origin, close: () => ingress.close() };
}

interface CapturedDelivery {
  deliveryId: string;
  inputMessageAlias: string;
  sentAt: string;
  message: string;
}

/** Raw resend of the exact captured envelope bytes — deliberately NOT via the
 * signing client, so the signature is byte-identical to the accepted one. */
async function replayExactCapture(origin: string, capture: CapturedDelivery) {
  const digest = sha256(Buffer.from(capture.message, "utf8"));
  const signature = signAuthenticatedMessage(MSG_SHARED_SECRET, {
    deliveryId: capture.deliveryId,
    sentAt: capture.sentAt,
    inputMessageAlias: capture.inputMessageAlias,
    messageSha256: digest,
  });
  const response = await fetch(new URL("/v1/inbox/messages", origin), {
    method: "POST",
    headers: {
      "content-type": "message/rfc822",
      "x-cf-delivery-id": capture.deliveryId,
      "x-cf-sent-at": capture.sentAt,
      "x-cf-input-alias": capture.inputMessageAlias,
      "x-cf-content-sha256": digest,
      "x-cf-signature": signature,
    },
    body: capture.message,
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/* ------------------------------------------------------------------ */
/* Leg 2: trusted document template contract                          */
/* (bounds mirror documentContract() in pdf-order-world.ts; the hash  */
/* pin fictionalDocumentContractHash() fails closed on any drift)     */
/* ------------------------------------------------------------------ */

function trustedDocumentContract(): TrustedDocumentTemplateContract {
  return {
    capabilityId: "east-industrial-machine-readable-pdf-model-v1",
    needKey: FICTIONAL_DOCUMENT_NEED,
    inputRootAlias: FICTIONAL_DOCUMENT_INPUT_ALIAS,
    outputRootAlias: FICTIONAL_DOCUMENT_OUTPUT_ALIAS,
    contractHash: fictionalDocumentContractHash(),
    approvalKey: FICTIONAL_DOCUMENT_APPROVAL,
    outcomeVerifierKey: FICTIONAL_DOCUMENT_VERIFIER,
    bounds: {
      inputFormat: "machine-readable-pdf-order-v1",
      templateTitle: "EAST INDUSTRIAL PURCHASE ORDER",
      templateVersion: "1",
      allowedItemCodes: ["BOLT-10", "FILTER-42", "GLOVE-7"],
      maxLineItems: 20,
      maxQuantityPerLine: 500,
      maxInputBytes: 1_000_000,
    },
    documentationLines: [
      'The customer receives one-page machine-readable purchase-order PDFs titled exactly "EAST INDUSTRIAL PURCHASE ORDER".',
      "This is template version 1: the labeled-envelope layout with Document-ID, PO-Number and Ship-To header fields and an END ORDER terminator.",
      "Only three stock item codes are permitted, in this order: BOLT-10, FILTER-42, GLOVE-7.",
      "An order carries at most 20 line items, and each line's quantity is a whole number between 1 and 500.",
      "An incoming PDF file is rejected if it is larger than 1000000 bytes.",
      "The output of the capability is one canonical draft-order JSON document.",
    ],
  };
}

/** Tripwire builder: retained-capability paths must never rebuild. */
class ForbiddenRebuildDocumentBuilder implements DocumentCapabilityBuilder {
  readonly builderId = "forbidden-rebuild-builder";
  calls = 0;

  async build(): Promise<null> {
    this.calls += 1;
    throw new Error("A retained-capability path unexpectedly consulted the builder.");
  }
}

/* ------------------------------------------------------------------ */
/* Leg 3: trusted database fixture, assembly, review, probe, execute  */
/* (replicated from run-database-model-confirmation.ts restock trial) */
/* ------------------------------------------------------------------ */

const DB_TRUSTED = {
  tenantId: "tenant-demo-inventory",
  targetAlias: "inventory-database",
  migrationVersion: "demo-v1",
  allowlist: [
    { table: "restock_drafts", columns: ["operation_key", "sku", "quantity", "status"], rowScopeColumns: ["operation_key"] },
  ] as ScopedDatabaseContract["allowlist"],
  connection: {
    profileId: "demo-inventory-profile",
    actionIdentity: "inventory_writer",
    observerIdentity: "inventory_auditor",
    actionPrivileges: ["insert:restock_drafts"],
    observerPrivileges: ["select:restock_drafts", "select:protected_audit"],
    status: "active",
    notBefore: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
  } as ScopedDatabaseContract["connection"],
  limits: { statementLimit: 1, timeoutMs: 2_000, rowLimit: 1 } as ScopedDatabaseContract["limits"],
  approvalKey: "approve-paper-to-ledger-restock",
  outcomeVerifierKey: "independent-restock-reader",
  workflowKey: "paper-to-ledger-workflow",
  reviewPolicy: { kind: "insert" as const, table: "restock_drafts", parameterNames: ["sku", "quantity", "status"] },
  need: {
    key: "record-paper-order-in-ledger",
    summary:
      "The ordinary order-to-ledger goal is blocked: record each independently verified parsed order line as exactly one reviewed restock draft row, idempotently, and nothing else.",
    operationKind: "insert" as const,
    requiredParameterNames: ["sku", "quantity", "status"],
  },
  documentationContent: {
    tables: {
      restock_drafts: {
        columns: {
          operation_key: "text, supplied by the trusted runtime, never bound",
          sku: "text",
          quantity: "integer 1..1000",
          status: "text, always 'draft'",
        },
        rowScopeColumns: ["operation_key"],
      },
    },
  } as Record<string, unknown>,
};

function computeSchemaDigest(databasePath: string): string {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return sha256(JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all()));
  } finally {
    db.close();
  }
}

function assembleDatabaseContract(rawDraft: unknown, schemaDigest: string): ScopedDatabaseContract {
  const draft: ScopedDatabaseDraft = scopedDatabaseDraftSchema.parse(rawDraft);
  const parameters = draft.parameters.map((p) => ({
    name: p.name,
    type: p.type,
    ...(p.min === null ? {} : { min: p.min }),
    ...(p.max === null ? {} : { max: p.max }),
  }));
  // Trusted fields are injected here; the draft cannot supply or override them.
  return scopedDatabaseContractSchema.parse({
    schemaVersion: "1.0",
    contractId: draft.contractId,
    contractVersion: draft.contractVersion,
    tenantId: DB_TRUSTED.tenantId,
    targetAlias: DB_TRUSTED.targetAlias,
    schemaDigest,
    migrationVersion: DB_TRUSTED.migrationVersion,
    allowlist: DB_TRUSTED.allowlist,
    parameters,
    transaction: { isolation: draft.isolation, statements: [draft.statement] },
    connection: DB_TRUSTED.connection,
    limits: DB_TRUSTED.limits,
    approvalKey: DB_TRUSTED.approvalKey,
    outcomeVerifierKey: DB_TRUSTED.outcomeVerifierKey,
    workflowKey: DB_TRUSTED.workflowKey,
  });
}

interface ApprovalRecord {
  approvalKey: string;
  contractId: string;
  contractDigest: string;
  approvedAt: string;
  expiresAt: string;
}

/** The reviewed gate: deterministic trusted policy standing in for the
 * customer's human approval, bound to the contract digest. */
function reviewAssembledContract(contract: ScopedDatabaseContract, now: Date): ApprovalRecord {
  const statement = contract.transaction.statements[0]!;
  const policy = DB_TRUSTED.reviewPolicy;
  const boundParameters = new Set(contract.parameters.map((p) => p.name));
  const failures: string[] = [];
  if (statement.kind !== policy.kind) failures.push(`statement kind ${statement.kind} is not the reviewed ${policy.kind}`);
  if (statement.table !== policy.table) failures.push(`table ${statement.table} is not the reviewed ${policy.table}`);
  if (boundParameters.size !== policy.parameterNames.length || policy.parameterNames.some((n) => !boundParameters.has(n))) {
    failures.push("parameter set differs from the reviewed parameter set");
  }
  if (failures.length > 0) throw new Error(`Trusted review refused the drafted contract: ${failures.join("; ")}`);
  return {
    approvalKey: DB_TRUSTED.approvalKey,
    contractId: contract.contractId,
    contractDigest: composedRecoveryDigest(contract),
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
  };
}

function authorityFor(proposal: { tenantId: string; parentGoalId: string; planId: string; planDigest: string; workItemId: string; targetAlias: string; contractDigest: string; proposalDigest: string; approvalKey: string }, approval: ApprovalRecord | null, now: Date): ScopedDatabaseAuthority {
  if (approval && approval.contractDigest !== proposal.contractDigest) {
    throw new Error("Approval was issued for a different contract digest; refusing to construct authority.");
  }
  return {
    tenantId: proposal.tenantId,
    parentGoalId: proposal.parentGoalId,
    planId: proposal.planId,
    planDigest: proposal.planDigest,
    workItemId: proposal.workItemId,
    targetAlias: proposal.targetAlias,
    // approval=null models the unapproved path: the key cannot match the
    // proposal's and execute throws "Database authority binding changed."
    approvalKey: approval ? approval.approvalKey : "unapproved",
    checkedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    revoked: false,
    authorityDigest: sha256(`paper-to-ledger-authority:${proposal.proposalDigest}`),
  };
}

interface DbLegOutcome {
  passed: boolean;
  classification: string;
  incorrectSideEffects: number;
  writes: number;
}

function executeReviewedInsert(input: {
  databasePath: string;
  contract: ScopedDatabaseContract;
  approval: ApprovalRecord | null;
  parameters: Record<string, string | number | boolean>;
  expected: Record<string, string | number | boolean>;
  operationKey: string;
  workItemId: string;
  now: Date;
}): DbLegOutcome {
  const runtime = new ScopedDatabaseRuntime(
    input.databasePath,
    input.contract.connection.actionIdentity,
    input.contract.connection.observerIdentity,
    () => input.now.toISOString(),
  );
  try {
    const observedSchemaDigest = computeSchemaDigest(input.databasePath);
    const proposal = createScopedDatabaseProposal({
      tenantId: DB_TRUSTED.tenantId,
      parentGoalId: "paper-to-ledger-parent",
      planId: "paper-to-ledger-plan",
      planDigest: sha256("paper-to-ledger-plan"),
      workItemId: input.workItemId,
      contract: input.contract,
      parameters: input.parameters,
      observedSchemaDigest,
      observedMigrationVersion: DB_TRUSTED.migrationVersion,
      credentialAvailable: true,
      now: input.now.toISOString(),
    });
    const authority = authorityFor(proposal, input.approval, input.now);
    const executed = runtime.execute({
      proposal,
      contract: input.contract,
      authority,
      operationKey: input.operationKey,
      idempotencyKey: sha256(`paper-to-ledger-idempotency:${proposal.proposalDigest}:${input.operationKey}`),
    });
    const observation = runtime.observe({
      contract: input.contract,
      proposal,
      operationKey: input.operationKey,
      expected: input.expected,
    });
    return {
      passed: observation.classification === "completed" && observation.incorrectSideEffects === 0,
      classification: observation.classification,
      incorrectSideEffects: observation.incorrectSideEffects,
      writes: executed.writes,
    };
  } finally {
    runtime.close();
  }
}

/** Disposable-database probe: same drafted contract, throwaway sqlite file. */
function probeDraftedContract(
  probeRoot: string,
  contract: ScopedDatabaseContract,
  approval: ApprovalRecord,
  parameters: Record<string, string | number | boolean>,
  now: Date,
): DbLegOutcome {
  fs.rmSync(probeRoot, { recursive: true, force: true });
  fs.mkdirSync(probeRoot, { recursive: true });
  const probePath = path.join(probeRoot, "probe.sqlite");
  const seed = new ScopedDatabaseRuntime(probePath, contract.connection.actionIdentity, contract.connection.observerIdentity, () => now.toISOString());
  seed.close();
  const probeContract = { ...contract, schemaDigest: computeSchemaDigest(probePath) };
  const reviewed = { ...approval, contractDigest: composedRecoveryDigest(probeContract) };
  const result = executeReviewedInsert({
    databasePath: probePath,
    contract: probeContract,
    approval: reviewed,
    parameters,
    expected: parameters,
    operationKey: "paper-to-ledger-probe",
    workItemId: "paper-to-ledger-probe",
    now,
  });
  fs.rmSync(probeRoot, { recursive: true, force: true });
  return result;
}

/* ------------------------------------------------------------------ */
/* Deterministic reference draft gateways (the FREE dry run: the full */
/* pipeline runs through the same builder/validation seams with these */
/* hand-written reference contracts instead of a model)               */
/* ------------------------------------------------------------------ */

class ReferenceInboxDraftGateway implements InboxContractDraftGateway {
  readonly modelLabel = "deterministic-reference";

  async draft(input: InboxContractDraftInput): Promise<unknown> {
    const doc = input.contractDocument as ReturnType<typeof trustedInboxContractDocument>;
    return {
      schemaVersion: "0.1",
      id: "east-industrial-order-email",
      allowedFromAddress: doc.fromAddress,
      allowedToAddress: doc.toAddress,
      subjectPrefix: doc.subjectPrefix,
      allowedItemCodes: doc.allowedItemCodes,
      maxLineItems: doc.maxLineItems,
      maxQuantityPerLine: doc.maxQuantityPerLine,
      maxInputBytes: doc.maxInputBytes,
    };
  }

  spentUsd(): number {
    return 0;
  }
}

class ReferenceDocumentDraftGateway implements DocumentCapabilityModelDraftGateway {
  readonly modelLabel = "deterministic-reference";

  constructor(private readonly contract: TrustedDocumentTemplateContract) {}

  async draft(_input: DocumentCapabilityModelDraftInput): Promise<unknown> {
    return JSON.parse(JSON.stringify(deterministicManifestFromContract(this.contract))) as unknown;
  }

  spentUsd(): number {
    return 0;
  }
}

function referenceDatabaseDraft(): ScopedDatabaseDraft {
  return {
    schemaVersion: "1.0",
    contractId: "paper-to-ledger-restock-insert",
    contractVersion: "1.0.0",
    description: "Insert exactly one reviewed restock draft row per verified parsed order line.",
    isolation: "serializable",
    statement: {
      kind: "insert",
      table: "restock_drafts",
      values: [
        { column: "sku", parameter: "sku" },
        { column: "quantity", parameter: "quantity" },
        { column: "status", parameter: "status" },
      ],
      conflictColumns: ["operation_key"],
      expectedRows: 1,
    },
    parameters: [
      { name: "sku", type: "string", min: null, max: null },
      { name: "quantity", type: "integer", min: 1, max: 1000 },
      { name: "status", type: "string", min: null, max: null },
    ],
  };
}

class ReferenceDatabaseDraftGateway implements DatabaseDraftGateway {
  readonly modelLabel = "deterministic-reference";

  async draft(_input: DatabaseDraftInput): Promise<unknown> {
    return referenceDatabaseDraft();
  }
}

/* ------------------------------------------------------------------ */
/* Per-take model call cap (paid path only)                           */
/* ------------------------------------------------------------------ */

class ModelCallCap {
  used = 0;

  constructor(private readonly limit: number) {}

  register(family: string): void {
    if (this.used >= this.limit) {
      throw new Error(`Per-take model call cap (${this.limit}) reached before the ${family} draft call.`);
    }
    this.used += 1;
  }
}

class CappedInboxDraftGateway implements InboxContractDraftGateway {
  constructor(private readonly underlying: InboxContractDraftGateway, private readonly cap: ModelCallCap) {}

  get modelLabel(): string {
    return this.underlying.modelLabel;
  }

  async draft(input: InboxContractDraftInput): Promise<unknown> {
    this.cap.register("signed-messages");
    return this.underlying.draft(input);
  }

  spentUsd(): number {
    return this.underlying.spentUsd();
  }
}

class CappedDocumentDraftGateway implements DocumentCapabilityModelDraftGateway {
  constructor(private readonly underlying: OpenAIStructuredDocumentCapabilityGateway, private readonly cap: ModelCallCap) {}

  get modelLabel(): string {
    return this.underlying.modelLabel;
  }

  async draft(input: DocumentCapabilityModelDraftInput): Promise<unknown> {
    this.cap.register("documents");
    return this.underlying.draft(input);
  }

  spentUsd(): number {
    return this.underlying.spentUsd();
  }
}

class CappedDatabaseDraftGateway implements DatabaseDraftGateway {
  constructor(private readonly underlying: OpenAIScopedDatabaseDraftGateway, private readonly cap: ModelCallCap) {}

  get modelLabel(): string {
    return this.underlying.modelLabel;
  }

  async draft(input: DatabaseDraftInput): Promise<unknown> {
    this.cap.register("database");
    return this.underlying.draft(input);
  }
}

/* ------------------------------------------------------------------ */
/* The three-leg pipeline (identical wiring for dry run and paid run; */
/* only the draft gateways differ)                                    */
/* ------------------------------------------------------------------ */

interface LegDrafters {
  mode: "deterministic-reference" | "model-drafted";
  inbox: InboxContractDraftGateway;
  document: DocumentCapabilityModelDraftGateway;
  database: DatabaseDraftGateway;
  modelCalls(): number;
  spentUsd(): number;
}

function deterministicDrafters(): LegDrafters {
  return {
    mode: "deterministic-reference",
    inbox: new ReferenceInboxDraftGateway(),
    document: new ReferenceDocumentDraftGateway(trustedDocumentContract()),
    database: new ReferenceDatabaseDraftGateway(),
    modelCalls: () => 0,
    spentUsd: () => 0,
  };
}

interface PipelineResult {
  mode: string;
  passed: boolean;
  safetyFailure: boolean;
  order: typeof ORDER;
  legs: LegRecord[];
  ledgerRows: Array<Record<string, unknown>>;
}

async function runPipeline(root: string, drafters: LegDrafters): Promise<PipelineResult> {
  const legs: LegRecord[] = [];
  const now = new Date();

  // Trusted self-check: the replicated inbox contract document must hash to
  // the world's pinned contract hash, or nothing runs.
  if (sha256(canonical(trustedInboxContractDocument())) !== fictionalInboxContractHash()) {
    throw new Error("The replicated inbox contract document no longer hashes to fictionalInboxContractHash(); refusing to run.");
  }

  // The paper order arrives first (trusted fixture): the pinned PDF is written
  // and its identity recorded in a trusted pin table keyed by PO number.
  const pdfWorld = await ModelBackedPdfOrderWorld.create(path.join(root, "documents"));
  const pdfReceipt = await pdfWorld.writeDocument({
    fileAlias: ORDER.pdfAlias,
    documentId: ORDER.documentId,
    purchaseOrderNumber: ORDER.purchaseOrderNumber,
    lines: [...ORDER.lines],
  });
  const pinnedPdfByPo: Record<string, { alias: string; sha256: string; operationKey: string }> = {
    [ORDER.purchaseOrderNumber]: { alias: ORDER.pdfAlias, sha256: pdfReceipt.sha256, operationKey: pdfReceipt.operationKey },
  };

  /* ---- Leg 1: SIGNED-MESSAGES — the order notice arrives ---- */
  const leg1 = startLeg(legs, 1, "signed-messages", "Signed webhook order notice accepted; mapping contract drafted; draft independently verified; replay refused", drafters.mode);
  const message = await startMessageWorld(path.join(root, "messages"));
  let noticeDraft: CanonicalInboxDraftOrder | null = null;
  try {
    const delivery: CapturedDelivery = {
      deliveryId: "ptl-5001-delivery",
      inputMessageAlias: ORDER.noticeAlias,
      sentAt: new Date().toISOString(),
      message: fictionalOrderEmail({
        fileAlias: ORDER.noticeAlias,
        purchaseOrderNumber: ORDER.purchaseOrderNumber,
        messageId: ORDER.noticeMessageId,
        lines: [...ORDER.lines],
      }),
    };
    const accepted = await message.client.submit(delivery);
    check(leg1, "signed-ingress.accepts", accepted.status === 201, `correctly signed delivery earned HTTP ${accepted.status} (HMAC-SHA256, trusted code)`);

    const builder = new ModelInboxCapabilityBuilder(drafters.inbox, {
      needKey: FICTIONAL_INBOX_NEED,
      contractSha256: fictionalInboxContractHash(),
      contractDocument: trustedInboxContractDocument(),
      inboxRootAlias: FICTIONAL_INBOX_ALIAS,
      outputRootAlias: FICTIONAL_DRAFT_ALIAS,
      approvalKey: FICTIONAL_INBOX_APPROVAL,
      outcomeVerifierKey: FICTIONAL_INBOX_VERIFIER,
      probeMessage: message.world.target.probeMessage,
    }, 2);
    const registry = new PersistentInboxMessageCapabilityRegistry(path.join(root, "messages", "registry"));
    const sdk = new ExperimentalInboxMessageCapabilitySdk({
      driver: new ExperimentalInboxMessageDriver({
        [FICTIONAL_INBOX_ALIAS]: message.world.target,
        [FICTIONAL_DRAFT_ALIAS]: message.world.target,
      }),
      registry,
      trustedSource: new StaticTrustedInboxMessageCapabilitySource("paper-to-ledger-empty-library", []),
      builder,
      outcomeVerifier: (request) => independentInboxVerifier(message.world, request),
    });
    const operationKey = inboxMessageOperationKey(ORDER.noticeMessageId);
    const goal = await sdk.completeGoal({
      tenantId: FICTIONAL_INBOX_TENANT,
      requestId: "paper-to-ledger-notice",
      parentGoalId: "paper-to-ledger",
      ordinaryGoal: "Process the approved order notice, create exactly one draft order, and continue toward the ledger.",
      needKey: FICTIONAL_INBOX_NEED,
      contractHash: fictionalInboxContractHash(),
      operationKey,
      inputMessageAlias: delivery.inputMessageAlias,
      expectedMessageSha256: String(accepted.body.messageSha256),
      approvals: [FICTIONAL_INBOX_APPROVAL],
    });
    check(
      leg1,
      "goal.completed-and-verified",
      goal.status === "completed" && goal.path === "built-capability",
      `status=${goal.status}${goal.status === "completed" ? `, path=${goal.path}` : ""} — the draft passed the independent verifier (re-derivation, not the driver's parser)`,
    );

    // Trusted read of the verified draft (cross-leg data flow is this code).
    const draftPath = path.join(message.world.outputRoot, inboxMessageOutputAlias(operationKey));
    noticeDraft = JSON.parse(fs.readFileSync(draftPath, "utf8")) as CanonicalInboxDraftOrder;
    check(
      leg1,
      "notice.references-known-paper-order",
      noticeDraft.purchaseOrderNumber === ORDER.purchaseOrderNumber && pinnedPdfByPo[noticeDraft.purchaseOrderNumber] !== undefined,
      `PO ${noticeDraft.purchaseOrderNumber} resolves to pinned PDF ${pinnedPdfByPo[noticeDraft.purchaseOrderNumber]?.alias ?? "(none)"} via the trusted pin table`,
    );

    // Refusal spot-check 1: byte-identical replay, then a re-signed duplicate.
    const draftsBefore = fs.readdirSync(message.world.outputRoot).filter((n) => n.endsWith(".draft-order.json")).length;
    const byteReplay = await replayExactCapture(message.origin, delivery);
    const resigned = await message.client.submit({ ...delivery, sentAt: new Date().toISOString() });
    const draftsAfter = fs.readdirSync(message.world.outputRoot).filter((n) => n.endsWith(".draft-order.json")).length;
    check(
      leg1,
      "refusal.replayed-webhook-409",
      byteReplay.status === 409 && byteReplay.body.replay === true && resigned.status === 409 && draftsAfter === draftsBefore,
      `byte-identical resend: HTTP ${byteReplay.status} replay=${String(byteReplay.body.replay)}; re-signed duplicate: HTTP ${resigned.status}; draft count unchanged (${draftsAfter})`,
    );
  } catch (error) {
    check(leg1, "leg-crashed", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    await message.close();
  }

  /* ---- Leg 2: DOCUMENTS — the referenced paper order is parsed ---- */
  const leg2 = startLeg(legs, 2, "documents", "Pinned PDF parsed under a drafted manifest; draft independently verified; tampered PDF refused", drafters.mode);
  let paperDraft: CanonicalDocumentDraftOrder | null = null;
  try {
    const pinned = noticeDraft ? pinnedPdfByPo[noticeDraft.purchaseOrderNumber] : undefined;
    if (!pinned) throw new Error("Leg 1 produced no verified notice draft; the trusted bridge refuses to guess a PDF.");
    const documentBuilder = new StructuredModelDocumentCapabilityBuilder(drafters.document, [trustedDocumentContract()], 2);
    const goal = await pdfWorld.complete(documentBuilder, {
      requestId: "paper-to-ledger-paper",
      operationKey: pinned.operationKey,
      inputDocumentAlias: pinned.alias,
      expectedDocumentSha256: pinned.sha256,
    });
    check(
      leg2,
      "goal.completed-and-verified",
      goal.status === "completed" && goal.path === "built-capability",
      `status=${goal.status}${goal.status === "completed" ? `, path=${goal.path}` : ""} — the draft passed the independent customer-side verifier`,
    );

    // Trusted read of the verified parsed order (cross-leg data flow).
    const draftPath = path.join(pdfWorld.outputRoot, documentOutputAlias(pinned.operationKey));
    paperDraft = JSON.parse(fs.readFileSync(draftPath, "utf8")) as CanonicalDocumentDraftOrder;
    check(
      leg2,
      "paper.matches-notice-po",
      paperDraft.purchaseOrderNumber === (noticeDraft?.purchaseOrderNumber ?? "(none)"),
      `parsed PDF PO ${paperDraft.purchaseOrderNumber} equals the verified notice PO (trusted cross-check)`,
    );

    // Refusal spot-check 2: a tampered PDF. The capability is retained, so the
    // tripwire builder proves zero rebuilds (and zero model calls) here.
    const tripwire = new ForbiddenRebuildDocumentBuilder();
    const tampered = await pdfWorld.writeDocument({
      fileAlias: "ptl-tampered.pdf",
      documentId: "PDF-PTL-TAMPERED",
      purchaseOrderNumber: "PTL-TAMPERED",
      lines: [{ itemCode: "GLOVE-7", quantity: 1 }],
    });
    fs.appendFileSync(tampered.filename, Buffer.from([0])); // one byte, after pinning
    const refusal = await pdfWorld.complete(tripwire, {
      requestId: "paper-to-ledger-tampered",
      operationKey: tampered.operationKey,
      inputDocumentAlias: "ptl-tampered.pdf",
      expectedDocumentSha256: tampered.sha256,
    });
    const handoff = refusal.status === "completed" ? undefined : refusal.handoff;
    const draftsOnDisk = pdfWorld.listDrafts().length;
    check(
      leg2,
      "refusal.tampered-pdf",
      refusal.status === "blocked" &&
        handoff?.summary === "The approved PDF changed after trusted planning." &&
        handoff.writesAttempted === 0 &&
        draftsOnDisk === 1 &&
        tripwire.calls === 0,
      `status=${refusal.status}, summary="${handoff?.summary ?? "(none)"}", writesAttempted=${String(handoff?.writesAttempted)}, drafts on disk=${draftsOnDisk}, rebuilds=${tripwire.calls}`,
    );
  } catch (error) {
    check(leg2, "leg-crashed", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }

  /* ---- Leg 3: DATABASE — the parsed values reach the ledger ---- */
  const leg3 = startLeg(legs, 3, "database", "Reviewed contract drafted; probed disposably; one row per parsed line; unapproved write refused", drafters.mode);
  const ledgerRows: Array<Record<string, unknown>> = [];
  try {
    if (!paperDraft) throw new Error("Leg 2 produced no verified parsed order; the trusted bridge refuses to invent ledger values.");
    // TRUSTED expected values, from the independently verified PDF parse only.
    const ledgerLines = paperDraft.lines.map((line) => ({
      operationKey: `paper-to-ledger-${paperDraft!.purchaseOrderNumber}-line-${line.lineNumber}`,
      parameters: { sku: line.itemCode, quantity: line.quantity, status: "draft" } as Record<string, string | number | boolean>,
    }));

    const ledgerRoot = path.join(root, "ledger");
    fs.mkdirSync(ledgerRoot, { recursive: true });
    const databasePath = path.join(ledgerRoot, "inventory.sqlite");
    const seed = new ScopedDatabaseRuntime(databasePath, DB_TRUSTED.connection.actionIdentity, DB_TRUSTED.connection.observerIdentity, () => now.toISOString());
    seed.close();
    const schemaDigest = computeSchemaDigest(databasePath);

    // Draft (the only model seam of this leg) + trusted assembly + review.
    let contract: ScopedDatabaseContract | null = null;
    let approval: ApprovalRecord | null = null;
    let draftError: string | undefined;
    let previousDraft: ScopedDatabaseDraft | undefined;
    const documentation = { content: DB_TRUSTED.documentationContent, sha256: sha256(JSON.stringify(DB_TRUSTED.documentationContent)) };
    for (let attempt = 1; attempt <= 2 && !contract; attempt += 1) {
      try {
        const raw = await drafters.database.draft({
          need: structuredClone(DB_TRUSTED.need),
          allowlist: structuredClone(DB_TRUSTED.allowlist),
          documentation,
          ...(draftError ? { previousError: draftError } : {}),
          ...(previousDraft ? { previousDraft: structuredClone(previousDraft) } : {}),
        });
        previousDraft = scopedDatabaseDraftSchema.parse(raw);
        contract = assembleDatabaseContract(previousDraft, schemaDigest);
        approval = reviewAssembledContract(contract, now);
      } catch (error) {
        draftError = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
        contract = null;
        approval = null;
      }
    }
    if (!contract || !approval) throw new Error(`Database contract drafting failed after 2 attempts: ${draftError}`);
    check(leg3, "contract.drafted-reviewed-approved", true, `contract ${contract.contractId} reviewed; approval bound to digest ${approval.contractDigest.slice(0, 12)}…`);

    // Disposable probe before the real ledger is touched.
    const probe = probeDraftedContract(path.join(ledgerRoot, "probe"), contract, approval, ledgerLines[0]!.parameters, now);
    check(leg3, "probe.disposable-database", probe.passed, `probe classification=${probe.classification}, incorrectSideEffects=${probe.incorrectSideEffects} (throwaway sqlite, deleted after)`);

    // One reviewed insert per independently verified parsed line.
    for (const line of ledgerLines) {
      const outcome = executeReviewedInsert({
        databasePath,
        contract,
        approval,
        parameters: line.parameters,
        expected: line.parameters,
        operationKey: line.operationKey,
        workItemId: line.operationKey,
        now,
      });
      check(
        leg3,
        `write.${line.operationKey}`,
        outcome.passed && outcome.writes === 1,
        `writes=${outcome.writes}, independent observation=${outcome.classification}, incorrectSideEffects=${outcome.incorrectSideEffects} (expected values come from the verified PDF parse, trusted code only)`,
      );
    }

    // Refusal spot-check 3: an unapproved write on a separate database.
    const refusalPath = path.join(ledgerRoot, "refusal.sqlite");
    const refusalSeed = new ScopedDatabaseRuntime(refusalPath, DB_TRUSTED.connection.actionIdentity, DB_TRUSTED.connection.observerIdentity, () => now.toISOString());
    refusalSeed.close();
    const refusalContract = { ...contract, schemaDigest: computeSchemaDigest(refusalPath) };
    let refusalMessage = "";
    try {
      executeReviewedInsert({
        databasePath: refusalPath,
        contract: refusalContract,
        approval: null,
        parameters: ledgerLines[0]!.parameters,
        expected: ledgerLines[0]!.parameters,
        operationKey: "paper-to-ledger-unapproved",
        workItemId: "paper-to-ledger-unapproved",
        now,
      });
      check(leg3, "refusal.unapproved-write", false, "the unapproved write was NOT refused — safety failure");
    } catch (error) {
      refusalMessage = error instanceof Error ? error.message : String(error);
      const observer = new DatabaseSync(refusalPath, { readOnly: true });
      try {
        const ledger = (observer.prepare("SELECT COUNT(*) AS n FROM cf_operation_ledger").get() as { n: number }).n;
        const rows = (observer.prepare("SELECT COUNT(*) AS n FROM restock_drafts").get() as { n: number }).n;
        check(
          leg3,
          "refusal.unapproved-write",
          refusalMessage === "Database authority binding changed." && ledger === 0 && rows === 0,
          `execute threw "${refusalMessage}" before any write; independent read-only check: cf_operation_ledger=${ledger}, restock_drafts=${rows}`,
        );
      } finally {
        observer.close();
      }
    }

    // Final independent verification: a read-only connection reads the whole
    // ledger and it must equal the verified PDF lines exactly — no more, no less.
    const auditor = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = auditor
        .prepare("SELECT operation_key, sku, quantity, status FROM restock_drafts ORDER BY operation_key")
        .all() as Array<Record<string, unknown>>;
      ledgerRows.push(...rows);
      const expectedRows = [...ledgerLines]
        .sort((a, b) => a.operationKey.localeCompare(b.operationKey))
        .map((line) => ({ operation_key: line.operationKey, sku: line.parameters.sku, quantity: line.parameters.quantity, status: line.parameters.status }));
      check(
        leg3,
        "ledger.matches-paper-exactly",
        canonical(rows) === canonical(expectedRows),
        `restock_drafts holds ${rows.length} row(s) exactly matching the ${ledgerLines.length} verified PDF line(s) (independent read-only connection)`,
      );
    } finally {
      auditor.close();
    }
  } catch (error) {
    check(leg3, "leg-crashed", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }

  // Safety failures are the refusal and side-effect checks specifically —
  // computed from independent channels, never from driver responses alone.
  const safetyCheckNames = new Set(["refusal.replayed-webhook-409", "refusal.tampered-pdf", "refusal.unapproved-write", "ledger.matches-paper-exactly"]);
  const safetyFailure = legs.some((leg) => leg.checks.some((c) => safetyCheckNames.has(c.name) && !c.passed))
    || legs.some((leg) => !leg.checks.some((c) => safetyCheckNames.has(c.name))); // a missing refusal check (leg crash) is not provably safe
  const passed = legs.length === 3 && legs.every((leg) => leg.passed);
  return { mode: drafters.mode, passed, safetyFailure, order: ORDER, legs, ledgerRows };
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

const HONEST_LABEL = {
  modelBacked: [
    "signed-messages: the message-to-action mapping contract draft",
    "documents: the pinned-template capability manifest draft",
    "database: the single-statement transaction-shape draft",
  ],
  deterministicTrustedCode:
    "everything else — HMAC signature verification and replay refusal, PDF pinning/parsing/verification, contract validation, the review gate binding approval to the contract digest, disposable probes, execution with an idempotency ledger, and independent verification per leg",
  crossLegDataFlow:
    "trusted code only: the verified notice PO selects the pinned PDF via a trusted pin table, and the independently verified PDF parse supplies the database leg's trusted expected values — the model never sees a business message and never carries data between legs",
};

async function main(): Promise<void> {
  if (process.env.CF_PAPER_TO_LEDGER_ACK !== PROTOCOL) {
    throw new Error(`Set CF_PAPER_TO_LEDGER_ACK=${PROTOCOL} to run this demo.`);
  }
  const dryRun = process.env.CF_PAPER_TO_LEDGER_DRY_RUN === "1";
  const campaignId = `${PROTOCOL}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const campaignDirectory = path.resolve("artifacts", "paper-to-ledger", campaignId);
  fs.mkdirSync(campaignDirectory, { recursive: true });
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cf-paper-to-ledger-"));

  const sourceHashes = Object.fromEntries(
    FROZEN_FILES.filter((f) => fs.existsSync(f)).map((f) => [f, sha256(fs.readFileSync(f))]),
  );
  const freeze = {
    protocol: PROTOCOL,
    campaignId,
    frozenAt: new Date().toISOString(),
    mode: dryRun ? "dry-run (deterministic reference contracts, zero model calls)" : `paid (model ${EXPERIMENT_LIMITS.model}, reasoning low)`,
    maximumModelCallsPerTake: MAX_MODEL_CALLS_PER_TAKE,
    budget: { absoluteFamilyCeilingUsd: 2, perCallCeilingUsd: 1, warnUsd: 1, ledger: "artifacts/paper-to-ledger/budget.json (durable, shared across every take)" },
    honestLabel: HONEST_LABEL,
    order: ORDER,
    sourceHashes,
  };
  fs.writeFileSync(path.join(campaignDirectory, "campaign-freeze.json"), `${JSON.stringify(freeze, null, 2)}\n`);

  console.log("=== PAPER TO LEDGER ===");
  console.log(dryRun
    ? "FREE DRY RUN — the complete three-leg pipeline with deterministic reference contracts. Zero model calls, no API key touched."
    : `PAID TAKE — the model drafts all three family contracts (max ${MAX_MODEL_CALLS_PER_TAKE} calls, $2 absolute family ceiling). Everything else is deterministic trusted code.`);
  console.log("Data between legs flows only through trusted code; the model never carries it.");

  if (dryRun) {
    // Exits before requireApiKey(): provably zero spend.
    const result = await runPipeline(path.join(scratchRoot, "dry"), deterministicDrafters());
    const report = { ...freeze, ...result, modelCalls: 0, spentUsd: 0, completedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(campaignDirectory, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${JSON.stringify({ campaignId, dryRun: true, passed: result.passed, safetyFailure: result.safetyFailure, modelCalls: 0, spentUsd: 0, result: path.join(campaignDirectory, "result.json") })}`);
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    if (!result.passed || result.safetyFailure) process.exitCode = 1;
    return;
  }

  // Paid path. Free deterministic rehearsal first: the identical pipeline must
  // pass with reference contracts before a single model call is allowed.
  const rehearsal = await runPipeline(path.join(scratchRoot, "rehearsal"), deterministicDrafters());
  fs.writeFileSync(path.join(campaignDirectory, "deterministic-rehearsal.json"), `${JSON.stringify(rehearsal, null, 2)}\n`);
  if (!rehearsal.passed || rehearsal.safetyFailure) {
    throw new Error("Paid take aborted: the free deterministic rehearsal of the same pipeline failed.");
  }

  const apiKey = requireApiKey();
  const budgetMirror = path.resolve("artifacts", "paper-to-ledger", "budget.json");
  const budget = new BudgetTracker(budgetMirror, { warnUsd: 1, maxUsd: 2, maxRunUsd: 1 });
  const trace = new TraceWriter(campaignId, path.join(campaignDirectory, "trace"), [apiKey]);
  const modelGateway = new OpenAIModelGateway(apiKey, budget, trace);
  const cap = new ModelCallCap(MAX_MODEL_CALLS_PER_TAKE);
  const drafters: LegDrafters = {
    mode: "model-drafted",
    inbox: new CappedInboxDraftGateway(new OpenAIInboxContractDraftGateway(modelGateway), cap),
    document: new CappedDocumentDraftGateway(new OpenAIStructuredDocumentCapabilityGateway(modelGateway), cap),
    database: new CappedDatabaseDraftGateway(new OpenAIScopedDatabaseDraftGateway(modelGateway), cap),
    modelCalls: () => modelGateway.callCount(),
    spentUsd: () => modelGateway.spentUsd(),
  };

  let result: PipelineResult | null = null;
  let crashed: Record<string, unknown> | null = null;
  try {
    result = await runPipeline(path.join(scratchRoot, "live"), drafters);
  } catch (error) {
    crashed = { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    budget.close();
  }

  const modelCalls = drafters.modelCalls();
  const spentUsd = drafters.spentUsd();
  const passed = result !== null && result.passed && !result.safetyFailure && modelCalls <= MAX_MODEL_CALLS_PER_TAKE && spentUsd <= 2;
  const safetyFailure = result === null ? true : result.safetyFailure;
  const report = {
    ...freeze,
    passed,
    safetyFailure,
    modelCalls,
    spentUsd,
    ...(result ?? {}),
    ...(crashed ? { error: crashed } : {}),
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(campaignDirectory, "result.json"), `${JSON.stringify(report, null, 2)}\n`);

  // Per-take snapshot for the demo-bank console:
  // takes/<ts>/{result.json,model-budget.json} (chain convention).
  const takeDir = path.resolve("artifacts", "paper-to-ledger", "takes", new Date().toISOString().replaceAll(/[:.]/g, "-"));
  fs.mkdirSync(takeDir, { recursive: true });
  fs.writeFileSync(path.join(takeDir, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (fs.existsSync(budgetMirror)) {
    fs.copyFileSync(budgetMirror, path.join(takeDir, "model-budget.json"));
  }

  console.log(`\n${JSON.stringify({ campaignId, passed, safetyFailure, modelCalls, spentUsd, result: path.join(campaignDirectory, "result.json") })}`);
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  if (!passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
