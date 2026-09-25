import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const EXPERIMENTAL_FILE_TRANSFER_DRIVER_VERSION = "file-transfer-driver-v0.1" as const;
export const EXPERIMENTAL_FILE_TRANSFER_CAPABILITY_MODE = "experimental-file-transfer-actions" as const;

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const experimentalFileTransferCapabilitySchema = z.object({
  schemaVersion: z.literal("0.1"),
  capabilityMode: z.literal(EXPERIMENTAL_FILE_TRANSFER_CAPABILITY_MODE),
  id: identifier,
  needKey: identifier,
  inputRootAlias: identifier,
  outputRootAlias: identifier,
  contractHash: sha256,
  inputFormat: z.enum(["x12-850", "edifact-orders-d96a"]),
  outputFormat: z.literal("canonical-order-json"),
  transportKind: z.enum(["local-directory", "authenticated-network"]).default("local-directory"),
  senderId: identifier,
  receiverId: identifier,
  allowedItemCodes: z.array(identifier).min(1).max(200),
  maxLineItems: z.number().int().positive().max(200),
  maxQuantityPerLine: z.number().int().positive().max(1_000_000),
  maxInputBytes: z.number().int().positive().max(5_000_000),
  approvalKey: identifier,
  outcomeVerifierKey: identifier,
}).strict().superRefine((manifest, context) => {
  if (manifest.inputRootAlias === manifest.outputRootAlias) {
    context.addIssue({ code: "custom", message: "Input and output roots must remain separate." });
  }
  if (new Set(manifest.allowedItemCodes).size !== manifest.allowedItemCodes.length) {
    context.addIssue({ code: "custom", message: "Allowed item codes must be unique." });
  }
});

export type ExperimentalFileTransferCapability = z.infer<typeof experimentalFileTransferCapabilitySchema>;

export interface ExperimentalFileTransferTransport {
  readonly kind: "authenticated-network";
  readInput(alias: string, maxBytes: number): Promise<Buffer>;
  readOutput(alias: string, maxBytes: number): Promise<Buffer | null>;
  writeOutputExclusive(alias: string, bytes: Buffer): Promise<void>;
}

export type ExperimentalFileTransferTarget = {
  contractHash: string;
  probeDocument: string;
} & (
  | {
      kind?: "local-directory";
      inputRoot: string;
      outputRoot: string;
    }
  | {
      kind: "authenticated-network";
      transport: ExperimentalFileTransferTransport;
    }
);

export interface CanonicalPurchaseOrderLine {
  lineNumber: number;
  itemCode: string;
  quantity: number;
  unit: "EA";
}

export interface CanonicalPurchaseOrder {
  schemaVersion: "1";
  operationKey: string;
  sourceFile: string;
  sourceSha256: string;
  senderId: string;
  receiverId: string;
  purchaseOrderNumber: string;
  purchaseOrderDate: string;
  shipToCode: string;
  lines: CanonicalPurchaseOrderLine[];
}

export interface ExperimentalFileTransferVerification {
  driverVersion: typeof EXPERIMENTAL_FILE_TRANSFER_DRIVER_VERSION;
  capabilityId: string;
  manifestDigest: string;
  contractHash: string;
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  verifiedAt: string;
}

export type ExperimentalFileTransferOutcome = "complete" | "not-started" | "partial" | "incorrect" | "unknown";

export interface ExperimentalFileTransferOutcomeVerifier {
  readonly key: string;
  verify(operationKey: string): Promise<{
    outcome: ExperimentalFileTransferOutcome;
    detail: string;
    stateDigest?: string;
  }>;
}

export interface FileTransferExecutionOptions {
  operationKey: string;
  runId: string;
  inputFileAlias: string;
  expectedInputSha256: string;
  approvals: string[];
  verification: ExperimentalFileTransferVerification;
  simulateLostResponseAfterCommit?: boolean;
}

