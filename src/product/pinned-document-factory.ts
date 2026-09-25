import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  documentManifestDigest,
  experimentalDocumentCapabilitySchema,
  parseBoundedPdfOrder,
  type CanonicalDocumentDraftOrder,
  type ExperimentalDocumentCapability,
} from "../experimental/document-driver.js";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

export const pinnedDocumentContractSchema = z.object({
  schemaVersion: z.literal("1.0"),
  contractId: identifier,
  contractVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  layout: z.enum(["labeled-envelope-v1", "controlled-table-v2"]),
  templateTitle: z.string().min(1).max(160),
  needKey: identifier,
  inputRootAlias: identifier,
  outputRootAlias: identifier,
  allowedItemCodes: z.array(identifier).min(1).max(200),
  maxLineItems: z.number().int().positive().max(200),
  maxQuantityPerLine: z.number().int().positive().max(1_000_000),
  maxInputBytes: z.number().int().positive().max(10_000_000),
  maximumDocumentAgeMs: z.number().int().positive().max(365 * 24 * 60 * 60 * 1_000),
  targetAlias: identifier,
  actionKey: identifier,
  approvalKey: identifier,
  outcomeVerifierKey: identifier,
  workflowKey: identifier,
}).strict().superRefine((value, context) => {
  if (value.inputRootAlias === value.outputRootAlias) context.addIssue({ code: "custom", message: "Pinned document input and output roots must differ." });
  if (new Set(value.allowedItemCodes).size !== value.allowedItemCodes.length) context.addIssue({ code: "custom", message: "Allowed item codes must be unique." });
});
export type PinnedDocumentContract = z.infer<typeof pinnedDocumentContractSchema>;

export interface PinnedDocumentFactoryInput {
  tenantId: string;
  parentGoalId: string;
  planId: string;
  planDigest: string;
  workItemId: string;
  approvedDocumentAlias: string;
  approvedDocumentBytes: Uint8Array;
  approvedDocumentSha256: string;
  approvedAt: string;
  contract: PinnedDocumentContract;
  now: string;
}

export interface PinnedDocumentProposal {
  schemaVersion: "1.0";
  proposalId: string;
  tenantId: string;
  parentGoalId: string;
  planId: string;
  planDigest: string;
  workItemId: string;
  approvedDocumentAlias: string;
  approvedDocumentSha256: string;
  approvedAt: string;
  contractId: string;
  contractVersion: string;
  contractDigest: string;
  layout: PinnedDocumentContract["layout"];
  targetAlias: string;
  actionKey: string;
  workflowKey: string;
  manifest: ExperimentalDocumentCapability;
  manifestDigest: string;
  extracted: Omit<CanonicalDocumentDraftOrder, "operationKey" | "sourceDocumentFile" | "sourceDocumentSha256" | "status">;
  extractedDigest: string;
  capabilityMaterialDigest: string;
  proposedAt: string;
  proposalDigest: string;
}

export interface PinnedDocumentAuthorityReceipt {
  schemaVersion: "1.0";
  tenantId: string;
  parentGoalId: string;
  planId: string;
  planDigest: string;
  workItemId: string;
  targetAlias: string;
  actionKey: string;
  approvalKey: string;
  authorityDigest: string;
  checkedAt: string;
  expiresAt: string;
}

export type PinnedDocumentOutcomeClassification =
  | "completed" | "not-started" | "partial" | "incorrect"
  | "duplicate" | "stale" | "collateral" | "unknown" | "unavailable";

export interface PinnedDocumentOutcomeOracle {
  operationKey: string;
  expected: CanonicalDocumentDraftOrder;
  oracleDigest: string;
}

export interface PinnedDocumentOutcomeObservation {
  classification: PinnedDocumentOutcomeClassification;
  evidenceDigest: string;
  incorrectSideEffects: number;
  detail: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  throw new Error("Pinned document material must be plain structured data.");
}

export function pinnedDocumentDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function bytesDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestFor(contract: PinnedDocumentContract, contractDigest: string): ExperimentalDocumentCapability {
  return experimentalDocumentCapabilitySchema.parse({
    schemaVersion: "0.1", capabilityMode: "experimental-document-actions",
    id: `pinned-${contract.contractId}-${contract.contractVersion.replaceAll(".", "-")}`,
    needKey: contract.needKey, inputRootAlias: contract.inputRootAlias, outputRootAlias: contract.outputRootAlias,
    contractHash: contractDigest,
    inputFormat: contract.layout === "labeled-envelope-v1" ? "machine-readable-pdf-order-v1" : "machine-readable-pdf-order-table-v2",
    outputFormat: "canonical-draft-order-json", templateTitle: contract.templateTitle,
    templateVersion: contract.layout === "labeled-envelope-v1" ? "1" : "2",
    allowedItemCodes: contract.allowedItemCodes, maxLineItems: contract.maxLineItems,
    maxQuantityPerLine: contract.maxQuantityPerLine, maxInputBytes: contract.maxInputBytes,
    approvalKey: contract.approvalKey, outcomeVerifierKey: contract.outcomeVerifierKey,
  });
}

