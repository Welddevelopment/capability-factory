import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const EXPERIMENTAL_INBOX_MESSAGE_DRIVER_VERSION = "inbox-message-driver-v0.1" as const;
export const EXPERIMENTAL_INBOX_MESSAGE_CAPABILITY_MODE = "experimental-inbox-message-actions" as const;

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const emailAddress = z.string().email().max(254);

export const experimentalInboxMessageCapabilitySchema = z.object({
  schemaVersion: z.literal("0.1"),
  capabilityMode: z.literal(EXPERIMENTAL_INBOX_MESSAGE_CAPABILITY_MODE),
  id: identifier,
  needKey: identifier,
  inboxRootAlias: identifier,
  outputRootAlias: identifier,
  contractHash: sha256,
  inputFormat: z.literal("rfc822-plain-text-order"),
  outputFormat: z.literal("canonical-draft-order-json"),
  allowedFromAddress: emailAddress,
  allowedToAddress: emailAddress,
  subjectPrefix: z.string().min(1).max(120),
  allowedItemCodes: z.array(identifier).min(1).max(200),
  maxLineItems: z.number().int().positive().max(200),
  maxQuantityPerLine: z.number().int().positive().max(1_000_000),
  maxInputBytes: z.number().int().positive().max(5_000_000),
  approvalKey: identifier,
  outcomeVerifierKey: identifier,
}).strict().superRefine((manifest, context) => {
  if (manifest.inboxRootAlias === manifest.outputRootAlias) {
    context.addIssue({ code: "custom", message: "Inbox and output roots must remain separate." });
  }
  if (new Set(manifest.allowedItemCodes).size !== manifest.allowedItemCodes.length) {
    context.addIssue({ code: "custom", message: "Allowed item codes must be unique." });
  }
});

export type ExperimentalInboxMessageCapability = z.infer<typeof experimentalInboxMessageCapabilitySchema>;

export interface ExperimentalInboxMessageTarget {
  inboxRoot: string;
  outputRoot: string;
  contractHash: string;
  probeMessage: string;
  trustedIngressSha256ByAlias: Record<string, string>;
  /**
   * Optional durable receipt lookup used by authenticated customer-local
   * ingress. The legacy in-memory map remains for the original local fixture.
   */
  trustedIngressReceiptLookup?: ((inputMessageAlias: string) => string | undefined) | undefined;
}

export interface CanonicalInboxOrderLine {
  lineNumber: number;
  itemCode: string;
  quantity: number;
}

export interface CanonicalInboxDraftOrder {
  schemaVersion: "1";
  operationKey: string;
  sourceMessageFile: string;
  sourceMessageSha256: string;
  messageId: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  purchaseOrderNumber: string;
  shipToCode: string;
  lines: CanonicalInboxOrderLine[];
  status: "draft";
}

export interface ExperimentalInboxMessageVerification {
  driverVersion: typeof EXPERIMENTAL_INBOX_MESSAGE_DRIVER_VERSION;
  capabilityId: string;
  manifestDigest: string;
  contractHash: string;
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  verifiedAt: string;
}

export type ExperimentalInboxMessageOutcome = "complete" | "not-started" | "partial" | "incorrect" | "unknown";

export interface ExperimentalInboxMessageOutcomeVerifier {
  readonly key: string;
  verify(operationKey: string): Promise<{
    outcome: ExperimentalInboxMessageOutcome;
    detail: string;
    stateDigest?: string;
  }>;
}

export interface InboxMessageExecutionOptions {
  operationKey: string;
  runId: string;
  inputMessageAlias: string;
  expectedMessageSha256: string;
  approvals: string[];
  verification: ExperimentalInboxMessageVerification;
  simulateLostResponseAfterCommit?: boolean;
}

export type ExperimentalInboxMessageRunResult =
  | {
      status: "completed";
      capabilityId: string;
      operationKey: string;
      outputFileAlias: string;
      sourceMessageSha256: string;
      outputSha256: string;
      writesAttempted: 0 | 1;
      reconciled: boolean;
      reason: string;
    }
  | {
      status: "blocked" | "unknown";
      capabilityId: string;
      operationKey: string;
      writesAttempted: 0 | 1;
      quarantined: boolean;
      reason: string;
    };

export class ExperimentalInboxMessagePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentalInboxMessagePolicyError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function inboxMessageManifestDigest(manifest: ExperimentalInboxMessageCapability): string {
  return digest(experimentalInboxMessageCapabilitySchema.parse(manifest));
}

function safeMessageAlias(value: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,180}$/.test(value) || value.includes("..") || !value.endsWith(".eml")) {
    throw new ExperimentalInboxMessagePolicyError("The input must be one exact .eml alias without path syntax.");
  }
  return value;
}

function requirePlainDirectory(root: string, label: string): string {
  const resolved = path.resolve(root);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ExperimentalInboxMessagePolicyError(`${label} must be a real local directory, not a link.`);
  }
  return resolved;
}

function resolvePlainMessage(root: string, alias: string): string {
  const safeRoot = requirePlainDirectory(root, "Inbox root");
  const filename = path.resolve(safeRoot, safeMessageAlias(alias));
  if (path.dirname(filename) !== safeRoot) {
    throw new ExperimentalInboxMessagePolicyError("The message escaped its approved inbox.");
  }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ExperimentalInboxMessagePolicyError("The approved message must be one regular file, not a link.");
  }
  return filename;
}

export function inboxMessageOutputAlias(operationKey: string): string {
  return `${createHash("sha256").update(operationKey).digest("hex")}.draft-order.json`;
}

export function inboxMessageOperationKey(messageId: string): string {
  return `inbox-message-${createHash("sha256").update(messageId).digest("hex")}`;
}

interface ParsedHeaders {
  fromAddress: string;
  toAddress: string;
  subject: string;
  messageId: string;
}

function parseHeaders(source: string): { headers: ParsedHeaders; body: string } {
  if (source.includes("\0")) {
    throw new ExperimentalInboxMessagePolicyError("The message contains binary data.");
  }
  const normalized = source.replace(/\r\n/g, "\n");
  const split = normalized.indexOf("\n\n");
  if (split < 0) throw new ExperimentalInboxMessagePolicyError("The message lacks a header/body boundary.");
  const headerLines = normalized.slice(0, split).split("\n");
  if (headerLines.some((line) => /^[ \t]/.test(line))) {
    throw new ExperimentalInboxMessagePolicyError("Folded or continuation headers are not supported.");
  }
  const allowed = new Set(["from", "to", "subject", "message-id", "date", "mime-version", "content-type"]);
  const values = new Map<string, string>();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon < 1) throw new ExperimentalInboxMessagePolicyError("The message contains a malformed header.");
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!allowed.has(key) || values.has(key)) {
      throw new ExperimentalInboxMessagePolicyError(`The message contains an unsupported or duplicate header: ${key}`);
    }
    values.set(key, value);
  }
  for (const key of ["from", "to", "subject", "message-id", "date", "content-type"]) {
    if (!values.get(key)) throw new ExperimentalInboxMessagePolicyError(`The message requires exactly one ${key} header.`);
  }
  if (values.get("content-type")?.toLowerCase() !== "text/plain; charset=utf-8") {
    throw new ExperimentalInboxMessagePolicyError("Only one UTF-8 plain-text message body is supported.");
  }
  const fromAddress = values.get("from")!;
  const toAddress = values.get("to")!;
  const messageId = values.get("message-id")!;
  if (!emailAddress.safeParse(fromAddress).success || !emailAddress.safeParse(toAddress).success) {
    throw new ExperimentalInboxMessagePolicyError("From and To must be exact bare email addresses.");
  }
  if (!/^<[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+>$/.test(messageId)) {
    throw new ExperimentalInboxMessagePolicyError("The Message-ID is missing or unsafe.");
  }
  const parsedDate = Date.parse(values.get("date")!);
  if (!Number.isFinite(parsedDate)) throw new ExperimentalInboxMessagePolicyError("The message Date is invalid.");
  return {
    headers: {
      fromAddress,
      toAddress,
      subject: values.get("subject")!,
      messageId,
    },
    body: normalized.slice(split + 2),
  };
}

export function parseBoundedInboxOrder(
  source: string,
  manifest: ExperimentalInboxMessageCapability,
): Omit<
  CanonicalInboxDraftOrder,
  "operationKey" | "sourceMessageFile" | "sourceMessageSha256" | "status"
