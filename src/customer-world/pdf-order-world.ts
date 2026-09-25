import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  ExperimentalDocumentCapabilitySdk,
  StaticTrustedDocumentCapabilitySource,
  type DocumentCapabilityBuilder,
  type DocumentCapabilityGoalRequest,
  type DocumentCapabilityGoalResult,
} from "../experimental/document-capability-sdk.js";
import {
  ExperimentalDocumentDriver,
  documentOperationKey,
  documentOutputAlias,
  experimentalDocumentCapabilitySchema,
  type CanonicalDocumentDraftOrder,
  type ExperimentalDocumentCapability,
  type ExperimentalDocumentOutcomeVerifier,
  type ExperimentalDocumentTarget,
} from "../experimental/document-driver.js";
import { PersistentDocumentCapabilityRegistry } from "../experimental/document-registry.js";

export const FICTIONAL_DOCUMENT_TENANT = "fictional-document-operator";
export const FICTIONAL_DOCUMENT_NEED = "convert-approved-pdf-order-to-draft";
export const FICTIONAL_DOCUMENT_APPROVAL = "create-approved-document-draft";
export const FICTIONAL_DOCUMENT_VERIFIER = "customer-document-draft-verifier-v1";
export const FICTIONAL_DOCUMENT_INPUT_ALIAS = "trusted-document-inbox";
export const FICTIONAL_DOCUMENT_OUTPUT_ALIAS = "customer-document-draft-store";

export interface FictionalPdfOrderInput {
  fileAlias: string;
  documentId: string;
  purchaseOrderNumber: string;
  shipToCode?: string;
  lines: Array<{ itemCode: string; quantity: number }>;
}