export type ExperimentalFileTransferRunResult =
  | {
      status: "completed";
      capabilityId: string;
      operationKey: string;
      outputFileAlias: string;
      sourceSha256: string;
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

export class ExperimentalFileTransferPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentalFileTransferPolicyError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function fileTransferManifestDigest(manifest: ExperimentalFileTransferCapability): string {
  return digest(experimentalFileTransferCapabilitySchema.parse(manifest));
}

function safeFileAlias(value: string, inputFormat: ExperimentalFileTransferCapability["inputFormat"]): string {
  const requiredExtension = inputFormat === "x12-850" ? ".edi" : ".unb";
  if (!/^[a-zA-Z0-9_.-]{1,180}$/.test(value) || value.includes("..") || !value.endsWith(requiredExtension)) {
    throw new ExperimentalFileTransferPolicyError(
      `The input must be one exact ${requiredExtension} file alias without path syntax.`,
    );
  }
  return value;
}

function requirePlainDirectory(root: string, label: string): string {
  const resolved = path.resolve(root);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ExperimentalFileTransferPolicyError(`${label} must be a real local directory, not a link.`);
  }
  return resolved;
}

function resolvePlainInput(
  root: string,
  alias: string,
  inputFormat: ExperimentalFileTransferCapability["inputFormat"],
): string {
  const safeRoot = requirePlainDirectory(root, "Input root");
  const filename = path.resolve(safeRoot, safeFileAlias(alias, inputFormat));
  if (path.dirname(filename) !== safeRoot) {
    throw new ExperimentalFileTransferPolicyError("The input file escaped its approved root.");
  }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ExperimentalFileTransferPolicyError("The approved input must be one regular file, not a link.");
  }
  return filename;
}

export function fileTransferOutputAlias(operationKey: string): string {
  return `${createHash("sha256").update(operationKey).digest("hex")}.order.json`;
}

function splitSegments(source: string): string[][] {
  const normalized = source.replace(/\r?\n/g, "").trim();
  if (!normalized.endsWith("~")) {
    throw new ExperimentalFileTransferPolicyError("The X12 document must end with a segment terminator.");
  }
  const segments = normalized.split("~").filter(Boolean).map((segment) => segment.split("*"));
  if (segments.length < 8 || segments.length > 250) {
    throw new ExperimentalFileTransferPolicyError("The X12 document has an unsafe segment count.");
  }
  const allowed = new Set(["ISA", "GS", "ST", "BEG", "N1", "PO1", "CTT", "SE", "GE", "IEA"]);
  for (const segment of segments) {
    if (!segment[0] || !allowed.has(segment[0])) {
      throw new ExperimentalFileTransferPolicyError(`Unsupported X12 segment: ${segment[0] ?? "missing"}`);
    }
  }
  return segments;
}

function exactSegment(segments: string[][], key: string): string[] {
  const found = segments.filter((segment) => segment[0] === key);
  if (found.length !== 1) {
    throw new ExperimentalFileTransferPolicyError(`The X12 document requires exactly one ${key} segment.`);
  }
  return found[0]!;
}

