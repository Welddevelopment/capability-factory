import { createHash } from "node:crypto";
import { z } from "zod";
import {
  experimentalFileTransferCapabilitySchema,
  type ExperimentalFileTransferCapability,
} from "../experimental/file-transfer-driver.js";

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const factStatus = z.enum(["observed", "extracted", "inferred-proposal", "customer-confirmed", "independently-verified", "unknown"]);
const fact = <T extends z.ZodTypeAny>(value: T) => z.object({ value, status: factStatus, sourceId: identifier }).strict();

export const fileTransferContractMaterialSchema = z.object({
  schemaVersion: z.literal("1.0"),
  materialId: identifier,
  sourceDigest: digest,
  needKey: fact(identifier),
  inputRootAlias: fact(identifier),
  outputRootAlias: fact(identifier),
  inputFormat: fact(z.enum(["x12-850", "edifact-orders-d96a"])),
  transportKind: fact(z.enum(["local-directory", "authenticated-network"])),
  senderId: fact(identifier),
  receiverId: fact(identifier),
  allowedItemCodes: fact(z.array(identifier).min(1).max(200)),
  maxLineItems: fact(z.number().int().positive().max(200)),
  maxQuantityPerLine: fact(z.number().int().positive().max(1_000_000)),
  maxInputBytes: fact(z.number().int().positive().max(5_000_000)),
  approvalKey: fact(identifier),
  outcomeVerifierKey: fact(identifier),
}).strict();
export type FileTransferContractMaterial = z.infer<typeof fileTransferContractMaterialSchema>;

export interface FileTransferAdapterProposal {
  schemaVersion: "1.0";
  proposalId: string;
  proposalDigest: string;
  materialId: string;
  sourceDigest: string;
  executable: false;
  proposedManifest: ExperimentalFileTransferCapability;
  facts: Array<{ key: string; status: z.infer<typeof factStatus>; sourceId: string }>;
  blockers: string[];
}

export interface FileTransferAdapterReview {
  proposalDigest: string;
  confirmedFactKeys: string[];
  confirmedByAlias: string;
  confirmedAt: string;
  verifierImplementationDigest: string;
  transportBindingDigest: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

const consequentialFacts = [
  "needKey", "inputRootAlias", "outputRootAlias", "inputFormat", "transportKind", "senderId", "receiverId",
  "allowedItemCodes", "maxLineItems", "maxQuantityPerLine", "maxInputBytes", "approvalKey", "outcomeVerifierKey",
] as const;

/** Proposes an isolated file/EDI manifest. It remains non-executable until exact review. */
export function proposeFileTransferAdapter(rawMaterial: unknown): FileTransferAdapterProposal {
  const material = fileTransferContractMaterialSchema.parse(rawMaterial);
  const facts = consequentialFacts.map((key) => ({ key, status: material[key].status, sourceId: material[key].sourceId }));
  const contractHash = hash({ sourceDigest: material.sourceDigest, facts: consequentialFacts.map((key) => [key, material[key].value]) });
  const proposedManifest = experimentalFileTransferCapabilitySchema.parse({
    schemaVersion: "0.1",
    capabilityMode: "experimental-file-transfer-actions",
    id: `file-capability-${contractHash.slice(0, 24)}`,
    needKey: material.needKey.value,
    inputRootAlias: material.inputRootAlias.value,
    outputRootAlias: material.outputRootAlias.value,
    contractHash,
    inputFormat: material.inputFormat.value,
    outputFormat: "canonical-order-json",
    transportKind: material.transportKind.value,
    senderId: material.senderId.value,
    receiverId: material.receiverId.value,
    allowedItemCodes: [...material.allowedItemCodes.value],
    maxLineItems: material.maxLineItems.value,
    maxQuantityPerLine: material.maxQuantityPerLine.value,
    maxInputBytes: material.maxInputBytes.value,
    approvalKey: material.approvalKey.value,
    outcomeVerifierKey: material.outcomeVerifierKey.value,
  });
  const blockers = facts
    .filter((item) => item.status !== "customer-confirmed" && item.status !== "independently-verified")
    .map((item) => `confirmation-required:${item.key}`);
  const unsigned = { schemaVersion: "1.0" as const, materialId: material.materialId, sourceDigest: material.sourceDigest, executable: false as const, proposedManifest, facts, blockers };
  const proposalDigest = hash(unsigned);
  return { ...unsigned, proposalId: `file-adapter-proposal-${proposalDigest.slice(0, 24)}`, proposalDigest };
}

/** Binds only an exact, fully reviewed proposal with real local verifier and transport implementations. */
export function bindReviewedFileTransferAdapter(
  proposal: FileTransferAdapterProposal,
  rawReview: FileTransferAdapterReview,
): { manifest: ExperimentalFileTransferCapability; bindingDigest: string } {
  const review = z.object({
    proposalDigest: digest,
    confirmedFactKeys: z.array(identifier).length(consequentialFacts.length),
    confirmedByAlias: identifier,
    confirmedAt: z.string().datetime(),
    verifierImplementationDigest: digest,
    transportBindingDigest: digest,
  }).strict().parse(rawReview);
  if (review.proposalDigest !== proposal.proposalDigest) throw new Error("Review does not match the exact file-adapter proposal.");
  if (proposal.blockers.length > 0) throw new Error(`File-adapter proposal still has blockers: ${proposal.blockers.join(", ")}`);
  if (new Set(review.confirmedFactKeys).size !== consequentialFacts.length || consequentialFacts.some((key) => !review.confirmedFactKeys.includes(key))) {
    throw new Error("Every consequential file-adapter fact must be explicitly confirmed.");
  }
  const manifest = experimentalFileTransferCapabilitySchema.parse(proposal.proposedManifest);
  const bindingDigest = hash({ proposalDigest: proposal.proposalDigest, manifest, review });
  return { manifest, bindingDigest };
}