> {
  const safe = experimentalInboxMessageCapabilitySchema.parse(manifest);
  const { headers, body } = parseHeaders(source);
  if (headers.fromAddress !== safe.allowedFromAddress || headers.toAddress !== safe.allowedToAddress) {
    throw new ExperimentalInboxMessagePolicyError("The message sender or recipient is outside the trusted contract.");
  }
  const bodyLines = body.trimEnd().split("\n");
  if (bodyLines.length < 5 || bodyLines.length > safe.maxLineItems + 4) {
    throw new ExperimentalInboxMessagePolicyError("The order body has an unsafe line count.");
  }
  if (bodyLines[0] !== "PURCHASE ORDER" || bodyLines.at(-1) !== "END ORDER") {
    throw new ExperimentalInboxMessagePolicyError("The message does not match the trusted plain-text order envelope.");
  }
  const purchaseOrderNumber = bodyLines[1]?.match(/^PO_NUMBER=([a-zA-Z0-9_.-]+)$/)?.[1];
  const shipToCode = bodyLines[2]?.match(/^SHIP_TO=([a-zA-Z0-9_.-]+)$/)?.[1];
  if (!purchaseOrderNumber || !shipToCode) {
    throw new ExperimentalInboxMessagePolicyError("The purchase-order or ship-to field is missing.");
  }
  if (headers.subject !== `${safe.subjectPrefix}${purchaseOrderNumber}`) {
    throw new ExperimentalInboxMessagePolicyError("The subject does not bind to the body purchase-order number.");
  }
  const rawLines = bodyLines.slice(3, -1);
  if (rawLines.length < 1 || rawLines.length > safe.maxLineItems) {
    throw new ExperimentalInboxMessagePolicyError("The order requires a bounded non-empty line set.");
  }
  const lines = rawLines.map((line, index): CanonicalInboxOrderLine => {
    const match = line.match(/^LINE=(\d+)\|([a-zA-Z0-9_.-]+)\|(\d+)$/);
    if (!match) throw new ExperimentalInboxMessagePolicyError("An order line does not match the trusted template.");
    const lineNumber = Number(match[1]);
    const itemCode = match[2]!;
    const quantity = Number(match[3]);
    if (
      lineNumber !== index + 1 ||
      !safe.allowedItemCodes.includes(itemCode) ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > safe.maxQuantityPerLine
    ) {
      throw new ExperimentalInboxMessagePolicyError("An order line is outside the trusted contract.");
    }
    return { lineNumber, itemCode, quantity };
  });
  return {
    schemaVersion: "1",
    ...headers,
    purchaseOrderNumber,
    shipToCode,
    lines,
  };
}

export class ExperimentalInboxMessageDriver {
  constructor(private readonly targets: Record<string, ExperimentalInboxMessageTarget>) {}

