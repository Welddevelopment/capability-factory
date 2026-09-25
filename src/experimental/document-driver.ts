import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { z } from "zod";

export const EXPERIMENTAL_DOCUMENT_DRIVER_VERSION = "document-driver-v0.1" as const;
export const EXPERIMENTAL_DOCUMENT_CAPABILITY_MODE = "experimental-document-actions" as const;

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const experimentalDocumentCapabilitySchema = z.object({
  schemaVersion: z.literal("0.1"),
  capabilityMode: z.literal(EXPERIMENTAL_DOCUMENT_CAPABILITY_MODE),
  id: identifier,
  needKey: identifier,
  inputRootAlias: identifier,
  outputRootAlias: identifier,
  contractHash: sha256,
  inputFormat: z.enum([
    "machine-readable-pdf-order-v1",
    "machine-readable-pdf-order-table-v2",
  ]),
  outputFormat: z.literal("canonical-draft-order-json"),
  templateTitle: z.string().min(1).max(160),
  templateVersion: z.enum(["1", "2"]),
  allowedItemCodes: z.array(identifier).min(1).max(200),
  maxLineItems: z.number().int().positive().max(200),
  maxQuantityPerLine: z.number().int().positive().max(1_000_000),
  maxInputBytes: z.number().int().positive().max(10_000_000),
  approvalKey: identifier,
  outcomeVerifierKey: identifier,
}).strict().superRefine((manifest, context) => {
  if (manifest.inputRootAlias === manifest.outputRootAlias) {
    context.addIssue({ code: "custom", message: "Document input and output roots must remain separate." });
  }
  if (new Set(manifest.allowedItemCodes).size !== manifest.allowedItemCodes.length) {
    context.addIssue({ code: "custom", message: "Allowed document item codes must be unique." });
  }
  if (
    (manifest.inputFormat === "machine-readable-pdf-order-v1" && manifest.templateVersion !== "1")
    || (manifest.inputFormat === "machine-readable-pdf-order-table-v2" && manifest.templateVersion !== "2")
  ) {
    context.addIssue({ code: "custom", message: "Document input format and template version must match." });
  }
});

export type ExperimentalDocumentCapability = z.infer<typeof experimentalDocumentCapabilitySchema>;

export interface ExperimentalDocumentTarget {
  inputRoot: string;
  outputRoot: string;
  contractHash: string;
  probeDocument: Uint8Array;
  trustedIngressSha256ByAlias: Record<string, string>;
}

export interface CanonicalDocumentOrderLine {
  lineNumber: number;
  itemCode: string;
  quantity: number;
}

export interface CanonicalDocumentDraftOrder {
  schemaVersion: "1";
  operationKey: string;
  sourceDocumentFile: string;
  sourceDocumentSha256: string;
  documentId: string;
  purchaseOrderNumber: string;
  shipToCode: string;
  lines: CanonicalDocumentOrderLine[];
  status: "draft";
}

export interface ExperimentalDocumentVerification {
  driverVersion: typeof EXPERIMENTAL_DOCUMENT_DRIVER_VERSION;
  capabilityId: string;
  manifestDigest: string;
  contractHash: string;
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  verifiedAt: string;
}

export type ExperimentalDocumentOutcome = "complete" | "not-started" | "partial" | "incorrect" | "unknown";

export interface ExperimentalDocumentOutcomeVerifier {
  readonly key: string;
  verify(operationKey: string): Promise<{
    outcome: ExperimentalDocumentOutcome;
    detail: string;
    stateDigest?: string;
  }>;
}

export interface DocumentExecutionOptions {
  operationKey: string;
  runId: string;
  inputDocumentAlias: string;
  expectedDocumentSha256: string;
  approvals: string[];
  verification: ExperimentalDocumentVerification;
  simulateLostResponseAfterCommit?: boolean;
}

export type ExperimentalDocumentRunResult =
  | {
      status: "completed";
      capabilityId: string;
      operationKey: string;
      outputFileAlias: string;
      sourceDocumentSha256: string;
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

export class ExperimentalDocumentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentalDocumentPolicyError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function documentManifestDigest(manifest: ExperimentalDocumentCapability): string {
  return digest(experimentalDocumentCapabilitySchema.parse(manifest));
}

export function documentOperationKey(documentId: string): string {
  return `document-${createHash("sha256").update(documentId).digest("hex")}`;
}

export function documentOutputAlias(operationKey: string): string {
  return `${createHash("sha256").update(operationKey).digest("hex")}.document-draft.json`;
}

function safeDocumentAlias(value: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,180}$/.test(value) || value.includes("..") || !value.endsWith(".pdf")) {
    throw new ExperimentalDocumentPolicyError("The input must be one exact .pdf alias without path syntax.");
  }
  return value;
}

