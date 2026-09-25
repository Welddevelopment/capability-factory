import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ExperimentalFileTransferCapabilitySdk,
  StaticTrustedFileTransferCapabilitySource,
  type FileTransferCapabilityBuilder,
  type FileTransferCapabilityGoalRequest,
  type FileTransferCapabilityGoalResult,
} from "../experimental/file-transfer-capability-sdk.js";
import {
  ExperimentalFileTransferDriver,
  experimentalFileTransferCapabilitySchema,
  fileTransferOutputAlias,
  type CanonicalPurchaseOrder,
  type ExperimentalFileTransferCapability,
  type ExperimentalFileTransferOutcomeVerifier,
  type ExperimentalFileTransferTarget,
} from "../experimental/file-transfer-driver.js";
import { PersistentFileTransferCapabilityRegistry } from "../experimental/file-transfer-registry.js";

export const FICTIONAL_EDI_TENANT = "fictional-distributor";
export const FICTIONAL_EDI_NEED = "import-approved-x12-order";
export const FICTIONAL_EDI_APPROVAL = "import-approved-partner-order";
export const FICTIONAL_EDI_VERIFIER = "customer-outbox-order-verifier-v1";
export const FICTIONAL_EDI_INPUT_ALIAS = "partner-orders-inbox";
export const FICTIONAL_EDI_OUTPUT_ALIAS = "customer-order-outbox";

export interface FictionalEdiOrderInput {
  fileAlias: string;
  purchaseOrderNumber: string;
  purchaseOrderDate?: string;
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

/**
 * Direct verifier parser. This intentionally does not call the capability
 * driver's parser, so a shared transformation bug cannot self-certify.
 */
function independentlyExpectedOrder(
  source: string,
  operationKey: string,
  sourceFile: string,
  sourceSha256: string,
): CanonicalPurchaseOrder {
  const segments = new Map(
    source
      .replace(/\r?\n/g, "")
      .split("~")
      .filter(Boolean)
      .map((segment) => {
        const elements = segment.split("*");
        return [elements[0]!, elements] as const;
      }),
  );
  const isa = segments.get("ISA");
  const beg = segments.get("BEG");
  const n1 = source
    .replace(/\r?\n/g, "")
    .split("~")
    .filter(Boolean)
    .map((segment) => segment.split("*"))
    .find((segment) => segment[0] === "N1" && segment[1] === "ST");
  const po1 = source
    .replace(/\r?\n/g, "")
    .split("~")
    .filter(Boolean)
    .map((segment) => segment.split("*"))
    .filter((segment) => segment[0] === "PO1");
  if (!isa || !beg || !n1 || po1.length < 1) {
    throw new Error("The independently read source lacks required order fields.");
  }
  return {
    schemaVersion: "1",
    operationKey,
    sourceFile,
    sourceSha256,
    senderId: isa[6]!.trim(),
    receiverId: isa[8]!.trim(),
    purchaseOrderNumber: beg[3]!.trim(),
    purchaseOrderDate: beg[5]!.trim(),
    shipToCode: n1[4]!.trim(),
    lines: po1.map((line) => ({
      lineNumber: Number(line[1]),
      quantity: Number(line[2]),
      unit: "EA",
      itemCode: line[7]!.trim(),
    })),
  };
}

function partnerContract() {
  return {
    schemaVersion: "1",
    senderId: "EASTINDUSTRIAL",
    receiverId: "FICTIONALBUYER",
    allowedItemCodes: ["BOLT-10", "FILTER-42", "GLOVE-7"],
    maxLineItems: 20,
    maxQuantityPerLine: 500,
    maxInputBytes: 64_000,
    inputFormat: "x12-850",
    outputFormat: "canonical-order-json",
  } as const;
}

export function fictionalEdiContractHash(): string {
  return sha256(canonical(partnerContract()));
}

export function fictionalX12PurchaseOrder(input: FictionalEdiOrderInput): string {
  const date = input.purchaseOrderDate ?? "20260731";
  const shipTo = input.shipToCode ?? "LONDON01";
  const poLines = input.lines
    .map((line, index) => `PO1*${index + 1}*${line.quantity}*EA***VN*${line.itemCode}~`)
    .join("");
  return [
    "ISA*00**00**ZZ*EASTINDUSTRIAL*ZZ*FICTIONALBUYER*260731*1200*U*00401*000000001*0*T*>~",
    "GS*PO*EASTINDUSTRIAL*FICTIONALBUYER*20260731*1200*1*X*004010~",
    "ST*850*0001~",
    `BEG*00*SA*${input.purchaseOrderNumber}**${date}~`,
    `N1*ST*Fictional Warehouse*92*${shipTo}~`,
    poLines,
    `CTT*${input.lines.length}~`,
    `SE*${input.lines.length + 5}*0001~`,
    "GE*1*1~",
    "IEA*1*000000001~",
  ].join("");
}

export function buildFictionalEdiManifest(contractHash = fictionalEdiContractHash()): ExperimentalFileTransferCapability {
  const contract = partnerContract();
  return experimentalFileTransferCapabilitySchema.parse({
    schemaVersion: "0.1",
    capabilityMode: "experimental-file-transfer-actions",
    id: "east-industrial-x12-850-import-v1",
    needKey: FICTIONAL_EDI_NEED,
    inputRootAlias: FICTIONAL_EDI_INPUT_ALIAS,
    outputRootAlias: FICTIONAL_EDI_OUTPUT_ALIAS,
    contractHash,
    inputFormat: contract.inputFormat,
    outputFormat: contract.outputFormat,
    senderId: contract.senderId,
    receiverId: contract.receiverId,
    allowedItemCodes: [...contract.allowedItemCodes],
    maxLineItems: contract.maxLineItems,
    maxQuantityPerLine: contract.maxQuantityPerLine,
    maxInputBytes: contract.maxInputBytes,
    approvalKey: FICTIONAL_EDI_APPROVAL,
    outcomeVerifierKey: FICTIONAL_EDI_VERIFIER,
  });
}

class ContractPinnedFileTransferBuilder implements FileTransferCapabilityBuilder {
  readonly builderId = "trusted-partner-contract-builder-v1";