export async function createPinnedDocumentProposal(input: PinnedDocumentFactoryInput): Promise<PinnedDocumentProposal> {
  const contract = pinnedDocumentContractSchema.parse(input.contract);
  for (const value of [input.tenantId, input.parentGoalId, input.planId, input.workItemId, input.approvedDocumentAlias]) identifier.parse(value);
  digestSchema.parse(input.planDigest); digestSchema.parse(input.approvedDocumentSha256);
  const approvedAt = Date.parse(timestampSchema.parse(input.approvedAt));
  const now = Date.parse(timestampSchema.parse(input.now));
  if (now < approvedAt || now - approvedAt > contract.maximumDocumentAgeMs) throw new Error("Approved pinned document is stale or not active yet.");
  if (input.approvedDocumentBytes.byteLength > contract.maxInputBytes) throw new Error("Approved pinned document exceeds the contract byte limit.");
  if (bytesDigest(input.approvedDocumentBytes) !== input.approvedDocumentSha256) throw new Error("Approved pinned document bytes changed after approval.");
  const contractDigest = pinnedDocumentDigest(contract);
  const manifest = manifestFor(contract, contractDigest);
  const extracted = await parseBoundedPdfOrder(input.approvedDocumentBytes, manifest);
  const extractedDigest = pinnedDocumentDigest(extracted);
  const manifestDigest = documentManifestDigest(manifest);
  const capabilityMaterialDigest = pinnedDocumentDigest({
    documentationDigest: contractDigest,
    schemaDigest: manifestDigest,
    provenanceDigest: input.approvedDocumentSha256,
  });
  const unsigned = {
    schemaVersion: "1.0" as const,
    proposalId: "",
    tenantId: input.tenantId, parentGoalId: input.parentGoalId, planId: input.planId,
    planDigest: input.planDigest, workItemId: input.workItemId,
    approvedDocumentAlias: input.approvedDocumentAlias, approvedDocumentSha256: input.approvedDocumentSha256,
    approvedAt: input.approvedAt, contractId: contract.contractId, contractVersion: contract.contractVersion,
    contractDigest, layout: contract.layout, targetAlias: contract.targetAlias,
    actionKey: contract.actionKey, workflowKey: contract.workflowKey,
    manifest, manifestDigest, extracted, extractedDigest,
    capabilityMaterialDigest, proposedAt: input.now,
  };
  unsigned.proposalId = `document-proposal.${pinnedDocumentDigest(unsigned).slice(0, 40)}`;
  return { ...unsigned, proposalDigest: pinnedDocumentDigest(unsigned) };
}

interface OutcomeRow { operation_key: string; outcome_json: string; source_document_sha256: string; status: string }

/** Fictional customer-local action surface. Extraction/proposal is completed before this class receives input. */
export class PinnedDocumentActionRuntime {
  private readonly database: DatabaseSync;
  private verifierState: "available" | "unavailable" | "unknown" = "available";

