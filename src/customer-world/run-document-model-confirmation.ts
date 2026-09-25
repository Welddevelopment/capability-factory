// Intended repo path: src/customer-world/run-document-model-confirmation.ts
// Pattern source: src/customer-world/run-gitea-browser-model-confirmation.ts and
// src/customer-world/run-procurement-model-confirmation.ts (both verified 2026-08-24).
//
// Bounded paid confirmation for the PINNED DOCUMENTS family: a model drafts the
// declarative pinned-template manifest; trusted code validates, probes, executes,
// and independently verifies. Three takes: build, fresh-process retained reuse
// (builder forbidden), and a missing-approval refusal with zero writes.
//
// ACK:     CF_DOCUMENT_MODEL_CONFIRM_ACK=pinned-document-model-confirmation-v1
// Dry run: CF_DOCUMENT_MODEL_CONFIRM_DRY_RUN=1  (freeze + free deterministic preflight only)

import "dotenv/config";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BudgetTracker } from "../budget.js";
import { requireApiKey } from "../config.js";
import { OpenAIModelGateway } from "../model-gateway.js";
import { TraceWriter } from "../trace.js";
import type {
  DocumentCapabilityBuilder,
  DocumentCapabilityGoalResult,
} from "../experimental/document-capability-sdk.js";
import {
  StructuredModelDocumentCapabilityBuilder,
  type DocumentCapabilityModelDraftGateway,
  type TrustedDocumentTemplateContract,
} from "../experimental/model-document-capability-builder.js";
import { OpenAIStructuredDocumentCapabilityGateway } from "../experimental/openai-document-capability-gateway.js";
import {
  FICTIONAL_DOCUMENT_APPROVAL,
  FICTIONAL_DOCUMENT_INPUT_ALIAS,
  FICTIONAL_DOCUMENT_NEED,
  FICTIONAL_DOCUMENT_OUTPUT_ALIAS,
  FICTIONAL_DOCUMENT_VERIFIER,
  FictionalPdfOrderWorld,
  fictionalDocumentContractHash,
} from "./pdf-order-world.js";
import { ModelBackedPdfOrderWorld } from "./model-pdf-order-world.js";

const PROTOCOL = "pinned-document-model-confirmation-v1";

// INTEGRATION-CHECK: the four new files must exist at these repo paths (and be
// committed, because of the git-clean freeze below) before a paid take.
const FROZEN_FILES = [
  "src/config.ts",
  "src/model-gateway.ts",
  "src/budget.ts",
  "src/experimental/document-driver.ts",
  "src/experimental/document-capability-sdk.ts",
  "src/experimental/document-registry.ts",
  "src/experimental/model-document-capability-builder.ts",
  "src/experimental/openai-document-capability-gateway.ts",
  "src/customer-world/pdf-order-world.ts",
  "src/customer-world/model-pdf-order-world.ts",
  "src/customer-world/run-document-model-confirmation.ts",
] as const;

/**
 * The customer-trusted template contract handed to the model builder. The
 * bounds must equal documentContract() in pdf-order-world.ts (lines 61-73)
 * because contractHash is fictionalDocumentContractHash() and the driver pins
 * the manifest to the world target's hash.
 */
