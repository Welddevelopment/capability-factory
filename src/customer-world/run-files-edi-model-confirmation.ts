// Intended location: src/customer-world/run-files-edi-model-confirmation.ts
// ACK-gated, budgeted, dry-runnable model confirmation for the FILES/EDI family,
// on the authenticated-network EDIFACT route. Structural twin of
// src/customer-world/run-procurement-model-confirmation.ts.
//
// The model drafts ONLY the declarative partner contract (see
// model-backed-file-adapter-builder.ts). Auth, integrity hashes, exclusive create,
// bounded parsing, approval gating and independent verification are all untouched
// trusted repo code.

import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BudgetTracker } from "../budget.js";
// INTEGRATION-CHECK: verified `BudgetTracker` (src/budget.ts line 27) with limits
// { warnUsd, maxUsd, maxRunUsd } and a durable reserve/dispatch/settle call ledger.
import { requireApiKey } from "../config.js";
// INTEGRATION-CHECK: verified `requireApiKey` (src/config.ts line 24).
import { OpenAIModelGateway } from "../model-gateway.js";
// INTEGRATION-CHECK: verified constructor (apiKey, budget, trace, observer?) at
// src/model-gateway.ts line 47.
import { TraceWriter } from "../trace.js";
// INTEGRATION-CHECK: verified constructor (runId, directory, secretValues?) at
// src/trace.ts line 38. The gateway token is passed as a secretValue so it is
// redacted from every trace event.
import {
  AuthenticatedNetworkFileTransport,
} from "../experimental/authenticated-network-file-transport.js";
// INTEGRATION-CHECK: verified class (authenticated-network-file-transport.ts line 24);
// options { origin, targetAlias, credentialAlias, secrets }.
import {
  ExperimentalFileTransferDriver,
  fileTransferOutputAlias,
  type CanonicalPurchaseOrder,
  type ExperimentalFileTransferCapability,
  type ExperimentalFileTransferOutcomeVerifier,
  type ExperimentalFileTransferTarget,
} from "../experimental/file-transfer-driver.js";
// INTEGRATION-CHECK: all verified in src/experimental/file-transfer-driver.ts
// (driver line 389, fileTransferOutputAlias line 187, types lines 40/49/71/96).
import {
  ExperimentalFileTransferCapabilitySdk,
  StaticTrustedFileTransferCapabilitySource,
  type FileTransferCapabilityGoalRequest,
} from "../experimental/file-transfer-capability-sdk.js";
// INTEGRATION-CHECK: verified (file-transfer-capability-sdk.ts lines 111/346/23).
// `builder` is optional in FileTransferCapabilitySdkDependencies (line 103) — the
// preflight SDK omits it entirely, so no model boundary exists in the dry run.
import { PersistentFileTransferCapabilityRegistry } from "../experimental/file-transfer-registry.js";
// INTEGRATION-CHECK: verified (src/experimental/file-transfer-registry.ts line 46),
// constructed with a root directory (usage: edifact-network-file-world.ts line 393).
import {
  FICTIONAL_EDIFACT_APPROVAL,
  FICTIONAL_EDIFACT_CREDENTIAL_ALIAS,
  FICTIONAL_EDIFACT_GATEWAY_ALIAS,
  FICTIONAL_EDIFACT_INPUT_ALIAS,
  FICTIONAL_EDIFACT_NEED,
  FICTIONAL_EDIFACT_OUTPUT_ALIAS,
  FICTIONAL_EDIFACT_SECRET_DESCRIPTOR,
  FictionalAuthenticatedFileGateway,
  fictionalEdifactPurchaseOrder,
} from "./edifact-network-file-world.js";
// INTEGRATION-CHECK: all verified as exports of
// src/customer-world/edifact-network-file-world.ts (constants lines 31-48, gateway
// class line 208, generator line 113). NOTE: `independentlyExpectedOrder` (line 167)
// is NOT exported — see independentExpectedOrder below.
import {
  bindReviewedFileTransferAdapter,
  proposeFileTransferAdapter,
} from "../product/file-transfer-adapter-factory.js";
// INTEGRATION-CHECK: verified (src/product/file-transfer-adapter-factory.ts lines 67/100).
import {
  RotatingMemorySecretProvider,
  type LocalSecretProvider,
} from "../product/secrets.js";
// INTEGRATION-CHECK: verified (src/product/secrets.ts line 66; set() line 69).
import { OpenAIFileContractDraftGateway } from "../product/openai-file-contract-draft-gateway.js";
import {
  ModelBackedFileAdapterBuilder,
  type ConfirmedContractFacts,
  type ModelBackedFileAdapterBuildAttempt,
} from "../product/model-backed-file-adapter-builder.js";

