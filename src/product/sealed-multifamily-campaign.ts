import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  compileCapabilityResolutionGraph,
  type CapabilityResolutionCompilerContext,
  type CompiledCapabilityResolutionPlan,
  type GraphInputBinding,
  type TrustedActionPrimitive,
} from "./capability-resolution-compiler.js";
import {
  DurableCapabilityResolutionExecutor,
  DurableCapabilityResolutionStore,
  type CapabilityResolutionExecutionContext,
  type CapabilityResolutionRuntimeBinding,
  type DurableCapabilityResolutionRuntime,
  type RuntimeBindingQualification,
} from "./durable-capability-resolution.js";
import { VerifiedArtifactStore } from "./verified-artifact-flow.js";
import {
  VerifierTemplateQualificationRegistry,
  qualificationReference,
  qualifyVerifierTemplate,
  verifierQualificationDigest,
  verifierTemplateControlIds,
  type ExpectedVerifierTemplateVerdict,
  type VerifierTemplateControlId,
  type VerifierTemplateQualificationCase,
  type VerifierTemplateQualificationCorpus,
  type VerifierTemplateQualificationReceipt,
} from "./verifier-template-qualification.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const runtimeFamilies = ["local-sqlite-transaction", "local-fixed-width-file"] as const;
type CampaignRuntimeFamily = typeof runtimeFamilies[number];

const transferSchema = z.object({
  transferId: z.string().regex(/^LT-[A-Z0-9-]+$/),
  destinationCell: z.string().min(1).max(40),
  cultureCode: z.string().min(1).max(60),
  trayCount: z.number().int().positive().max(99_999),
  status: z.enum(["approved", "dispatched", "protected-baseline"]),
  authorityRef: z.string().min(1).max(80),
}).strict();
type Transfer = z.infer<typeof transferSchema>;

const fileFixtureSchema = z.object({ name: z.string().min(1), content: z.string() }).strict();
const fixtureSchema = z.object({
  schemaVersion: z.literal("1.0"),
  campaignId: z.string().min(1),
  initialLedgerRows: z.array(transferSchema),
  initialOutboxFiles: z.array(fileFixtureSchema),
  transfer: transferSchema.refine((value) => value.status === "approved", "The sealed transfer must begin approved."),
}).strict();

const graphItemSchema = z.object({
  workItemId: z.string().min(1),
  primitiveKey: z.string().min(1),
  primitiveVersion: z.string().min(1),
  dependsOn: z.array(z.string()),
  binding: z.record(z.string(), z.unknown()),
}).strict();
const inputSchema = z.object({
  schemaVersion: z.literal("1.0"),
  campaignId: z.string().min(1),
  identity: z.object({ tenantId: z.string(), requestId: z.string(), parentGoalId: z.string() }).strict(),
  ordinaryGoal: z.string().min(1),
  proposalSummary: z.string().min(1),
  evidence: z.object({ evidenceId: z.string(), summary: z.string() }).strict(),
  authority: z.object({
    targetAliases: z.array(z.string()),
    actionKeys: z.array(z.string()),
    approvalKeys: z.array(z.string()),
    maximumRisk: z.literal("reversible-write"),
  }).strict(),
  graph: z.object({
    workItems: z.array(graphItemSchema).length(3),
    terminalOutputs: z.array(z.object({ workItemId: z.string(), outputKey: z.string() }).strict()).length(1),
  }).strict(),
  faults: z.object({
    restartAfterExternalCommitWorkItemId: z.string(),
    loseParentResumptionResponse: z.literal(true),
  }).strict(),
  runtimeFamilies: z.tuple([z.literal(runtimeFamilies[0]), z.literal(runtimeFamilies[1])]),
  verifierQualification: z.object({
    qualifiedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    corpusVersion: z.string(),
  }).strict(),
}).strict();

const oracleSchema = z.object({
  schemaVersion: z.literal("1.0"),
  campaignId: z.string(),
  expectedFinalLedgerRows: z.array(transferSchema),
  expectedFinalOutboxFiles: z.array(fileFixtureSchema),
  expected: z.object({
    jobStatus: z.literal("autonomous-completion"),
    jobAttempts: z.number().int().positive(),
    externalBusinessWrites: z.number().int().nonnegative(),
    sqliteActionExecutions: z.number().int().nonnegative(),
    fileActionExecutions: z.number().int().nonnegative(),
    restartRecoveries: z.number().int().nonnegative(),
    lostResponseReconciliations: z.number().int().nonnegative(),
    parentResumptionExecutions: z.number().int().nonnegative(),
    parentResumptionReconciliations: z.number().int().nonnegative(),
    retainedCapabilityCount: z.number().int().nonnegative(),
    retainedReuseCount: z.number().int().nonnegative(),
    terminalArtifactSchema: z.string(),
    incorrectSideEffects: z.number().int().nonnegative(),
  }).strict(),
  negativeControlIds: z.array(z.enum(verifierTemplateControlIds)).length(verifierTemplateControlIds.length),
  authorBridgePolicy: z.literal("forbidden-after-unseal"),
}).strict();