export function parseBoundedX12PurchaseOrder(
  source: string,
  manifest: ExperimentalFileTransferCapability,
): Omit<CanonicalPurchaseOrder, "operationKey" | "sourceFile" | "sourceSha256"> {
  const safe = experimentalFileTransferCapabilitySchema.parse(manifest);
  const segments = splitSegments(source);
  const isa = exactSegment(segments, "ISA");
  const st = exactSegment(segments, "ST");
  const beg = exactSegment(segments, "BEG");
  const ctt = exactSegment(segments, "CTT");
  if (st[1] !== "850") throw new ExperimentalFileTransferPolicyError("Only an X12 850 purchase order is allowed.");
  const senderId = isa[6]?.trim();
  const receiverId = isa[8]?.trim();
  if (senderId !== safe.senderId || receiverId !== safe.receiverId) {
    throw new ExperimentalFileTransferPolicyError("The X12 trading-partner identity is outside the trusted contract.");
  }
  const purchaseOrderNumber = beg[3]?.trim();
  const purchaseOrderDate = beg[5]?.trim();
  if (!purchaseOrderNumber || !identifier.safeParse(purchaseOrderNumber).success) {
    throw new ExperimentalFileTransferPolicyError("The X12 purchase-order number is missing or unsafe.");
  }
  if (!purchaseOrderDate || !/^\d{8}$/.test(purchaseOrderDate)) {
    throw new ExperimentalFileTransferPolicyError("The X12 purchase-order date must be YYYYMMDD.");
  }
  const shipTo = segments.find((segment) => segment[0] === "N1" && segment[1] === "ST");
  const shipToCode = shipTo?.[4]?.trim();
  if (!shipToCode || !identifier.safeParse(shipToCode).success) {
    throw new ExperimentalFileTransferPolicyError("The X12 ship-to code is missing or unsafe.");
  }
  const po1 = segments.filter((segment) => segment[0] === "PO1");
  if (po1.length < 1 || po1.length > safe.maxLineItems || Number(ctt[1]) !== po1.length) {
    throw new ExperimentalFileTransferPolicyError("The X12 line count does not match the trusted limit.");
  }
  const lines = po1.map((segment, index): CanonicalPurchaseOrderLine => {
    const lineNumber = Number(segment[1]);
    const quantity = Number(segment[2]);
    const unit = segment[3];
    const qualifier = segment[6];
    const itemCode = segment[7]?.trim();
    if (lineNumber !== index + 1 || !Number.isInteger(quantity) || quantity < 1 || quantity > safe.maxQuantityPerLine) {
      throw new ExperimentalFileTransferPolicyError("The X12 purchase-order line number or quantity is unsafe.");
    }
    if (unit !== "EA" || qualifier !== "VN" || !itemCode || !safe.allowedItemCodes.includes(itemCode)) {
      throw new ExperimentalFileTransferPolicyError("The X12 item or unit is outside the trusted contract.");
    }
    return { lineNumber, itemCode, quantity, unit: "EA" };
  });
  return {
    schemaVersion: "1",
    senderId,
    receiverId,
    purchaseOrderNumber,
    purchaseOrderDate,
    shipToCode,
    lines,
  };
}

function splitEdifactSegments(source: string): string[][] {
  const normalized = source.replace(/\r?\n/g, "").trim();
  if (!normalized.endsWith("'")) {
    throw new ExperimentalFileTransferPolicyError("The EDIFACT document must end with a segment terminator.");
  }
  const segments = normalized.split("'").filter(Boolean).map((segment) => segment.split("+"));
  if (segments.length < 10 || segments.length > 250) {
    throw new ExperimentalFileTransferPolicyError("The EDIFACT document has an unsafe segment count.");
  }
  const allowed = new Set(["UNB", "UNH", "BGM", "DTM", "NAD", "LIN", "QTY", "UNS", "CNT", "UNT", "UNZ"]);
  for (const segment of segments) {
    if (!segment[0] || !allowed.has(segment[0])) {
      throw new ExperimentalFileTransferPolicyError(`Unsupported EDIFACT segment: ${segment[0] ?? "missing"}`);
    }
  }
  return segments;
}

function exactEdifactSegment(segments: string[][], key: string): string[] {
  const found = segments.filter((segment) => segment[0] === key);
  if (found.length !== 1) {
    throw new ExperimentalFileTransferPolicyError(`The EDIFACT document requires exactly one ${key} segment.`);
  }
  return found[0]!;
}

