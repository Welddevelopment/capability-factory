// ONE GOAL, MANY HANDS (one-goal-many-hands-v1) — model planning AND model
// construction in one run, across three capability families.
//
// One ordinary broad goal in prose. The MODEL does exactly TWO cognitive jobs:
//   1. PLANNING: it decomposes the goal into dependency-ordered work items
//      against a NEW trusted scope (one-goal-scope.ts) covering the three
//      family legs — signed-message accept, document capture, database record —
//      validated by the untouched GoalPlanCompiler's full trusted checks
//      (src/product/goal-coordination.ts), one repair attempt allowed.
//   2. DRAFTING: per work item it drafts that family's contract through the
//      existing per-family gateways, exactly as the V1 paper-to-ledger demo.
//
// DETERMINISTIC TRUSTED CODE (everything else): plan validation and ordering,
// HMAC signature verification and replay refusal, PDF pinning/parsing/
// verification, contract validation, the review gate (approval bound to the
// contract digest — the model never holds an approval key), disposable probes,
// execution with an idempotency ledger, and INDEPENDENT verification per leg.
// CROSS-LEG DATA FLOWS THROUGH TRUSTED CODE ONLY, exactly as V1.
//
// RETENTION + REUSE: after the first order completes, a SECOND goal (a second
// order) is handled by fresh coordinator/registry instances reopened from the
// retained on-disk state. The retained plan is re-validated from scratch by
// the same GoalPlanCompiler (replay planner, zero model calls) and every leg
// must take the retained-capability path with ZERO new drafting calls —
// enforced by tripwire builders that throw if consulted.
//
// HONEST MODE LABEL: this is a demo route, unsealed — not a claim of
// generality. The plan drives leg dispatch through a small trusted map in
// this runner (the trusted GoalScheduler executes HTTP capability layers, not
// these experimental family SDKs), and the "fresh process" is fresh
// coordinator/registry/world instances reopened from disk within one process.
//
// ACK:     CF_ONE_GOAL_ACK=one-goal-many-hands-v1
// Dry run: CF_ONE_GOAL_DRY_RUN=1 — FREE: a deterministic reference planner
//          (hardcoded proposal through the SAME GoalPlanCompiler validation;
//          checksPassed is asserted > 0) plus deterministic reference
//          contracts exercise the whole structure end to end, including the
//          reuse phase and one refusal spot-check per leg. Zero model calls.
// Paid:    at most 7 model calls per take (1 plan + 1 plan repair + 3 drafts
//          + 2 shared draft retries, enforced by local caps), $2 absolute
//          family ceiling in artifacts/one-goal-many-hands/budget.json.
//          Takes land in artifacts/one-goal-many-hands/takes/<ts>/.
//
// Pattern sources (verified 2026-08-24):
//   src/customer-world/run-paper-to-ledger.ts (the three family legs, refusal
//     spot-checks, caps, takes convention — reused nearly verbatim)
//   src/customer-world/run-broad-goal-model-campaign.ts (planner + compiler
//     wiring and the checksPassed reporting shape)
//
// BOUNDARY: this runner only REUSES existing world/driver/gateway/planner
// files. It modifies none of them, and touches nothing in validation/, the
// goal-coordination/planner sources, or the sealed CF-033 fixtures.

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
  GoalPlanCompiler,
  type GoalPlanProposal,
  type GoalPlanValidationCheck,
  type GoalPlanner,
  type TrustedGoalScope,
  type ValidatedGoalPlan,
} from "../product/goal-coordination.js";
import { OpenAIStructuredGoalPlanner } from "../product/openai-goal-planner.js";
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
  type InboxMessageCapabilityBuilder,
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
import {
  COVERAGE_LEDGER_RECORD,
  COVERAGE_PAPER_DOCUMENT,
  COVERAGE_SIGNED_NOTICE,
  ONE_GOAL_COVERAGE_ORDER,
  createOneGoalTrustedScope,
  proposalFromValidatedPlan,
  referenceOneGoalPlanProposal,
} from "./one-goal-scope.js";

const PROTOCOL = "one-goal-many-hands-v1";
const MAX_MODEL_CALLS_PER_TAKE = 7; // 1 plan + 1 plan repair + 3 drafts + 2 shared draft retries
const MAX_PLAN_CALLS = 2;
const MAX_DRAFT_CALLS = 5;

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
  "src/product/goal-coordination.ts",
  "src/product/openai-goal-planner.ts",
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
  "src/customer-world/one-goal-scope.ts",
  "src/customer-world/run-one-goal-many-hands.ts",
] as const;

/* ------------------------------------------------------------------ */
/* The two trusted order fixtures (goal 1, then the reuse goal)       */
/* ------------------------------------------------------------------ */

interface OrderFixture {
  purchaseOrderNumber: string;
  documentId: string;
  pdfAlias: string;
  noticeAlias: string;
  noticeMessageId: string;
  lines: ReadonlyArray<{ itemCode: string; quantity: number }>;
}

const ORDER_ONE: OrderFixture = {
  purchaseOrderNumber: "OGMH-6001",
  documentId: "PDF-OGMH-6001",
  pdfAlias: "ogmh-6001.pdf",
  noticeAlias: "ogmh-6001-notice.eml",
  noticeMessageId: "<ogmh-6001-notice@east-industrial.example>",
  lines: [
    { itemCode: "BOLT-10", quantity: 8 },
    { itemCode: "FILTER-42", quantity: 2 },
  ],
};

const ORDER_TWO: OrderFixture = {
  purchaseOrderNumber: "OGMH-6002",
  documentId: "PDF-OGMH-6002",
  pdfAlias: "ogmh-6002.pdf",
  noticeAlias: "ogmh-6002-notice.eml",
  noticeMessageId: "<ogmh-6002-notice@east-industrial.example>",
  lines: [
    { itemCode: "FILTER-42", quantity: 4 },
    { itemCode: "GLOVE-7", quantity: 6 },
  ],
};

const GOAL_ONE =
  "Process today's fictional order intake: accept the signed order notice, capture the paper purchase order it references, and record the resulting ledger entries — refusing anything unverified.";
const GOAL_TWO =
  "Process the follow-up fictional order intake using only abilities already retained: accept the second signed order notice, capture the paper order it references, and record its ledger entries — with zero new contract drafting.";

/* ------------------------------------------------------------------ */
/* Reporting (pattern: run-paper-to-ledger.ts)                        */
/* ------------------------------------------------------------------ */

interface CheckRecord {
  name: string;
  passed: boolean;
  detail: string;
}