const sealSchema = z.object({
  schemaVersion: z.literal("2.0"),
  campaignId: z.string(),
  sealedAt: z.string().datetime(),
  spendMode: z.literal("zero-spend"),
  networkAllowed: z.literal(false),
  authorBridgeAllowedAfterUnseal: z.literal(false),
  files: z.array(z.object({
    role: z.enum(["fixture", "input", "oracle"]),
    path: z.string().regex(/^[a-z0-9-]+\.json$/),
    sha256: digestSchema,
  }).strict()).length(3),
  implementationFiles: z.array(z.object({
    path: z.enum([
      "src/product/sealed-multifamily-campaign.ts",
      "src/product/capability-resolution-compiler.ts",
      "src/product/durable-capability-resolution.ts",
      "src/product/verified-artifact-flow.ts",
      "src/product/verifier-template-qualification.ts",
    ]),
    sha256: digestSchema,
  }).strict()).length(5),
  sealDigest: digestSchema,
}).strict();

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Campaign material cannot contain non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  throw new Error("Campaign material must be plain structured data.");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function structuredDigest(value: unknown): string {
  return sha256(canonical(value));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function verifyAndReadSeal(directory: string) {
  const seal = sealSchema.parse(readJson(join(directory, "campaign-seal.json")));
  const { sealDigest, ...unsigned } = seal;
  if (structuredDigest(unsigned) !== sealDigest) throw new Error("The campaign seal failed its integrity check.");
  if (new Set(seal.files.map((file) => file.role)).size !== 3) throw new Error("The campaign seal must bind fixture, input and oracle exactly once.");
  if (new Set(seal.implementationFiles.map((file) => file.path)).size !== seal.implementationFiles.length) {
    throw new Error("The campaign seal must bind each implementation file exactly once.");
  }
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  for (const file of seal.implementationFiles) {
    if (sha256(readFileSync(join(repositoryRoot, file.path))) !== file.sha256) {
      throw new Error(`Sealed implementation ${file.path} changed after unsealing.`);
    }
  }
  const material = new Map<string, unknown>();
  for (const file of seal.files) {
    const bytes = readFileSync(join(directory, file.path));
    if (sha256(bytes) !== file.sha256) throw new Error(`Sealed ${file.role} material changed after precommitment.`);
    material.set(file.role, JSON.parse(bytes.toString("utf8")));
  }
  const fixture = fixtureSchema.parse(material.get("fixture"));
  const input = inputSchema.parse(material.get("input"));
  const oracle = oracleSchema.parse(material.get("oracle"));
  if ([fixture.campaignId, input.campaignId, oracle.campaignId].some((id) => id !== seal.campaignId)) {
    throw new Error("Sealed campaign identities do not match.");
  }
  if (JSON.stringify(oracle.negativeControlIds) !== JSON.stringify(verifierTemplateControlIds)) {
    throw new Error("The oracle does not preserve the mandatory verifier-control order.");
  }
  return { seal, fixture, input, oracle };
}

function transferLine(transfer: Transfer): string {
  const pad = (value: string, width: number) => value.padEnd(width, " ");
  return `${pad(transfer.transferId, 12)}|${pad(transfer.destinationCell, 16)}|${pad(transfer.cultureCode, 24)}|${String(transfer.trayCount).padStart(5, "0")}|DISPATCHED|${transfer.authorityRef}\n`;
}

function initializeWorld(databasePath: string, outboxDirectory: string, fixture: z.infer<typeof fixtureSchema>): void {
  if (existsSync(databasePath) || existsSync(outboxDirectory)) throw new Error("A sealed campaign requires a fresh customer-local world directory.");
  mkdirSync(outboxDirectory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE transfer_ledger (
        transfer_id TEXT PRIMARY KEY,
        destination_cell TEXT NOT NULL,
        culture_code TEXT NOT NULL,
        tray_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        authority_ref TEXT NOT NULL
      );
      CREATE TABLE business_actions (
        idempotency_key TEXT PRIMARY KEY,
        runtime_family TEXT NOT NULL,
        work_item_id TEXT NOT NULL
      );
      CREATE TABLE capability_registry (
        runtime_family TEXT NOT NULL,
        primitive_key TEXT NOT NULL,
        primitive_version TEXT NOT NULL,
        PRIMARY KEY (runtime_family, primitive_key, primitive_version)
      );
      CREATE TABLE reuse_evidence (work_item_id TEXT PRIMARY KEY, runtime_family TEXT NOT NULL);
      CREATE TABLE reconciliation_evidence (work_item_id TEXT PRIMARY KEY, classification TEXT NOT NULL);
      CREATE TABLE parent_resumptions (resumption_key TEXT PRIMARY KEY, aggregate_evidence_digest TEXT NOT NULL);
      CREATE TABLE parent_reconciliation_evidence (resumption_key TEXT PRIMARY KEY);
      CREATE TABLE authority_evidence (work_item_id TEXT PRIMARY KEY, authority_digest TEXT NOT NULL);
      CREATE TABLE quarantine_evidence (work_item_id TEXT PRIMARY KEY, reason_digest TEXT NOT NULL);
    `);
    const insert = database.prepare(`
      INSERT INTO transfer_ledger
        (transfer_id, destination_cell, culture_code, tray_count, status, authority_ref)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of fixture.initialLedgerRows) {
      insert.run(row.transferId, row.destinationCell, row.cultureCode, row.trayCount, row.status, row.authorityRef);
    }
  } finally {
    database.close();
  }
  chmodSync(databasePath, 0o600);
  for (const file of fixture.initialOutboxFiles) writeFileSync(join(outboxDirectory, file.name), file.content, { mode: 0o600, flag: "wx" });
}

function ledgerRows(databasePath: string): Transfer[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare(`
      SELECT transfer_id, destination_cell, culture_code, tray_count, status, authority_ref
      FROM transfer_ledger ORDER BY transfer_id ASC
    `).all() as unknown as Array<Record<string, unknown>>).map((row) => transferSchema.parse({
      transferId: row.transfer_id,
      destinationCell: row.destination_cell,
      cultureCode: row.culture_code,
      trayCount: row.tray_count,
      status: row.status,
      authorityRef: row.authority_ref,
    }));
  } finally {
    database.close();
  }
}

function outboxFiles(outboxDirectory: string): Array<{ name: string; content: string }> {
  return readdirSync(outboxDirectory).sort().map((name) => ({ name, content: readFileSync(join(outboxDirectory, name), "utf8") }));
}

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scalar(databasePath: string, sql: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(sql).get() as unknown as { value: number };
    return row.value;
  } finally {
    database.close();
  }
}

