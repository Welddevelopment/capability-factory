import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ExperimentalInboxMessageCapabilitySdk,
  StaticTrustedInboxMessageCapabilitySource,
  type InboxMessageCapabilityBuilder,
  type InboxMessageCapabilityGoalRequest,
  type InboxMessageCapabilityGoalResult,
} from "../experimental/inbox-message-capability-sdk.js";
import {
  ExperimentalInboxMessageDriver,
  experimentalInboxMessageCapabilitySchema,
  inboxMessageOperationKey,
  inboxMessageOutputAlias,
  type CanonicalInboxDraftOrder,
  type ExperimentalInboxMessageCapability,
  type ExperimentalInboxMessageOutcomeVerifier,
  type ExperimentalInboxMessageTarget,
} from "../experimental/inbox-message-driver.js";
import { PersistentInboxMessageCapabilityRegistry } from "../experimental/inbox-message-registry.js";

export const FICTIONAL_INBOX_TENANT = "fictional-distributor-inbox";
export const FICTIONAL_INBOX_NEED = "convert-approved-order-email-to-draft";
export const FICTIONAL_INBOX_APPROVAL = "create-approved-draft-order";
export const FICTIONAL_INBOX_VERIFIER = "customer-draft-order-verifier-v1";
export const FICTIONAL_INBOX_ALIAS = "customer-order-inbox";
export const FICTIONAL_DRAFT_ALIAS = "customer-draft-order-store";

export interface FictionalInboxOrderInput {
  fileAlias: string;
  purchaseOrderNumber: string;
  messageId: string;
  shipToCode?: string;
  lines: Array<{ itemCode: string; quantity: number }>;
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function inboxContract() {
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
  } as const;
}

export function fictionalInboxContractHash(): string {
  return sha256(canonical(inboxContract()));
}

export function fictionalOrderEmail(input: FictionalInboxOrderInput): string {
  const contract = inboxContract();
  const bodyLines = input.lines.map(
    (line, index) => `LINE=${index + 1}|${line.itemCode}|${line.quantity}`,
  );
  return [
    `From: ${contract.fromAddress}`,
    `To: ${contract.toAddress}`,
    `Subject: ${contract.subjectPrefix}${input.purchaseOrderNumber}`,
    `Message-ID: ${input.messageId}`,
    "Date: Fri, 31 Jul 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "PURCHASE ORDER",
    `PO_NUMBER=${input.purchaseOrderNumber}`,
    `SHIP_TO=${input.shipToCode ?? "LONDON01"}`,
    ...bodyLines,
    "END ORDER",
    "",
  ].join("\r\n");
}

function buildManifest(contractHash: string): ExperimentalInboxMessageCapability {
  const contract = inboxContract();
  return experimentalInboxMessageCapabilitySchema.parse({
    schemaVersion: "0.1",
    capabilityMode: "experimental-inbox-message-actions",
    id: "east-industrial-order-email-v1",
    needKey: FICTIONAL_INBOX_NEED,
    inboxRootAlias: FICTIONAL_INBOX_ALIAS,
    outputRootAlias: FICTIONAL_DRAFT_ALIAS,
    contractHash,
    inputFormat: contract.inputFormat,
    outputFormat: contract.outputFormat,
    allowedFromAddress: contract.fromAddress,
    allowedToAddress: contract.toAddress,
    subjectPrefix: contract.subjectPrefix,
    allowedItemCodes: [...contract.allowedItemCodes],
    maxLineItems: contract.maxLineItems,
    maxQuantityPerLine: contract.maxQuantityPerLine,
    maxInputBytes: contract.maxInputBytes,
    approvalKey: FICTIONAL_INBOX_APPROVAL,
    outcomeVerifierKey: FICTIONAL_INBOX_VERIFIER,
  });
}

class ContractPinnedInboxBuilder implements InboxMessageCapabilityBuilder {
  readonly builderId = "trusted-inbox-template-builder-v1";