interface StageRecord {
  stage: number;
  family: string;
  title: string;
  cognitiveJob: string;
  checks: CheckRecord[];
  passed: boolean;
}

function startStage(records: StageRecord[], stage: number, family: string, title: string, cognitiveJob: string): StageRecord {
  const record: StageRecord = { stage, family, title, cognitiveJob, checks: [], passed: true };
  records.push(record);
  console.log(`\n--- Stage ${stage} [${family}]: ${title} (${cognitiveJob})`);
  return record;
}

function check(record: StageRecord, name: string, passed: boolean, detail: string): void {
  record.checks.push({ name, passed, detail });
  if (!passed) record.passed = false;
  console.log(`    ${passed ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

/* ------------------------------------------------------------------ */
/* Planners: reference (dry run), capped model (paid), retained replay */
/* ------------------------------------------------------------------ */

class CallCap {
  used = 0;

  constructor(private readonly limit: number, private readonly label: string) {}

  register(kind: string): void {
    if (this.used >= this.limit) {
      throw new Error(`Per-take ${this.label} cap (${this.limit}) reached before the ${kind} call.`);
    }
    this.used += 1;
  }
}

/** Dry-run planner: the hardcoded reference proposal goes through the SAME
 * GoalPlanCompiler trusted validation. It refuses repair requests loudly —
 * the reference proposal must validate on the first attempt. */
class ReferenceOneGoalPlanner implements GoalPlanner {
  calls = 0;

  async propose(
    _scope: TrustedGoalScope,
    repair?: { previousProposal: GoalPlanProposal; failedChecks: GoalPlanValidationCheck[] },
  ): Promise<GoalPlanProposal> {
    this.calls += 1;
    if (repair) {
      throw new Error(
        `The deterministic reference plan failed trusted validation: ${repair.failedChecks.map((c) => c.id).join(", ")}`,
      );
    }
    return referenceOneGoalPlanProposal();
  }
}

/** Reuse-phase planner: replays the retained (already validated) plan as a
 * proposal so the compiler re-validates it from scratch for the second goal.
 * Zero model calls; a repair request means retention broke — throw. */
class RetainedPlanReplayPlanner implements GoalPlanner {
  calls = 0;

  constructor(private readonly retainedProposal: GoalPlanProposal) {}

  async propose(
    _scope: TrustedGoalScope,
    repair?: { previousProposal: GoalPlanProposal; failedChecks: GoalPlanValidationCheck[] },
  ): Promise<GoalPlanProposal> {
    this.calls += 1;
    if (repair) {
      throw new Error(
        `The retained plan no longer passes trusted validation: ${repair.failedChecks.map((c) => c.id).join(", ")}`,
      );
    }
    return structuredClone(this.retainedProposal);
  }
}

class CappedGoalPlanner implements GoalPlanner {
  constructor(private readonly underlying: OpenAIStructuredGoalPlanner, private readonly cap: CallCap) {}

  async propose(
    scope: TrustedGoalScope,
    repair?: { previousProposal: GoalPlanProposal; failedChecks: GoalPlanValidationCheck[] },
  ): Promise<GoalPlanProposal> {
    this.cap.register(repair ? "plan-repair" : "plan");
    return this.underlying.propose(scope, repair);
  }
}

/* ------------------------------------------------------------------ */
/* Stage 0/4: goal planning through the untouched GoalPlanCompiler    */
/* ------------------------------------------------------------------ */

interface CompiledPlanRecord {
  plan: ValidatedGoalPlan | null;
  checksPassed: number;
  attempts: number;
}

async function compileGoalPlan(
  record: StageRecord,
  scope: TrustedGoalScope,
  planner: GoalPlanner,
): Promise<CompiledPlanRecord> {
  try {
    const compiled = await new GoalPlanCompiler(planner, MAX_PLAN_CALLS).compile(scope);
    if (compiled.status !== "validated") {
      check(
        record,
        "plan.validated",
        false,
        `rejected after ${compiled.attempts} attempt(s); failed checks: ${compiled.checks.filter((c) => !c.passed).map((c) => c.id).join(", ")}`,
      );
      return { plan: null, checksPassed: 0, attempts: compiled.attempts };
    }
    const plan = compiled.plan;
    const checksPassed = plan.checks.filter((c) => c.passed).length;
    check(
      record,
      "plan.validated",
      true,
      `validated in ${compiled.attempts} attempt(s); receipt ${plan.validationReceiptId.slice(0, 12)}…, ${plan.workItems.length} work items, mode ${plan.executionMode}`,
    );
    // The dry run must PROVE the trusted plan validation actually ran.
    check(
      record,
      "plan.validation-checks-ran",
      checksPassed > 0,
      `the GoalPlanCompiler's trusted validation recorded ${checksPassed} passing check(s) (of ${plan.checks.length})`,
    );
    const orderedCoverage = [...plan.workItems]
      .sort((left, right) => left.executionOrder - right.executionOrder)
      .map((item) => item.coverageKeys.join("+"));
    check(
      record,
      "plan.covers-three-families-in-order",
      orderedCoverage.length === ONE_GOAL_COVERAGE_ORDER.length &&
        orderedCoverage.every((key, index) => key === ONE_GOAL_COVERAGE_ORDER[index]),
      `validated execution order [${orderedCoverage.join(" → ")}] — the trusted document→database dependency edge (and the notice→document edge) forced this order`,
    );
    check(
      record,
      "plan.items-authorized",
      plan.workItems.every((item) => item.authority.currentlyAuthorized),
      "every work item is within the trusted authority envelope (targets, credentials, methods, per-action write approvals)",
    );
    return { plan, checksPassed, attempts: compiled.attempts };
  } catch (error) {
    check(record, "plan.crashed", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return { plan: null, checksPassed: 0, attempts: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* Leg 1 pins: trusted inbox contract document + independent verifier */
/* (replicated from run-paper-to-ledger.ts; self-checks against       */
/* fictionalInboxContractHash() before anything runs)                 */
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
/* Leg 2: trusted document template contract + tripwire builder       */
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
  readonly builderId = "forbidden-rebuild-document-builder";
  calls = 0;

  async build(): Promise<null> {
    this.calls += 1;
    throw new Error("A retained-capability path unexpectedly consulted the document builder.");
  }
}

/** Tripwire builder: the reuse phase must never draft an inbox mapping. */
class ForbiddenRebuildInboxBuilder implements InboxMessageCapabilityBuilder {
  readonly builderId = "forbidden-rebuild-inbox-builder";
  calls = 0;

  async build(): Promise<null> {
    this.calls += 1;
    throw new Error("A retained-capability path unexpectedly consulted the inbox builder.");
  }
}

/** Tripwire gateway: the reuse phase must never draft a database contract. */
class ForbiddenDatabaseDraftGateway implements DatabaseDraftGateway {
  readonly modelLabel = "forbidden-database-draft-tripwire";
  calls = 0;

  async draft(_input: DatabaseDraftInput): Promise<unknown> {
    this.calls += 1;
    throw new Error("The reuse phase unexpectedly requested a database contract draft.");
  }
}

/* ------------------------------------------------------------------ */
/* Leg 3: trusted database fixture, assembly, review, probe, execute  */
/* (replicated from run-paper-to-ledger.ts)                           */
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
  approvalKey: "approve-one-goal-restock",
  outcomeVerifierKey: "independent-restock-reader",
  workflowKey: "record-order-ledger",
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

interface PlanCorrelation {
  parentGoalId: string;
  planId: string;
  planDigest: string;
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
    authorityDigest: sha256(`one-goal-authority:${proposal.proposalDigest}`),
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
  correlation: PlanCorrelation;
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
      parentGoalId: input.correlation.parentGoalId,
      planId: input.correlation.planId,
      planDigest: input.correlation.planDigest,
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
      idempotencyKey: sha256(`one-goal-idempotency:${proposal.proposalDigest}:${input.operationKey}`),
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
  correlation: PlanCorrelation,
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
    operationKey: "one-goal-probe",
    workItemId: "one-goal-probe",
    correlation,
    now,
  });
  fs.rmSync(probeRoot, { recursive: true, force: true });
  return result;
}