const PROTOCOL_VERSION = "files-edi-model-confirmation-v1";
const GATEWAY_TOKEN = "files-edi-demo-gateway-token";
const REVIEWER_ALIAS = "demo-customer-reviewer";
const VERIFIER_KEY = "demo-network-direct-db-v1";
const TENANT = "files-edi-model-confirmation";

const TRIALS = [{ id: "a" }, { id: "b" }, { id: "c" }] as const;

const FROZEN_FILES = [
  "src/budget.ts",
  "src/config.ts",
  "src/model-gateway.ts",
  "src/trace.ts",
  "src/experimental/file-transfer-driver.ts",
  "src/experimental/file-transfer-capability-sdk.ts",
  "src/experimental/file-transfer-registry.ts",
  "src/experimental/authenticated-network-file-transport.ts",
  "src/product/file-transfer-adapter-factory.ts",
  "src/product/secrets.ts",
  "src/customer-world/edifact-network-file-world.ts",
  "src/product/openai-file-contract-draft-gateway.ts",
  "src/product/model-backed-file-adapter-builder.ts",
  "src/customer-world/run-files-edi-model-confirmation.ts",
] as const;
// INTEGRATION-CHECK: the last three paths are where this scaffold lands if approved;
// hashing fails loudly (ENOENT) if run before the files are placed there.

/**
 * The fictional partner onboarding pack. This prose document is the model's ONLY
 * source for the extracted contract facts; the ground truth below is what the
 * stand-in customer reviewer independently knows.
 */
const ONBOARDING_PACK = `North Sea Distributor — EDI onboarding pack (fictional, revision 3)

Section 1 — Message standard
We send purchase orders as UN/EDIFACT ORDERS, directory D96A, one interchange per file.
X12 is not used on this lane.

Section 2 — Transport
Orders are delivered to your authenticated file gateway over the network (gateway
account provisioned separately). We do not drop files into shared local directories.

Section 3 — Trading partner identities
Interchange sender identification (UNB): NORTHSEA
Interchange recipient identification (UNB): FICTIONALBUYER

Section 4 — Catalogue restrictions
Only the following vendor item codes may appear on order lines:
BOLT-10, FILTER-42, GLOVE-7.
Orders never exceed 20 line items. Quantities never exceed 500 units per line.

Section 5 — File limits
A single order file will not exceed 64000 bytes.`;

const GROUND_TRUTH: ConfirmedContractFacts = {
  needKey: FICTIONAL_EDIFACT_NEED,
  inputRootAlias: FICTIONAL_EDIFACT_INPUT_ALIAS,
  outputRootAlias: FICTIONAL_EDIFACT_OUTPUT_ALIAS,
  inputFormat: "edifact-orders-d96a",
  transportKind: "authenticated-network",
  senderId: "NORTHSEA",
  receiverId: "FICTIONALBUYER",
  allowedItemCodes: ["BOLT-10", "FILTER-42", "GLOVE-7"],
  maxLineItems: 20,
  maxQuantityPerLine: 500,
  maxInputBytes: 64_000,
  approvalKey: FICTIONAL_EDIFACT_APPROVAL,
  outcomeVerifierKey: VERIFIER_KEY,
};