export function parseBoundedEdifactPurchaseOrder(
  source: string,
  manifest: ExperimentalFileTransferCapability,
): Omit<CanonicalPurchaseOrder, "operationKey" | "sourceFile" | "sourceSha256"> {
  const safe = experimentalFileTransferCapabilitySchema.parse(manifest);
  if (safe.inputFormat !== "edifact-orders-d96a") {
    throw new ExperimentalFileTransferPolicyError("The capability is not pinned to EDIFACT ORDERS D96A.");
  }
  const segments = splitEdifactSegments(source);
  const unb = exactEdifactSegment(segments, "UNB");
  const unh = exactEdifactSegment(segments, "UNH");
  const bgm = exactEdifactSegment(segments, "BGM");
  const dtm = exactEdifactSegment(segments, "DTM");
  const cnt = exactEdifactSegment(segments, "CNT");
  const message = unh[2]?.split(":");
  if (message?.join(":") !== "ORDERS:D:96A:UN") {
    throw new ExperimentalFileTransferPolicyError("Only EDIFACT ORDERS D96A is allowed.");
  }
  const senderId = unb[2]?.split(":")[0]?.trim();
  const receiverId = unb[3]?.split(":")[0]?.trim();
  if (senderId !== safe.senderId || receiverId !== safe.receiverId) {
    throw new ExperimentalFileTransferPolicyError("The EDIFACT trading-partner identity is outside the trusted contract.");
  }
  const purchaseOrderNumber = bgm[2]?.trim();
  if (bgm[1] !== "220" || !purchaseOrderNumber || !identifier.safeParse(purchaseOrderNumber).success) {
    throw new ExperimentalFileTransferPolicyError("The EDIFACT purchase-order identity is missing or unsafe.");
  }
  const [dateQualifier, purchaseOrderDate, dateFormat] = (dtm[1] ?? "").split(":");
  if (dateQualifier !== "137" || dateFormat !== "102" || !/^\d{8}$/.test(purchaseOrderDate ?? "")) {
    throw new ExperimentalFileTransferPolicyError("The EDIFACT order date must use DTM 137 with YYYYMMDD.");
  }
  const shipTo = segments.find((segment) => segment[0] === "NAD" && segment[1] === "DP");
  const [shipToCode, , qualifier] = (shipTo?.[2] ?? "").split(":");
  if (qualifier !== "92" || !shipToCode || !identifier.safeParse(shipToCode).success) {
    throw new ExperimentalFileTransferPolicyError("The EDIFACT delivery-party code is missing or unsafe.");
  }
  const lineSegments = segments.filter((segment) => segment[0] === "LIN");
  const quantitySegments = segments.filter((segment) => segment[0] === "QTY");
  const declaredCount = (cnt[1] ?? "").split(":");
  if (
    lineSegments.length < 1
    || lineSegments.length > safe.maxLineItems
    || lineSegments.length !== quantitySegments.length
    || declaredCount[0] !== "2"
    || Number(declaredCount[1]) !== lineSegments.length
  ) {
    throw new ExperimentalFileTransferPolicyError("The EDIFACT line count does not match the trusted limit.");
  }
  const lines = lineSegments.map((line, index): CanonicalPurchaseOrderLine => {
    const lineNumber = Number(line[1]);
    const [itemCode, itemQualifier] = (line[3] ?? "").split(":");
    const [quantityQualifier, quantityRaw, unit] = (quantitySegments[index]?.[1] ?? "").split(":");
    const quantity = Number(quantityRaw);
    if (
      lineNumber !== index + 1
      || itemQualifier !== "SA"
      || quantityQualifier !== "21"
      || unit !== "EA"
      || !Number.isInteger(quantity)
      || quantity < 1
      || quantity > safe.maxQuantityPerLine
      || !itemCode
      || !safe.allowedItemCodes.includes(itemCode)
    ) {
      throw new ExperimentalFileTransferPolicyError("The EDIFACT item, quantity, or unit is outside the trusted contract.");
    }
    return { lineNumber, itemCode, quantity, unit: "EA" };
  });
  return {
    schemaVersion: "1",
    senderId,
    receiverId,
    purchaseOrderNumber,
    purchaseOrderDate: purchaseOrderDate!,
    shipToCode,
    lines,
  };
}

export function parseBoundedPurchaseOrder(
  source: string,
  manifest: ExperimentalFileTransferCapability,
): Omit<CanonicalPurchaseOrder, "operationKey" | "sourceFile" | "sourceSha256"> {
  return manifest.inputFormat === "x12-850"
    ? parseBoundedX12PurchaseOrder(source, manifest)
    : parseBoundedEdifactPurchaseOrder(source, manifest);
}