interface ExpectedDocumentFields {
  documentId: string;
  purchaseOrderNumber: string;
  shipToCode: string;
  lines: Array<{ lineNumber: number; itemCode: string; quantity: number }>;
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

function sha256(value: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function documentContract() {
  return {
    schemaVersion: "1",
    templateTitle: "EAST INDUSTRIAL PURCHASE ORDER",
    templateVersion: "1",
    inputFormat: "machine-readable-pdf-order-v1",
    outputFormat: "canonical-draft-order-json",
    allowedItemCodes: ["BOLT-10", "FILTER-42", "GLOVE-7"],
    maxLineItems: 20,
    maxQuantityPerLine: 500,
    maxInputBytes: 1_000_000,
  } as const;
}

export function fictionalDocumentContractHash(): string {
  return sha256(canonical(documentContract()));
}

function expectedFields(input: FictionalPdfOrderInput): ExpectedDocumentFields {
  return {
    documentId: input.documentId,
    purchaseOrderNumber: input.purchaseOrderNumber,
    shipToCode: input.shipToCode ?? "LONDON01",
    lines: input.lines.map((line, index) => ({
      lineNumber: index + 1,
      itemCode: line.itemCode,
      quantity: line.quantity,
    })),
  };
}

export async function fictionalPdfOrder(input: FictionalPdfOrderInput): Promise<Uint8Array> {
  const contract = documentContract();
  const pdf = await PDFDocument.create();
  pdf.setTitle(contract.templateTitle);
  pdf.setProducer("Capability Factory fictional document fixture");
  pdf.setCreator("Capability Factory");
  pdf.setCreationDate(new Date("2026-07-31T00:00:00.000Z"));
  pdf.setModificationDate(new Date("2026-07-31T00:00:00.000Z"));
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fields = expectedFields(input);
  const lines = [
    contract.templateTitle,
    `Template-Version: ${contract.templateVersion}`,
    `Document-ID: ${fields.documentId}`,
    `PO-Number: ${fields.purchaseOrderNumber}`,
    `Ship-To: ${fields.shipToCode}`,
    ...fields.lines.map((line) => `Line: ${line.lineNumber} | ${line.itemCode} | ${line.quantity}`),
    "END ORDER",
  ];
  lines.forEach((line, index) => {
    page.drawText(line, { x: 54, y: 730 - index * 28, size: index === 0 ? 16 : 11, font });
  });
  return pdf.save({ useObjectStreams: false });
}

function buildManifest(contractHash: string): ExperimentalDocumentCapability {
  const contract = documentContract();
  return experimentalDocumentCapabilitySchema.parse({
    schemaVersion: "0.1",
    capabilityMode: "experimental-document-actions",
    id: "east-industrial-machine-readable-pdf-v1",
    needKey: FICTIONAL_DOCUMENT_NEED,
    inputRootAlias: FICTIONAL_DOCUMENT_INPUT_ALIAS,
    outputRootAlias: FICTIONAL_DOCUMENT_OUTPUT_ALIAS,
    contractHash,
    inputFormat: contract.inputFormat,
    outputFormat: contract.outputFormat,
    templateTitle: contract.templateTitle,
    templateVersion: contract.templateVersion,
    allowedItemCodes: [...contract.allowedItemCodes],
    maxLineItems: contract.maxLineItems,
    maxQuantityPerLine: contract.maxQuantityPerLine,
    maxInputBytes: contract.maxInputBytes,
    approvalKey: FICTIONAL_DOCUMENT_APPROVAL,
    outcomeVerifierKey: FICTIONAL_DOCUMENT_VERIFIER,
  });
}

class ContractPinnedDocumentBuilder implements DocumentCapabilityBuilder {
  readonly builderId = "trusted-document-template-builder-v1";

  async build(needKey: string, contractHash: string): Promise<ExperimentalDocumentCapability | null> {
    if (needKey !== FICTIONAL_DOCUMENT_NEED || contractHash !== fictionalDocumentContractHash()) return null;
    return buildManifest(contractHash);
  }
}

export class FictionalPdfOrderWorld {
  readonly inputRoot: string;
  readonly outputRoot: string;
  readonly registryRoot: string;
  readonly contractHash = fictionalDocumentContractHash();
  readonly target: ExperimentalDocumentTarget;
  private readonly expectedByAlias: Record<string, ExpectedDocumentFields> = {};

  private constructor(readonly root: string, probeDocument: Uint8Array) {
    this.inputRoot = path.join(root, "trusted-pdf-inbox");
    this.outputRoot = path.join(root, "document-drafts");
    this.registryRoot = path.join(root, "registry");
    fs.mkdirSync(this.inputRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.outputRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.registryRoot, { recursive: true, mode: 0o700 });
    this.target = {
      inputRoot: this.inputRoot,
      outputRoot: this.outputRoot,
      contractHash: this.contractHash,
      probeDocument,
      trustedIngressSha256ByAlias: {},
    };
  }

  static async create(root: string): Promise<FictionalPdfOrderWorld> {
    const probe = await fictionalPdfOrder({
      fileAlias: "probe.pdf",
      documentId: "PDF-PROBE-001",
      purchaseOrderNumber: "PROBE-001",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    return new FictionalPdfOrderWorld(root, probe);
  }

  async writeDocument(
    input: FictionalPdfOrderInput,
  ): Promise<{ filename: string; sha256: string; operationKey: string }> {
    if (!/^[a-zA-Z0-9_.-]+\.pdf$/.test(input.fileAlias) || input.fileAlias.includes("..")) {
      throw new Error("Fictional document input requires one safe .pdf alias.");
    }
    const source = await fictionalPdfOrder(input);
    const filename = path.join(this.inputRoot, input.fileAlias);
    fs.writeFileSync(filename, source, { mode: 0o600, flag: "wx" });
    const sourceSha256 = sha256(source);
    this.target.trustedIngressSha256ByAlias[input.fileAlias] = sourceSha256;
    this.expectedByAlias[input.fileAlias] = expectedFields(input);
    return {
      filename,
      sha256: sourceSha256,
      operationKey: documentOperationKey(input.documentId),
    };
  }

  sdk(): ExperimentalDocumentCapabilitySdk {
    const target = this.target;
    return new ExperimentalDocumentCapabilitySdk({
      driver: new ExperimentalDocumentDriver({
        [FICTIONAL_DOCUMENT_INPUT_ALIAS]: target,
        [FICTIONAL_DOCUMENT_OUTPUT_ALIAS]: target,
      }),
      registry: new PersistentDocumentCapabilityRegistry(this.registryRoot),
      trustedSource: new StaticTrustedDocumentCapabilitySource("reviewed-document-library", []),
      builder: new ContractPinnedDocumentBuilder(),
      outcomeVerifier: (request) => this.verifier(request),
    });
  }

  request(input: {
    requestId: string;
    parentGoalId?: string;
    operationKey: string;
    inputDocumentAlias: string;
    expectedDocumentSha256: string;
    approvals?: string[];
    simulateLostResponseAfterCommit?: boolean;
  }): DocumentCapabilityGoalRequest {
    return {
      tenantId: FICTIONAL_DOCUMENT_TENANT,
      requestId: input.requestId,
      parentGoalId: input.parentGoalId ?? `parent-${input.requestId}`,
      ordinaryGoal: "Process the approved purchase-order PDF, create exactly one draft order, and continue fulfilment.",
      needKey: FICTIONAL_DOCUMENT_NEED,
      contractHash: this.contractHash,
      operationKey: input.operationKey,
      inputDocumentAlias: input.inputDocumentAlias,
      expectedDocumentSha256: input.expectedDocumentSha256,
      approvals: input.approvals ?? [FICTIONAL_DOCUMENT_APPROVAL],
      ...(input.simulateLostResponseAfterCommit ? { simulateLostResponseAfterCommit: true } : {}),
    };
  }

  async complete(
    input: Parameters<FictionalPdfOrderWorld["request"]>[0],
  ): Promise<DocumentCapabilityGoalResult> {
    return this.sdk().completeGoal(this.request(input));
  }

  listDrafts(): Array<{ alias: string; draft: CanonicalDocumentDraftOrder }> {
    return fs.readdirSync(this.outputRoot)
      .filter((alias) => alias.endsWith(".document-draft.json"))
      .sort()
      .map((alias) => ({
        alias,
        draft: JSON.parse(fs.readFileSync(path.join(this.outputRoot, alias), "utf8")) as CanonicalDocumentDraftOrder,
      }));
  }

  private verifier(request: DocumentCapabilityGoalRequest): ExperimentalDocumentOutcomeVerifier {
    return {
      key: FICTIONAL_DOCUMENT_VERIFIER,
      verify: async (operationKey) => {
        const expectedAlias = documentOutputAlias(operationKey);
        if (!fs.existsSync(path.join(this.outputRoot, expectedAlias))) {
          return { outcome: "not-started", detail: "No document-backed draft exists for the exact operation." };
        }
        try {
          const outputPath = path.join(this.outputRoot, expectedAlias);
          const stat = fs.lstatSync(outputPath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            return { outcome: "unknown", detail: "The expected draft is not one plain file." };
          }
          const source = fs.readFileSync(path.join(this.inputRoot, request.inputDocumentAlias));
          const fields = this.expectedByAlias[request.inputDocumentAlias];
          if (!fields) return { outcome: "unknown", detail: "Trusted fixture ground truth is unavailable." };
          const expected: CanonicalDocumentDraftOrder = {
            schemaVersion: "1",
            operationKey,
            sourceDocumentFile: request.inputDocumentAlias,
            sourceDocumentSha256: request.expectedDocumentSha256,
            ...fields,
            status: "draft",
          };
          const actual = JSON.parse(fs.readFileSync(outputPath, "utf8")) as CanonicalDocumentDraftOrder;
          if (
            sha256(source) !== request.expectedDocumentSha256 ||
            canonical(actual) !== canonical(expected)
          ) {
            return { outcome: "incorrect", detail: "The draft does not match the customer-side expected document outcome." };
          }
          return {
            outcome: "complete",
            detail: "Exactly one draft matches the trusted document ground truth.",
            stateDigest: sha256(fs.readFileSync(outputPath)),
          };
        } catch (error) {
          return { outcome: "unknown", detail: `The document-backed draft could not be verified: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    };
  }
}