/* ------------------------------------------------------------------ */
/* Deterministic reference draft gateways (FREE dry run + rehearsal)  */
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
    contractId: "one-goal-restock-insert",
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
/* Capped model draft gateways (paid path only)                       */
/* ------------------------------------------------------------------ */

class CappedInboxDraftGateway implements InboxContractDraftGateway {
  constructor(private readonly underlying: InboxContractDraftGateway, private readonly cap: CallCap) {}

  get modelLabel(): string {
    return this.underlying.modelLabel;
  }

  async draft(input: InboxContractDraftInput): Promise<unknown> {
    this.cap.register("signed-messages draft");
    return this.underlying.draft(input);
  }

  spentUsd(): number {
    return this.underlying.spentUsd();
  }
}

class CappedDocumentDraftGateway implements DocumentCapabilityModelDraftGateway {
  constructor(private readonly underlying: OpenAIStructuredDocumentCapabilityGateway, private readonly cap: CallCap) {}

  get modelLabel(): string {
    return this.underlying.modelLabel;
  }

  async draft(input: DocumentCapabilityModelDraftInput): Promise<unknown> {
    this.cap.register("documents draft");
    return this.underlying.draft(input);
  }

  spentUsd(): number {
    return this.underlying.spentUsd();
  }
}

class CappedDatabaseDraftGateway implements DatabaseDraftGateway {
  constructor(private readonly underlying: OpenAIScopedDatabaseDraftGateway, private readonly cap: CallCap) {}

  get modelLabel(): string {
    return this.underlying.modelLabel;
  }

  async draft(input: DatabaseDraftInput): Promise<unknown> {
    this.cap.register("database draft");
    return this.underlying.draft(input);
  }
}

/* ------------------------------------------------------------------ */
/* Demo tools: one bundle for planner + drafters                      */
/* ------------------------------------------------------------------ */

interface LegDrafters {
  mode: "deterministic-reference" | "model-drafted";
  inbox: InboxContractDraftGateway;
  document: DocumentCapabilityModelDraftGateway;
  database: DatabaseDraftGateway;
}

interface DemoTools {
  mode: "deterministic-reference" | "model";
  planner: GoalPlanner;
  drafters: LegDrafters;
  modelCalls(): number;
  spentUsd(): number;
}

function deterministicTools(): DemoTools {
  return {
    mode: "deterministic-reference",
    planner: new ReferenceOneGoalPlanner(),
    drafters: {
      mode: "deterministic-reference",
      inbox: new ReferenceInboxDraftGateway(),
      document: new ReferenceDocumentDraftGateway(trustedDocumentContract()),
      database: new ReferenceDatabaseDraftGateway(),
    },
    modelCalls: () => 0,
    spentUsd: () => 0,
  };
}

/* ------------------------------------------------------------------ */
/* Durable per-take retention paths (the reuse phase reopens these)   */
/* ------------------------------------------------------------------ */

interface RetainedPaths {
  inboxRegistryDir: string;
  documentsRoot: string;
  ledgerDir: string;
  dbContractPath: string;
  expectedRowsPath: string;
}

function retainedPaths(root: string): RetainedPaths {
  const base = path.join(root, "retained");
  fs.mkdirSync(base, { recursive: true });
  return {
    inboxRegistryDir: path.join(base, "inbox-registry"),
    documentsRoot: path.join(base, "documents"),
    ledgerDir: path.join(base, "ledger"),
    dbContractPath: path.join(base, "db-contract.json"),
    expectedRowsPath: path.join(base, "ledger-expected.json"),
  };
}

type ExpectedRow = { operation_key: string; sku: string; quantity: number; status: string };

function readExpectedRows(retained: RetainedPaths): ExpectedRow[] {
  if (!fs.existsSync(retained.expectedRowsPath)) return [];
  return JSON.parse(fs.readFileSync(retained.expectedRowsPath, "utf8")) as ExpectedRow[];
}

/* ------------------------------------------------------------------ */
/* One goal phase: three legs dispatched in the plan's trusted order  */
/* ------------------------------------------------------------------ */

interface PhaseInput {
  reuse: boolean;
  phaseRoot: string;
  retained: RetainedPaths;
  scope: TrustedGoalScope;
  plan: ValidatedGoalPlan;
  order: OrderFixture;
  records: StageRecord[];
  stageBase: number;
  drafters: LegDrafters;
  tripwires: {
    inbox: ForbiddenRebuildInboxBuilder;
    document: ForbiddenRebuildDocumentBuilder;
    database: ForbiddenDatabaseDraftGateway;
  };
}