  async build(needKey: string, contractHash: string): Promise<ExperimentalFileTransferCapability | null> {
    if (needKey !== FICTIONAL_EDI_NEED || contractHash !== fictionalEdiContractHash()) return null;
    return buildFictionalEdiManifest(contractHash);
  }
}

/**
 * Disposable customer-local EDI world. The driver writes only the outbox; the
 * verifier reads it independently and compares it with the immutable inbox.
 */
export class FictionalEdiFileTransferWorld {
  readonly inputRoot: string;
  readonly outputRoot: string;
  readonly registryRoot: string;
  readonly contractHash = fictionalEdiContractHash();
  readonly target: ExperimentalFileTransferTarget;

  constructor(readonly root: string) {
    this.inputRoot = path.join(root, "inbox");
    this.outputRoot = path.join(root, "outbox");
    this.registryRoot = path.join(root, "registry");
    fs.mkdirSync(this.inputRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.outputRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.registryRoot, { recursive: true, mode: 0o700 });
    this.target = {
      inputRoot: this.inputRoot,
      outputRoot: this.outputRoot,
      contractHash: this.contractHash,
      probeDocument: fictionalX12PurchaseOrder({
        fileAlias: "probe.edi",
        purchaseOrderNumber: "PROBE-001",
        lines: [{ itemCode: "BOLT-10", quantity: 1 }],
      }),
    };
  }