  async build(needKey: string, contractHash: string): Promise<ExperimentalInboxMessageCapability | null> {
    if (needKey !== FICTIONAL_INBOX_NEED || contractHash !== fictionalInboxContractHash()) return null;
    return buildManifest(contractHash);
  }
}

/**
 * Independent verifier transformation. It deliberately does not call the
 * capability driver's message parser.
 */
function independentlyExpectedDraft(
  source: string,
  operationKey: string,
  sourceMessageFile: string,
  sourceMessageSha256: string,
): CanonicalInboxDraftOrder {
  const normalized = source.replace(/\r\n/g, "\n");
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
  const orderLines = bodyLines.filter((line) => line.startsWith("LINE=")).map((line) => {
    const [lineNumber, itemCode, quantity] = line.slice("LINE=".length).split("|");
    return {
      lineNumber: Number(lineNumber),
      itemCode: itemCode!,
      quantity: Number(quantity),
    };
  });
  if (!poNumber || !shipTo || orderLines.length < 1) {
    throw new Error("The independently read message lacks required order fields.");
  }
  return {
    schemaVersion: "1",
    operationKey,
    sourceMessageFile,
    sourceMessageSha256,
    messageId: headers.get("message-id")!,
    fromAddress: headers.get("from")!,
    toAddress: headers.get("to")!,
    subject: headers.get("subject")!,
    purchaseOrderNumber: poNumber,
    shipToCode: shipTo,
    lines: orderLines,
    status: "draft",
  };
}

export class FictionalInboxOrderWorld {
  readonly inboxRoot: string;
  readonly outputRoot: string;
  readonly registryRoot: string;
  readonly contractHash = fictionalInboxContractHash();
  readonly target: ExperimentalInboxMessageTarget;

  constructor(readonly root: string) {
    this.inboxRoot = path.join(root, "maildir-new");
    this.outputRoot = path.join(root, "draft-orders");
    this.registryRoot = path.join(root, "registry");
    fs.mkdirSync(this.inboxRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.outputRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.registryRoot, { recursive: true, mode: 0o700 });
    this.target = {
      inboxRoot: this.inboxRoot,
      outputRoot: this.outputRoot,
      contractHash: this.contractHash,
      trustedIngressSha256ByAlias: {},
      probeMessage: fictionalOrderEmail({
        fileAlias: "probe.eml",
        purchaseOrderNumber: "PROBE-001",
        messageId: "<probe-001@east-industrial.example>",
        lines: [{ itemCode: "BOLT-10", quantity: 1 }],
      }),
    };
  }