function requirePlainDirectory(root: string, label: string): string {
  const resolved = path.resolve(root);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ExperimentalDocumentPolicyError(`${label} must be a real local directory, not a link.`);
  }
  return resolved;
}

function resolvePlainDocument(root: string, alias: string): string {
  const safeRoot = requirePlainDirectory(root, "Document input root");
  const filename = path.resolve(safeRoot, safeDocumentAlias(alias));
  if (path.dirname(filename) !== safeRoot) {
    throw new ExperimentalDocumentPolicyError("The document escaped its approved input root.");
  }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ExperimentalDocumentPolicyError("The approved document must be one regular file, not a link.");
  }
  return filename;
}

interface PdfTextItem {
  str: string;
  transform: number[];
}

function groupTextItems(items: PdfTextItem[]): string[] {
  const positioned = items
    .filter((item) => item.str.trim().length > 0)
    .map((item) => ({
      text: item.str.trim(),
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0,
    }))
    .sort((left, right) => Math.abs(right.y - left.y) > 1 ? right.y - left.y : left.x - right.x);
  const lines: Array<{ y: number; values: Array<{ x: number; text: string }> }> = [];
  for (const item of positioned) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= 1);
    if (line) {
      line.values.push({ x: item.x, text: item.text });
    } else {
      lines.push({ y: item.y, values: [{ x: item.x, text: item.text }] });
    }
  }
  return lines
    .sort((left, right) => right.y - left.y)
    .map((line) => line.values.sort((left, right) => left.x - right.x).map((item) => item.text).join(" ").trim());
}

