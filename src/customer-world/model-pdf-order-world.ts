// Intended repo path: src/customer-world/model-pdf-order-world.ts
//
// Thin adapter over FictionalPdfOrderWorld (src/customer-world/pdf-order-world.ts)
// that lets the demo runner inject a DocumentCapabilityBuilder. The stock world
// hard-wires its hand-coded ContractPinnedDocumentBuilder inside sdk(), and its
// outcome verifier + expectedByAlias ground truth are private, so both are
// reproduced here. See PLAN.md open question 1: the cleaner integration is an
// optional builder parameter on FictionalPdfOrderWorld.sdk().

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ExperimentalDocumentCapabilitySdk,
  StaticTrustedDocumentCapabilitySource,
  type DocumentCapabilityBuilder,
  type DocumentCapabilityGoalRequest,
  type DocumentCapabilityGoalResult,
} from "../experimental/document-capability-sdk.js";
import {
  ExperimentalDocumentDriver,
  documentOutputAlias,
  type CanonicalDocumentDraftOrder,
  type ExperimentalDocumentOutcomeVerifier,
} from "../experimental/document-driver.js";
import { PersistentDocumentCapabilityRegistry } from "../experimental/document-registry.js";
import {
  FICTIONAL_DOCUMENT_INPUT_ALIAS,
  FICTIONAL_DOCUMENT_OUTPUT_ALIAS,
  FICTIONAL_DOCUMENT_VERIFIER,
  FictionalPdfOrderWorld,
  type FictionalPdfOrderInput,
} from "./pdf-order-world.js";

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

export class ModelBackedPdfOrderWorld {
  // INTEGRATION-CHECK: duplicate of the private expectedFields ground truth in
  // FictionalPdfOrderWorld (pdf-order-world.ts lines 79-90, 156). The shipToCode
  // default "LONDON01" must stay in sync with that file.
  private readonly expectedByAlias: Record<string, ExpectedDocumentFields> = {};

  private constructor(readonly world: FictionalPdfOrderWorld) {}

  static async create(root: string): Promise<ModelBackedPdfOrderWorld> {
    return new ModelBackedPdfOrderWorld(await FictionalPdfOrderWorld.create(root));
  }

  get contractHash(): string {
    return this.world.contractHash;
  }

  get outputRoot(): string {
    return this.world.outputRoot;
  }

  async writeDocument(
    input: FictionalPdfOrderInput,
  ): Promise<{ filename: string; sha256: string; operationKey: string }> {
    const receipt = await this.world.writeDocument(input);
    this.expectedByAlias[input.fileAlias] = {
      documentId: input.documentId,
      purchaseOrderNumber: input.purchaseOrderNumber,
      shipToCode: input.shipToCode ?? "LONDON01",
      lines: input.lines.map((line, index) => ({
        lineNumber: index + 1,
        itemCode: line.itemCode,
        quantity: line.quantity,
      })),
    };
    return receipt;
  }

  /** Same wiring as FictionalPdfOrderWorld.sdk() but with an injected builder. */
  sdkWith(builder: DocumentCapabilityBuilder): ExperimentalDocumentCapabilitySdk {
    const target = this.world.target;
    return new ExperimentalDocumentCapabilitySdk({
      driver: new ExperimentalDocumentDriver({
        [FICTIONAL_DOCUMENT_INPUT_ALIAS]: target,
        [FICTIONAL_DOCUMENT_OUTPUT_ALIAS]: target,
      }),
      registry: new PersistentDocumentCapabilityRegistry(this.world.registryRoot),
      trustedSource: new StaticTrustedDocumentCapabilitySource("reviewed-document-library", []),
      builder,
      outcomeVerifier: (request) => this.verifier(request),
    });
  }

  request(input: Parameters<FictionalPdfOrderWorld["request"]>[0]): DocumentCapabilityGoalRequest {
    return this.world.request(input);
  }

  async complete(
    builder: DocumentCapabilityBuilder,
    input: Parameters<FictionalPdfOrderWorld["request"]>[0],
  ): Promise<DocumentCapabilityGoalResult> {
    return this.sdkWith(builder).completeGoal(this.world.request(input));
  }

  listDrafts(): Array<{ alias: string; draft: CanonicalDocumentDraftOrder }> {
    return this.world.listDrafts();
  }

  // INTEGRATION-CHECK: reimplementation of FictionalPdfOrderWorld's private
  // verifier (pdf-order-world.ts lines 257-299). Behavior must match: compare
  // the on-disk draft canonically against independently recorded expected
  // fields plus the immutable source hash; never call the extraction parser.
  private verifier(request: DocumentCapabilityGoalRequest): ExperimentalDocumentOutcomeVerifier {
    return {
      key: FICTIONAL_DOCUMENT_VERIFIER,
      verify: async (operationKey) => {
        const expectedAlias = documentOutputAlias(operationKey);
        const outputPath = path.join(this.world.outputRoot, expectedAlias);
        if (!fs.existsSync(outputPath)) {
          return { outcome: "not-started" as const, detail: "No document-backed draft exists for the exact operation." };
        }
        try {
          const stat = fs.lstatSync(outputPath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            return { outcome: "unknown" as const, detail: "The expected draft is not one plain file." };
          }
          const source = fs.readFileSync(path.join(this.world.inputRoot, request.inputDocumentAlias));
          const fields = this.expectedByAlias[request.inputDocumentAlias];
          if (!fields) return { outcome: "unknown" as const, detail: "Trusted fixture ground truth is unavailable." };
          const expected: CanonicalDocumentDraftOrder = {
            schemaVersion: "1",
            operationKey,
            sourceDocumentFile: request.inputDocumentAlias,
            sourceDocumentSha256: request.expectedDocumentSha256,
            ...fields,
            status: "draft",
          };
          const actual = JSON.parse(fs.readFileSync(outputPath, "utf8")) as CanonicalDocumentDraftOrder;
          if (sha256(source) !== request.expectedDocumentSha256 || canonical(actual) !== canonical(expected)) {
            return { outcome: "incorrect" as const, detail: "The draft does not match the customer-side expected document outcome." };
          }
          return {
            outcome: "complete" as const,
            detail: "Exactly one draft matches the trusted document ground truth.",
            stateDigest: sha256(fs.readFileSync(outputPath)),
          };
        } catch (error) {
          return {
            outcome: "unknown" as const,
            detail: `The document-backed draft could not be verified: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    };
  }
}