export class ExperimentalFileTransferDriver {
  constructor(private readonly targets: Record<string, ExperimentalFileTransferTarget>) {}

  async verifyCapability(
    manifest: ExperimentalFileTransferCapability,
  ): Promise<ExperimentalFileTransferVerification> {
    const safe = experimentalFileTransferCapabilitySchema.parse(manifest);
    const target = this.target(safe);
    const checks: ExperimentalFileTransferVerification["checks"] = [];
    const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
    check("separate-roots", safe.inputRootAlias !== safe.outputRootAlias, "Input and output roots are distinct aliases.");
    check("contract-hash", safe.contractHash === target.contractHash, "The capability is pinned to the trusted partner contract.");
    check(
      "bounded-format",
      ["x12-850", "edifact-orders-d96a"].includes(safe.inputFormat)
        && safe.outputFormat === "canonical-order-json",
      "Only one explicitly declared bounded partner-order format can reach the canonical order output.",
    );
    check(
      "transport-kind",
      safe.transportKind === (target.kind ?? "local-directory"),
      "The capability transport kind matches the reviewed target.",
    );
    check("single-approval", Boolean(safe.approvalKey), "One exact business approval is required.");
    try {
      const parsed = parseBoundedPurchaseOrder(target.probeDocument, safe);
      check("disposable-probe", parsed.lines.length > 0, "A disposable in-memory partner document parsed without touching the business outbox.");
    } catch (error) {
      check("disposable-probe", false, error instanceof Error ? error.message : String(error));
    }
    return {
      driverVersion: EXPERIMENTAL_FILE_TRANSFER_DRIVER_VERSION,
      capabilityId: safe.id,
      manifestDigest: fileTransferManifestDigest(safe),
      contractHash: safe.contractHash,
      passed: checks.every((item) => item.passed),
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }

  async execute(
    manifest: ExperimentalFileTransferCapability,
    options: FileTransferExecutionOptions,
    verifier: ExperimentalFileTransferOutcomeVerifier,
  ): Promise<ExperimentalFileTransferRunResult> {
    const safe = experimentalFileTransferCapabilitySchema.parse(manifest);
    const target = this.target(safe);
    this.requireVerification(safe, options.verification);
    if (verifier.key !== safe.outcomeVerifierKey) {
      throw new ExperimentalFileTransferPolicyError("The independent outcome verifier does not match the capability.");
    }
    if (!options.approvals.includes(safe.approvalKey)) {
      return this.blocked(safe, options, "The exact file-import approval is missing.");
    }
    let sourceBytes: Buffer;
    try {
      sourceBytes = await this.readInput(target, options.inputFileAlias, safe);
    } catch (error) {
      return this.blocked(safe, options, error instanceof Error ? error.message : String(error));
    }
    const source = sourceBytes.toString("utf8");
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    if (sourceSha256 !== options.expectedInputSha256) {
      return this.blocked(safe, options, "The approved input changed after trusted planning.");
    }
    let parsed: Omit<CanonicalPurchaseOrder, "operationKey" | "sourceFile" | "sourceSha256">;
    try {
      parsed = parseBoundedPurchaseOrder(source, safe);
    } catch (error) {
      return this.blocked(safe, options, error instanceof Error ? error.message : String(error));
    }
    const canonical: CanonicalPurchaseOrder = {
      ...parsed,
      operationKey: options.operationKey,
      sourceFile: options.inputFileAlias,
      sourceSha256,
    };
    const outputFileAlias = fileTransferOutputAlias(options.operationKey);
    const outputBytes = Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, "utf8");
    let before: Awaited<ReturnType<ExperimentalFileTransferOutcomeVerifier["verify"]>>;
    try {
      before = await verifier.verify(options.operationKey);
    } catch (error) {
      return {
        status: "unknown",
        capabilityId: safe.id,
        operationKey: options.operationKey,
        writesAttempted: 0,
        quarantined: true,
        reason: `Pre-action reconciliation could not inspect external state: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (before.outcome === "complete") {
      return this.completed(
        target,
        safe,
        options,
        outputFileAlias,
        sourceSha256,
        0,
        true,
        "Independent reconciliation found the exact completed output; no write was repeated.",
      );
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
      await this.writeOutputExclusive(target, outputFileAlias, outputBytes);
      if (options.simulateLostResponseAfterCommit) {
        throw new Error("Simulated response loss after the atomic customer-local file commit.");
      }
    } catch (error) {
      let reconciled: Awaited<ReturnType<ExperimentalFileTransferOutcomeVerifier["verify"]>>;
      try {
        reconciled = await verifier.verify(options.operationKey);
      } catch (verificationError) {
        return {
          status: "unknown",
          capabilityId: safe.id,
          operationKey: options.operationKey,
          writesAttempted: 1,
          quarantined: true,
          reason: `The file write may have occurred, but reconciliation could not inspect external state: ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`,
        };
      }
      if (reconciled.outcome === "complete") {
        return this.completed(
          target,
          safe,
          options,
          outputFileAlias,
          sourceSha256,
          1,
          true,
          "The write response was unavailable; independent reconciliation proved exact completion without a duplicate.",
        );
      }
      return {
        status: reconciled.outcome === "unknown" ? "unknown" : "blocked",
        capabilityId: safe.id,
        operationKey: options.operationKey,
        writesAttempted: 1,
        quarantined: true,
        reason: `The file action failed and reconciliation did not prove completion: ${error instanceof Error ? error.message : String(error)} ${reconciled.detail}`,
      };
    }
    let after: Awaited<ReturnType<ExperimentalFileTransferOutcomeVerifier["verify"]>>;
    try {
      after = await verifier.verify(options.operationKey);
    } catch (error) {
      return {
        status: "unknown",
        capabilityId: safe.id,
        operationKey: options.operationKey,
        writesAttempted: 1,
        quarantined: true,
        reason: `The file was written, but independent verification could not inspect external state: ${error instanceof Error ? error.message : String(error)}`,
      };
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
    return this.completed(
      target,
      safe,
      options,
      outputFileAlias,
      sourceSha256,
      1,
      false,
      "The bounded file action and independent external-state verification completed.",
    );
  }

  private target(manifest: ExperimentalFileTransferCapability): ExperimentalFileTransferTarget {
    const input = this.targets[manifest.inputRootAlias];
    const output = this.targets[manifest.outputRootAlias];
    if (!input || !output || input !== output) {
      throw new ExperimentalFileTransferPolicyError("The input and output aliases must resolve to one reviewed file-transfer target.");
    }
    if ((input.kind ?? "local-directory") === "local-directory") {
      const local = input as Extract<ExperimentalFileTransferTarget, { kind?: "local-directory" }>;
      requirePlainDirectory(local.inputRoot, "Input root");
      requirePlainDirectory(local.outputRoot, "Output root");
    } else {
      const network = input as Extract<ExperimentalFileTransferTarget, { kind: "authenticated-network" }>;
      if (network.transport.kind !== "authenticated-network") {
        throw new ExperimentalFileTransferPolicyError("Network file target requires the authenticated transport driver.");
      }
    }
    if (!sha256.safeParse(input.contractHash).success) {
      throw new ExperimentalFileTransferPolicyError("The trusted target requires a SHA-256 contract hash.");
    }
    return input;
  }

  private requireVerification(
    manifest: ExperimentalFileTransferCapability,
    verification: ExperimentalFileTransferVerification,
  ): void {
    if (
      !verification.passed ||
      verification.driverVersion !== EXPERIMENTAL_FILE_TRANSFER_DRIVER_VERSION ||
      verification.capabilityId !== manifest.id ||
      verification.contractHash !== manifest.contractHash ||
      verification.manifestDigest !== fileTransferManifestDigest(manifest)
    ) {
      throw new ExperimentalFileTransferPolicyError("Execution requires a current passing verification receipt for this exact file capability.");
    }
  }

  private blocked(
    manifest: ExperimentalFileTransferCapability,
    options: FileTransferExecutionOptions,
    reason: string,
  ): ExperimentalFileTransferRunResult {
    return {
      status: "blocked",
      capabilityId: manifest.id,
      operationKey: options.operationKey,
      writesAttempted: 0,
      quarantined: false,
      reason,
    };
  }

  private async completed(
    target: ExperimentalFileTransferTarget,
    manifest: ExperimentalFileTransferCapability,
    options: FileTransferExecutionOptions,
    outputFileAlias: string,
    sourceSha256: string,
    writesAttempted: 0 | 1,
    reconciled: boolean,
    reason: string,
  ): Promise<Extract<ExperimentalFileTransferRunResult, { status: "completed" }>> {
    const output = await this.readOutput(target, outputFileAlias, manifest.maxInputBytes * 2);
    if (!output) throw new ExperimentalFileTransferPolicyError("Verified output could not be read for its evidence digest.");
    return {
      status: "completed",
      capabilityId: manifest.id,
      operationKey: options.operationKey,
      outputFileAlias,
      sourceSha256,
      outputSha256: createHash("sha256").update(output).digest("hex"),
      writesAttempted,
      reconciled,
      reason,
    };
  }

  private async readInput(
    target: ExperimentalFileTransferTarget,
    alias: string,
    manifest: ExperimentalFileTransferCapability,
  ): Promise<Buffer> {
    safeFileAlias(alias, manifest.inputFormat);
    if ((target.kind ?? "local-directory") === "authenticated-network") {
      const network = target as Extract<ExperimentalFileTransferTarget, { kind: "authenticated-network" }>;
      const bytes = await network.transport.readInput(alias, manifest.maxInputBytes);
      if (bytes.byteLength > manifest.maxInputBytes) {
        throw new ExperimentalFileTransferPolicyError("The approved network input exceeds the capability's byte limit.");
      }
      return bytes;
    }
    const local = target as Extract<ExperimentalFileTransferTarget, { kind?: "local-directory" }>;
    const filename = resolvePlainInput(local.inputRoot, alias, manifest.inputFormat);
    const inputStat = fs.statSync(filename);
    if (inputStat.size > manifest.maxInputBytes) {
      throw new ExperimentalFileTransferPolicyError("The approved input exceeds the capability's byte limit.");
    }
    return fs.readFileSync(filename);
  }

  private async writeOutputExclusive(
    target: ExperimentalFileTransferTarget,
    alias: string,
    bytes: Buffer,
  ): Promise<void> {
    if ((target.kind ?? "local-directory") === "authenticated-network") {
      const network = target as Extract<ExperimentalFileTransferTarget, { kind: "authenticated-network" }>;
      await network.transport.writeOutputExclusive(alias, bytes);
      return;
    }
    const local = target as Extract<ExperimentalFileTransferTarget, { kind?: "local-directory" }>;
    const safeOutputRoot = requirePlainDirectory(local.outputRoot, "Output root");
    const outputFilename = path.resolve(safeOutputRoot, alias);
    if (path.dirname(outputFilename) !== safeOutputRoot) {
      throw new ExperimentalFileTransferPolicyError("The generated output escaped its approved root.");
    }
    fs.writeFileSync(outputFilename, bytes, { mode: 0o600, flag: "wx" });
  }

  private async readOutput(
    target: ExperimentalFileTransferTarget,
    alias: string,
    maxBytes: number,
  ): Promise<Buffer | null> {
    if ((target.kind ?? "local-directory") === "authenticated-network") {
      const network = target as Extract<ExperimentalFileTransferTarget, { kind: "authenticated-network" }>;
      return network.transport.readOutput(alias, maxBytes);
    }
    const local = target as Extract<ExperimentalFileTransferTarget, { kind?: "local-directory" }>;
    const safeOutputRoot = requirePlainDirectory(local.outputRoot, "Output root");
    const filename = path.resolve(safeOutputRoot, alias);
    if (path.dirname(filename) !== safeOutputRoot || !fs.existsSync(filename)) return null;
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
      throw new ExperimentalFileTransferPolicyError("The output is not one bounded plain file.");
    }
    return fs.readFileSync(filename);
  }
}