export async function extractMachineReadablePdfLines(source: Uint8Array): Promise<string[]> {
  let document: PDFDocumentProxy | undefined;
  try {
    const loadingTask = getDocument({
      data: source.slice(),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl: new URL("../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href,
    });
    document = await loadingTask.promise;
    if (document.numPages !== 1) {
      throw new ExperimentalDocumentPolicyError("Only one-page machine-readable documents are supported.");
    }
    const attachments = await document.getAttachments();
    if (attachments && Object.keys(attachments).length > 0) {
      throw new ExperimentalDocumentPolicyError("Embedded PDF attachments are not supported.");
    }
    const javaScript = await document.getJSActions();
    if (javaScript && Object.keys(javaScript).length > 0) {
      throw new ExperimentalDocumentPolicyError("PDF JavaScript actions are not supported.");
    }
    const page = await document.getPage(1);
    const text = await page.getTextContent();
    const textItems: PdfTextItem[] = text.items.flatMap((item) =>
      "str" in item ? [{ str: item.str, transform: [...item.transform] }] : [],
    );
    const lines = groupTextItems(textItems);
    if (lines.length < 6 || lines.length > 250) {
      throw new ExperimentalDocumentPolicyError("The document has missing or excessive machine-readable text.");
    }
    return lines;
  } catch (error) {
    if (error instanceof ExperimentalDocumentPolicyError) throw error;
    throw new ExperimentalDocumentPolicyError(
      `The PDF could not be read as a bounded machine-readable document: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await document?.destroy();
  }
}

export async function parseBoundedPdfOrder(
  source: Uint8Array,
  manifest: ExperimentalDocumentCapability,
): Promise<Omit<
  CanonicalDocumentDraftOrder,
  "operationKey" | "sourceDocumentFile" | "sourceDocumentSha256" | "status"
>> {
  const safe = experimentalDocumentCapabilitySchema.parse(manifest);
  const lines = await extractMachineReadablePdfLines(source);
  if (safe.inputFormat === "machine-readable-pdf-order-table-v2") {
    return parseBoundedPdfTableOrder(lines, safe);
  }
  if (lines[0] !== safe.templateTitle || lines[1] !== `Template-Version: ${safe.templateVersion}`) {
    throw new ExperimentalDocumentPolicyError("The PDF title or template version does not match the trusted contract.");
  }
  if (lines.at(-1) !== "END ORDER") {
    throw new ExperimentalDocumentPolicyError("The PDF order envelope is incomplete.");
  }
  const documentId = lines[2]?.match(/^Document-ID: ([a-zA-Z0-9_.-]+)$/)?.[1];
  const purchaseOrderNumber = lines[3]?.match(/^PO-Number: ([a-zA-Z0-9_.-]+)$/)?.[1];
  const shipToCode = lines[4]?.match(/^Ship-To: ([a-zA-Z0-9_.-]+)$/)?.[1];
  if (!documentId || !purchaseOrderNumber || !shipToCode) {
    throw new ExperimentalDocumentPolicyError("The PDF order identity fields are missing or ambiguous.");
  }
  const rawLines = lines.slice(5, -1);
  if (rawLines.length < 1 || rawLines.length > safe.maxLineItems) {
    throw new ExperimentalDocumentPolicyError("The PDF requires a bounded non-empty line set.");
  }
  const orderLines = rawLines.map((line, index): CanonicalDocumentOrderLine => {
    const match = line.match(/^Line: (\d+) \| ([a-zA-Z0-9_.-]+) \| (\d+)$/);
    if (!match) throw new ExperimentalDocumentPolicyError("A PDF order line does not match the trusted template.");
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
      throw new ExperimentalDocumentPolicyError("A PDF order line is outside the trusted contract.");
    }
    return { lineNumber, itemCode, quantity };
  });
  return {
    schemaVersion: "1",
    documentId,
    purchaseOrderNumber,
    shipToCode,
    lines: orderLines,
  };
}

function parseBoundedPdfTableOrder(
  lines: string[],
  manifest: ExperimentalDocumentCapability,
): Omit<
  CanonicalDocumentDraftOrder,
  "operationKey" | "sourceDocumentFile" | "sourceDocumentSha256" | "status"
> {
  if (
    lines[0] !== manifest.templateTitle
    || lines[1] !== "Template Version / 2"
    || lines[5] !== "# | SKU | Units"
    || lines.at(-1) !== "DOCUMENT COMPLETE"
  ) {
    throw new ExperimentalDocumentPolicyError("The table PDF envelope does not match the trusted v2 contract.");
  }
  const documentId = lines[2]?.match(/^Order ID \/ ([a-zA-Z0-9_.-]+)$/)?.[1];
  const purchaseOrderNumber = lines[3]?.match(/^Purchase Order \/ ([a-zA-Z0-9_.-]+)$/)?.[1];
  const shipToCode = lines[4]?.match(/^Delivery Code \/ ([a-zA-Z0-9_.-]+)$/)?.[1];
  const controlIndex = lines.findIndex((line) => line.startsWith("Control Total / "));
  if (!documentId || !purchaseOrderNumber || !shipToCode || controlIndex < 7) {
    throw new ExperimentalDocumentPolicyError("The table PDF identity or control fields are missing.");
  }
  const rawLines = lines.slice(6, controlIndex);
  const controlTotal = Number(lines[controlIndex]?.match(/^Control Total \/ (\d+)$/)?.[1]);
  if (
    rawLines.length < 1
    || rawLines.length > manifest.maxLineItems
    || controlTotal !== rawLines.length
    || controlIndex !== lines.length - 2
  ) {
    throw new ExperimentalDocumentPolicyError("The table PDF line count does not match its trusted control total.");
  }
  const orderLines = rawLines.map((line, index): CanonicalDocumentOrderLine => {
    const match = line.match(/^(\d+) \| ([a-zA-Z0-9_.-]+) \| (\d+)$/);
    if (!match) throw new ExperimentalDocumentPolicyError("A table PDF row does not match the trusted template.");
    const lineNumber = Number(match[1]);
    const itemCode = match[2]!;
    const quantity = Number(match[3]);
    if (
      lineNumber !== index + 1
      || !manifest.allowedItemCodes.includes(itemCode)
      || !Number.isInteger(quantity)
      || quantity < 1
      || quantity > manifest.maxQuantityPerLine
    ) {
      throw new ExperimentalDocumentPolicyError("A table PDF row is outside the trusted contract.");
    }
    return { lineNumber, itemCode, quantity };
  });
  return {
    schemaVersion: "1",
    documentId,
    purchaseOrderNumber,
    shipToCode,
    lines: orderLines,
  };
}

export class ExperimentalDocumentDriver {
  constructor(private readonly targets: Record<string, ExperimentalDocumentTarget>) {}

  async verifyCapability(
    manifest: ExperimentalDocumentCapability,
  ): Promise<ExperimentalDocumentVerification> {
    const safe = experimentalDocumentCapabilitySchema.parse(manifest);
    const target = this.target(safe);
    const checks: ExperimentalDocumentVerification["checks"] = [];
    const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
    check("separate-roots", safe.inputRootAlias !== safe.outputRootAlias, "Document input and output roots use distinct aliases.");
    check("contract-hash", safe.contractHash === target.contractHash, "The capability is pinned to the trusted PDF template contract.");
    check(
      "bounded-format",
      ["machine-readable-pdf-order-v1", "machine-readable-pdf-order-table-v2"].includes(safe.inputFormat),
      "Only one explicitly pinned machine-readable one-page PDF order template is represented.",
    );
    check("single-approval", Boolean(safe.approvalKey), "One exact draft-order approval is required.");
    try {
      const parsed = await parseBoundedPdfOrder(target.probeDocument, safe);
      check("disposable-probe", parsed.lines.length > 0, "An in-memory PDF probe parsed without touching the business draft store.");
    } catch (error) {
      check("disposable-probe", false, error instanceof Error ? error.message : String(error));
    }
    return {
      driverVersion: EXPERIMENTAL_DOCUMENT_DRIVER_VERSION,
      capabilityId: safe.id,
      manifestDigest: documentManifestDigest(safe),
      contractHash: safe.contractHash,
      passed: checks.every((item) => item.passed),
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }

  async execute(
    manifest: ExperimentalDocumentCapability,
    options: DocumentExecutionOptions,
    verifier: ExperimentalDocumentOutcomeVerifier,
  ): Promise<ExperimentalDocumentRunResult> {
    const safe = experimentalDocumentCapabilitySchema.parse(manifest);
    const target = this.target(safe);
    this.requireVerification(safe, options.verification);
    if (verifier.key !== safe.outcomeVerifierKey) {
      throw new ExperimentalDocumentPolicyError("The independent outcome verifier does not match the capability.");
    }
    if (!options.approvals.includes(safe.approvalKey)) {
      return this.blocked(safe, options, "The exact document-to-draft approval is missing.");
    }
    const inputFilename = resolvePlainDocument(target.inputRoot, options.inputDocumentAlias);
    const inputStat = fs.statSync(inputFilename);
    if (inputStat.size > safe.maxInputBytes) {
      return this.blocked(safe, options, "The approved PDF exceeds the capability's byte limit.");
    }
    const source = fs.readFileSync(inputFilename);
    const sourceDocumentSha256 = createHash("sha256").update(source).digest("hex");
    if (sourceDocumentSha256 !== options.expectedDocumentSha256) {
      return this.blocked(safe, options, "The approved PDF changed after trusted planning.");
    }
    if (target.trustedIngressSha256ByAlias[options.inputDocumentAlias] !== sourceDocumentSha256) {
      return this.blocked(safe, options, "The PDF lacks a matching customer-local trusted-ingress receipt.");
    }
    let parsed: Awaited<ReturnType<typeof parseBoundedPdfOrder>>;
    try {
      parsed = await parseBoundedPdfOrder(new Uint8Array(source), safe);
    } catch (error) {
      return this.blocked(safe, options, error instanceof Error ? error.message : String(error));
    }
    if (options.operationKey !== documentOperationKey(parsed.documentId)) {
      return this.blocked(safe, options, "The operation identity is not bound to the immutable Document-ID.");
    }
    const canonical: CanonicalDocumentDraftOrder = {
      ...parsed,
      operationKey: options.operationKey,
      sourceDocumentFile: options.inputDocumentAlias,
      sourceDocumentSha256,
      status: "draft",
    };
    const safeOutputRoot = requirePlainDirectory(target.outputRoot, "Document output root");
    const outputFileAlias = documentOutputAlias(options.operationKey);
    const outputFilename = path.resolve(safeOutputRoot, outputFileAlias);
    if (path.dirname(outputFilename) !== safeOutputRoot) {
      throw new ExperimentalDocumentPolicyError("The generated document output escaped its approved root.");
    }

    let before: Awaited<ReturnType<ExperimentalDocumentOutcomeVerifier["verify"]>>;
    try {
      before = await verifier.verify(options.operationKey);
    } catch (error) {
      return this.unknown(safe, options, 0, `Pre-action reconciliation could not inspect draft state: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (before.outcome === "complete") {
      return this.completed(safe, options, outputFileAlias, sourceDocumentSha256, outputFilename, 0, true, "Independent reconciliation found the exact document-backed draft; no write was repeated.");
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
        throw new Error("Simulated response loss after the atomic document-backed draft commit.");
      }
    } catch (error) {
      let reconciled: Awaited<ReturnType<ExperimentalDocumentOutcomeVerifier["verify"]>>;
      try {
        reconciled = await verifier.verify(options.operationKey);
      } catch (verificationError) {
        return this.unknown(safe, options, 1, `The draft may have been created, but reconciliation could not inspect state: ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`);
      }
      if (reconciled.outcome === "complete") {
        return this.completed(safe, options, outputFileAlias, sourceDocumentSha256, outputFilename, 1, true, "The response was unavailable; independent reconciliation proved exact completion without a duplicate.");
      }
      return {
        status: reconciled.outcome === "unknown" ? "unknown" : "blocked",
        capabilityId: safe.id,
        operationKey: options.operationKey,
        writesAttempted: 1,
        quarantined: true,
        reason: `The document action failed and reconciliation did not prove completion: ${error instanceof Error ? error.message : String(error)} ${reconciled.detail}`,
      };
    }
    let after: Awaited<ReturnType<ExperimentalDocumentOutcomeVerifier["verify"]>>;
    try {
      after = await verifier.verify(options.operationKey);
    } catch (error) {
      return this.unknown(safe, options, 1, `The draft was written, but independent verification could not inspect state: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (after.outcome !== "complete") {
      return {
        status: after.outcome === "unknown" ? "unknown" : "blocked",
        capabilityId: safe.id,
        operationKey: options.operationKey,
        writesAttempted: 1,
        quarantined: true,
        reason: `Independent draft verification did not prove completion: ${after.detail}`,
      };
    }
    return this.completed(safe, options, outputFileAlias, sourceDocumentSha256, outputFilename, 1, false, "The bounded PDF action and independent draft verification completed.");
  }

  private target(manifest: ExperimentalDocumentCapability): ExperimentalDocumentTarget {
    const input = this.targets[manifest.inputRootAlias];
    const output = this.targets[manifest.outputRootAlias];
    if (!input || !output || input !== output) {
      throw new ExperimentalDocumentPolicyError("The document aliases must resolve to one reviewed target.");
    }
    requirePlainDirectory(input.inputRoot, "Document input root");
    requirePlainDirectory(input.outputRoot, "Document output root");
    if (!sha256.safeParse(input.contractHash).success) {
      throw new ExperimentalDocumentPolicyError("The trusted document target requires a SHA-256 contract hash.");
    }
    return input;
  }

  private requireVerification(
    manifest: ExperimentalDocumentCapability,
    verification: ExperimentalDocumentVerification,
  ): void {
    if (
      !verification.passed ||
      verification.driverVersion !== EXPERIMENTAL_DOCUMENT_DRIVER_VERSION ||
      verification.capabilityId !== manifest.id ||
      verification.contractHash !== manifest.contractHash ||
      verification.manifestDigest !== documentManifestDigest(manifest)
    ) {
      throw new ExperimentalDocumentPolicyError("Execution requires a current passing receipt for this exact document capability.");
    }
  }

  private blocked(
    manifest: ExperimentalDocumentCapability,
    options: DocumentExecutionOptions,
    reason: string,
  ): ExperimentalDocumentRunResult {
    return { status: "blocked", capabilityId: manifest.id, operationKey: options.operationKey, writesAttempted: 0, quarantined: false, reason };
  }

  private unknown(
    manifest: ExperimentalDocumentCapability,
    options: DocumentExecutionOptions,
    writesAttempted: 0 | 1,
    reason: string,
  ): ExperimentalDocumentRunResult {
    return { status: "unknown", capabilityId: manifest.id, operationKey: options.operationKey, writesAttempted, quarantined: true, reason };
  }

  private completed(
    manifest: ExperimentalDocumentCapability,
    options: DocumentExecutionOptions,
    outputFileAlias: string,
    sourceDocumentSha256: string,
    outputFilename: string,
    writesAttempted: 0 | 1,
    reconciled: boolean,
    reason: string,
  ): Extract<ExperimentalDocumentRunResult, { status: "completed" }> {
    return {
      status: "completed",
      capabilityId: manifest.id,
      operationKey: options.operationKey,
      outputFileAlias,
      sourceDocumentSha256,
      outputSha256: createHash("sha256").update(fs.readFileSync(outputFilename)).digest("hex"),
      writesAttempted,
      reconciled,
      reason,
    };
  }
}