  constructor(databasePath: string, private readonly now: () => string = () => new Date().toISOString()) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS document_outcomes (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_key TEXT NOT NULL,
        outcome_json TEXT NOT NULL, source_document_sha256 TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_actions (
        idempotency_key TEXT PRIMARY KEY, operation_key TEXT NOT NULL, proposal_digest TEXT NOT NULL
      );
    `);
  }

  setVerifierState(value: "available" | "unavailable" | "unknown"): void { this.verifierState = value; }

  execute(input: {
    proposal: PinnedDocumentProposal;
    authority: PinnedDocumentAuthorityReceipt;
    operationKey: string;
    idempotencyKey: string;
    loseResponseAfterCommit?: boolean;
  }): { writesAttempted: 0 | 1 } {
    const { proposal, authority } = input;
    const { proposalDigest, ...unsignedProposal } = proposal;
    if (pinnedDocumentDigest(unsignedProposal) !== proposalDigest) throw new Error("Pinned document proposal integrity failed.");
    digestSchema.parse(input.idempotencyKey); digestSchema.parse(authority.authorityDigest);
    for (const [label, left, right] of [
      ["tenant", authority.tenantId, proposal.tenantId], ["parent", authority.parentGoalId, proposal.parentGoalId],
      ["plan ID", authority.planId, proposal.planId], ["plan", authority.planDigest, proposal.planDigest],
      ["work item", authority.workItemId, proposal.workItemId], ["target", authority.targetAlias, proposal.targetAlias],
      ["action", authority.actionKey, proposal.actionKey], ["approval", authority.approvalKey, proposal.manifest.approvalKey],
    ] as const) if (left !== right) throw new Error(`Document authority is not bound to the exact ${label}.`);
    if (Date.parse(authority.checkedAt) > Date.parse(this.now()) || Date.parse(authority.expiresAt) <= Date.parse(this.now())) throw new Error("Document authority is expired or not active yet.");
    const expectedOperationKey = `document-${createHash("sha256").update(proposal.extracted.documentId).digest("hex")}`;
    if (input.operationKey !== expectedOperationKey) throw new Error("Document action identity is not bound to the extracted immutable document ID.");
    const existing = this.database.prepare("SELECT 1 FROM document_actions WHERE idempotency_key=?").get(input.idempotencyKey);
    if (existing) return { writesAttempted: 0 };
    const outcome: CanonicalDocumentDraftOrder = {
      ...proposal.extracted, operationKey: input.operationKey,
      sourceDocumentFile: proposal.approvedDocumentAlias,
      sourceDocumentSha256: proposal.approvedDocumentSha256, status: "draft",
    };
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare("INSERT INTO document_outcomes (operation_key, outcome_json, source_document_sha256, status) VALUES (?, ?, ?, 'draft')")
        .run(input.operationKey, JSON.stringify(outcome), proposal.approvedDocumentSha256);
      this.database.prepare("INSERT INTO document_actions VALUES (?, ?, ?)").run(input.idempotencyKey, input.operationKey, proposal.proposalDigest);
      this.database.exec("COMMIT;");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK;");
      throw error;
    }
    if (input.loseResponseAfterCommit) throw new Error("Document action response was lost after commit.");
    return { writesAttempted: 1 };
  }

  observe(oracle: PinnedDocumentOutcomeOracle): PinnedDocumentOutcomeObservation {
    if (this.verifierState !== "available") return {
      classification: this.verifierState,
      evidenceDigest: pinnedDocumentDigest({ oracle, verifierState: this.verifierState }), incorrectSideEffects: 0,
      detail: this.verifierState === "unknown" ? "Independent document outcome remained indeterminate." : "Independent document outcome verifier is unavailable.",
    };
    if (oracle.oracleDigest !== pinnedDocumentDigest({ operationKey: oracle.operationKey, expected: oracle.expected })) throw new Error("Document outcome oracle integrity failed.");
    const all = this.database.prepare("SELECT * FROM document_outcomes ORDER BY sequence").all() as unknown as OutcomeRow[];
    const target = all.filter((row) => row.operation_key === oracle.operationKey);
    const collateral = all.filter((row) => row.operation_key !== oracle.operationKey);
    const parsed = target.flatMap((row) => {
      try { return [JSON.parse(row.outcome_json) as unknown]; } catch { return []; }
    });
    const exact = parsed.filter((value) => canonical(value) === canonical(oracle.expected));
    let classification: PinnedDocumentOutcomeClassification;
    if (collateral.length > 0) classification = "collateral";
    else if (target.length > 1) classification = "duplicate";
    else if (target.length === 0) classification = "not-started";
    else if (exact.length === 1) classification = "completed";
    else {
      const candidate = parsed[0] as Partial<CanonicalDocumentDraftOrder> | undefined;
      classification = candidate && (!Array.isArray(candidate.lines) || candidate.lines.length < oracle.expected.lines.length) ? "partial" : "incorrect";
    }
    const incorrectSideEffects = classification === "incorrect" || classification === "duplicate" || classification === "collateral" ? Math.max(1, target.length - exact.length + collateral.length) : 0;
    return {
      classification, evidenceDigest: pinnedDocumentDigest({ oracleDigest: oracle.oracleDigest, rows: all }),
      incorrectSideEffects, detail: `Independent external document-outcome observation classified ${classification}.`,
    };
  }

  injectOutcome(operationKey: string, outcome: unknown): void {
    this.database.prepare("INSERT INTO document_outcomes (operation_key, outcome_json, source_document_sha256, status) VALUES (?, ?, ?, 'draft')")
      .run(operationKey, JSON.stringify(outcome), hashForInjection(outcome));
  }

  actionCount(): number {
    return (this.database.prepare("SELECT COUNT(*) AS value FROM document_actions").get() as unknown as { value: number }).value;
  }

  close(): void { this.database.close(); }
}

function hashForInjection(value: unknown): string { return pinnedDocumentDigest({ injected: value }); }