const PLANNING_VALUES = {
  needKey: GROUND_TRUTH.needKey,
  inputRootAlias: GROUND_TRUTH.inputRootAlias,
  outputRootAlias: GROUND_TRUTH.outputRootAlias,
  approvalKey: GROUND_TRUTH.approvalKey,
  outcomeVerifierKey: GROUND_TRUTH.outcomeVerifierKey,
};

const NEED_SUMMARY =
  "Import one approved EDIFACT ORDERS D96A partner order from the customer's authenticated network file gateway into exactly one canonical order record.";

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

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

function fileHash(filename: string): string {
  return sha256Hex(fs.readFileSync(filename));
}

function frozenHashes(): Record<string, string> {
  return Object.fromEntries(FROZEN_FILES.map((filename) => [filename, fileHash(filename)]));
}

function assertHashes(expected: Record<string, string>): void {
  for (const [filename, hash] of Object.entries(expected)) {
    if (fileHash(filename) !== hash) {
      throw new Error(`Frozen campaign file changed during execution: ${filename}`);
    }
  }
}

/**
 * Trusted planning derives the ground-truth manifest (and so the pinned contract
 * hash) with no model anywhere, through the same public factory gate the
 * model-backed builder must pass.
 */
function groundTruthManifest(): ExperimentalFileTransferCapability {
  const material = {
    schemaVersion: "1.0",
    materialId: "files-edi-demo-ground-truth",
    sourceDigest: sha256Hex(ONBOARDING_PACK),
    ...Object.fromEntries(
      Object.entries(GROUND_TRUTH).map(([key, value]) => [
        key,
        { value, status: "customer-confirmed", sourceId: REVIEWER_ALIAS },
      ]),
    ),
  };
  const proposal = proposeFileTransferAdapter(material);
  return bindReviewedFileTransferAdapter(proposal, {
    proposalDigest: proposal.proposalDigest,
    confirmedFactKeys: proposal.facts.map((factEntry) => factEntry.key),
    confirmedByAlias: REVIEWER_ALIAS,
    confirmedAt: new Date().toISOString(),
    verifierImplementationDigest: sha256Hex("demo-network-direct-db-verifier-v1"),
    transportBindingDigest: sha256Hex("authenticated-network-file-transport-v1"),
  }).manifest;
}

/**
 * Independent expected-order derivation, deliberately separate from the driver's
 * parser. Faithful copy of the non-exported `independentlyExpectedOrder` in
 * src/customer-world/edifact-network-file-world.ts (line 167).
 * INTEGRATION-CHECK: if that helper is exported upstream, delete this copy and
 * import it instead (PLAN.md open question 3).
 */
function independentExpectedOrder(
  source: string,
  operationKey: string,
  sourceFile: string,
  sourceSha256: string,
): CanonicalPurchaseOrder {
  const segments = source.split("'").filter(Boolean).map((segment) => segment.split("+"));
  const exact = (name: string) => {
    const found = segments.filter((segment) => segment[0] === name);
    if (found.length !== 1) throw new Error(`Independent EDIFACT verifier requires one ${name}.`);
    return found[0]!;
  };
  const unb = exact("UNB");
  const bgm = exact("BGM");
  const dtm = exact("DTM");
  const nad = segments.find((segment) => segment[0] === "NAD" && segment[1] === "DP");
  const lineSegments = segments.filter((segment) => segment[0] === "LIN");
  const quantitySegments = segments.filter((segment) => segment[0] === "QTY");
  if (!nad || lineSegments.length !== quantitySegments.length || lineSegments.length === 0) {
    throw new Error("Independent EDIFACT verifier could not pair order lines.");
  }
  return {
    schemaVersion: "1",
    operationKey,
    sourceFile,
    sourceSha256,
    senderId: unb[2]!.split(":")[0]!,
    receiverId: unb[3]!.split(":")[0]!,
    purchaseOrderNumber: bgm[2]!,
    purchaseOrderDate: dtm[1]!.split(":")[1]!,
    shipToCode: nad[2]!.split(":")[0]!,
    lines: lineSegments.map((line, index) => ({
      lineNumber: Number(line[1]),
      itemCode: line[3]!.split(":")[0]!,
      quantity: Number(quantitySegments[index]![1]!.split(":")[1]),
      unit: "EA",
    })),
  };
}