  async verifyCapability(
    manifest: ExperimentalInboxMessageCapability,
  ): Promise<ExperimentalInboxMessageVerification> {
    const safe = experimentalInboxMessageCapabilitySchema.parse(manifest);
    const target = this.target(safe);
    const checks: ExperimentalInboxMessageVerification["checks"] = [];
    const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
    check("separate-roots", safe.inboxRootAlias !== safe.outputRootAlias, "Inbox and output roots use distinct aliases.");
    check("contract-hash", safe.contractHash === target.contractHash, "The capability is pinned to the trusted sender/template contract.");
    check("bounded-message", safe.inputFormat === "rfc822-plain-text-order", "Only one strict RFC 822 plain-text order shape is represented.");
    check("single-approval", Boolean(safe.approvalKey), "One exact draft-order approval is required.");
    try {
      const parsed = parseBoundedInboxOrder(target.probeMessage, safe);
      check("disposable-probe", parsed.lines.length > 0, "An in-memory probe parsed without touching the business outbox.");
    } catch (error) {
      check("disposable-probe", false, error instanceof Error ? error.message : String(error));
    }
    return {
      driverVersion: EXPERIMENTAL_INBOX_MESSAGE_DRIVER_VERSION,
      capabilityId: safe.id,
      manifestDigest: inboxMessageManifestDigest(safe),
      contractHash: safe.contractHash,
      passed: checks.every((item) => item.passed),
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }

  async execute(
    manifest: ExperimentalInboxMessageCapability,
    options: InboxMessageExecutionOptions,
    verifier: ExperimentalInboxMessageOutcomeVerifier,
  ): Promise<ExperimentalInboxMessageRunResult> {
    const safe = experimentalInboxMessageCapabilitySchema.parse(manifest);
    const target = this.target(safe);
    this.requireVerification(safe, options.verification);
    if (verifier.key !== safe.outcomeVerifierKey) {
      throw new ExperimentalInboxMessagePolicyError("The independent outcome verifier does not match the capability.");
    }
    if (!options.approvals.includes(safe.approvalKey)) {
      return this.blocked(safe, options, "The exact draft-order approval is missing.");
    }
    const inputFilename = resolvePlainMessage(target.inboxRoot, options.inputMessageAlias);
    const inputStat = fs.statSync(inputFilename);
    if (inputStat.size > safe.maxInputBytes) {
      return this.blocked(safe, options, "The approved message exceeds the capability's byte limit.");
    }
    const source = fs.readFileSync(inputFilename, "utf8");
    const sourceMessageSha256 = createHash("sha256").update(source).digest("hex");
    if (sourceMessageSha256 !== options.expectedMessageSha256) {
      return this.blocked(safe, options, "The approved message changed after trusted planning.");
    }
    const trustedIngressSha256 =
      target.trustedIngressReceiptLookup?.(options.inputMessageAlias) ??
      target.trustedIngressSha256ByAlias[options.inputMessageAlias];
    if (trustedIngressSha256 !== sourceMessageSha256) {
      return this.blocked(
        safe,
        options,
        "The message lacks a matching customer-local trusted-ingress receipt.",
      );
    }
    let parsed: ReturnType<typeof parseBoundedInboxOrder>;
    try {
      parsed = parseBoundedInboxOrder(source, safe);
    } catch (error) {
      return this.blocked(safe, options, error instanceof Error ? error.message : String(error));
    }
    if (options.operationKey !== inboxMessageOperationKey(parsed.messageId)) {
      return this.blocked(
        safe,
        options,
        "The operation identity is not bound to the immutable Message-ID.",
      );
    }
    const canonical: CanonicalInboxDraftOrder = {
      ...parsed,
      operationKey: options.operationKey,
      sourceMessageFile: options.inputMessageAlias,
      sourceMessageSha256,
      status: "draft",
    };
    const safeOutputRoot = requirePlainDirectory(target.outputRoot, "Output root");
    const outputFileAlias = inboxMessageOutputAlias(options.operationKey);
    const outputFilename = path.resolve(safeOutputRoot, outputFileAlias);
    if (path.dirname(outputFilename) !== safeOutputRoot) {
      throw new ExperimentalInboxMessagePolicyError("The generated output escaped its approved root.");
    }

    let before: Awaited<ReturnType<ExperimentalInboxMessageOutcomeVerifier["verify"]>>;
    try {
      before = await verifier.verify(options.operationKey);
    } catch (error) {
      return this.unknown(safe, options, 0, `Pre-action reconciliation could not inspect external state: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (before.outcome === "complete") {
      return this.completed(safe, options, outputFileAlias, sourceMessageSha256, outputFilename, 0, true, "Independent reconciliation found the exact draft; no write was repeated.");
    }
    if (before.outcome !== "not-started") {
      return {
        status: before.outcome === "unknown" ? "unknown" : "blocked",
        capabilityId: safe.id,
        operationKey: options.operationKey,
        writesAttempted: 0,
        quarantined: true,
        reason: `Pre-action reconciliation refused the write: ${before.detail}`,
      };
    }
    try {
      fs.writeFileSync(outputFilename, `${JSON.stringify(canonical, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      if (options.simulateLostResponseAfterCommit) {
        throw new Error("Simulated response loss after the atomic customer-local draft commit.");
      }
    } catch (error) {
      let reconciled: Awaited<ReturnType<ExperimentalInboxMessageOutcomeVerifier["verify"]>>;
      try {
        reconciled = await verifier.verify(options.operationKey);
      } catch (verificationError) {
        return this.unknown(
          safe,
          options,
          1,
          `The draft may have been created, but reconciliation could not inspect external state: ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`,
        );
      }
      if (reconciled.outcome === "complete") {
        return this.completed(safe, options, outputFileAlias, sourceMessageSha256, outputFilename, 1, true, "The response was unavailable; independent reconciliation proved exact completion without a duplicate.");
      }
      return {
        status: reconciled.outcome === "unknown" ? "unknown" : "blocked",
        capabilityId: safe.id,
        operationKey: options.operationKey,
        writesAttempted: 1,
        quarantined: true,
        reason: `The inbox action failed and reconciliation did not prove completion: ${error instanceof Error ? error.message : String(error)} ${reconciled.detail}`,
      };
    }

    let after: Awaited<ReturnType<ExperimentalInboxMessageOutcomeVerifier["verify"]>>;
    try {
      after = await verifier.verify(options.operationKey);
    } catch (error) {
      return this.unknown(safe, options, 1, `The draft was written, but independent verification could not inspect external state: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (after.outcome !== "complete") {
      return {
        status: after.outcome === "unknown" ? "unknown" : "blocked",
        capabilityId: safe.id,
        operationKey: options.operationKey,
        writesAttempted: 1,
        quarantined: true,
        reason: `Independent external-state verification did not prove completion: ${after.detail}`,
      };
    }
    return this.completed(safe, options, outputFileAlias, sourceMessageSha256, outputFilename, 1, false, "The bounded inbox action and independent external-state verification completed.");
  }

  private target(manifest: ExperimentalInboxMessageCapability): ExperimentalInboxMessageTarget {
    const inbox = this.targets[manifest.inboxRootAlias];
    const output = this.targets[manifest.outputRootAlias];
    if (!inbox || !output || inbox !== output) {
      throw new ExperimentalInboxMessagePolicyError("The inbox and output aliases must resolve to one reviewed message target.");
    }
    requirePlainDirectory(inbox.inboxRoot, "Inbox root");
    requirePlainDirectory(inbox.outputRoot, "Output root");
    if (!sha256.safeParse(inbox.contractHash).success) {
      throw new ExperimentalInboxMessagePolicyError("The trusted target requires a SHA-256 contract hash.");
    }
    return inbox;
  }

  private requireVerification(
    manifest: ExperimentalInboxMessageCapability,
    verification: ExperimentalInboxMessageVerification,
  ): void {
    if (
      !verification.passed ||
      verification.driverVersion !== EXPERIMENTAL_INBOX_MESSAGE_DRIVER_VERSION ||
      verification.capabilityId !== manifest.id ||
      verification.contractHash !== manifest.contractHash ||
      verification.manifestDigest !== inboxMessageManifestDigest(manifest)
    ) {
      throw new ExperimentalInboxMessagePolicyError("Execution requires a current passing receipt for this exact inbox capability.");
    }
  }

  private blocked(
    manifest: ExperimentalInboxMessageCapability,
    options: InboxMessageExecutionOptions,
    reason: string,
  ): ExperimentalInboxMessageRunResult {
    return {
      status: "blocked",
      capabilityId: manifest.id,
      operationKey: options.operationKey,
      writesAttempted: 0,
      quarantined: false,
      reason,
    };
  }

  private unknown(
    manifest: ExperimentalInboxMessageCapability,
    options: InboxMessageExecutionOptions,
    writesAttempted: 0 | 1,
    reason: string,
  ): ExperimentalInboxMessageRunResult {
    return {
      status: "unknown",
      capabilityId: manifest.id,
      operationKey: options.operationKey,
      writesAttempted,
      quarantined: true,
      reason,
    };
  }

  private completed(
    manifest: ExperimentalInboxMessageCapability,
    options: InboxMessageExecutionOptions,
    outputFileAlias: string,
    sourceMessageSha256: string,
    outputFilename: string,
    writesAttempted: 0 | 1,
    reconciled: boolean,
    reason: string,
  ): Extract<ExperimentalInboxMessageRunResult, { status: "completed" }> {
    return {
      status: "completed",
      capabilityId: manifest.id,
      operationKey: options.operationKey,
      outputFileAlias,
      sourceMessageSha256,
      outputSha256: createHash("sha256").update(fs.readFileSync(outputFilename)).digest("hex"),
      writesAttempted,
      reconciled,
      reason,
    };
  }
}