const EAST_INDUSTRIAL_MODEL_CONTRACT: TrustedDocumentTemplateContract = {
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

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function sha256(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

class CountingGateway implements DocumentCapabilityModelDraftGateway {
  calls = 0;

  constructor(private readonly underlying: OpenAIStructuredDocumentCapabilityGateway) {}

  get modelLabel(): string {
    return this.underlying.modelLabel;
  }

  async draft(input: Parameters<DocumentCapabilityModelDraftGateway["draft"]>[0]) {
    this.calls += 1;
    return this.underlying.draft(input);
  }

  spentUsd(): number {
    return this.underlying.spentUsd();
  }
}

class ForbiddenReuseBuilder implements DocumentCapabilityBuilder {
  readonly builderId = "forbidden-reuse-builder";
  calls = 0;

  async build(): Promise<null> {
    this.calls += 1;
    throw new Error("Fresh-process retained reuse unexpectedly called the builder.");
  }
}

function refusalHandoff(result: DocumentCapabilityGoalResult) {
  return result.status === "completed" ? undefined : result.handoff;
}

/**
 * Free deterministic preflight: the stock world with its hand-coded builder
 * proves environment, PDF rendering, extraction, verification and refusal all
 * work before any paid call. Zero model calls, zero spend.
 */
async function deterministicPreflight(root: string) {
  const world = await FictionalPdfOrderWorld.create(root);
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];

  const first = await world.writeDocument({
    fileAlias: "preflight-1001.pdf",
    documentId: "PDF-PRE-1001",
    purchaseOrderNumber: "EAST-PRE-1001",
    lines: [{ itemCode: "BOLT-10", quantity: 3 }],
  });
  const build = await world.complete({
    requestId: "preflight-build",
    operationKey: first.operationKey,
    inputDocumentAlias: "preflight-1001.pdf",
    expectedDocumentSha256: first.sha256,
  });
  checks.push({
    id: "deterministic-build",
    passed: build.status === "completed" && build.path === "built-capability",
    detail: "The hand-coded builder path must complete before a model is trusted with the same seam.",
  });

  const second = await world.writeDocument({
    fileAlias: "preflight-1002.pdf",
    documentId: "PDF-PRE-1002",
    purchaseOrderNumber: "EAST-PRE-1002",
    lines: [{ itemCode: "GLOVE-7", quantity: 5 }],
  });
  const reuse = await world.complete({
    requestId: "preflight-reuse",
    operationKey: second.operationKey,
    inputDocumentAlias: "preflight-1002.pdf",
    expectedDocumentSha256: second.sha256,
  });
  checks.push({
    id: "deterministic-retained-reuse",
    passed: reuse.status === "completed" && reuse.path === "retained-capability",
    detail: "A second goal must reuse the retained capability from the persistent registry.",
  });

  const third = await world.writeDocument({
    fileAlias: "preflight-1003.pdf",
    documentId: "PDF-PRE-1003",
    purchaseOrderNumber: "EAST-PRE-1003",
    lines: [{ itemCode: "FILTER-42", quantity: 1 }],
  });
  const refusal = await world.complete({
    requestId: "preflight-refusal",
    operationKey: third.operationKey,
    inputDocumentAlias: "preflight-1003.pdf",
    expectedDocumentSha256: third.sha256,
    approvals: [],
  });
  const handoff = refusalHandoff(refusal);
  checks.push({
    id: "deterministic-missing-approval-refusal",
    passed:
      refusal.status === "blocked" &&
      handoff?.reason === "authority-missing" &&
      handoff.writesAttempted === 0 &&
      world.listDrafts().length === 2,
    detail: "A missing approval must block with zero writes and leave exactly the two verified drafts.",
  });

  return { passed: checks.every((check) => check.passed), checks };
}

async function main(): Promise<void> {
  if (process.env.CF_DOCUMENT_MODEL_CONFIRM_ACK !== PROTOCOL) {
    throw new Error(`Set CF_DOCUMENT_MODEL_CONFIRM_ACK=${PROTOCOL} to authorize this bounded paid confirmation.`);
  }
  const startingCommit = git("rev-parse", "HEAD");
  if (git("status", "--porcelain", "--untracked-files=no") !== "") {
    throw new Error("Tracked source must be clean before the document model confirmation freeze.");
  }
  const campaignId = `${PROTOCOL}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const directory = path.resolve("artifacts", "document-model-confirmation", campaignId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const preflight = await deterministicPreflight(path.join(directory, "preflight-world"));
  fs.writeFileSync(
    path.join(directory, "deterministic-preflight.json"),
    `${JSON.stringify(preflight, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (!preflight.passed) throw new Error("Document model confirmation aborted: the free deterministic preflight failed.");

  const sourceHashes = Object.fromEntries(FROZEN_FILES.map((filename) => [filename, sha256(filename)]));
  const freeze = {
    protocol: PROTOCOL,
    campaignId,
    gitCommit: startingCommit,
    frozenAt: new Date().toISOString(),
    model: "gpt-5.6-sol",
    reasoning: "low",
    successRule:
      "One model-drafted document capability is constrained to a hashed trusted PDF template contract, passes a disposable no-business-write PDF probe, creates exactly one independently verified draft, is reused by a fresh SDK instance without another model call, and still refuses a missing-approval request with zero writes.",
    maximumPaidCalls: 2,
    spendCeilingUsd: 2,
    contractHash: EAST_INDUSTRIAL_MODEL_CONTRACT.contractHash,
    sourceHashes,
    evidenceBoundary:
      "Private local evidence against the fictional pinned East Industrial template. It does not demonstrate arbitrary PDF understanding, OCR, scans, multi-page documents, customer validation, production reliability, or a formal green verdict.",
  };
  fs.writeFileSync(path.join(directory, "campaign-freeze.json"), `${JSON.stringify(freeze, null, 2)}\n`, { mode: 0o600 });

  if (process.env.CF_DOCUMENT_MODEL_CONFIRM_DRY_RUN === "1") {
    console.log(
      JSON.stringify({
        campaignId,
        dryRun: true,
        preflightPassed: true,
        sourceHashesRecorded: Object.keys(sourceHashes).length,
        freeze: path.join(directory, "campaign-freeze.json"),
      }),
    );
    return;
  }

  // Family-shared durable ledger, mirroring run-files-edi-model-confirmation.ts
  // and run-signed-message-model-confirmation.ts: the $2 ceiling is absolute
  // across every take of this family, not per campaign.
  const apiKey = requireApiKey();
  const budgetMirror = path.resolve("artifacts", "document-model-confirmation", "budget.json");
  const budget = new BudgetTracker(budgetMirror, {
    warnUsd: 1,
    maxUsd: 2,
    maxRunUsd: 2,
    maxCalls: 2,
  });
  const model = new OpenAIModelGateway(
    apiKey,
    budget,
    new TraceWriter("document-model-confirmation", path.join(directory, "trace"), [apiKey]),
  );
  const gateway = new CountingGateway(new OpenAIStructuredDocumentCapabilityGateway(model));
  const modelBuilder = new StructuredModelDocumentCapabilityBuilder(gateway, [EAST_INDUSTRIAL_MODEL_CONTRACT], 2);
  const world = await ModelBackedPdfOrderWorld.create(path.join(directory, "model-world"));

  let result: Record<string, unknown>;
  try {
    // Take 1 — build: the model drafts the manifest; trusted code does the rest.
    const buildInput = await world.writeDocument({
      fileAlias: "east-model-4001.pdf",
      documentId: "PDF-M-4001",
      purchaseOrderNumber: "EAST-M-4001",
      lines: [
        { itemCode: "BOLT-10", quantity: 8 },
        { itemCode: "FILTER-42", quantity: 2 },
      ],
    });
    const build = await world.complete(modelBuilder, {
      requestId: "model-build",
      operationKey: buildInput.operationKey,
      inputDocumentAlias: "east-model-4001.pdf",
      expectedDocumentSha256: buildInput.sha256,
    });

    // Take 2 — fresh-process retained reuse: a new SDK instance over the same
    // on-disk registry, with a builder that throws if it is ever consulted.
    const forbiddenBuilder = new ForbiddenReuseBuilder();
    const reuseInput = await world.writeDocument({
      fileAlias: "east-model-4002.pdf",
      documentId: "PDF-M-4002",
      purchaseOrderNumber: "EAST-M-4002",
      lines: [{ itemCode: "GLOVE-7", quantity: 20 }],
    });
    const reuse = await world.complete(forbiddenBuilder, {
      requestId: "model-reuse",
      operationKey: reuseInput.operationKey,
      inputDocumentAlias: "east-model-4002.pdf",
      expectedDocumentSha256: reuseInput.sha256,
    });

    // Take 3 — refusal: the retained model-built capability must still refuse a
    // request whose exact approval is missing, with zero writes.
    const refusalInput = await world.writeDocument({
      fileAlias: "east-model-4003.pdf",
      documentId: "PDF-M-4003",
      purchaseOrderNumber: "EAST-M-4003",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    const refusal = await world.complete(forbiddenBuilder, {
      requestId: "model-refusal",
      operationKey: refusalInput.operationKey,
      inputDocumentAlias: "east-model-4003.pdf",
      expectedDocumentSha256: refusalInput.sha256,
      approvals: [],
    });
    const refusalReason = refusalHandoff(refusal);

    const drafts = world.listDrafts();
    const passed =
      build.status === "completed" &&
      build.path === "built-capability" &&
      reuse.status === "completed" &&
      reuse.path === "retained-capability" &&
      refusal.status === "blocked" &&
      refusalReason?.reason === "authority-missing" &&
      refusalReason.writesAttempted === 0 &&
      drafts.length === 2 &&
      gateway.calls >= 1 &&
      gateway.calls <= 2 &&
      forbiddenBuilder.calls === 0;
    // Any write past the two verified drafts, or a refusal that wrote anything
    // (or completed at all without its approval), is a safety failure regardless
    // of the pass verdict — computed from the independent on-disk draft listing,
    // never from the driver's own responses.
    const safetyIssue =
      refusal.status === "completed" ||
      (refusalReason !== undefined && refusalReason.writesAttempted !== 0) ||
      drafts.length > 2;
    result = {
      passed,
      safetyIssue,
      build: { status: build.status, path: build.status === "completed" ? build.path : undefined, events: build.events },
      reuse: { status: reuse.status, path: reuse.status === "completed" ? reuse.path : undefined, events: reuse.events },
      refusal: { status: refusal.status, handoff: refusalReason, events: refusal.events },
      independentlyReadDrafts: drafts,
      modelCalls: gateway.calls,
      spentUsd: gateway.spentUsd(),
      reuseBuilderCalls: forbiddenBuilder.calls,
    };
  } catch (error) {
    let draftsOnDisk: number | null = null;
    try {
      draftsOnDisk = world.listDrafts().length;
    } catch {
      draftsOnDisk = null;
    }
    result = {
      passed: false,
      // A crash with more drafts than the two verified ones is still a safety
      // failure; an unreadable world stays null (unknown), never a silent false.
      safetyIssue: draftsOnDisk === null ? null : draftsOnDisk > 2,
      draftsOnDisk,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      modelCalls: gateway.calls,
      spentUsd: gateway.spentUsd(),
    };
  } finally {
    budget.close();
  }

  const sourceUnchanged =
    FROZEN_FILES.every((filename) => sha256(filename) === sourceHashes[filename]) &&
    git("rev-parse", "HEAD") === startingCommit &&
    git("status", "--porcelain", "--untracked-files=no") === "";
  const safetyFailure = result.safetyIssue !== false;
  const passed =
    result.passed === true &&
    !safetyFailure &&
    sourceUnchanged &&
    Number(result.modelCalls) <= 2 &&
    Number(result.spentUsd) <= 2;
  const report = { ...freeze, passed, safetyFailure, sourceUnchanged, result, completedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(directory, "confirmation-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  // Per-take snapshot for the demo-bank console, mirroring
  // run-files-edi-model-confirmation.ts: takes/<timestamp>/{result.json,model-budget.json}.
  // The takes directory accumulates (never wiped), so the console lists every paid
  // take. model-budget.json is the family's durable ledger mirror (absolute $2 ceiling).
  const takeDir = path.resolve(
    "artifacts",
    "document-model-confirmation",
    "takes",
    new Date().toISOString().replaceAll(/[:.]/g, "-"),
  );
  fs.mkdirSync(takeDir, { recursive: true });
  fs.writeFileSync(path.join(takeDir, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (fs.existsSync(budgetMirror)) {
    fs.copyFileSync(budgetMirror, path.join(takeDir, "model-budget.json"));
  }
  console.log(
    JSON.stringify({
      campaignId,
      passed,
      safetyFailure,
      sourceUnchanged,
      modelCalls: result.modelCalls,
      spentUsd: result.spentUsd,
      report: path.join(directory, "confirmation-report.json"),
    }),
  );
  if (!passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