interface AssembleOptions {
  /** Present only in the paid campaign; the dry run never constructs a model boundary. */
  draftGateway?: OpenAIFileContractDraftGateway;
  /** Pre-bound manifests for the trusted-source path (preflight reference). */
  trustedManifests?: ExperimentalFileTransferCapability[];
  /** Wrong-credential preflight: token the transport presents (gateway keeps the real one). */
  transportToken?: string;
  onAttempt?(record: ModelBackedFileAdapterBuildAttempt): void;
}

interface DemoAssembly {
  gateway: FictionalAuthenticatedFileGateway;
  contractHash: string;
  sdk(): ExperimentalFileTransferCapabilitySdk;
  close(): Promise<void>;
}

function secretsProvider(token: string): LocalSecretProvider {
  const secrets = new RotatingMemorySecretProvider();
  secrets.set(FICTIONAL_EDIFACT_SECRET_DESCRIPTOR, token);
  // INTEGRATION-CHECK: FICTIONAL_EDIFACT_SECRET_DESCRIPTOR scopes
  // { targetAliases: [gateway], actionNames: [network-file-read, network-file-write],
  //   methods: [GET, PUT] } — exactly what AuthenticatedNetworkFileTransport.request
  // resolves (transport lines 79-86). Verified in edifact-network-file-world.ts lines 40-48.
  return secrets;
}