  writeInput(input: FictionalEdiOrderInput): { filename: string; sha256: string } {
    if (!/^[a-zA-Z0-9_.-]+\.edi$/.test(input.fileAlias) || input.fileAlias.includes("..")) {
      throw new Error("Fictional input requires one safe .edi alias.");
    }
    const source = fictionalX12PurchaseOrder(input);
    const filename = path.join(this.inputRoot, input.fileAlias);
    fs.writeFileSync(filename, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { filename, sha256: sha256(source) };
  }

  sdk(options?: { trustedManifest?: ExperimentalFileTransferCapability }): ExperimentalFileTransferCapabilitySdk {
    const target = this.target;
    const driver = new ExperimentalFileTransferDriver({
      [FICTIONAL_EDI_INPUT_ALIAS]: target,
      [FICTIONAL_EDI_OUTPUT_ALIAS]: target,
    });
    return new ExperimentalFileTransferCapabilitySdk({
      driver,
      registry: new PersistentFileTransferCapabilityRegistry(this.registryRoot),
      trustedSource: new StaticTrustedFileTransferCapabilitySource(
        "reviewed-customer-library",
        options?.trustedManifest ? [options.trustedManifest] : [],
      ),
      builder: new ContractPinnedFileTransferBuilder(),
      outcomeVerifier: (request) => this.verifier(request),
    });
  }

  request(input: {
    requestId: string;
    parentGoalId?: string;
    operationKey: string;
    inputFileAlias: string;
    expectedInputSha256: string;
    approvals?: string[];
    simulateLostResponseAfterCommit?: boolean;
  }): FileTransferCapabilityGoalRequest {
    return {
      tenantId: FICTIONAL_EDI_TENANT,
      requestId: input.requestId,
      parentGoalId: input.parentGoalId ?? `parent-${input.requestId}`,
      ordinaryGoal: "Import the approved distributor order, verify exactly one customer-local order, and continue fulfilment.",
      needKey: FICTIONAL_EDI_NEED,
      contractHash: this.contractHash,
      operationKey: input.operationKey,
      inputFileAlias: input.inputFileAlias,
      expectedInputSha256: input.expectedInputSha256,
      approvals: input.approvals ?? [FICTIONAL_EDI_APPROVAL],
      ...(input.simulateLostResponseAfterCommit ? { simulateLostResponseAfterCommit: true } : {}),
    };
  }

  async complete(
    input: Parameters<FictionalEdiFileTransferWorld["request"]>[0],
  ): Promise<FileTransferCapabilityGoalResult> {
    return this.sdk().completeGoal(this.request(input));
  }

  listOutputs(): Array<{ alias: string; order: CanonicalPurchaseOrder }> {
    return fs.readdirSync(this.outputRoot)
      .filter((alias) => alias.endsWith(".order.json"))
      .sort()
      .map((alias) => ({
        alias,
        order: JSON.parse(fs.readFileSync(path.join(this.outputRoot, alias), "utf8")) as CanonicalPurchaseOrder,
      }));
  }

  private verifier(request: FileTransferCapabilityGoalRequest): ExperimentalFileTransferOutcomeVerifier {
    return {
      key: FICTIONAL_EDI_VERIFIER,
      verify: async (operationKey) => {
        const expectedAlias = fileTransferOutputAlias(operationKey);
        const outputNames = fs.readdirSync(this.outputRoot).filter((name) => name.endsWith(".order.json"));
        const matches = outputNames.filter((name) => name === expectedAlias);
        if (matches.length === 0) {
          return { outcome: "not-started", detail: "No output exists for the exact operation." };
        }
        if (matches.length !== 1) {
          return { outcome: "incorrect", detail: "More than one output exists for the exact operation." };
        }
        try {
          const outputPath = path.join(this.outputRoot, expectedAlias);
          const stat = fs.lstatSync(outputPath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            return { outcome: "unknown", detail: "The expected output is not one plain file." };
          }
          const order = JSON.parse(fs.readFileSync(outputPath, "utf8")) as CanonicalPurchaseOrder;
          const sourcePath = path.join(this.inputRoot, request.inputFileAlias);
          const source = fs.readFileSync(sourcePath);
          const expected = independentlyExpectedOrder(
            source.toString("utf8"),
            operationKey,
            request.inputFileAlias,
            request.expectedInputSha256,
          );
          const valid =
            sha256(source) === request.expectedInputSha256 &&
            canonical(order) === canonical(expected);
          if (!valid) {
            return { outcome: "incorrect", detail: "The outbox record does not match the exact approved source and contract." };
          }
          return {
            outcome: "complete",
            detail: "Exactly one canonical order matches the approved immutable source file.",
            stateDigest: sha256(fs.readFileSync(outputPath)),
          };
        } catch (error) {
          return { outcome: "unknown", detail: `The outbox could not be verified: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    };
  }
}