async function runGoalPhase(input: PhaseInput): Promise<void> {
  const { reuse, retained, scope, plan, order, records } = input;
  const now = new Date();
  const draftedBy = reuse ? "reuse: retained contracts, tripwired builders" : `contract drafted by: ${input.drafters.mode}`;
  const correlation: PlanCorrelation = {
    parentGoalId: scope.parentGoalId,
    planId: plan.validationReceiptId,
    planDigest: sha256(canonical({ receipt: plan.validationReceiptId, items: plan.workItems.map((item) => item.workItemId) })),
  };

  // Trusted self-check: the replicated inbox contract document must hash to
  // the world's pinned contract hash, or nothing runs.
  if (sha256(canonical(trustedInboxContractDocument())) !== fictionalInboxContractHash()) {
    throw new Error("The replicated inbox contract document no longer hashes to fictionalInboxContractHash(); refusing to run.");
  }

  // The paper order arrives first (trusted fixture): the pinned PDF is written
  // into the durable document world and its identity recorded in a trusted pin
  // table keyed by PO number. Reopening the same root retains the registry.
  const pdfWorld = await ModelBackedPdfOrderWorld.create(retained.documentsRoot);
  const pdfReceipt = await pdfWorld.writeDocument({
    fileAlias: order.pdfAlias,
    documentId: order.documentId,
    purchaseOrderNumber: order.purchaseOrderNumber,
    lines: [...order.lines],
  });
  const pinnedPdfByPo: Record<string, { alias: string; sha256: string; operationKey: string }> = {
    [order.purchaseOrderNumber]: { alias: order.pdfAlias, sha256: pdfReceipt.sha256, operationKey: pdfReceipt.operationKey },
  };

  let noticeDraft: CanonicalInboxDraftOrder | null = null;
  let paperDraft: CanonicalDocumentDraftOrder | null = null;
  const expectedPath = reuse ? "retained-capability" : "built-capability";

  const orderedItems = [...plan.workItems].sort((left, right) => left.executionOrder - right.executionOrder);
  for (const [index, item] of orderedItems.entries()) {
    const stage = input.stageBase + index;
    const coverage = item.coverageKeys[0] ?? "(none)";

    if (coverage === COVERAGE_SIGNED_NOTICE) {
      /* ---- SIGNED-MESSAGES leg ---- */
      const record = startStage(records, stage, "signed-messages", `${reuse ? "Reuse: " : ""}Signed webhook order notice for ${order.purchaseOrderNumber} (plan item ${item.key})`, draftedBy);
      const message = await startMessageWorld(path.join(input.phaseRoot, "messages"));
      try {
        const delivery: CapturedDelivery = {
          deliveryId: `${order.purchaseOrderNumber.toLowerCase()}-delivery`,
          inputMessageAlias: order.noticeAlias,
          sentAt: new Date().toISOString(),
          message: fictionalOrderEmail({
            fileAlias: order.noticeAlias,
            purchaseOrderNumber: order.purchaseOrderNumber,
            messageId: order.noticeMessageId,
            lines: [...order.lines],
          }),
        };
        const accepted = await message.client.submit(delivery);
        check(record, "signed-ingress.accepts", accepted.status === 201, `correctly signed delivery earned HTTP ${accepted.status} (HMAC-SHA256, trusted code)`);

        const builder: InboxMessageCapabilityBuilder = reuse
          ? input.tripwires.inbox
          : new ModelInboxCapabilityBuilder(input.drafters.inbox, {
              needKey: FICTIONAL_INBOX_NEED,
              contractSha256: fictionalInboxContractHash(),
              contractDocument: trustedInboxContractDocument(),
              inboxRootAlias: FICTIONAL_INBOX_ALIAS,
              outputRootAlias: FICTIONAL_DRAFT_ALIAS,
              approvalKey: FICTIONAL_INBOX_APPROVAL,
              outcomeVerifierKey: FICTIONAL_INBOX_VERIFIER,
              probeMessage: message.world.target.probeMessage,
            }, 2);
        // A FRESH registry instance every phase, reopened from the durable dir.
        const registry = new PersistentInboxMessageCapabilityRegistry(retained.inboxRegistryDir);
        const sdk = new ExperimentalInboxMessageCapabilitySdk({
          driver: new ExperimentalInboxMessageDriver({
            [FICTIONAL_INBOX_ALIAS]: message.world.target,
            [FICTIONAL_DRAFT_ALIAS]: message.world.target,
          }),
          registry,
          trustedSource: new StaticTrustedInboxMessageCapabilitySource("one-goal-empty-library", []),
          builder,
          outcomeVerifier: (request) => independentInboxVerifier(message.world, request),
        });
        const operationKey = inboxMessageOperationKey(order.noticeMessageId);
        const goal = await sdk.completeGoal({
          tenantId: FICTIONAL_INBOX_TENANT,
          requestId: `${scope.requestId}-notice`,
          parentGoalId: scope.parentGoalId,
          ordinaryGoal: scope.ordinaryGoal,
          needKey: FICTIONAL_INBOX_NEED,
          contractHash: fictionalInboxContractHash(),
          operationKey,
          inputMessageAlias: delivery.inputMessageAlias,
          expectedMessageSha256: String(accepted.body.messageSha256),
          approvals: [FICTIONAL_INBOX_APPROVAL],
        });
        check(
          record,
          reuse ? "reuse.goal-completed-via-retained-capability" : "goal.completed-and-verified",
          goal.status === "completed" && goal.path === expectedPath,
          `status=${goal.status}${goal.status === "completed" ? `, path=${goal.path}` : ""} — expected path ${expectedPath}; the draft passed the independent verifier (re-derivation, not the driver's parser)`,
        );
        if (reuse) {
          check(record, "reuse.zero-inbox-rebuilds", input.tripwires.inbox.calls === 0, `tripwire inbox builder calls=${input.tripwires.inbox.calls}`);
        }

        // Trusted read of the verified draft (cross-leg data flow is this code).
        const draftPath = path.join(message.world.outputRoot, inboxMessageOutputAlias(operationKey));
        noticeDraft = JSON.parse(fs.readFileSync(draftPath, "utf8")) as CanonicalInboxDraftOrder;
        check(
          record,
          "notice.references-known-paper-order",
          noticeDraft.purchaseOrderNumber === order.purchaseOrderNumber && pinnedPdfByPo[noticeDraft.purchaseOrderNumber] !== undefined,
          `PO ${noticeDraft.purchaseOrderNumber} resolves to pinned PDF ${pinnedPdfByPo[noticeDraft.purchaseOrderNumber]?.alias ?? "(none)"} via the trusted pin table`,
        );

        if (!reuse) {
          // Refusal spot-check 1: byte-identical replay, then a re-signed duplicate.
          const draftsBefore = fs.readdirSync(message.world.outputRoot).filter((n) => n.endsWith(".draft-order.json")).length;
          const byteReplay = await replayExactCapture(message.origin, delivery);
          const resigned = await message.client.submit({ ...delivery, sentAt: new Date().toISOString() });
          const draftsAfter = fs.readdirSync(message.world.outputRoot).filter((n) => n.endsWith(".draft-order.json")).length;
          check(
            record,
            "refusal.replayed-webhook-409",
            byteReplay.status === 409 && byteReplay.body.replay === true && resigned.status === 409 && draftsAfter === draftsBefore,
            `byte-identical resend: HTTP ${byteReplay.status} replay=${String(byteReplay.body.replay)}; re-signed duplicate: HTTP ${resigned.status}; draft count unchanged (${draftsAfter})`,
          );
        }
      } catch (error) {
        check(record, "leg-crashed", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      } finally {
        await message.close();
      }
    } else if (coverage === COVERAGE_PAPER_DOCUMENT) {
      /* ---- DOCUMENTS leg ---- */
      const record = startStage(records, stage, "documents", `${reuse ? "Reuse: " : ""}Pinned PDF for ${order.purchaseOrderNumber} parsed under the ${reuse ? "retained" : "drafted"} manifest (plan item ${item.key})`, draftedBy);
      try {
        const pinned = noticeDraft ? pinnedPdfByPo[noticeDraft.purchaseOrderNumber] : undefined;
        if (!pinned) throw new Error("The notice leg produced no verified draft; the trusted bridge refuses to guess a PDF.");
        const documentBuilder: DocumentCapabilityBuilder = reuse
          ? input.tripwires.document
          : new StructuredModelDocumentCapabilityBuilder(input.drafters.document, [trustedDocumentContract()], 2);
        const goal = await pdfWorld.complete(documentBuilder, {
          requestId: `${scope.requestId}-paper`,
          parentGoalId: scope.parentGoalId,
          operationKey: pinned.operationKey,
          inputDocumentAlias: pinned.alias,
          expectedDocumentSha256: pinned.sha256,
        });
        check(
          record,
          reuse ? "reuse.goal-completed-via-retained-capability" : "goal.completed-and-verified",
          goal.status === "completed" && goal.path === expectedPath,
          `status=${goal.status}${goal.status === "completed" ? `, path=${goal.path}` : ""} — expected path ${expectedPath}; the draft passed the independent customer-side verifier`,
        );
        if (reuse) {
          check(record, "reuse.zero-document-rebuilds", input.tripwires.document.calls === 0, `tripwire document builder calls=${input.tripwires.document.calls}`);
        }

        // Trusted read of the verified parsed order (cross-leg data flow).
        const draftPath = path.join(pdfWorld.outputRoot, documentOutputAlias(pinned.operationKey));
        paperDraft = JSON.parse(fs.readFileSync(draftPath, "utf8")) as CanonicalDocumentDraftOrder;
        check(
          record,
          "paper.matches-notice-po",
          paperDraft.purchaseOrderNumber === (noticeDraft?.purchaseOrderNumber ?? "(none)"),
          `parsed PDF PO ${paperDraft.purchaseOrderNumber} equals the verified notice PO (trusted cross-check)`,
        );

        if (!reuse) {
          // Refusal spot-check 2: a tampered PDF. The capability is retained, so
          // a local tripwire builder proves zero rebuilds (and zero model calls).
          const tripwire = new ForbiddenRebuildDocumentBuilder();
          const tampered = await pdfWorld.writeDocument({
            fileAlias: "ogmh-tampered.pdf",
            documentId: "PDF-OGMH-TAMPERED",
            purchaseOrderNumber: "OGMH-TAMPERED",
            lines: [{ itemCode: "GLOVE-7", quantity: 1 }],
          });
          fs.appendFileSync(tampered.filename, Buffer.from([0])); // one byte, after pinning
          const refusal = await pdfWorld.complete(tripwire, {
            requestId: `${scope.requestId}-tampered`,
            parentGoalId: scope.parentGoalId,
            operationKey: tampered.operationKey,
            inputDocumentAlias: "ogmh-tampered.pdf",
            expectedDocumentSha256: tampered.sha256,
          });
          const handoff = refusal.status === "completed" ? undefined : refusal.handoff;
          const draftsOnDisk = pdfWorld.listDrafts().length;
          check(
            record,
            "refusal.tampered-pdf",
            refusal.status === "blocked" &&
              handoff?.summary === "The approved PDF changed after trusted planning." &&
              handoff.writesAttempted === 0 &&
              draftsOnDisk === 1 &&
              tripwire.calls === 0,
            `status=${refusal.status}, summary="${handoff?.summary ?? "(none)"}", writesAttempted=${String(handoff?.writesAttempted)}, drafts on disk=${draftsOnDisk}, rebuilds=${tripwire.calls}`,
          );
        }
      } catch (error) {
        check(record, "leg-crashed", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      }
    } else if (coverage === COVERAGE_LEDGER_RECORD) {
      /* ---- DATABASE leg ---- */
      const record = startStage(records, stage, "database", `${reuse ? "Reuse: " : ""}${reuse ? "Retained reviewed contract re-verified; one row per parsed line" : "Reviewed contract drafted; probed disposably; one row per parsed line; unapproved write refused"} (plan item ${item.key})`, draftedBy);
      try {
        if (!paperDraft) throw new Error("The document leg produced no verified parsed order; the trusted bridge refuses to invent ledger values.");
        // TRUSTED expected values, from the independently verified PDF parse only.
        const ledgerLines = paperDraft.lines.map((line) => ({
          operationKey: `one-goal-${paperDraft!.purchaseOrderNumber}-line-${line.lineNumber}`,
          parameters: { sku: line.itemCode, quantity: line.quantity, status: "draft" } as Record<string, string | number | boolean>,
        }));

        fs.mkdirSync(retained.ledgerDir, { recursive: true });
        const databasePath = path.join(retained.ledgerDir, "inventory.sqlite");
        if (!reuse) {
          const seed = new ScopedDatabaseRuntime(databasePath, DB_TRUSTED.connection.actionIdentity, DB_TRUSTED.connection.observerIdentity, () => now.toISOString());
          seed.close();
        }
        const schemaDigest = computeSchemaDigest(databasePath);

        let contract: ScopedDatabaseContract | null = null;
        let approval: ApprovalRecord | null = null;
        if (!reuse) {
          // Draft (the only model seam of this leg) + trusted assembly + review.
          let draftError: string | undefined;
          let previousDraft: ScopedDatabaseDraft | undefined;
          const documentation = { content: DB_TRUSTED.documentationContent, sha256: sha256(JSON.stringify(DB_TRUSTED.documentationContent)) };
          for (let attempt = 1; attempt <= 2 && !contract; attempt += 1) {
            try {
              const raw = await input.drafters.database.draft({
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
          check(record, "contract.drafted-reviewed-approved", true, `contract ${contract.contractId} reviewed; approval bound to digest ${approval.contractDigest.slice(0, 12)}…`);

          // RETENTION: the reviewed contract (with its digest-bound approval)
          // is durably retained for the reuse phase. Trusted code only.
          fs.writeFileSync(retained.dbContractPath, `${JSON.stringify({ contract, approval }, null, 2)}\n`);

          // Disposable probe before the real ledger is touched.
          const probe = probeDraftedContract(path.join(retained.ledgerDir, "probe"), contract, approval, ledgerLines[0]!.parameters, correlation, now);
          check(record, "probe.disposable-database", probe.passed, `probe classification=${probe.classification}, incorrectSideEffects=${probe.incorrectSideEffects} (throwaway sqlite, deleted after)`);
        } else {
          // REUSE: reopen the retained contract; zero drafting. The trusted
          // review re-runs deterministically and its digest must equal the
          // retained approval's digest, or nothing executes.
          if (!fs.existsSync(retained.dbContractPath)) throw new Error("No retained database contract exists; retention failed.");
          const stored = JSON.parse(fs.readFileSync(retained.dbContractPath, "utf8")) as { contract: unknown; approval: ApprovalRecord };
          contract = scopedDatabaseContractSchema.parse(stored.contract);
          approval = reviewAssembledContract(contract, now);
          check(
            record,
            "reuse.retained-db-contract-re-reviewed",
            approval.contractDigest === stored.approval.contractDigest && contract.schemaDigest === schemaDigest,
            `fresh trusted review digest ${approval.contractDigest.slice(0, 12)}… equals the retained approval digest; ledger schema digest unchanged`,
          );
          check(record, "reuse.zero-database-drafts", input.tripwires.database.calls === 0, `tripwire database draft gateway calls=${input.tripwires.database.calls}`);
        }

        // One reviewed insert per independently verified parsed line.
        for (const line of ledgerLines) {
          const outcome = executeReviewedInsert({
            databasePath,
            contract,
            approval,
            parameters: line.parameters,
            expected: line.parameters,
            operationKey: line.operationKey,
            workItemId: `${item.workItemId}-${line.operationKey}`,
            correlation,
            now,
          });
          check(
            record,
            `write.${line.operationKey}`,
            outcome.passed && outcome.writes === 1,
            `writes=${outcome.writes}, independent observation=${outcome.classification}, incorrectSideEffects=${outcome.incorrectSideEffects} (expected values come from the verified PDF parse, trusted code only)`,
          );
        }

        if (!reuse) {
          // Refusal spot-check 3: an unapproved write on a separate database.
          const refusalPath = path.join(retained.ledgerDir, "refusal.sqlite");
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
              operationKey: "one-goal-unapproved",
              workItemId: "one-goal-unapproved",
              correlation,
              now,
            });
            check(record, "refusal.unapproved-write", false, "the unapproved write was NOT refused — safety failure");
          } catch (error) {
            refusalMessage = error instanceof Error ? error.message : String(error);
            const observer = new DatabaseSync(refusalPath, { readOnly: true });
            try {
              const ledger = (observer.prepare("SELECT COUNT(*) AS n FROM cf_operation_ledger").get() as { n: number }).n;
              const rows = (observer.prepare("SELECT COUNT(*) AS n FROM restock_drafts").get() as { n: number }).n;
              check(
                record,
                "refusal.unapproved-write",
                refusalMessage === "Database authority binding changed." && ledger === 0 && rows === 0,
                `execute threw "${refusalMessage}" before any write; independent read-only check: cf_operation_ledger=${ledger}, restock_drafts=${rows}`,
              );
            } finally {
              observer.close();
            }
          }
        }

        // Final independent verification: a read-only connection reads the
        // WHOLE ledger and it must equal every verified line recorded so far —
        // no more, no less (both orders after the reuse phase).
        const previouslyExpected = readExpectedRows(retained);
        const expectedRows: ExpectedRow[] = [
          ...previouslyExpected,
          ...ledgerLines.map((line) => ({
            operation_key: line.operationKey,
            sku: String(line.parameters.sku),
            quantity: Number(line.parameters.quantity),
            status: String(line.parameters.status),
          })),
        ].sort((a, b) => a.operation_key.localeCompare(b.operation_key));
        const auditor = new DatabaseSync(databasePath, { readOnly: true });
        try {
          const rows = auditor
            .prepare("SELECT operation_key, sku, quantity, status FROM restock_drafts ORDER BY operation_key")
            .all() as Array<Record<string, unknown>>;
          check(
            record,
            reuse ? "reuse.ledger.matches-both-orders-exactly" : "ledger.matches-paper-exactly",
            canonical(rows) === canonical(expectedRows),
            `restock_drafts holds ${rows.length} row(s) exactly matching the ${expectedRows.length} verified PDF line(s) recorded so far (independent read-only connection)`,
          );
        } finally {
          auditor.close();
        }
        fs.writeFileSync(retained.expectedRowsPath, `${JSON.stringify(expectedRows, null, 2)}\n`);
      } catch (error) {
        check(record, "leg-crashed", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      }
    } else {
      const record = startStage(records, stage, "unknown", `Unrecognized coverage ${coverage} (plan item ${item.key})`, draftedBy);
      check(record, "coverage.recognized", false, `no trusted leg is mapped to coverage key ${coverage}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* The whole demo: plan → three legs → retained replan → three legs   */
/* ------------------------------------------------------------------ */

interface DemoResult {
  mode: string;
  passed: boolean;
  safetyFailure: boolean;
  planChecksPassed: number;
  reusePlanChecksPassed: number;
  planAttempts: number;
  orders: { first: OrderFixture; second: OrderFixture };
  stages: StageRecord[];
  planning: Record<string, unknown> | null;
  reusePlanning: Record<string, unknown> | null;
}

function planSummary(plan: ValidatedGoalPlan, checksPassed: number, attempts: number): Record<string, unknown> {
  return {
    status: "validated",
    attempts,
    validationReceiptId: plan.validationReceiptId,
    checksPassed,
    checksTotal: plan.checks.length,
    executionMode: plan.executionMode,
    items: plan.workItems.map((item) => ({
      key: item.key,
      coverageKeys: item.coverageKeys,
      workflowKey: item.workflowKey,
      dependencyWorkItemIds: item.dependencyWorkItemIds,
      executionOrder: item.executionOrder,
      currentlyAuthorized: item.authority.currentlyAuthorized,
    })),
  };
}

const REQUIRED_SAFETY_CHECKS = [
  "refusal.replayed-webhook-409",
  "refusal.tampered-pdf",
  "refusal.unapproved-write",
  "ledger.matches-paper-exactly",
  "reuse.ledger.matches-both-orders-exactly",
] as const;

async function runDemo(root: string, tools: DemoTools): Promise<DemoResult> {
  const stages: StageRecord[] = [];
  const retained = retainedPaths(root);
  const result: DemoResult = {
    mode: tools.mode,
    passed: false,
    safetyFailure: true,
    planChecksPassed: 0,
    reusePlanChecksPassed: 0,
    planAttempts: 0,
    orders: { first: ORDER_ONE, second: ORDER_TWO },
    stages,
    planning: null,
    reusePlanning: null,
  };

  /* ---- Stage 0: the model (or reference) plans the first goal ---- */
  const scopeOne = createOneGoalTrustedScope("one-goal-many-hands-1", "one-goal-request-1", GOAL_ONE);
  const planRecord = startStage(stages, 0, "goal-planning", "One ordinary goal decomposed into dependency-ordered multi-family work items", `plan proposed by: ${tools.mode === "model" ? "model" : "deterministic-reference"}; validated by the untouched GoalPlanCompiler`);
  const compiledOne = await compileGoalPlan(planRecord, scopeOne, tools.planner);
  result.planChecksPassed = compiledOne.checksPassed;
  result.planAttempts = compiledOne.attempts;
  if (!compiledOne.plan) {
    return finishDemo(result);
  }
  result.planning = planSummary(compiledOne.plan, compiledOne.checksPassed, compiledOne.attempts);

  /* ---- Stages 1-3: the first order travels all three families ---- */
  const phaseTripwires = () => ({
    inbox: new ForbiddenRebuildInboxBuilder(),
    document: new ForbiddenRebuildDocumentBuilder(),
    database: new ForbiddenDatabaseDraftGateway(),
  });
  await runGoalPhase({
    reuse: false,
    phaseRoot: path.join(root, "phase-1"),
    retained,
    scope: scopeOne,
    plan: compiledOne.plan,
    order: ORDER_ONE,
    records: stages,
    stageBase: 1,
    drafters: tools.drafters,
    tripwires: phaseTripwires(),
  });

  const modelCallsAfterFirstGoal = tools.modelCalls();

  /* ---- Stage 4: the retained plan is re-validated for the second goal ---- */
  const scopeTwo = createOneGoalTrustedScope("one-goal-many-hands-2", "one-goal-request-2", GOAL_TWO);
  const reusePlanRecord = startStage(stages, 4, "goal-planning", "Retained plan replayed for the second order's goal — re-validated from scratch, zero model calls", "plan proposed by: retained-plan replay (trusted reconstruction); validated by the untouched GoalPlanCompiler");
  const replayPlanner = new RetainedPlanReplayPlanner(proposalFromValidatedPlan(compiledOne.plan));
  const compiledTwo = await compileGoalPlan(reusePlanRecord, scopeTwo, replayPlanner);
  result.reusePlanChecksPassed = compiledTwo.checksPassed;
  check(
    reusePlanRecord,
    "reuse.single-replay-no-repair",
    replayPlanner.calls === 1,
    `retained-plan replay planner was consulted exactly ${replayPlanner.calls} time(s); a repair request would have thrown`,
  );
  if (!compiledTwo.plan) {
    return finishDemo(result);
  }
  result.reusePlanning = planSummary(compiledTwo.plan, compiledTwo.checksPassed, compiledTwo.attempts);

  /* ---- Stages 5-7: second order through FRESH instances, retained contracts ---- */
  const reuseTripwires = phaseTripwires();
  await runGoalPhase({
    reuse: true,
    phaseRoot: path.join(root, "phase-2"),
    retained,
    scope: scopeTwo,
    plan: compiledTwo.plan,
    order: ORDER_TWO,
    records: stages,
    stageBase: 5,
    drafters: tools.drafters,
    tripwires: reuseTripwires,
  });

  /* ---- Stage 8: retention verdict ---- */
  const retention = startStage(stages, 8, "retention", "Zero new cognitive work in the reuse phase", "trusted accounting");
  check(
    retention,
    "reuse.zero-model-calls",
    tools.modelCalls() === modelCallsAfterFirstGoal,
    `model calls before the reuse phase: ${modelCallsAfterFirstGoal}; after: ${tools.modelCalls()} (must be equal; ${tools.mode === "model" ? "counted by the gateway" : "reference mode, always zero"})`,
  );
  check(
    retention,
    "reuse.zero-tripwire-hits",
    reuseTripwires.inbox.calls === 0 && reuseTripwires.document.calls === 0 && reuseTripwires.database.calls === 0,
    `tripwire hits — inbox: ${reuseTripwires.inbox.calls}, document: ${reuseTripwires.document.calls}, database: ${reuseTripwires.database.calls}`,
  );

  return finishDemo(result);
}

function finishDemo(result: DemoResult): DemoResult {
  const allChecks = result.stages.flatMap((stage) => stage.checks);
  // Safety failures are the refusal and side-effect checks specifically —
  // computed from independent channels, never from driver responses alone.
  // A missing safety check (leg crash or skipped phase) is not provably safe.
  result.safetyFailure = REQUIRED_SAFETY_CHECKS.some(
    (name) => !allChecks.some((c) => c.name === name && c.passed),
  );
  result.passed =
    result.stages.length === 9 &&
    result.stages.every((stage) => stage.passed) &&
    result.planChecksPassed > 0 &&
    result.reusePlanChecksPassed > 0 &&
    !result.safetyFailure;
  return result;
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

const HONEST_LABEL = {
  modelCognitiveJobs: [
    "planning: decomposing the one ordinary goal into dependency-ordered multi-family work items (validated by the untouched GoalPlanCompiler's full trusted checks; one repair attempt allowed)",
    "drafting: the three per-family contract drafts — the message-to-action mapping, the pinned-template manifest, and the single-statement transaction shape",
  ],
  deterministicTrustedCode:
    "everything else — plan validation and dependency ordering, HMAC signature verification and replay refusal, PDF pinning/parsing/verification, contract validation, the review gate binding approval to the contract digest, disposable probes, execution with an idempotency ledger, independent verification per leg, retention, and the reuse-phase tripwires",
  crossLegDataFlow:
    "trusted code only: the verified notice PO selects the pinned PDF via a trusted pin table, and the independently verified PDF parse supplies the database leg's trusted expected values — the model never sees a business message and never carries data between legs",
  demoRoute:
    "a demo route, unsealed — not a claim of generality. The plan drives leg dispatch through a small trusted map in this runner, and the reuse phase reopens fresh coordinator/registry/world instances from disk within one process",
};

async function main(): Promise<void> {
  if (process.env.CF_ONE_GOAL_ACK !== PROTOCOL) {
    throw new Error(`Set CF_ONE_GOAL_ACK=${PROTOCOL} to run this demo.`);
  }
  const dryRun = process.env.CF_ONE_GOAL_DRY_RUN === "1";
  const campaignId = `${PROTOCOL}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const campaignDirectory = path.resolve("artifacts", "one-goal-many-hands", campaignId);
  fs.mkdirSync(campaignDirectory, { recursive: true });
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cf-one-goal-"));

  const sourceHashes = Object.fromEntries(
    FROZEN_FILES.filter((f) => fs.existsSync(f)).map((f) => [f, sha256(fs.readFileSync(f))]),
  );
  const freeze = {
    protocol: PROTOCOL,
    campaignId,
    frozenAt: new Date().toISOString(),
    mode: dryRun
      ? "dry-run (deterministic reference planner + reference contracts through the full trusted validation, zero model calls)"
      : `paid (model ${EXPERIMENT_LIMITS.model}: plan at reasoning medium, drafts at reasoning low)`,
    maximumModelCallsPerTake: MAX_MODEL_CALLS_PER_TAKE,
    callBudgetShape: "1 plan + 1 plan repair (cap 2) and 3 drafts + 2 shared retries (cap 5)",
    budget: { absoluteFamilyCeilingUsd: 2, perCallCeilingUsd: 1, warnUsd: 1, ledger: "artifacts/one-goal-many-hands/budget.json (durable, shared across every take)" },
    honestLabel: HONEST_LABEL,
    orders: { first: ORDER_ONE, second: ORDER_TWO },
    goals: { first: GOAL_ONE, second: GOAL_TWO },
    sourceHashes,
  };
  fs.writeFileSync(path.join(campaignDirectory, "campaign-freeze.json"), `${JSON.stringify(freeze, null, 2)}\n`);

  console.log("=== ONE GOAL, MANY HANDS ===");
  console.log(dryRun
    ? "FREE DRY RUN — reference plan through the REAL GoalPlanCompiler validation + reference contracts through the complete two-goal structure. Zero model calls, no API key touched."
    : `PAID TAKE — the model PLANS the multi-family work and DRAFTS all three family contracts (max ${MAX_MODEL_CALLS_PER_TAKE} calls, $2 absolute family ceiling). Everything else is deterministic trusted code.`);
  console.log("Two cognitive jobs for the model: the plan and the drafts. Validation, execution, verification and authority stay trusted; data between legs flows only through trusted code.");

  if (dryRun) {
    // Exits before requireApiKey(): provably zero spend.
    const result = await runDemo(path.join(scratchRoot, "dry"), deterministicTools());
    const report = { ...freeze, ...result, modelCalls: 0, spentUsd: 0, completedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(campaignDirectory, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${JSON.stringify({ campaignId, dryRun: true, passed: result.passed, safetyFailure: result.safetyFailure, planChecksPassed: result.planChecksPassed, reusePlanChecksPassed: result.reusePlanChecksPassed, modelCalls: 0, spentUsd: 0, result: path.join(campaignDirectory, "result.json") })}`);
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    if (!result.passed || result.safetyFailure) process.exitCode = 1;
    return;
  }

  // Paid path. Free deterministic rehearsal first: the identical two-goal
  // structure must pass with the reference planner and contracts before a
  // single model call is allowed.
  const rehearsal = await runDemo(path.join(scratchRoot, "rehearsal"), deterministicTools());
  fs.writeFileSync(path.join(campaignDirectory, "deterministic-rehearsal.json"), `${JSON.stringify(rehearsal, null, 2)}\n`);
  if (!rehearsal.passed || rehearsal.safetyFailure) {
    throw new Error("Paid take aborted: the free deterministic rehearsal of the same structure failed.");
  }

  const apiKey = requireApiKey();
  const budgetMirror = path.resolve("artifacts", "one-goal-many-hands", "budget.json");
  const budget = new BudgetTracker(budgetMirror, { warnUsd: 1, maxUsd: 2, maxRunUsd: 1 });
  const trace = new TraceWriter(campaignId, path.join(campaignDirectory, "trace"), [apiKey]);
  const modelGateway = new OpenAIModelGateway(apiKey, budget, trace);
  const planCap = new CallCap(MAX_PLAN_CALLS, "plan call");
  const draftCap = new CallCap(MAX_DRAFT_CALLS, "draft call");
  const tools: DemoTools = {
    mode: "model",
    planner: new CappedGoalPlanner(new OpenAIStructuredGoalPlanner(modelGateway), planCap),
    drafters: {
      mode: "model-drafted",
      inbox: new CappedInboxDraftGateway(new OpenAIInboxContractDraftGateway(modelGateway), draftCap),
      document: new CappedDocumentDraftGateway(new OpenAIStructuredDocumentCapabilityGateway(modelGateway), draftCap),
      database: new CappedDatabaseDraftGateway(new OpenAIScopedDatabaseDraftGateway(modelGateway), draftCap),
    },
    modelCalls: () => modelGateway.callCount(),
    spentUsd: () => modelGateway.spentUsd(),
  };

  let result: DemoResult | null = null;
  let crashed: Record<string, unknown> | null = null;
  try {
    result = await runDemo(path.join(scratchRoot, "live"), tools);
  } catch (error) {
    crashed = { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    budget.close();
  }

  const modelCalls = tools.modelCalls();
  const spentUsd = tools.spentUsd();
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
  const takeDir = path.resolve("artifacts", "one-goal-many-hands", "takes", new Date().toISOString().replaceAll(/[:.]/g, "-"));
  fs.mkdirSync(takeDir, { recursive: true });
  fs.writeFileSync(path.join(takeDir, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (fs.existsSync(budgetMirror)) {
    fs.copyFileSync(budgetMirror, path.join(takeDir, "model-budget.json"));
  }

  console.log(`\n${JSON.stringify({ campaignId, passed, safetyFailure, planChecksPassed: result?.planChecksPassed ?? 0, reusePlanChecksPassed: result?.reusePlanChecksPassed ?? 0, modelCalls, spentUsd, result: path.join(campaignDirectory, "result.json") })}`);
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  if (!passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
