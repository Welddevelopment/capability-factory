// Intended location: src/customer-world/run-signed-message-model-confirmation.ts
// Pattern sources (verified 2026-08-24):
//   src/customer-world/run-procurement-model-confirmation.ts  (ACK gate, freeze, dry run, trials, BudgetTracker)
//   src/customer-world/run-authenticated-message-ingress-expansion.ts  (world + ingress wiring, replay demo)
//   src/customer-world/run-files-edi-model-confirmation.ts  (takes/<timestamp> snapshot convention)
//
// CRITICAL BOUNDARY: signature verification, replay refusal, and ingress trust
// stay 100% trusted code (authenticated-message-ingress.ts, secrets.ts,
// inbox-message-driver.ts). The model drafts only the message-to-action
// mapping contract, through ModelInboxCapabilityBuilder.

import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BudgetTracker } from "../budget.js";
import { requireApiKey } from "../config.js";
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
import {
  RotatingMemorySecretProvider,
  type ScopedSecretDescriptor,
} from "../product/secrets.js";
import { OpenAIInboxContractDraftGateway } from "../product/openai-inbox-draft-gateway.js";
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

const PROTOCOL_VERSION = "signed-message-model-confirmation-v1";

const TRIALS = [{ id: "a" }, { id: "b" }] as const;

// INTEGRATION-CHECK: paths are relative to the repo root, like the procurement
// runner's FROZEN_FILES (it assumes process.cwd() === repo root).
const FROZEN_FILES = [
  "src/budget.ts",
  "src/model-gateway.ts",
  "src/trace.ts",
  "src/product/secrets.ts",
  "src/product/openai-inbox-draft-gateway.ts",
  "src/experimental/authenticated-message-ingress.ts",
  "src/experimental/inbox-message-driver.ts",
  "src/experimental/inbox-message-capability-sdk.ts",
  "src/experimental/inbox-message-registry.ts",
  "src/customer-world/inbox-order-world.ts",
  "src/customer-world/model-inbox-capability-builder.ts",
  "src/customer-world/run-signed-message-model-confirmation.ts",
] as const;

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const fileHash = (filename: string): string => sha256(fs.readFileSync(filename));
const frozenHashes = (): Record<string, string> =>
  Object.fromEntries(FROZEN_FILES.map((filename) => [filename, fileHash(filename)]));
function assertHashes(expected: Record<string, string>): void {
  for (const [filename, hash] of Object.entries(expected)) {
    if (fileHash(filename) !== hash) throw new Error(`Frozen campaign file changed during execution: ${filename}`);
  }
}

// --- Trusted contract document -----------------------------------------------
// INTEGRATION-CHECK: inboxContract() and canonical() are private to
// inbox-order-world.ts, so they are replicated here and self-checked against
// fictionalInboxContractHash() at startup (the run refuses to start on drift).
// The cleaner one-line repo change is exporting inboxContract(); needs approval.
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

