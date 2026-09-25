import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  ExperimentalDocumentCapabilitySdk,
  StaticTrustedDocumentCapabilitySource,
  type DocumentCapabilityBuilder,
  type DocumentCapabilityGoalRequest,
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

export const FICTIONAL_TABLE_DOCUMENT_TENANT = "fictional-table-document-operator";
export const FICTIONAL_TABLE_DOCUMENT_NEED = "convert-approved-table-pdf-order-to-draft";
export const FICTIONAL_TABLE_DOCUMENT_APPROVAL = "create-approved-table-document-draft";
export const FICTIONAL_TABLE_DOCUMENT_VERIFIER = "customer-table-document-verifier-v1";
export const FICTIONAL_TABLE_DOCUMENT_INPUT_ALIAS = "trusted-table-pdf-inbox";
export const FICTIONAL_TABLE_DOCUMENT_OUTPUT_ALIAS = "customer-table-document-drafts";

export interface FictionalPdfTableOrderInput {
  fileAlias: string;
  documentId: string;
  purchaseOrderNumber: string;
  shipToCode?: string;
  lines: Array<{ itemCode: string; quantity: number }>;
}

interface ExpectedFields {
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

function sha256(value: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function contract() {
  return {
    schemaVersion: "1",
    templateTitle: "NORTH SEA TABULAR PURCHASE ORDER",
    templateVersion: "2",
    inputFormat: "machine-readable-pdf-order-table-v2",
    outputFormat: "canonical-draft-order-json",
    allowedItemCodes: ["BOLT-10", "FILTER-42", "GLOVE-7"],
    maxLineItems: 20,
    maxQuantityPerLine: 500,
    maxInputBytes: 1_000_000,
  } as const;
}

export function fictionalTableDocumentContractHash(): string {
  return sha256(canonical(contract()));
}

function expectedFields(input: FictionalPdfTableOrderInput): ExpectedFields {
  return {
    documentId: input.documentId,
    purchaseOrderNumber: input.purchaseOrderNumber,
    shipToCode: input.shipToCode ?? "LONDON03",
    lines: input.lines.map((line, index) => ({
      lineNumber: index + 1,
      itemCode: line.itemCode,
      quantity: line.quantity,
    })),
  };
}

export async function fictionalPdfTableOrder(input: FictionalPdfTableOrderInput): Promise<Uint8Array> {
  const safe = contract();
  const pdf = await PDFDocument.create();
  pdf.setTitle(safe.templateTitle);
  pdf.setProducer("Capability Factory fictional table document fixture");
  pdf.setCreator("Capability Factory");
  pdf.setCreationDate(new Date("2026-07-31T00:00:00.000Z"));
  pdf.setModificationDate(new Date("2026-07-31T00:00:00.000Z"));
  const page = pdf.addPage([792, 612]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const expected = expectedFields(input);
  const lines = [
    safe.templateTitle,
    "Template Version / 2",
    `Order ID / ${expected.documentId}`,
    `Purchase Order / ${expected.purchaseOrderNumber}`,
    `Delivery Code / ${expected.shipToCode}`,
    "# | SKU | Units",
    ...expected.lines.map((line) => `${line.lineNumber} | ${line.itemCode} | ${line.quantity}`),
    `Control Total / ${expected.lines.length}`,
    "DOCUMENT COMPLETE",
  ];
  lines.forEach((line, index) => {
    page.drawText(line, {
      x: 56,
      y: 550 - index * 34,
      size: index === 0 ? 17 : 11,
      font: index === 0 || index === 5 ? bold : regular,
    });
  });
  return pdf.save({ useObjectStreams: false });
}

function buildManifest(contractHash: string): ExperimentalDocumentCapability {
  const safe = contract();
  return experimentalDocumentCapabilitySchema.parse({
    schemaVersion: "0.1",
    capabilityMode: "experimental-document-actions",
    id: "north-sea-machine-readable-table-pdf-v2",
    needKey: FICTIONAL_TABLE_DOCUMENT_NEED,
    inputRootAlias: FICTIONAL_TABLE_DOCUMENT_INPUT_ALIAS,
    outputRootAlias: FICTIONAL_TABLE_DOCUMENT_OUTPUT_ALIAS,
    contractHash,
    inputFormat: safe.inputFormat,
    outputFormat: safe.outputFormat,
    templateTitle: safe.templateTitle,
    templateVersion: safe.templateVersion,
    allowedItemCodes: [...safe.allowedItemCodes],
    maxLineItems: safe.maxLineItems,
    maxQuantityPerLine: safe.maxQuantityPerLine,
    maxInputBytes: safe.maxInputBytes,
    approvalKey: FICTIONAL_TABLE_DOCUMENT_APPROVAL,
    outcomeVerifierKey: FICTIONAL_TABLE_DOCUMENT_VERIFIER,
  });
}

class ContractPinnedTableDocumentBuilder implements DocumentCapabilityBuilder {
  readonly builderId = "trusted-table-document-template-builder-v1";

  async build(needKey: string, contractHash: string): Promise<ExperimentalDocumentCapability | null> {
    if (needKey !== FICTIONAL_TABLE_DOCUMENT_NEED || contractHash !== fictionalTableDocumentContractHash()) {
      return null;
    }
    return buildManifest(contractHash);
  }
}

export class FictionalPdfTableOrderWorld {
  readonly inputRoot: string;
  readonly outputRoot: string;
  readonly registryRoot: string;
  readonly contractHash = fictionalTableDocumentContractHash();
  readonly target: ExperimentalDocumentTarget;
  private readonly expectedByAlias: Record<string, ExpectedFields> = {};

  private constructor(readonly root: string, probeDocument: Uint8Array) {
    this.inputRoot = path.join(root, "trusted-table-pdf-inbox");
    this.outputRoot = path.join(root, "table-document-drafts");
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

  static async create(root: string): Promise<FictionalPdfTableOrderWorld> {
    const probe = await fictionalPdfTableOrder({
      fileAlias: "probe-table.pdf",
      documentId: "TABLE-PROBE-001",
      purchaseOrderNumber: "TABLE-PROBE-001",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    return new FictionalPdfTableOrderWorld(root, probe);
  }

  async writeDocument(input: FictionalPdfTableOrderInput): Promise<{
    filename: string;
    sha256: string;
    operationKey: string;
  }> {
    if (!/^[a-zA-Z0-9_.-]+\.pdf$/.test(input.fileAlias) || input.fileAlias.includes("..")) {
      throw new Error("Table document input requires one safe .pdf alias.");
    }
    const source = await fictionalPdfTableOrder(input);
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
        [FICTIONAL_TABLE_DOCUMENT_INPUT_ALIAS]: target,
        [FICTIONAL_TABLE_DOCUMENT_OUTPUT_ALIAS]: target,
      }),
      registry: new PersistentDocumentCapabilityRegistry(this.registryRoot),
      trustedSource: new StaticTrustedDocumentCapabilitySource("empty-table-document-library", []),
      builder: new ContractPinnedTableDocumentBuilder(),
      outcomeVerifier: (request) => this.verifier(request),
    });
  }

  request(input: {
    requestId: string;
    operationKey: string;
    inputDocumentAlias: string;
    expectedDocumentSha256: string;
    approvals?: string[];
    simulateLostResponseAfterCommit?: boolean;
  }): DocumentCapabilityGoalRequest {
    return {
      tenantId: FICTIONAL_TABLE_DOCUMENT_TENANT,
      requestId: input.requestId,
      parentGoalId: `parent-${input.requestId}`,
      ordinaryGoal: "Convert the approved tabular purchase-order PDF into one verified draft and continue fulfilment.",
      needKey: FICTIONAL_TABLE_DOCUMENT_NEED,
      contractHash: this.contractHash,
      operationKey: input.operationKey,
      inputDocumentAlias: input.inputDocumentAlias,
      expectedDocumentSha256: input.expectedDocumentSha256,
      approvals: input.approvals ?? [FICTIONAL_TABLE_DOCUMENT_APPROVAL],
      ...(input.simulateLostResponseAfterCommit ? { simulateLostResponseAfterCommit: true } : {}),
    };
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
      key: FICTIONAL_TABLE_DOCUMENT_VERIFIER,
      verify: async (operationKey) => {
        const alias = documentOutputAlias(operationKey);
        const filename = path.join(this.outputRoot, alias);
        if (!fs.existsSync(filename)) {
          return { outcome: "not-started", detail: "No table-document draft exists for the operation." };
        }
        const expectedFieldsForAlias = this.expectedByAlias[request.inputDocumentAlias];
        if (!expectedFieldsForAlias) {
          return { outcome: "unknown", detail: "Independent table-document ground truth is unavailable." };
        }
        const source = fs.readFileSync(path.join(this.inputRoot, request.inputDocumentAlias));
        const expected: CanonicalDocumentDraftOrder = {
          schemaVersion: "1",
          operationKey,
          sourceDocumentFile: request.inputDocumentAlias,
          sourceDocumentSha256: request.expectedDocumentSha256,
          ...expectedFieldsForAlias,
          status: "draft",
        };
        try {
          const actual = JSON.parse(fs.readFileSync(filename, "utf8")) as CanonicalDocumentDraftOrder;
          if (
            sha256(source) !== request.expectedDocumentSha256
            || canonical(actual) !== canonical(expected)
          ) {
            return { outcome: "incorrect", detail: "The draft does not match independent table-document ground truth." };
          }
          return {
            outcome: "complete",
            detail: "Exactly one draft matches the approved table-document ground truth.",
            stateDigest: sha256(fs.readFileSync(filename)),
          };
        } catch (error) {
          return { outcome: "unknown", detail: error instanceof Error ? error.message : String(error) };
        }
      },
    };
  }
}