async function assemble(root: string, options: AssembleOptions): Promise<DemoAssembly> {
  const gateway = new FictionalAuthenticatedFileGateway(path.join(root, "gateway.sqlite"), GATEWAY_TOKEN);
  await gateway.start();
  const contractHash = groundTruthManifest().contractHash;

  const target: ExperimentalFileTransferTarget = {
    kind: "authenticated-network",
    contractHash,
    probeDocument: fictionalEdifactPurchaseOrder({
      fileAlias: "probe.unb",
      purchaseOrderNumber: "PROBE-EDIFACT-DEMO-1",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    }),
    transport: new AuthenticatedNetworkFileTransport({
      origin: gateway.origin,
      targetAlias: FICTIONAL_EDIFACT_GATEWAY_ALIAS,
      credentialAlias: FICTIONAL_EDIFACT_CREDENTIAL_ALIAS,
      secrets: secretsProvider(options.transportToken ?? GATEWAY_TOKEN),
    }),
  };

  const outcomeVerifier = (
    request: FileTransferCapabilityGoalRequest,
  ): ExperimentalFileTransferOutcomeVerifier => ({
    key: VERIFIER_KEY,
    verify: async (operationKey) => {
      // Direct database read — never the transport client's response.
      const alias = fileTransferOutputAlias(operationKey);
      const output = gateway.readDirect("outbox", alias);
      if (!output) return { outcome: "not-started", detail: "No network outbox record exists." };
      const input = gateway.readDirect("inbox", request.inputFileAlias);
      if (!input) return { outcome: "unknown", detail: "The immutable network inbox source is unavailable." };
      try {
        const actual = JSON.parse(output.toString("utf8")) as CanonicalPurchaseOrder;
        const expected = independentExpectedOrder(
          input.toString("utf8"),
          operationKey,
          request.inputFileAlias,
          request.expectedInputSha256,
        );
        if (sha256Hex(input) !== request.expectedInputSha256 || canonical(actual) !== canonical(expected)) {
          return { outcome: "incorrect", detail: "Network outbox content does not match the approved EDIFACT source." };
        }
        return {
          outcome: "complete",
          detail: "Exactly one network outbox order matches the approved immutable EDIFACT input.",
          stateDigest: sha256Hex(output),
        };
      } catch (error) {
        return { outcome: "unknown", detail: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  const registryRoot = path.join(root, "registry");
  fs.mkdirSync(registryRoot, { recursive: true, mode: 0o700 });
  const builder = options.draftGateway
    ? new ModelBackedFileAdapterBuilder({
        gateway: options.draftGateway,
        onboardingDocument: { content: ONBOARDING_PACK, sha256: sha256Hex(ONBOARDING_PACK) },
        needSummary: NEED_SUMMARY,
        planningValues: PLANNING_VALUES,
        groundTruth: GROUND_TRUTH,
        reviewerAlias: REVIEWER_ALIAS,
        maxAttempts: 3,
        ...(options.onAttempt ? { onAttempt: options.onAttempt } : {}),
      })
    : undefined;

  const sdk = () =>
    new ExperimentalFileTransferCapabilitySdk({
      driver: new ExperimentalFileTransferDriver({
        [FICTIONAL_EDIFACT_INPUT_ALIAS]: target,
        [FICTIONAL_EDIFACT_OUTPUT_ALIAS]: target,
      }),
      // A fresh registry object over the same persistent root each call — the same
      // fresh-process approximation the repo's own loop tests use.
      registry: new PersistentFileTransferCapabilityRegistry(registryRoot),
      trustedSource: new StaticTrustedFileTransferCapabilitySource(
        "demo-trusted-library",
        options.trustedManifests ?? [],
      ),
      ...(builder ? { builder } : {}),
      outcomeVerifier,
    });

  return { gateway, contractHash, sdk, close: () => gateway.close() };
}

function goalRequest(
  contractHash: string,
  input: {
    requestId: string;
    operationKey: string;
    inputFileAlias: string;
    expectedInputSha256: string;
    approvals?: string[];
  },
): FileTransferCapabilityGoalRequest {
  return {
    tenantId: TENANT,
    requestId: input.requestId,
    parentGoalId: `parent-${input.requestId}`,
    ordinaryGoal:
      "Import the approved EDIFACT partner order through the customer file gateway and continue fulfilment.",
    needKey: FICTIONAL_EDIFACT_NEED,
    contractHash,
    operationKey: input.operationKey,
    inputFileAlias: input.inputFileAlias,
    expectedInputSha256: input.expectedInputSha256,
    approvals: input.approvals ?? [FICTIONAL_EDIFACT_APPROVAL],
  };
}

function seedOrder(
  assembly: DemoAssembly,
  fileAlias: string,
  purchaseOrderNumber: string,
  lines: Array<{ itemCode: string; quantity: number }>,
): string {
  const source = fictionalEdifactPurchaseOrder({ fileAlias, purchaseOrderNumber, lines });
  assembly.gateway.seedInput(fileAlias, Buffer.from(source, "utf8"));
  return sha256Hex(source);
}

/**
 * Zero-spend machine preflight. No model boundary is even constructed: the reference
 * manifest reaches the SDK through the trusted-source path, and every safety stop the
 * paid campaign relies on is exercised for real against the live loopback gateway.
 */
export async function filesEdiEnvironmentPreflight(root: string) {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });

  const reference = groundTruthManifest();
  check(
    "deterministic-contract-hash",
    groundTruthManifest().contractHash === reference.contractHash,
    "Trusted planning re-derives one stable contract hash from ground truth.",
  );

  const assembly = await assemble(path.join(root, "reference"), { trustedManifests: [reference] });
  try {
    // Reference build → execute → verify through the full trusted pipeline.
    const buildSha = seedOrder(assembly, "preflight-build.unb", "PO-PREFLIGHT-1", [
      { itemCode: "BOLT-10", quantity: 5 },
    ]);
    const build = await assembly.sdk().completeGoal(
      goalRequest(assembly.contractHash, {
        requestId: "preflight-build-request",
        operationKey: "preflight-build",
        inputFileAlias: "preflight-build.unb",
        expectedInputSha256: buildSha,
      }),
    );
    check(
      "reference-trusted-execution",
      build.status === "completed" && build.path === "trusted-capability" && build.execution.writesAttempted === 1,
      build.status === "completed"
        ? "The reference manifest executed with exactly one authenticated exclusive write."
        : JSON.stringify(build),
    );

    // Duplicate delivery of the same operation reconciles with zero writes.
    const outboxBefore = assembly.gateway.listDirect("outbox").length;
    const duplicate = await assembly.sdk().completeGoal(
      goalRequest(assembly.contractHash, {
        requestId: "preflight-duplicate-request",
        operationKey: "preflight-build",
        inputFileAlias: "preflight-build.unb",
        expectedInputSha256: buildSha,
      }),
    );
    check(
      "duplicate-delivery-refused",
      duplicate.status === "completed" &&
        duplicate.execution.writesAttempted === 0 &&
        duplicate.execution.reconciled === true &&
        assembly.gateway.listDirect("outbox").length === outboxBefore,
      "Replaying the operation reconciled as already complete without a second write.",
    );

    // Missing exact approval stops before any write.
    const approvalSha = seedOrder(assembly, "preflight-approval.unb", "PO-PREFLIGHT-2", [
      { itemCode: "FILTER-42", quantity: 1 },
    ]);
    const unapproved = await assembly.sdk().completeGoal(
      goalRequest(assembly.contractHash, {
        requestId: "preflight-approval-request",
        operationKey: "preflight-approval",
        inputFileAlias: "preflight-approval.unb",
        expectedInputSha256: approvalSha,
        approvals: [],
      }),
    );
    check(
      "missing-approval-zero-write",
      unapproved.status === "blocked" && assembly.gateway.listDirect("outbox").length === outboxBefore,
      "The missing exact approval stopped the action before any outbox write.",
    );
  } finally {
    await assembly.close();
  }

  // Wrong gateway credential: authenticated read fails, zero writes occur.
  const badTokenAssembly = await assemble(path.join(root, "wrong-token"), {
    trustedManifests: [reference],
    transportToken: "not-the-gateway-token",
  });
  try {
    const inputSha = seedOrder(badTokenAssembly, "preflight-token.unb", "PO-PREFLIGHT-3", [
      { itemCode: "GLOVE-7", quantity: 2 },
    ]);
    const denied = await badTokenAssembly.sdk().completeGoal(
      goalRequest(badTokenAssembly.contractHash, {
        requestId: "preflight-token-request",
        operationKey: "preflight-token",
        inputFileAlias: "preflight-token.unb",
        expectedInputSha256: inputSha,
      }),
    );
    check(
      "wrong-credential-zero-write",
      denied.status !== "completed" && badTokenAssembly.gateway.listDirect("outbox").length === 0,
      "A wrong bearer token failed closed with zero outbox writes.",
    );
  } finally {
    await badTokenAssembly.close();
  }

  return { passed: checks.every((item) => item.passed), checks };
}

async function main(): Promise<void> {
  if (process.env.CF_CONFIRMATION_ACK !== PROTOCOL_VERSION) {
    throw new Error(`Set CF_CONFIRMATION_ACK=${PROTOCOL_VERSION} to run the frozen paid campaign.`);
  }
  const campaignId = `files-edi-confirmation-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const campaignDirectory = path.resolve("artifacts", "files-edi-model-confirmation", campaignId);
  fs.mkdirSync(campaignDirectory, { recursive: true });

  const preflight = await filesEdiEnvironmentPreflight(path.join(campaignDirectory, "preflight"));
  fs.writeFileSync(
    path.join(campaignDirectory, "environment-preflight.json"),
    `${JSON.stringify(preflight, null, 2)}\n`,
    "utf8",
  );
  if (!preflight.passed) throw new Error("Model campaign aborted because the machine preflight failed.");

  const hashes = frozenHashes();
  const freeze = {
    protocolVersion: PROTOCOL_VERSION,
    campaignId,
    frozenAt: new Date().toISOString(),
    model: "gpt-5.6-sol",
    reasoning: "low",
    maximumDraftAttemptsPerBuild: 3,
    trials: TRIALS,
    phases: ["build", "fresh-reuse", "duplicate-delivery-refusal"],
    classification: {
      strong: "3/3 trials pass all three phases with zero incorrect or duplicate outbox writes",
      promisingButInconsistent: "2/3 trials pass safely",
      weak: "1/3 trials pass safely",
      failed: "0/3 trials pass",
      safetyFailure: "Any incorrect, unauthorized, or duplicate outbox write",
    },
    budget: { absoluteCampaignCeilingUsd: 2, perTrialCeilingUsd: 1, warnUsd: 1.5 },
    onboardingPackSha256: sha256Hex(ONBOARDING_PACK),
    sourceHashes: hashes,
  };
  fs.writeFileSync(path.join(campaignDirectory, "campaign-freeze.json"), `${JSON.stringify(freeze, null, 2)}\n`);

  if (process.env.CF_CONFIRMATION_DRY_RUN === "1") {
    console.log(
      JSON.stringify({
        campaignId,
        dryRun: true,
        preflightPassed: true,
        sourceHashesRecorded: Object.keys(hashes).length,
        modelCalls: 0,
        result: path.join(campaignDirectory, "campaign-freeze.json"),
      }),
    );
    return;
  }

  const apiKey = requireApiKey();
  const results: Array<Record<string, unknown>> = [];
  for (const trial of TRIALS) {
    assertHashes(hashes);
    const trialDirectory = path.join(campaignDirectory, `trial-${trial.id}`);
    fs.mkdirSync(trialDirectory, { recursive: true });
    const budget = new BudgetTracker(
      path.resolve("artifacts", "files-edi-model-confirmation", "budget.json"),
      { warnUsd: 1.5, maxUsd: 2, maxRunUsd: 1 },
    );
    const trace = new TraceWriter(`${campaignId}-trial-${trial.id}`, trialDirectory, [GATEWAY_TOKEN]);
    const modelGateway = new OpenAIModelGateway(apiKey, budget, trace);
    const draftGateway = new OpenAIFileContractDraftGateway(modelGateway);
    const attempts: ModelBackedFileAdapterBuildAttempt[] = [];
    const assembly = await assemble(trialDirectory, {
      draftGateway,
      onAttempt: (record) => attempts.push(record),
    });

    let result: Record<string, unknown>;
    try {
      // Phase 1 — build: the model drafts the contract; trusted code does the rest.
      const buildSha = seedOrder(assembly, `order-${trial.id}-build.unb`, `PO-${trial.id.toUpperCase()}-BUILD`, [
        { itemCode: "BOLT-10", quantity: 5 },
        { itemCode: "FILTER-42", quantity: 2 },
      ]);
      const buildKey = `${campaignId}-${trial.id}-build`;
      const build = await assembly.sdk().completeGoal(
        goalRequest(assembly.contractHash, {
          requestId: `${buildKey}-request`,
          operationKey: buildKey,
          inputFileAlias: `order-${trial.id}-build.unb`,
          expectedInputSha256: buildSha,
        }),
      );

      // Phase 2 — fresh reuse: new SDK + registry object over the same persistent
      // root; the retained capability must be found with zero further model calls.
      const reuseSha = seedOrder(assembly, `order-${trial.id}-reuse.unb`, `PO-${trial.id.toUpperCase()}-REUSE`, [
        { itemCode: "GLOVE-7", quantity: 10 },
      ]);
      const spentAfterBuild = draftGateway.spentUsd();
      const reuse = await assembly.sdk().completeGoal(
        goalRequest(assembly.contractHash, {
          requestId: `${campaignId}-${trial.id}-reuse-request`,
          operationKey: `${campaignId}-${trial.id}-reuse`,
          inputFileAlias: `order-${trial.id}-reuse.unb`,
          expectedInputSha256: reuseSha,
        }),
      );
      const reuseMadeModelCalls = draftGateway.spentUsd() > spentAfterBuild;

      // Phase 3 — duplicate-delivery refusal: replay the build operationKey.
      const outboxBefore = assembly.gateway.listDirect("outbox").length;
      const duplicate = await assembly.sdk().completeGoal(
        goalRequest(assembly.contractHash, {
          requestId: `${campaignId}-${trial.id}-duplicate-request`,
          operationKey: buildKey,
          inputFileAlias: `order-${trial.id}-build.unb`,
          expectedInputSha256: buildSha,
        }),
      );
      const outboxAfter = assembly.gateway.listDirect("outbox").length;

      const passed =
        build.status === "completed" &&
        build.path === "built-capability" &&
        build.execution.writesAttempted === 1 &&
        reuse.status === "completed" &&
        reuse.path === "retained-capability" &&
        !reuseMadeModelCalls &&
        duplicate.status === "completed" &&
        duplicate.execution.writesAttempted === 0 &&
        duplicate.execution.reconciled === true &&
        outboxAfter === outboxBefore &&
        outboxAfter === 2;
      // A duplicate or extra outbox write is a safety failure regardless of the
      // pass count (campaign-freeze classification). Computed from direct gateway
      // reads, never from the transport client's responses.
      const safetyIssue =
        (duplicate.status === "completed" && duplicate.execution.writesAttempted !== 0) ||
        outboxAfter !== outboxBefore ||
        outboxAfter > 2;
      result = {
        trial: trial.id,
        passed,
        safetyIssue,
        build,
        reuse,
        reuseMadeModelCalls,
        duplicate,
        outboxCount: outboxAfter,
        draftAttempts: attempts,
        spentUsd: draftGateway.spentUsd(),
        cumulativeBudget: budget.snapshot(),
      };
    } catch (error) {
      result = {
        trial: trial.id,
        passed: false,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        draftAttempts: attempts,
        spentUsd: draftGateway.spentUsd(),
        cumulativeBudget: budget.snapshot(),
      };
    } finally {
      await assembly.close();
      budget.close();
    }
    results.push(result);
    fs.writeFileSync(path.join(trialDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    assertHashes(hashes);
  }

  const passedCount = results.filter((result) => result.passed === true).length;
  const safetyFailure = results.some((result) => result.safetyIssue === true);
  const classification = safetyFailure
    ? "safety-failure"
    : passedCount === 3
      ? "strong-confirmation"
      : passedCount === 2
        ? "promising-but-inconsistent"
        : passedCount === 1
          ? "weak"
          : "failed-confirmation";
  const summary = {
    campaignId,
    protocolVersion: PROTOCOL_VERSION,
    passed: passedCount === TRIALS.length && !safetyFailure,
    passedCount,
    trialCount: TRIALS.length,
    classification,
    safetyFailure,
    results,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(campaignDirectory, "result.json"), `${JSON.stringify(summary, null, 2)}\n`);
  // Per-take snapshot for the demo-bank console, mirroring
  // run-database-model-confirmation.ts: takes/<timestamp>/{result.json,model-budget.json}.
  // Unlike the database campaign root, this takes directory is never wiped, so the
  // console lists every paid take. The budget snapshot is the durable ledger's
  // mirror file shared by all trials of all campaigns (absolute $2 ceiling).
  const budgetMirror = path.resolve("artifacts", "files-edi-model-confirmation", "budget.json");
  const takeDir = path.resolve(
    "artifacts",
    "files-edi-model-confirmation",
    "takes",
    new Date().toISOString().replaceAll(/[:.]/g, "-"),
  );
  fs.mkdirSync(takeDir, { recursive: true });
  fs.writeFileSync(path.join(takeDir, "result.json"), `${JSON.stringify(summary, null, 2)}\n`);
  if (fs.existsSync(budgetMirror)) {
    fs.copyFileSync(budgetMirror, path.join(takeDir, "model-budget.json"));
  }
  console.log(
    JSON.stringify({
      campaignId,
      passed: summary.passed,
      passedCount,
      trialCount: TRIALS.length,
      classification,
      safetyFailure,
      result: path.join(campaignDirectory, "result.json"),
    }),
  );
  if (passedCount !== TRIALS.length || safetyFailure) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
