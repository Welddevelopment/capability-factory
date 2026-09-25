import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VerifiedArtifactStore, verifiedArtifactDigest } from "../src/product/verified-artifact-flow.js";

const digest = (character: string) => character.repeat(64);
const quantitySchema = { schemaKey: "quantity-v1", maximumBytes: 64, parse: (value: unknown) => z.number().int().min(0).max(10_000).parse(value) };

function publication(value = 18) {
  return {
    artifact: {
      schemaVersion: "1.0" as const, artifactId: "artifact-one", version: 1, tenantId: "tenant-one", parentGoalId: "goal-one",
      producerWorkItemId: "calculate-shortage", schemaKey: "quantity-v1", classification: "internal" as const,
      contentDigest: verifiedArtifactDigest(value), evidenceReceiptDigest: digest("a"), planDigest: digest("b"),
      allowedConsumerWorkItemIds: ["create-draft"], expiresAt: "2026-08-12T12:00:00.000Z", reusePolicy: "same-plan-only" as const,
      customerLocalReference: "artifact-value-one", createdAt: "2026-08-12T10:00:00.000Z",
    },
    value,
    producerVerification: { passed: true as const, incorrectSideEffects: 0 as const, externalEvidenceDigest: digest("a") },
  };
}

describe("verified artifact flow", () => {
  it("publishes only independently verified data and resolves it for the exact consumer", () => {
    const store = new VerifiedArtifactStore(":memory:", [quantitySchema]);
    try {
      store.publish(publication());
      expect(store.resolve({ artifactId: "artifact-one", tenantId: "tenant-one", parentGoalId: "goal-one", consumerWorkItemId: "create-draft", expectedSchemaKey: "quantity-v1", maximumClassification: "internal", planDigest: digest("b"), now: "2026-08-12T11:00:00.000Z" }).value).toBe(18);
    } finally { store.close(); }
  });

  it("survives a fresh process while preserving immutable plan and content binding", () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-artifact-flow-"));
    const databasePath = join(directory, "artifacts.sqlite");
    try {
      const first = new VerifiedArtifactStore(databasePath, [quantitySchema]); first.publish(publication()); first.close();
      const reopened = new VerifiedArtifactStore(databasePath, [quantitySchema]);
      try {
        expect(reopened.resolve({ artifactId: "artifact-one", tenantId: "tenant-one", parentGoalId: "goal-one", consumerWorkItemId: "create-draft", expectedSchemaKey: "quantity-v1", maximumClassification: "internal", planDigest: digest("b"), now: "2026-08-12T11:00:00.000Z" }).value).toBe(18);
      } finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects wrong evidence, content, plan, consumer, schema, classification and expiry", () => {
    const invalidEvidence = new VerifiedArtifactStore(":memory:", [quantitySchema]);
    expect(() => invalidEvidence.publish({ ...publication(), producerVerification: { passed: true, incorrectSideEffects: 0, externalEvidenceDigest: digest("c") } })).toThrow(/evidence digest/i);
    invalidEvidence.close();
    const invalidContent = new VerifiedArtifactStore(":memory:", [quantitySchema]);
    expect(() => invalidContent.publish({ ...publication(), value: 19 })).toThrow(/content digest/i);
    invalidContent.close();

    const store = new VerifiedArtifactStore(":memory:", [quantitySchema]); store.publish(publication());
    const base = { artifactId: "artifact-one", tenantId: "tenant-one", parentGoalId: "goal-one", consumerWorkItemId: "create-draft", expectedSchemaKey: "quantity-v1", maximumClassification: "internal" as const, planDigest: digest("b"), now: "2026-08-12T11:00:00.000Z" };
    expect(() => store.resolve({ ...base, planDigest: digest("c") })).toThrow(/plan digest/i);
    expect(() => store.resolve({ ...base, consumerWorkItemId: "other-work" })).toThrow(/allowed/i);
    expect(() => store.resolve({ ...base, expectedSchemaKey: "money-v1" })).toThrow(/schema/i);
    expect(() => store.resolve({ ...base, maximumClassification: "public" })).toThrow(/classification/i);
    expect(() => store.resolve({ ...base, now: "2026-08-12T12:00:00.000Z" })).toThrow(/expired/i);
    store.close();
  });

  it("does not permit an artifact ID to be rewritten", () => {
    const store = new VerifiedArtifactStore(":memory:", [quantitySchema]);
    try { store.publish(publication()); expect(() => store.publish(publication())).toThrow(/immutable/i); }
    finally { store.close(); }
  });
});
