import { describe, expect, it } from "vitest";
import { bindReviewedFileTransferAdapter, proposeFileTransferAdapter } from "../src/product/file-transfer-adapter-factory.js";

const digest = (character: string) => character.repeat(64);
const confirmed = <T>(value: T, sourceId = "partner-contract") => ({ value, status: "customer-confirmed" as const, sourceId });

function material(inputFormat: "x12-850" | "edifact-orders-d96a") {
  return {
    schemaVersion: "1.0", materialId: `${inputFormat.replaceAll(/[^a-z0-9]+/g, "-")}-contract`, sourceDigest: digest("a"),
    needKey: confirmed(`import-${inputFormat}`), inputRootAlias: confirmed("partner-inbox"), outputRootAlias: confirmed("customer-outbox"),
    inputFormat: confirmed(inputFormat), transportKind: confirmed(inputFormat === "x12-850" ? "local-directory" as const : "authenticated-network" as const),
    senderId: confirmed("APPROVEDPARTNER"), receiverId: confirmed("CUSTOMER"), allowedItemCodes: confirmed(["BOLT-10", "FILTER-42"]),
    maxLineItems: confirmed(20), maxQuantityPerLine: confirmed(500), maxInputBytes: confirmed(64_000), approvalKey: confirmed("import-approved-order"),
    outcomeVerifierKey: { value: "independent-order-observer", status: "independently-verified" as const, sourceId: "observer-registry" },
  };
}

function review(proposalDigest: string) {
  return {
    proposalDigest,
    confirmedFactKeys: ["needKey", "inputRootAlias", "outputRootAlias", "inputFormat", "transportKind", "senderId", "receiverId", "allowedItemCodes", "maxLineItems", "maxQuantityPerLine", "maxInputBytes", "approvalKey", "outcomeVerifierKey"],
    confirmedByAlias: "platform-engineer", confirmedAt: "2026-08-12T12:00:00.000Z", verifierImplementationDigest: digest("b"), transportBindingDigest: digest("c"),
  };
}

describe("file-transfer adapter factory", () => {
  it.each(["x12-850", "edifact-orders-d96a"] as const)("proposes and binds the supported %s family from reviewed metadata", (format) => {
    const proposal = proposeFileTransferAdapter(material(format));
    expect(proposal).toMatchObject({ executable: false, blockers: [], proposedManifest: { inputFormat: format } });
    const bound = bindReviewedFileTransferAdapter(proposal, review(proposal.proposalDigest));
    expect(bound.manifest.inputFormat).toBe(format);
    expect(bound.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps extracted or inferred facts blocked until explicitly reviewed", () => {
    const raw = material("x12-850");
    const proposal = proposeFileTransferAdapter({ ...raw, allowedItemCodes: { ...raw.allowedItemCodes, status: "extracted" } });
    expect(proposal.blockers).toContain("confirmation-required:allowedItemCodes");
    expect(() => bindReviewedFileTransferAdapter(proposal, review(proposal.proposalDigest))).toThrow(/blockers/i);
  });

  it("rejects stale review digests and incomplete confirmation sets", () => {
    const proposal = proposeFileTransferAdapter(material("x12-850"));
    expect(() => bindReviewedFileTransferAdapter(proposal, review(digest("d")))).toThrow(/exact/i);
    expect(() => bindReviewedFileTransferAdapter(proposal, { ...review(proposal.proposalDigest), confirmedFactKeys: ["needKey"] })).toThrow();
  });
});