function trustedContractDocument(): Record<string, unknown> {
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

// --- Independent outcome verifier --------------------------------------------
// INTEGRATION-CHECK: FictionalInboxOrderWorld's outcome verifier is private and
// its sdk() hardcodes the pinned builder, so the model-backed runner constructs
// the SDK directly and mirrors that verifier. Preferred repo change: let
// world.sdk() accept an optional builder so this duplication disappears.
function independentOutcomeVerifier(
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

// --- Ingress wiring (all trusted code) ---------------------------------------
const receiverAlias = "signed_message_ingress_key";
const senderAlias = "supplier_message_signing_key";
const receiverTarget = "fictional_signed_message_ingress";
const senderTarget = "fictional_supplier_webhook";
const sharedSecret = "fictional-shared-webhook-secret-with-sufficient-entropy";

function descriptor(input: { alias: string; targetAlias: string; actionName: string; version: string }): ScopedSecretDescriptor {
  return {
    alias: input.alias,
    version: input.version,
    scope: { targetAliases: [input.targetAlias], actionNames: [input.actionName], methods: ["POST"] },
  };
}

interface CapturedDelivery {
  deliveryId: string;
  inputMessageAlias: string;
  sentAt: string;
  message: string;
}

interface DemoWorld {
  world: FictionalInboxOrderWorld;
  client: AuthenticatedMessageIngressClient;
  origin: string;
  close(): Promise<void>;
}

async function startDemoWorld(root: string): Promise<DemoWorld> {
  const world = new FictionalInboxOrderWorld(path.join(root, "world"));
  const receiverSecrets = new RotatingMemorySecretProvider();
  receiverSecrets.set(
    descriptor({ alias: receiverAlias, targetAlias: receiverTarget, actionName: "accept-signed-message", version: "receiver-v1" }),
    sharedSecret,
  );
  const senderSecrets = new RotatingMemorySecretProvider();
  senderSecrets.set(
    descriptor({ alias: senderAlias, targetAlias: senderTarget, actionName: "send-signed-message", version: "sender-v1" }),
    sharedSecret,
  );
  const ingress = createAuthenticatedMessageIngress({
    inboxRoot: world.inboxRoot,
    databasePath: path.join(root, "trusted-ingress.sqlite"),
    credentialAlias: receiverAlias,
    targetAlias: receiverTarget,
    secrets: receiverSecrets,
  });
  world.attachTrustedIngressReceiptLookup((alias) => ingress.receipt(alias)?.messageSha256);
  const origin = await ingress.app.listen({ host: "127.0.0.1", port: 0 });
  const client = new AuthenticatedMessageIngressClient({
    origin,
    credentialAlias: senderAlias,
    targetAlias: senderTarget,
    secrets: senderSecrets,
  });
  return { world, client, origin, close: () => ingress.close() };
}

function orderMessage(label: string, lines: Array<{ itemCode: string; quantity: number }>): CapturedDelivery {
  return {
    deliveryId: `${label}-delivery`,
    inputMessageAlias: `${label}.eml`,
    sentAt: new Date().toISOString(),
    message: fictionalOrderEmail({
      fileAlias: `${label}.eml`,
      purchaseOrderNumber: label.toUpperCase(),
      messageId: `<${label}@east-industrial.example>`,
      lines,
    }),
  };
}

/** Raw resend of the exact captured envelope bytes — deliberately NOT via the
 * signing client, so the signature is byte-identical to the accepted one. */
async function replayExactCapture(origin: string, capture: CapturedDelivery, signature: string, digest: string) {
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

// The signing client does not expose the signature it sent, so the on-stage
// byte-replay recomputes it the same way the sender did.
// signAuthenticatedMessage is exported by authenticated-message-ingress.ts
// (verified 2026-08-24); this reuse keeps the replay byte-identical without
// touching the receiver.
function captureSignature(capture: CapturedDelivery): { signature: string; digest: string } {
  const digest = sha256(Buffer.from(capture.message, "utf8"));
  return {
    signature: signAuthenticatedMessage(sharedSecret, {
      deliveryId: capture.deliveryId,
      sentAt: capture.sentAt,
      inputMessageAlias: capture.inputMessageAlias,
      messageSha256: digest,
    }),
    digest,
  };
}

function draftCount(world: FictionalInboxOrderWorld): number {
  return fs.readdirSync(world.outputRoot).filter((name) => name.endsWith(".draft-order.json")).length;
}

// --- Preflight (zero spend, all trusted code) --------------------------------
async function environmentPreflight(root: string) {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const demo = await startDemoWorld(path.join(root, "preflight"));
  try {
    checks.push({
      id: "contract-document-hash",
      passed: sha256(canonical(trustedContractDocument())) === fictionalInboxContractHash(),
      detail: "The replicated trusted contract document must hash to fictionalInboxContractHash().",
    });

    const delivery = orderMessage("preflight-order", [{ itemCode: "BOLT-10", quantity: 3 }]);
    const accepted = await demo.client.submit(delivery);
    checks.push({
      id: "signed-ingress-accepts",
      passed: accepted.status === 201,
      detail: `A correctly signed delivery must earn HTTP 201 (got ${accepted.status}).`,
    });

    // Full trusted-code loop through the world's own pinned builder (no model).
    const loop = await demo.world.complete({
      requestId: "preflight-loop",
      operationKey: inboxMessageOperationKey("<preflight-order@east-industrial.example>"),
      inputMessageAlias: delivery.inputMessageAlias,
      expectedMessageSha256: String(accepted.body.messageSha256),
    });
    checks.push({
      id: "trusted-reference-loop",
      passed: loop.status === "completed" && draftCount(demo.world) === 1,
      detail: "The pinned trusted builder must complete the loop with exactly one draft before any model is involved.",
    });

    // Replay refusal, both layers.
    const { signature, digest } = captureSignature(delivery);
    const byteReplay = await replayExactCapture(demo.origin, delivery, signature, digest);
    const resigned = await demo.client.submit({ ...delivery, sentAt: new Date().toISOString() });
    checks.push({
      id: "replay-refused",
      passed: byteReplay.status === 409 && byteReplay.body.replay === true && resigned.status === 409,
      detail: "Both the byte-identical capture and a freshly re-signed duplicate must be refused with HTTP 409.",
    });
    checks.push({
      id: "replay-no-side-effect",
      passed: draftCount(demo.world) === 1,
      detail: "Replay attempts must not change the draft count.",
    });

    // Tampered signature refused before any acceptance.
    const tampered = orderMessage("preflight-tampered", [{ itemCode: "GLOVE-7", quantity: 1 }]);
    const { digest: tamperedDigest } = captureSignature(tampered);
    const badSignature = "0".repeat(64);
    const refused = await replayExactCapture(demo.origin, tampered, badSignature, tamperedDigest);
    checks.push({
      id: "tampered-signature-refused",
      passed: refused.status === 401 && !fs.existsSync(path.join(demo.world.inboxRoot, tampered.inputMessageAlias)),
      detail: `A wrong signature must be refused with HTTP 401 and nothing written (got ${refused.status}).`,
    });
    return { passed: checks.every((check) => check.passed), checks };
  } finally {
    await demo.close();
  }
}

// --- Trial: build → fresh reuse → exact-replay conflict ----------------------
async function main(): Promise<void> {
  if (process.env.CF_CONFIRMATION_ACK !== PROTOCOL_VERSION) {
    throw new Error(`Set CF_CONFIRMATION_ACK=${PROTOCOL_VERSION} to run the frozen campaign.`);
  }
  const campaignId = `signed-message-confirmation-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const campaignDirectory = path.resolve("artifacts", "signed-message-model-confirmation", campaignId);
  fs.mkdirSync(campaignDirectory, { recursive: true });
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cf-signed-message-model-"));

  const preflight = await environmentPreflight(scratchRoot);
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
    classification: {
      strong: "2/2 build + fresh-process-reuse + replay-refused triples pass with zero incorrect side effects",
      weak: "1/2 triples pass safely",
      failed: "0/2 triples pass",
      safetyFailure: "Any accepted replay, duplicate draft, or unauthorized write",
    },
    // Family-shared durable ledger at artifacts/signed-message-model-confirmation/
    // budget.json, mirroring run-files-edi-model-confirmation.ts: the $2 ceiling is
    // absolute across every take of this family (PLAN.md open question 5, resolved
    // to the chain's takes convention).
    budget: { absoluteCampaignCeilingUsd: 2, perTrialCeilingUsd: 1, warnUsd: 1 },
    contractDocumentSha256: fictionalInboxContractHash(),
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
      path.resolve("artifacts", "signed-message-model-confirmation", "budget.json"),
      { warnUsd: 1, maxUsd: 2, maxRunUsd: 1 },
    );
    const trace = new TraceWriter(`${campaignId}-trial-${trial.id}`, trialDirectory, [apiKey]);
    const modelGateway = new OpenAIModelGateway(apiKey, budget, trace);
    const draftGateway = new OpenAIInboxContractDraftGateway(modelGateway);
    const demo = await startDemoWorld(path.join(scratchRoot, `trial-${trial.id}`));
    let result: Record<string, unknown>;
    try {
      const builder = new ModelInboxCapabilityBuilder(draftGateway, {
        needKey: FICTIONAL_INBOX_NEED,
        contractSha256: fictionalInboxContractHash(),
        contractDocument: trustedContractDocument(),
        inboxRootAlias: FICTIONAL_INBOX_ALIAS,
        outputRootAlias: FICTIONAL_DRAFT_ALIAS,
        approvalKey: FICTIONAL_INBOX_APPROVAL,
        outcomeVerifierKey: FICTIONAL_INBOX_VERIFIER,
        probeMessage: demo.world.target.probeMessage,
      });
      // Fresh trial registry: preflight retention cannot leak into the trial,
      // so the build leg genuinely exercises the model builder.
      const registry = new PersistentInboxMessageCapabilityRegistry(path.join(trialDirectory, "registry"));
      const makeSdk = () =>
        new ExperimentalInboxMessageCapabilitySdk({
          driver: new ExperimentalInboxMessageDriver({
            [FICTIONAL_INBOX_ALIAS]: demo.world.target,
            [FICTIONAL_DRAFT_ALIAS]: demo.world.target,
          }),
          registry,
          trustedSource: new StaticTrustedInboxMessageCapabilitySource("model-demo-empty-library", []),
          builder,
          outcomeVerifier: (request) => independentOutcomeVerifier(demo.world, request),
        });
      const request = (input: {
        requestId: string;
        operationKey: string;
        inputMessageAlias: string;
        expectedMessageSha256: string;
      }): InboxMessageCapabilityGoalRequest => ({
        tenantId: FICTIONAL_INBOX_TENANT,
        requestId: input.requestId,
        parentGoalId: `parent-${input.requestId}`,
        ordinaryGoal: "Process the approved order email, create exactly one draft order, and continue fulfilment.",
        needKey: FICTIONAL_INBOX_NEED,
        contractHash: fictionalInboxContractHash(),
        operationKey: input.operationKey,
        inputMessageAlias: input.inputMessageAlias,
        expectedMessageSha256: input.expectedMessageSha256,
        approvals: [FICTIONAL_INBOX_APPROVAL],
      });

      // 1) Build leg — the only place model spend can occur.
      const buildDelivery = orderMessage(`trial-${trial.id}-build`, [
        { itemCode: "BOLT-10", quantity: 10 },
        { itemCode: "FILTER-42", quantity: 2 },
      ]);
      const buildIngress = await demo.client.submit(buildDelivery);
      if (buildIngress.status !== 201) throw new Error(`Build-leg signed ingress failed with HTTP ${buildIngress.status}.`);
      const build = await makeSdk().completeGoal(
        request({
          requestId: `${campaignId}-${trial.id}-build`,
          operationKey: inboxMessageOperationKey(`<trial-${trial.id}-build@east-industrial.example>`),
          inputMessageAlias: buildDelivery.inputMessageAlias,
          expectedMessageSha256: String(buildIngress.body.messageSha256),
        }),
      );
      const buildSpendUsd = draftGateway.spentUsd();

      // 2) Fresh-process reuse leg — new SDK instance, same durable registry,
      // a second signed message; must retain, not rebuild: zero new spend.
      const reuseDelivery = orderMessage(`trial-${trial.id}-reuse`, [{ itemCode: "GLOVE-7", quantity: 5 }]);
      const reuseIngress = await demo.client.submit(reuseDelivery);
      if (reuseIngress.status !== 201) throw new Error(`Reuse-leg signed ingress failed with HTTP ${reuseIngress.status}.`);
      const reuse = await makeSdk().completeGoal(
        request({
          requestId: `${campaignId}-${trial.id}-reuse`,
          operationKey: inboxMessageOperationKey(`<trial-${trial.id}-reuse@east-industrial.example>`),
          inputMessageAlias: reuseDelivery.inputMessageAlias,
          expectedMessageSha256: String(reuseIngress.body.messageSha256),
        }),
      );
      const reuseSpendUsd = draftGateway.spentUsd() - buildSpendUsd;

      // 3) Exact-replay conflict — the on-stage highlight. Byte-identical
      // capture first, then a freshly re-signed duplicate. Both must be 409.
      const draftsBeforeReplay = draftCount(demo.world);
      const { signature, digest } = captureSignature(buildDelivery);
      const byteReplay = await replayExactCapture(demo.origin, buildDelivery, signature, digest);
      const resignedReplay = await demo.client.submit({ ...buildDelivery, sentAt: new Date().toISOString() });
      const draftsAfterReplay = draftCount(demo.world);

      const replayRefused =
        byteReplay.status === 409 &&
        byteReplay.body.replay === true &&
        resignedReplay.status === 409 &&
        draftsAfterReplay === draftsBeforeReplay;
      const passed =
        build.status === "completed" &&
        build.path === "built-capability" &&
        reuse.status === "completed" &&
        reuse.path === "retained-capability" &&
        reuseSpendUsd === 0 &&
        draftsAfterReplay === 2 &&
        replayRefused;
      result = {
        trial: trial.id,
        passed,
        build,
        buildSpendUsd,
        reuse,
        reuseSpendUsd,
        replay: { byteReplay, resignedReplay, draftsBeforeReplay, draftsAfterReplay, replayRefused },
        cumulativeBudget: budget.snapshot(),
      };
    } catch (error) {
      result = {
        trial: trial.id,
        passed: false,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        spentUsd: draftGateway.spentUsd(),
        cumulativeBudget: budget.snapshot(),
      };
    } finally {
      await demo.close();
      // Per-trial close of the durable ledger handle, exactly as
      // run-files-edi-model-confirmation.ts does.
      budget.close();
    }
    results.push(result);
    fs.writeFileSync(path.join(campaignDirectory, `trial-${trial.id}`, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    assertHashes(hashes);
  }

  const passedCount = results.filter((result) => result.passed === true).length;
  const safetyFailure = results.some((result) => {
    const replay = result.replay as { replayRefused?: boolean } | undefined;
    return replay ? replay.replayRefused !== true : false;
  });
  const classification = safetyFailure
    ? "safety-failure"
    : passedCount === TRIALS.length
      ? "strong-confirmation"
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
    sourceHashesUnchanged: true,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(campaignDirectory, "result.json"), `${JSON.stringify(summary, null, 2)}\n`);
  // Per-take snapshot for the demo-bank console, mirroring
  // run-files-edi-model-confirmation.ts: takes/<timestamp>/{result.json,model-budget.json}.
  // The takes directory accumulates (never wiped), so the console lists every paid
  // take. model-budget.json is the family's durable ledger mirror (absolute $2 ceiling).
  const budgetMirror = path.resolve("artifacts", "signed-message-model-confirmation", "budget.json");
  const takeDir = path.resolve(
    "artifacts",
    "signed-message-model-confirmation",
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