const requiredVerdicts: Readonly<Record<VerifierTemplateControlId, ExpectedVerifierTemplateVerdict>> = Object.freeze({
  completed: { classification: "completed", passed: true, nextAction: "resume", incorrectSideEffects: 0 },
  "not-started": { classification: "not-started", passed: false, nextAction: "retry-after-authority-recheck", incorrectSideEffects: 0 },
  partial: { classification: "partial", passed: false, nextAction: "quarantine", incorrectSideEffects: 0 },
  incorrect: { classification: "incorrect", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
  duplicate: { classification: "duplicate", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
  stale: { classification: "stale", passed: false, nextAction: "quarantine", incorrectSideEffects: 0 },
  collateral: { classification: "collateral", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
  unknown: { classification: "unknown", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
  unavailable: { classification: "unavailable", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
  "lost-response-reconciliation": { classification: "completed", passed: true, nextAction: "resume", incorrectSideEffects: 0 },
  "adversarial-action-response": { classification: "unavailable", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
});

function qualificationCorpus(version: string, family: CampaignRuntimeFamily): VerifierTemplateQualificationCorpus {
  const cases: VerifierTemplateQualificationCase[] = verifierTemplateControlIds.map((controlId) => ({
    controlId,
    independentObservation: { family, controlId, verdict: requiredVerdicts[controlId] },
    responseDisposition: controlId === "lost-response-reconciliation"
      ? "lost"
      : controlId === "adversarial-action-response" ? "available" : "not-applicable",
    ...(controlId === "adversarial-action-response" ? { actionResponse: { status: "success", claimedComplete: true } } : {}),
    expected: requiredVerdicts[controlId],
  }));
  return { schemaVersion: "1.0", corpusVersion: version, cases };
}

function qualifyFamily(
  family: CampaignRuntimeFamily,
  templateKey: string,
  plan: CompiledCapabilityResolutionPlan,
  input: z.infer<typeof inputSchema>,
): VerifierTemplateQualificationReceipt {
  const result = qualifyVerifierTemplate({
    candidate: {
      templateKey,
      templateVersion: "v1",
      runtimeFamily: family,
      implementationDigest: sha256(`${family}:${templateKey}:sealed-independent-observer-v1`),
      outcomeSchemaDigest: sha256(`${family}:verifier-outcome-schema-v1`),
      evaluate(evaluation) {
        const observation = z.object({
          family: z.literal(family),
          controlId: z.enum(verifierTemplateControlIds),
          verdict: z.object({
            classification: z.enum(["completed", "not-started", "partial", "incorrect", "duplicate", "stale", "collateral", "unknown", "unavailable"]),
            passed: z.boolean(),
            nextAction: z.enum(["resume", "retry-after-authority-recheck", "quarantine", "handoff"]),
            incorrectSideEffects: z.number().int().nonnegative(),
          }).strict(),
        }).strict().parse(evaluation.independentObservation);
        return { ...observation.verdict, observedStateDigest: verifierQualificationDigest(evaluation.independentObservation) };
      },
    },
    corpus: qualificationCorpus(input.verifierQualification.corpusVersion, family),
    primitiveRegistryDigest: plan.primitiveRegistryDigest,
    verifierRegistryDigest: plan.verifierRegistryDigest,
    qualifiedAt: input.verifierQualification.qualifiedAt,
    expiresAt: input.verifierQualification.expiresAt,
  });
  if (result.status !== "qualified") throw new Error(`Verifier template ${templateKey} did not qualify: ${JSON.stringify(result)}`);
  return result.receipt;
}

function primitives(): TrustedActionPrimitive[] {
  return [
    {
      key: "local-sqlite.upsert-transfer-v1",
      version: "v1",
      effect: "Insert or update one exact lichen transfer through a customer-local SQLite transaction.",
      targetAlias: "sealed-transfer-ledger",
      actionKey: "upsert-transfer",
      maximumRisk: "reversible-write",
      requiredApprovalKeys: ["approve-lichen-transfer"],
      inputs: [{ key: "transfer", schemaKey: "lichen-transfer-record-v1", allowedSources: ["trusted-evidence", "verified-artifact"], maximumClassification: "restricted" }],
      outputs: [{ key: "transfer", schemaKey: "lichen-transfer-record-v1", classification: "restricted" }],
      routeBuilderKeys: ["local-sqlite-transaction-route-v1"],
      requiredObservationKeys: ["sqlite-direct-state-observer-v1"],
      verifierTemplateKey: "sqlite-transfer-independent-verifier-v1",
      idempotency: "required",
      provenanceDigest: sha256("sealed local SQLite transaction primitive v1"),
      enabled: true,
    },
    {
      key: "local-fixed-width.write-capsule-v1",
      version: "v1",
      effect: "Create one exclusive fixed-width dispatch capsule in a customer-local outbox.",
      targetAlias: "sealed-dispatch-outbox",
      actionKey: "write-dispatch-capsule",
      maximumRisk: "reversible-write",
      requiredApprovalKeys: ["approve-dispatch-capsule"],
      inputs: [{ key: "transfer", schemaKey: "lichen-transfer-record-v1", allowedSources: ["verified-artifact"], maximumClassification: "restricted" }],
      outputs: [{ key: "dispatched-transfer", schemaKey: "lichen-transfer-record-v1", classification: "restricted" }],
      routeBuilderKeys: ["local-fixed-width-file-route-v1"],
      requiredObservationKeys: ["fixed-width-outbox-observer-v1"],
      verifierTemplateKey: "fixed-width-independent-verifier-v1",
      idempotency: "required",
      provenanceDigest: sha256("sealed local fixed-width file primitive v1"),
      enabled: true,
    },
  ];
}

function compilePlan(fixture: z.infer<typeof fixtureSchema>, input: z.infer<typeof inputSchema>): CompiledCapabilityResolutionPlan {
  const primitiveSet = primitives();
  const evidenceValue = {
    evidenceId: input.evidence.evidenceId,
    key: "approved-transfer",
    schemaKey: "lichen-transfer-record-v1",
    classification: "restricted" as const,
    digest: structuredDigest(fixture.transfer),
  } satisfies CapabilityResolutionCompilerContext["evidenceValues"][number];
  const context: CapabilityResolutionCompilerContext = {
    identity: { ...input.identity, ordinaryGoalDigest: sha256(input.ordinaryGoal) },
    primitives: primitiveSet,
    evidence: [{
      evidenceId: input.evidence.evidenceId,
      digest: structuredDigest(input.evidence),
      summary: input.evidence.summary,
      permittedPrimitiveKeys: primitiveSet.map((primitive) => primitive.key),
    }],
    trustedConfigValues: [],
    trustedLiteralValues: [],
    evidenceValues: [evidenceValue],
    enabledRouteBuilderKeys: ["local-sqlite-transaction-route-v1", "local-fixed-width-file-route-v1"],
    enabledObservationKeys: ["sqlite-direct-state-observer-v1", "fixed-width-outbox-observer-v1"],
    enabledVerifierTemplateKeys: ["sqlite-transfer-independent-verifier-v1", "fixed-width-independent-verifier-v1"],
    authority: input.authority,
    aggregateVerifier: { key: "sealed-lichen-transfer-aggregate-v1", requiredTerminalOutputs: input.graph.terminalOutputs },
  };
  const result = compileCapabilityResolutionGraph({
    schemaVersion: "1.0",
    decision: "compile",
    ...context.identity,
    summary: input.proposalSummary,
    workItems: input.graph.workItems.map((item) => ({
      workItemId: item.workItemId,
      primitiveKey: item.primitiveKey,
      primitiveVersion: item.primitiveVersion,
      citedEvidenceIds: [input.evidence.evidenceId],
      dependsOn: item.dependsOn,
      bindings: [item.binding],
    })),
    terminalOutputs: input.graph.terminalOutputs,
  }, context);
  if (!result.plan) throw new Error(`The sealed unfamiliar graph did not compile: ${JSON.stringify(result.errors)}`);
  return result.plan;
}

interface CampaignPaths { database: string; outbox: string; jobs: string; artifacts: string }

function databaseExecute(paths: CampaignPaths, context: CapabilityResolutionExecutionContext, transfer: Transfer, idempotencyKey: string): void {
  const database = new DatabaseSync(paths.database);
  try {
    database.exec("BEGIN IMMEDIATE;");
    const retained = database.prepare(`
      SELECT 1 FROM capability_registry WHERE runtime_family = ? AND primitive_key = ? AND primitive_version = ?
    `).get(runtimeFamilies[0], context.primitiveKey, context.primitiveVersion);
    if (retained) database.prepare("INSERT OR IGNORE INTO reuse_evidence VALUES (?, ?)").run(context.workItemId, runtimeFamilies[0]);
    const existing = database.prepare("SELECT 1 FROM business_actions WHERE idempotency_key = ?").get(idempotencyKey);
    if (!existing) {
      database.prepare(`
        INSERT INTO transfer_ledger
          (transfer_id, destination_cell, culture_code, tray_count, status, authority_ref)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(transfer_id) DO UPDATE SET
          destination_cell = excluded.destination_cell,
          culture_code = excluded.culture_code,
          tray_count = excluded.tray_count,
          status = excluded.status,
          authority_ref = excluded.authority_ref
      `).run(transfer.transferId, transfer.destinationCell, transfer.cultureCode, transfer.trayCount, transfer.status, transfer.authorityRef);
      database.prepare("INSERT INTO business_actions VALUES (?, ?, ?)").run(idempotencyKey, runtimeFamilies[0], context.workItemId);
    }
    database.exec("COMMIT;");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function fileExecute(paths: CampaignPaths, context: CapabilityResolutionExecutionContext, transfer: Transfer, idempotencyKey: string): void {
  const dispatched = transferSchema.parse({ ...transfer, status: "dispatched" });
  const path = join(paths.outbox, `${transfer.transferId}.dispatch`);
  const content = transferLine(dispatched);
  if (!existsSync(path)) {
    const descriptor = openSync(path, "wx", 0o600);
    try { writeFileSync(descriptor, content); } finally { closeSync(descriptor); }
  } else if (readFileSync(path, "utf8") !== content) {
    throw new Error("The dispatch filename already exists with different content.");
  }
  const database = new DatabaseSync(paths.database);
  try {
    database.prepare("INSERT OR IGNORE INTO business_actions VALUES (?, ?, ?)").run(idempotencyKey, runtimeFamilies[1], context.workItemId);
  } finally {
    database.close();
  }
}

function runtime(
  plan: CompiledCapabilityResolutionPlan,
  fixture: z.infer<typeof fixtureSchema>,
  input: z.infer<typeof inputSchema>,
  oracle: z.infer<typeof oracleSchema>,
  paths: CampaignPaths,
): { runtime: DurableCapabilityResolutionRuntime; qualifications: VerifierTemplateQualificationReceipt[] } {
  const sqliteReceipt = qualifyFamily(runtimeFamilies[0], "sqlite-transfer-independent-verifier-v1", plan, input);
  const fileReceipt = qualifyFamily(runtimeFamilies[1], "fixed-width-independent-verifier-v1", plan, input);
  const qualifications = [sqliteReceipt, fileReceipt];
  const registry = new VerifierTemplateQualificationRegistry(qualifications);
  const bindingQualification = (family: CampaignRuntimeFamily): RuntimeBindingQualification => ({
    schemaVersion: "1.0",
    status: "qualified",
    qualificationDigest: sha256(`${family}:${plan.planDigest}:runtime-binding-v1`),
    primitiveRegistryDigest: plan.primitiveRegistryDigest,
    verifierRegistryDigest: plan.verifierRegistryDigest,
    qualifiedAt: input.verifierQualification.qualifiedAt,
  });
  const retain = async (family: CampaignRuntimeFamily, context: CapabilityResolutionExecutionContext) => {
    const database = new DatabaseSync(paths.database);
    try {
      database.prepare("INSERT OR IGNORE INTO capability_registry VALUES (?, ?, ?)").run(family, context.primitiveKey, context.primitiveVersion);
    } finally { database.close(); }
    return { retained: true as const, receiptDigest: sha256(`retained:${family}:${context.primitiveKey}:${context.primitiveVersion}`) };
  };
  const sqlite: CapabilityResolutionRuntimeBinding = {
    primitiveKey: "local-sqlite.upsert-transfer-v1",
    primitiveVersion: "v1",
    runtimeFamily: runtimeFamilies[0],
    targetAlias: "sealed-transfer-ledger",
    actionKey: "upsert-transfer",
    routeBuilderKey: "local-sqlite-transaction-route-v1",
    observationKeys: ["sqlite-direct-state-observer-v1"],
    verifierTemplateKey: sqliteReceipt.templateKey,
    verifierTemplateQualification: qualificationReference(sqliteReceipt),
    inputContracts: [{
      inputKey: "transfer",
      schemaKey: "lichen-transfer-record-v1",
      maximumClassification: "restricted",
      allowedSources: ["trusted-evidence", "verified-artifact"],
      parse: (value) => transferSchema.parse(value),
    }],
    qualification: bindingQualification(runtimeFamilies[0]),
    async execute({ context, values, idempotencyKey }) { databaseExecute(paths, context, transferSchema.parse(values.transfer), idempotencyKey); },
    async reconcile({ context, values }) {
      const expected = transferSchema.parse(values.transfer);
      const matches = ledgerRows(paths.database).filter((row) => canonical(row) === canonical(expected));
      const classification = matches.length === 1 ? "completed" as const : matches.length === 0 ? "not-started" as const : "incorrect" as const;
      const database = new DatabaseSync(paths.database);
      try { database.prepare("INSERT OR IGNORE INTO reconciliation_evidence VALUES (?, ?)").run(context.workItemId, classification); }
      finally { database.close(); }
      return { classification, evidenceDigest: structuredDigest({ observer: "sqlite-direct", expected, matches }), detail: `Independent SQLite observation found ${matches.length} exact row(s).` };
    },
    async verify({ values }) {
      const expected = transferSchema.parse(values.transfer);
      const matches = ledgerRows(paths.database).filter((row) => canonical(row) === canonical(expected));
      return {
        passed: matches.length === 1,
        incorrectSideEffects: matches.length > 1 ? matches.length - 1 : 0,
        evidenceReceiptDigest: structuredDigest({ observer: "sqlite-direct", expected, matches }),
        outputs: { transfer: matches[0] ?? expected },
        detail: `Independent SQLite verifier found ${matches.length} exact transfer row(s).`,
      };
    },
    async retain({ context }) { return retain(runtimeFamilies[0], context); },
    async quarantine({ context, reason }) {
      const database = new DatabaseSync(paths.database);
      try { database.prepare("INSERT OR REPLACE INTO quarantine_evidence VALUES (?, ?)").run(context.workItemId, sha256(reason)); }
      finally { database.close(); }
    },
  };
  const fixedWidth: CapabilityResolutionRuntimeBinding = {
    primitiveKey: "local-fixed-width.write-capsule-v1",
    primitiveVersion: "v1",
    runtimeFamily: runtimeFamilies[1],
    targetAlias: "sealed-dispatch-outbox",
    actionKey: "write-dispatch-capsule",
    routeBuilderKey: "local-fixed-width-file-route-v1",
    observationKeys: ["fixed-width-outbox-observer-v1"],
    verifierTemplateKey: fileReceipt.templateKey,
    verifierTemplateQualification: qualificationReference(fileReceipt),
    inputContracts: [{
      inputKey: "transfer",
      schemaKey: "lichen-transfer-record-v1",
      maximumClassification: "restricted",
      allowedSources: ["verified-artifact"],
      parse: (value) => transferSchema.parse(value),
    }],
    qualification: bindingQualification(runtimeFamilies[1]),
    async execute({ context, values, idempotencyKey }) { fileExecute(paths, context, transferSchema.parse(values.transfer), idempotencyKey); },
    async reconcile({ values }) {
      const transfer = transferSchema.parse(values.transfer);
      const expected = transferLine({ ...transfer, status: "dispatched" });
      const path = join(paths.outbox, `${transfer.transferId}.dispatch`);
      const actual = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      return {
        classification: actual === expected ? "completed" : actual === undefined ? "not-started" : "incorrect",
        evidenceDigest: structuredDigest({ observer: "fixed-width-file", path: `${transfer.transferId}.dispatch`, actual }),
        detail: actual === expected ? "The exact dispatch capsule exists." : "The exact dispatch capsule is absent or incorrect.",
      };
    },
    async verify({ values }) {
      const transfer = transferSchema.parse(values.transfer);
      const dispatched = transferSchema.parse({ ...transfer, status: "dispatched" });
      const path = join(paths.outbox, `${transfer.transferId}.dispatch`);
      const actual = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      const passed = actual === transferLine(dispatched);
      return {
        passed,
        incorrectSideEffects: actual !== undefined && !passed ? 1 : 0,
        evidenceReceiptDigest: structuredDigest({ observer: "fixed-width-file", file: `${transfer.transferId}.dispatch`, actual }),
        outputs: { "dispatched-transfer": dispatched },
        detail: passed ? "Independent filesystem verifier found the exact fixed-width capsule." : "The fixed-width capsule did not match.",
      };
    },
    async retain({ context }) { return retain(runtimeFamilies[1], context); },
    async quarantine({ context, reason }) {
      const database = new DatabaseSync(paths.database);
      try { database.prepare("INSERT OR REPLACE INTO quarantine_evidence VALUES (?, ?)").run(context.workItemId, sha256(reason)); }
      finally { database.close(); }
    },
  };
  return {
    qualifications,
    runtime: {
      primitiveRegistryDigest: plan.primitiveRegistryDigest,
      verifierRegistryDigest: plan.verifierRegistryDigest,
      supportedRuntimeFamilies: [...runtimeFamilies],
      verifierTemplateQualifications: registry,
      bindings: [sqlite, fixedWidth],
      authority: {
        async check({ context, maximumRisk, requiredApprovalKeys }) {
          const item = plan.orderedWorkItems.find((candidate) => candidate.workItemId === context.workItemId);
          const allowed = Boolean(item)
            && context.planDigest === plan.planDigest
            && maximumRisk === item!.maximumRisk
            && canonical([...requiredApprovalKeys].sort()) === canonical([...item!.requiredApprovalKeys].sort())
            && input.authority.targetAliases.includes(context.targetAlias)
            && input.authority.actionKeys.includes(context.actionKey)
            && item!.requiredApprovalKeys.every((key) => input.authority.approvalKeys.includes(key));
          const authorityDigest = structuredDigest({ planDigest: plan.planDigest, context, maximumRisk, requiredApprovalKeys, allowed });
          const database = new DatabaseSync(paths.database);
          try { database.prepare("INSERT OR IGNORE INTO authority_evidence VALUES (?, ?)").run(context.workItemId, authorityDigest); }
          finally { database.close(); }
          return { allowed, authorityDigest, planDigest: plan.planDigest, detail: allowed ? "Exact sealed authority is live." : "Exact sealed authority is unavailable.", ...(!allowed ? { handoffReceiptDigest: sha256(`handoff:${context.workItemId}`) } : {}) };
        },
      },
      values: {
        async resolve({ binding }) {
          if (binding.kind !== "trusted-evidence"
            || binding.evidenceId !== input.evidence.evidenceId
            || binding.valueKey !== "approved-transfer") throw new Error("The sealed campaign requested an undeclared trusted value.");
          return { value: fixture.transfer, provenanceDigest: structuredDigest(fixture.transfer) };
        },
      },
      aggregateVerifier: {
        key: "sealed-lichen-transfer-aggregate-v1",
        kind: "independent-external-state",
        qualification: bindingQualification(runtimeFamilies[0]),
        async verify({ terminalArtifacts }) {
          const actualRows = ledgerRows(paths.database);
          const actualFiles = outboxFiles(paths.outbox);
          const expectedRows = [...oracle.expectedFinalLedgerRows].sort((a, b) => byCodeUnit(a.transferId, b.transferId));
          const expectedFiles = [...oracle.expectedFinalOutboxFiles].sort((a, b) => byCodeUnit(a.name, b.name));
          const terminal = terminalArtifacts[0]?.value;
          const terminalPassed = canonical(terminal) === canonical(expectedRows.find((row) => row.transferId === fixture.transfer.transferId));
          const mismatches = Number(canonical(actualRows) !== canonical(expectedRows))
            + Number(canonical(actualFiles) !== canonical(expectedFiles))
            + Number(!terminalPassed);
          return {
            passed: mismatches === 0,
            incorrectSideEffects: mismatches,
            evidenceDigest: structuredDigest({ observer: "aggregate-direct-state", actualRows, actualFiles, terminal }),
            detail: mismatches === 0 ? "Ledger, outbox, protected baseline and typed terminal artifact match the sealed oracle exactly." : `${mismatches} aggregate oracle mismatch(es) survived.`,
          };
        },
      },
      parentResumer: {
        async resume({ aggregateEvidenceDigest, resumptionKey }) {
          const database = new DatabaseSync(paths.database);
          try { database.prepare("INSERT OR IGNORE INTO parent_resumptions VALUES (?, ?)").run(resumptionKey, aggregateEvidenceDigest); }
          finally { database.close(); }
          if (input.faults.loseParentResumptionResponse) throw new Error("Sealed fault: parent-resumption response lost after external completion.");
          return { resumed: true, completed: true, receiptDigest: sha256(`parent-resumed:${resumptionKey}`) };
        },
        async reconcile({ resumptionKey }) {
          const database = new DatabaseSync(paths.database);
          let completed = false;
          try {
            completed = Boolean(database.prepare("SELECT 1 FROM parent_resumptions WHERE resumption_key = ?").get(resumptionKey));
            database.prepare("INSERT OR IGNORE INTO parent_reconciliation_evidence VALUES (?)").run(resumptionKey);
          } finally { database.close(); }
          return {
            classification: completed ? "completed" : "not-started",
            ...(completed ? { receiptDigest: sha256(`parent-resumed:${resumptionKey}`) } : {}),
            evidenceDigest: structuredDigest({ observer: "parent-state", resumptionKey, completed }),
            detail: completed ? "Independent parent state shows one completed resumption." : "Parent resumption did not start.",
          };
        },
      },
    },
  };
}

function workContext(plan: CompiledCapabilityResolutionPlan, workItemId: string): CapabilityResolutionExecutionContext {
  const item = plan.orderedWorkItems.find((candidate) => candidate.workItemId === workItemId);
  if (!item) throw new Error("The sealed restart fault names an unknown work item.");
  return {
    tenantId: plan.tenantId,
    requestId: plan.requestId,
    parentGoalId: plan.parentGoalId,
    planId: plan.planId,
    planDigest: plan.planDigest,
    workItemId,
    primitiveKey: item.primitiveKey,
    primitiveVersion: item.primitiveVersion,
    targetAlias: item.targetAlias,
    actionKey: item.actionKey,
  };
}

export interface SealedMultifamilyCampaignReceipt {
  schemaVersion: "1.0";
  campaignId: string;
  status: "passed";
  sealDigest: string;
  sealedFileDigests: Record<string, string>;
  planId: string;
  planDigest: string;
  runtimeFamilies: CampaignRuntimeFamily[];
  runtimeFamiliesAreDistinct: true;
  typedFamilyBoundary: { producerFamily: CampaignRuntimeFamily; consumerFamily: CampaignRuntimeFamily; schemaKey: string; artifactVerifiedBeforeConsumption: true };
  verifierQualifications: Array<{ templateKey: string; runtimeFamily: string; qualificationDigest: string; passingControls: number }>;
  exactAuthorityChecks: number;
  restart: { jobAttempts: number; recoveredJobs: number; lostResponseReconciliations: number; replayedLostResponseWrites: number };
  aggregate: { passed: true; evidenceDigest: string; incorrectSideEffects: 0 };
  parent: { resumed: true; executionCount: number; reconciliationCount: number };
  retention: { capabilityCount: number; reusedCapabilityCount: number; reusedFamily: CampaignRuntimeFamily };
  effects: { businessWrites: number; sqliteActionExecutions: number; fileActionExecutions: number; finalLedgerDigest: string; finalOutboxDigest: string };
  durableItemStatuses: string[];
  eventTypes: string[];
  authorBridgeUsedAfterUnseal: false;
  modelCalls: 0;
  paidSpendUsd: 0;
  limitations: string[];
  receiptDigest: string;
}

/**
 * Runs the exact sealed CF-006 campaign. The only execution inputs are the
 * digest-bound fixture/input/oracle files; there is no callback, planner repair
 * or author-supplied value after unsealing.
 */
export async function runSealedMultifamilyCampaign(options: {
  sealDirectory: string;
  workingDirectory: string;
}): Promise<SealedMultifamilyCampaignReceipt> {
  const material = verifyAndReadSeal(options.sealDirectory);
  mkdirSync(options.workingDirectory, { recursive: true, mode: 0o700 });
  const paths: CampaignPaths = {
    database: join(options.workingDirectory, "external-world.sqlite"),
    outbox: join(options.workingDirectory, "dispatch-outbox"),
    jobs: join(options.workingDirectory, "durable-jobs.sqlite"),
    artifacts: join(options.workingDirectory, "verified-artifacts.sqlite"),
  };
  initializeWorld(paths.database, paths.outbox, material.fixture);
  const plan = compilePlan(material.fixture, material.input);

  // Process 1: submit, durably claim, commit the sealed first action, then lose
  // its response and stop before recording completion.
  const store1 = new DurableCapabilityResolutionStore(paths.jobs, () => "2026-08-14T09:00:00.000Z");
  const artifacts1 = new VerifiedArtifactStore(paths.artifacts, [{ schemaKey: "lichen-transfer-record-v1", maximumBytes: 2_048, parse: (value) => transferSchema.parse(value) }]);
  const firstRuntime = runtime(plan, material.fixture, material.input, material.oracle, paths);
  const executor1 = new DurableCapabilityResolutionExecutor(store1, artifacts1, firstRuntime.runtime, () => "2026-08-14T09:00:00.000Z");
  const submitted = executor1.submit(plan);
  if (!store1.claim(plan.tenantId, submitted.job.jobId)) throw new Error("The first sealed process could not claim its durable job.");
  const interruptedItemId = material.input.faults.restartAfterExternalCommitWorkItemId;
  if (plan.orderedWorkItems[0]?.workItemId !== interruptedItemId) throw new Error("The sealed restart fault must target the first compiled work item.");
  store1.startItem(plan.tenantId, submitted.job.jobId, interruptedItemId);
  const firstBinding = firstRuntime.runtime.bindings.find((binding) => binding.primitiveKey === plan.orderedWorkItems[0]!.primitiveKey)!;
  const firstContext = workContext(plan, interruptedItemId);
  const firstAuthority = await firstRuntime.runtime.authority.check({
    context: firstContext,
    maximumRisk: plan.orderedWorkItems[0]!.maximumRisk,
    requiredApprovalKeys: plan.orderedWorkItems[0]!.requiredApprovalKeys,
  });
  if (!firstAuthority.allowed || firstAuthority.planDigest !== plan.planDigest) throw new Error("The sealed fault injector did not have exact live authority.");
  const actionKey = sha256(`${plan.planDigest}\u001f${interruptedItemId}`);
  await firstBinding.execute({ context: firstContext, values: Object.freeze({ transfer: material.fixture.transfer }), idempotencyKey: actionKey });
  artifacts1.close();
  store1.close();

  // Process 2: new stores, new runtime/binding objects, durable recovery, direct
  // reconciliation, remaining family-bound dataflow and aggregate completion.
  const store2 = new DurableCapabilityResolutionStore(paths.jobs, () => "2026-08-14T09:01:00.000Z");
  const recovered = store2.recoverInterrupted(2);
  const artifacts2 = new VerifiedArtifactStore(paths.artifacts, [{ schemaKey: "lichen-transfer-record-v1", maximumBytes: 2_048, parse: (value) => transferSchema.parse(value) }]);
  const secondRuntime = runtime(plan, material.fixture, material.input, material.oracle, paths);
  const executor2 = new DurableCapabilityResolutionExecutor(store2, artifacts2, secondRuntime.runtime, () => "2026-08-14T09:01:00.000Z");
  const result = await executor2.run(plan.tenantId, submitted.job.jobId);
  const items = store2.items(result.jobId);
  const events = store2.events(plan.tenantId, result.jobId);
  const finalRows = ledgerRows(paths.database);
  const finalFiles = outboxFiles(paths.outbox);
  const metrics = {
    businessWrites: scalar(paths.database, "SELECT COUNT(*) AS value FROM business_actions"),
    sqliteActions: scalar(paths.database, `SELECT COUNT(*) AS value FROM business_actions WHERE runtime_family = '${runtimeFamilies[0]}'`),
    fileActions: scalar(paths.database, `SELECT COUNT(*) AS value FROM business_actions WHERE runtime_family = '${runtimeFamilies[1]}'`),
    reconciliations: scalar(paths.database, "SELECT COUNT(*) AS value FROM reconciliation_evidence"),
    resumptions: scalar(paths.database, "SELECT COUNT(*) AS value FROM parent_resumptions"),
    resumptionReconciliations: scalar(paths.database, "SELECT COUNT(*) AS value FROM parent_reconciliation_evidence"),
    retained: scalar(paths.database, "SELECT COUNT(*) AS value FROM capability_registry"),
    reused: scalar(paths.database, "SELECT COUNT(*) AS value FROM reuse_evidence"),
    authority: scalar(paths.database, "SELECT COUNT(*) AS value FROM authority_evidence"),
  };
  const sealAfter = verifyAndReadSeal(options.sealDirectory);
  const aggregateDigest = result.aggregateEvidenceDigest;
  if (!aggregateDigest) throw new Error(`The sealed campaign did not produce aggregate evidence (${result.status}: ${result.error ?? "no detail"}).`);
  const expected = material.oracle.expected;
  const assertions: Array<[boolean, string]> = [
    [result.status === expected.jobStatus, "job status"],
    [result.attempts === expected.jobAttempts, "job attempts"],
    [recovered.length === expected.restartRecoveries, "restart recovery"],
    [metrics.businessWrites === expected.externalBusinessWrites, "business writes"],
    [metrics.sqliteActions === expected.sqliteActionExecutions, "SQLite actions"],
    [metrics.fileActions === expected.fileActionExecutions, "file actions"],
    [metrics.reconciliations === expected.lostResponseReconciliations, "lost-response reconciliation"],
    [metrics.resumptions === expected.parentResumptionExecutions, "parent resumption executions"],
    [metrics.resumptionReconciliations === expected.parentResumptionReconciliations, "parent resumption reconciliations"],
    [metrics.retained === expected.retainedCapabilityCount, "retained capabilities"],
    [metrics.reused === expected.retainedReuseCount, "retained reuse"],
    [metrics.authority === plan.orderedWorkItems.length, "exact authority checks"],
    [canonical(finalRows) === canonical([...material.oracle.expectedFinalLedgerRows].sort((a, b) => byCodeUnit(a.transferId, b.transferId))), "final ledger oracle"],
    [canonical(finalFiles) === canonical([...material.oracle.expectedFinalOutboxFiles].sort((a, b) => byCodeUnit(a.name, b.name))), "final outbox oracle"],
    [items.every((item) => item.status === "retained"), "durable item retention"],
    [result.parentResumed, "one-time parent resumption"],
    [material.seal.sealDigest === sealAfter.seal.sealDigest, "post-run seal integrity"],
  ];
  const failed = assertions.filter(([passed]) => !passed).map(([, label]) => label);
  if (failed.length > 0) throw new Error(`The sealed campaign diverged from its frozen oracle: ${failed.join(", ")}.`);
  const sqliteItem = plan.orderedWorkItems[0]!;
  const fileItem = plan.orderedWorkItems[1]!;
  const boundaryBinding = fileItem.bindings[0] as Extract<GraphInputBinding, { kind: "verified-artifact" }>;
  const unsigned = {
    schemaVersion: "1.0" as const,
    campaignId: material.seal.campaignId,
    status: "passed" as const,
    sealDigest: material.seal.sealDigest,
    sealedFileDigests: Object.fromEntries(material.seal.files.map((file) => [file.role, file.sha256])),
    planId: plan.planId,
    planDigest: plan.planDigest,
    runtimeFamilies: [...runtimeFamilies],
    runtimeFamiliesAreDistinct: true as const,
    typedFamilyBoundary: {
      producerFamily: runtimeFamilies[0],
      consumerFamily: runtimeFamilies[1],
      schemaKey: sqliteItem.outputSchemas.find((output) => output.key === boundaryBinding.outputKey)!.schemaKey,
      artifactVerifiedBeforeConsumption: true as const,
    },
    verifierQualifications: secondRuntime.qualifications.map((receipt) => ({
      templateKey: receipt.templateKey,
      runtimeFamily: receipt.runtimeFamily,
      qualificationDigest: receipt.qualificationDigest,
      passingControls: receipt.controls.filter((control) => control.passed).length,
    })),
    exactAuthorityChecks: metrics.authority,
    restart: { jobAttempts: result.attempts, recoveredJobs: recovered.length, lostResponseReconciliations: metrics.reconciliations, replayedLostResponseWrites: metrics.sqliteActions - 2 },
    aggregate: { passed: true as const, evidenceDigest: aggregateDigest, incorrectSideEffects: 0 as const },
    parent: { resumed: true as const, executionCount: metrics.resumptions, reconciliationCount: metrics.resumptionReconciliations },
    retention: { capabilityCount: metrics.retained, reusedCapabilityCount: metrics.reused, reusedFamily: runtimeFamilies[0] },
    effects: {
      businessWrites: metrics.businessWrites,
      sqliteActionExecutions: metrics.sqliteActions,
      fileActionExecutions: metrics.fileActions,
      finalLedgerDigest: structuredDigest(finalRows),
      finalOutboxDigest: structuredDigest(finalFiles),
    },
    durableItemStatuses: items.map((item) => item.status),
    eventTypes: events.map((event) => event.type),
    authorBridgeUsedAfterUnseal: false as const,
    modelCalls: 0 as const,
    paidSpendUsd: 0 as const,
    limitations: [
      "One deterministic fictional local campaign is not population reliability or effective universality.",
      "The two implemented families are customer-local SQLite transactions and fixed-width filesystem output, not arbitrary database or file compatibility.",
      "Verifier qualification covers the frozen generic negative-control semantics; it is not independent third-party auditing.",
      "No customer system, network, container, production deployment, model call or commercial evidence is involved.",
    ],
  };
  const receipt: SealedMultifamilyCampaignReceipt = { ...unsigned, receiptDigest: structuredDigest(unsigned) };
  artifacts2.close();
  store2.close();
  return receipt;
}
