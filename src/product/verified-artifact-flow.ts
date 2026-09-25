import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { artifactClassificationSchema, type ArtifactClassification } from "./capability-resolution-compiler.js";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const verifiedArtifactSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactId: identifier,
  version: z.number().int().positive(),
  tenantId: identifier,
  parentGoalId: identifier,
  producerWorkItemId: identifier,
  schemaKey: identifier,
  classification: artifactClassificationSchema,
  contentDigest: digest,
  evidenceReceiptDigest: digest,
  planDigest: digest,
  allowedConsumerWorkItemIds: z.array(identifier).min(1).max(32),
  expiresAt: z.string().datetime(),
  reusePolicy: z.enum(["same-plan-only", "same-parent-version"]),
  customerLocalReference: identifier,
  createdAt: z.string().datetime(),
}).strict();
export type VerifiedArtifact = z.infer<typeof verifiedArtifactSchema>;

export interface VerifiedArtifactPublication {
  artifact: VerifiedArtifact;
  value: unknown;
  producerVerification: {
    passed: true;
    incorrectSideEffects: 0;
    externalEvidenceDigest: string;
  };
}

export interface ArtifactValueSchema {
  schemaKey: string;
  maximumBytes: number;
  parse(value: unknown): unknown;
}

export interface ResolveVerifiedArtifactInput {
  artifactId: string;
  tenantId: string;
  parentGoalId: string;
  consumerWorkItemId: string;
  expectedSchemaKey: string;
  maximumClassification: ArtifactClassification;
  planDigest: string;
  now: string;
}

const classificationRank: Readonly<Record<ArtifactClassification, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Customer-local durable artifact store. Only independently verified outputs
 * may be published. Secrets are not a supported artifact classification, and
 * every read is bound to the exact plan, parent and declared consumer.
 */
export class VerifiedArtifactStore {
  private readonly database: DatabaseSync;
  private readonly schemas = new Map<string, ArtifactValueSchema>();

  constructor(databasePath = ":memory:", schemas: ArtifactValueSchema[] = []) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS verified_artifacts (
        artifact_id TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL,
        value_json TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        plan_digest TEXT NOT NULL
      );
    `);
    for (const schema of schemas) this.registerSchema(schema);
  }

  registerSchema(schema: ArtifactValueSchema): void {
    identifier.parse(schema.schemaKey);
    if (!Number.isInteger(schema.maximumBytes) || schema.maximumBytes < 1 || schema.maximumBytes > 1_000_000) {
      throw new Error("Artifact schema maximumBytes must be between 1 and 1,000,000.");
    }
    if (this.schemas.has(schema.schemaKey)) throw new Error(`Artifact schema ${schema.schemaKey} is already registered.`);
    this.schemas.set(schema.schemaKey, schema);
  }

  publish(raw: VerifiedArtifactPublication): VerifiedArtifact {
    const artifact = verifiedArtifactSchema.parse(raw.artifact);
    digest.parse(raw.producerVerification.externalEvidenceDigest);
    if (raw.producerVerification.externalEvidenceDigest !== artifact.evidenceReceiptDigest) {
      throw new Error("Artifact evidence digest does not match the independently verified producer receipt.");
    }
    const schema = this.schemas.get(artifact.schemaKey);
    if (!schema) throw new Error(`Artifact schema ${artifact.schemaKey} is not registered.`);
    const parsedValue = schema.parse(raw.value);
    const valueJson = JSON.stringify(parsedValue);
    if (Buffer.byteLength(valueJson, "utf8") > schema.maximumBytes) throw new Error("Artifact value exceeds its trusted schema byte ceiling.");
    if (hash(parsedValue) !== artifact.contentDigest) throw new Error("Artifact content digest does not match the customer-local value.");
    if (new Set(artifact.allowedConsumerWorkItemIds).size !== artifact.allowedConsumerWorkItemIds.length) {
      throw new Error("Artifact consumer IDs must be unique.");
    }
    try {
      this.database.prepare(`
        INSERT INTO verified_artifacts (artifact_id, metadata_json, value_json, content_digest, plan_digest)
        VALUES (?, ?, ?, ?, ?)
      `).run(artifact.artifactId, JSON.stringify(artifact), valueJson, artifact.contentDigest, artifact.planDigest);
    } catch {
      throw new Error(`Artifact ${artifact.artifactId} already exists and is immutable.`);
    }
    return artifact;
  }

  resolve(raw: ResolveVerifiedArtifactInput): { artifact: VerifiedArtifact; value: unknown } {
    const input = z.object({
      artifactId: identifier,
      tenantId: identifier,
      parentGoalId: identifier,
      consumerWorkItemId: identifier,
      expectedSchemaKey: identifier,
      maximumClassification: artifactClassificationSchema,
      planDigest: digest,
      now: z.string().datetime(),
    }).strict().parse(raw);
    const row = this.database.prepare(`
      SELECT metadata_json, value_json, content_digest, plan_digest
      FROM verified_artifacts WHERE artifact_id = ?
    `).get(input.artifactId) as { metadata_json: string; value_json: string; content_digest: string; plan_digest: string } | undefined;
    if (!row) throw new Error("Verified artifact is unavailable.");
    const artifact = verifiedArtifactSchema.parse(JSON.parse(row.metadata_json));
    if (artifact.tenantId !== input.tenantId || artifact.parentGoalId !== input.parentGoalId) throw new Error("Artifact identity does not match the trusted execution context.");
    if (artifact.planDigest !== input.planDigest || row.plan_digest !== input.planDigest) throw new Error("Artifact plan digest does not match the compiled plan.");
    if (!artifact.allowedConsumerWorkItemIds.includes(input.consumerWorkItemId)) throw new Error("The work item is not an allowed artifact consumer.");
    if (artifact.schemaKey !== input.expectedSchemaKey) throw new Error("Artifact schema does not match the downstream input.");
    if (classificationRank[artifact.classification] > classificationRank[input.maximumClassification]) throw new Error("Artifact classification exceeds the downstream input ceiling.");
    if (Date.parse(input.now) >= Date.parse(artifact.expiresAt)) throw new Error("Verified artifact has expired.");
    const schema = this.schemas.get(artifact.schemaKey);
    if (!schema) throw new Error("Artifact schema is no longer registered.");
    const value = schema.parse(JSON.parse(row.value_json));
    if (hash(value) !== artifact.contentDigest || row.content_digest !== artifact.contentDigest) throw new Error("Artifact content failed its immutable digest check.");
    return { artifact, value };
  }

  close(): void {
    this.database.close();
  }
}

export function verifiedArtifactDigest(value: unknown): string {
  return hash(value);
}