  writeMessage(input: FictionalInboxOrderInput): { filename: string; sha256: string; operationKey: string } {
    if (!/^[a-zA-Z0-9_.-]+\.eml$/.test(input.fileAlias) || input.fileAlias.includes("..")) {
      throw new Error("Fictional inbox input requires one safe .eml alias.");
    }
    const source = fictionalOrderEmail(input);
    const filename = path.join(this.inboxRoot, input.fileAlias);
    fs.writeFileSync(filename, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const sourceSha256 = sha256(source);
    this.target.trustedIngressSha256ByAlias[input.fileAlias] = sourceSha256;
    return {
      filename,
      sha256: sourceSha256,
      operationKey: inboxMessageOperationKey(input.messageId),
    };
  }

  attachTrustedIngressReceiptLookup(
    lookup: (inputMessageAlias: string) => string | undefined,
  ): void {
    this.target.trustedIngressReceiptLookup = lookup;
  }

  sdk(): ExperimentalInboxMessageCapabilitySdk {
    const target = this.target;
    return new ExperimentalInboxMessageCapabilitySdk({
      driver: new ExperimentalInboxMessageDriver({
        [FICTIONAL_INBOX_ALIAS]: target,
        [FICTIONAL_DRAFT_ALIAS]: target,
      }),
      registry: new PersistentInboxMessageCapabilityRegistry(this.registryRoot),
      trustedSource: new StaticTrustedInboxMessageCapabilitySource("reviewed-inbox-library", []),
      builder: new ContractPinnedInboxBuilder(),
      outcomeVerifier: (request) => this.verifier(request),
    });
  }

  request(input: {
    requestId: string;
    parentGoalId?: string;
    operationKey: string;
    inputMessageAlias: string;
    expectedMessageSha256: string;
    approvals?: string[];
    simulateLostResponseAfterCommit?: boolean;
  }): InboxMessageCapabilityGoalRequest {
    return {
      tenantId: FICTIONAL_INBOX_TENANT,
      requestId: input.requestId,
      parentGoalId: input.parentGoalId ?? `parent-${input.requestId}`,
      ordinaryGoal: "Process the approved order email, create exactly one draft order, and continue fulfilment.",
      needKey: FICTIONAL_INBOX_NEED,
      contractHash: this.contractHash,
      operationKey: input.operationKey,
      inputMessageAlias: input.inputMessageAlias,
      expectedMessageSha256: input.expectedMessageSha256,
      approvals: input.approvals ?? [FICTIONAL_INBOX_APPROVAL],
      ...(input.simulateLostResponseAfterCommit ? { simulateLostResponseAfterCommit: true } : {}),
    };
  }

  async complete(
    input: Parameters<FictionalInboxOrderWorld["request"]>[0],
  ): Promise<InboxMessageCapabilityGoalResult> {
    return this.sdk().completeGoal(this.request(input));
  }

  listDrafts(): Array<{ alias: string; draft: CanonicalInboxDraftOrder }> {
    return fs.readdirSync(this.outputRoot)
      .filter((alias) => alias.endsWith(".draft-order.json"))
      .sort()
      .map((alias) => ({
        alias,
        draft: JSON.parse(fs.readFileSync(path.join(this.outputRoot, alias), "utf8")) as CanonicalInboxDraftOrder,
      }));
  }

  private verifier(request: InboxMessageCapabilityGoalRequest): ExperimentalInboxMessageOutcomeVerifier {
    return {
      key: FICTIONAL_INBOX_VERIFIER,
      verify: async (operationKey) => {
        const expectedAlias = inboxMessageOutputAlias(operationKey);
        const outputNames = fs.readdirSync(this.outputRoot).filter((name) => name.endsWith(".draft-order.json"));
        const matches = outputNames.filter((name) => name === expectedAlias);
        if (matches.length === 0) {
          return { outcome: "not-started", detail: "No draft exists for the exact operation." };
        }
        if (matches.length !== 1) {
          return { outcome: "incorrect", detail: "More than one draft exists for the exact operation." };
        }
        try {
          const outputPath = path.join(this.outputRoot, expectedAlias);
          const stat = fs.lstatSync(outputPath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            return { outcome: "unknown", detail: "The expected draft is not one plain file." };
          }
          const draft = JSON.parse(fs.readFileSync(outputPath, "utf8")) as CanonicalInboxDraftOrder;
          const sourcePath = path.join(this.inboxRoot, request.inputMessageAlias);
          const source = fs.readFileSync(sourcePath);
          const expected = independentlyExpectedDraft(
            source.toString("utf8"),
            operationKey,
            request.inputMessageAlias,
            request.expectedMessageSha256,
          );
          const valid =
            sha256(source) === request.expectedMessageSha256 &&
            canonical(draft) === canonical(expected);
          if (!valid) {
            return { outcome: "incorrect", detail: "The draft does not match the exact approved immutable message." };
          }
          return {
            outcome: "complete",
            detail: "Exactly one draft matches the approved immutable inbox message.",
            stateDigest: sha256(fs.readFileSync(outputPath)),
          };
        } catch (error) {
          return { outcome: "unknown", detail: `The draft could not be verified: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    };
  }
}
