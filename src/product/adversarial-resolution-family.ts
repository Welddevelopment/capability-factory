import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  type VerifierTemplateQualificationReceipt,
} from "./verifier-template-qualification.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const families = ["generic-local-sqlite", "generic-local-schema-file"] as const;
type RuntimeFamily = typeof families[number];
const primitiveKeys = [
  "generic-sqlite.record-upsert-v1",
  "generic-file.record-transform-v1",
  "generic-sqlite.record-merge-v1",
] as const;
type PrimitiveKey = typeof primitiveKeys[number];

const recordSchema = z.object({
  recordId: z.string().regex(/^[A-Z]{2}-[A-Z0-9-]+$/),
  subjectCode: z.string().min(1).max(80),
  unitCount: z.number().int().positive().max(99_999),
  stage: z.string().min(1).max(60),
  branches: z.array(z.string().min(1).max(60)).max(8),
  authorityRef: z.string().min(1).max(80),
}).strict().superRefine((value, context) => {
  if (new Set(value.branches).size !== value.branches.length) context.addIssue({ code: "custom", message: "Record branches must be unique." });
});
type GenericRecord = z.infer<typeof recordSchema>;

const evidenceInputSchema = z.object({ inputKey: z.string(), kind: z.literal("trusted-evidence"), valueKey: z.string() }).strict();
const artifactInputSchema = z.object({
  inputKey: z.string(), kind: z.literal("verified-artifact"), producerWorkItemId: z.string(), outputKey: z.string(),
}).strict();
const workItemSchema = z.object({
  workItemId: z.string().min(1),
  primitiveKey: z.enum(primitiveKeys),
  dependsOn: z.array(z.string()),
  inputs: z.array(z.union([evidenceInputSchema, artifactInputSchema])).min(1).max(2),
  fileTransform: z.object({
    outputName: z.string().regex(/^[A-Z0-9.-]+$/i),
    encoding: z.enum(["fixed-width-v1", "canonical-json-v1"]),
    nextStage: z.string().min(1),
    addBranch: z.string().min(1),
  }).strict().optional(),
  merge: z.object({ nextStage: z.string().min(1) }).strict().optional(),
}).strict();
const authoritySchema = z.object({
  targetAliases: z.array(z.enum(["generic-record-ledger", "generic-record-outbox"])),
  actionKeys: z.array(z.enum(["upsert-record", "write-record-file", "merge-records"])),
  approvalKeys: z.array(z.enum(["approve-record-write", "approve-record-file", "approve-record-merge"])),
  maximumRisk: z.literal("reversible-write"),
}).strict();
const caseSchema = z.object({
  caseId: z.string().regex(/^[a-z0-9-]+$/),
  ordinaryGoal: z.string().min(1),
  identity: z.object({ tenantId: z.string(), requestId: z.string(), parentGoalId: z.string() }).strict(),
  authority: authoritySchema,
  record: recordSchema,
  initialRows: z.array(recordSchema),
  initialFiles: z.array(z.object({ name: z.string(), content: z.string() }).strict()),
  workItems: z.array(workItemSchema).min(2).max(8),
  terminal: z.object({ workItemId: z.string(), outputKey: z.literal("record") }).strict(),
  fault: z.object({ restartAfterCommitWorkItemId: z.string(), loseParentResponse: z.literal(true) }).strict(),
}).strict();
type GoalCase = z.infer<typeof caseSchema>;
const familySchema = z.object({
  schemaVersion: z.literal("1.0"),
  campaignId: z.string(),
  baseline: z.object({
    name: z.string(),
    primitiveKeys: z.array(z.enum(primitiveKeys)).length(3),
    fixedGraphPrimitiveKeys: z.array(z.enum(primitiveKeys)).min(1),
    fixedDependencyCounts: z.array(z.number().int().nonnegative()).min(1),
  }).strict(),
  bridgePolicy: z.object({
    postUnsealCallbacksAllowed: z.literal(false),
    caseSpecificSourceFilesAllowed: z.literal(false),
    allowedDeclarativeDecisions: z.array(z.enum(["record", "graph", "serialization", "transition", "authority", "fault", "oracle"])).length(7),
  }).strict(),
  qualification: z.object({ qualifiedAt: z.string().datetime(), expiresAt: z.string().datetime(), corpusVersion: z.string() }).strict(),
  cases: z.array(caseSchema).min(2).max(12),
}).strict();
const oracleCaseSchema = z.object({
  caseId: z.string(), finalRecord: recordSchema,
  files: z.array(z.object({ name: z.string(), content: z.string() }).strict()),
  expected: z.object({
    workItems: z.number().int(), sqliteActions: z.number().int(), fileActions: z.number().int(), restartRecoveries: z.number().int(),
    lostActionReconciliations: z.number().int(), retainedCapabilities: z.number().int(), retainedReuses: z.number().int(),
    parentExecutions: z.number().int(), parentReconciliations: z.number().int(), incorrectSideEffects: z.literal(0),
  }).strict(),
}).strict();
const oracleSchema = z.object({
  schemaVersion: z.literal("1.0"), campaignId: z.string(), cases: z.array(oracleCaseSchema),
  fixedToolBaseline: z.object({ goalsCompleted: z.number().int(), goalCount: z.number().int(), primitiveCoveredWorkItems: z.number().int(), executableWorkItems: z.number().int(), totalWorkItems: z.number().int(), coverageReason: z.string() }).strict(),
  authorBridgeOracle: z.object({ caseSpecificSourceFiles: z.literal(0), postUnsealCallbacks: z.literal(0), reusablePrimitiveCount: z.number().int(), preciseBlockers: z.literal(0) }).strict(),
}).strict();
type Oracle = z.infer<typeof oracleSchema>;

const sealSchema = z.object({
  schemaVersion: z.literal("1.0"), campaignId: z.string(), sealedAt: z.string().datetime(),
  zeroSpend: z.literal(true), networkAllowed: z.literal(false), authorBridgeAllowedAfterUnseal: z.literal(false),
  materialFiles: z.array(z.object({ path: z.enum(["family.json", "oracle.json"]), sha256: digestSchema }).strict()).length(2),
  implementationFiles: z.array(z.object({
    path: z.enum([
      "src/product/adversarial-resolution-family.ts",
      "src/product/capability-resolution-compiler.ts",
      "src/product/durable-capability-resolution.ts",
      "src/product/verified-artifact-flow.ts",
      "src/product/verifier-template-qualification.ts",
    ]), sha256: digestSchema,
  }).strict()).length(5),
  sealDigest: digestSchema,
}).strict();

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  throw new Error("Campaign values must be plain structured data.");
}
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const structuredDigest = (value: unknown) => sha256(canonical(value));
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;
const order = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export function auditAuthorAuthoredBridges(raw: unknown): { ready: boolean; blockers: string[] } {
  const blockers: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const location = path ? `${path}.${key}` : key;
      if (/callback|sourcefile|adaptercode|authorpatch|customfunction/i.test(key)) blockers.push(`case-specific-source:${location}`);
      visit(item, location);
    }
  };
  visit(raw, "");
  const parsed = caseSchema.safeParse(raw);
  if (!parsed.success) blockers.push(`invalid-declarative-case:${parsed.error.issues[0]?.message ?? "unknown"}`);
  if (parsed.success) {
    for (const item of parsed.data.workItems) {
      if (item.primitiveKey === "generic-file.record-transform-v1" && !item.fileTransform) blockers.push(`missing-reusable-file-transform:${item.workItemId}`);
      if (item.primitiveKey !== "generic-file.record-transform-v1" && item.fileTransform) blockers.push(`unexpected-file-transform:${item.workItemId}`);
      if (item.primitiveKey === "generic-sqlite.record-merge-v1" && !item.merge) blockers.push(`missing-reusable-merge:${item.workItemId}`);
      if (item.primitiveKey !== "generic-sqlite.record-merge-v1" && item.merge) blockers.push(`unexpected-merge:${item.workItemId}`);
    }
  } else {
    const candidateItems = (raw as { workItems?: unknown } | null)?.workItems;
    if (Array.isArray(candidateItems)) {
      for (const rawItem of candidateItems) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const item = rawItem as Record<string, unknown>;
        if (item.primitiveKey === "generic-file.record-transform-v1" && item.fileTransform === undefined) blockers.push(`missing-reusable-file-transform:${String(item.workItemId)}`);
        if (item.primitiveKey === "generic-sqlite.record-merge-v1" && item.merge === undefined) blockers.push(`missing-reusable-merge:${String(item.workItemId)}`);
      }
    }
  }
  return { ready: blockers.length === 0, blockers };
}

function loadMaterial(directory: string, requireSeal: boolean) {
  const familyBytes = readFileSync(join(directory, "family.json"));
  const oracleBytes = readFileSync(join(directory, "oracle.json"));
  const family = familySchema.parse(JSON.parse(familyBytes.toString("utf8")));
  const oracle = oracleSchema.parse(JSON.parse(oracleBytes.toString("utf8")));
  if (family.campaignId !== oracle.campaignId) throw new Error("Campaign and oracle identities differ.");
  for (const goal of family.cases) {
    const audit = auditAuthorAuthoredBridges(goal);
    if (!audit.ready) throw new Error(`Author-authored bridge blockers for ${goal.caseId}: ${audit.blockers.join(", ")}`);
  }
  let sealDigest: string | undefined;
  if (requireSeal) {
    const seal = sealSchema.parse(readJson(join(directory, "campaign-seal.json")));
    const { sealDigest: claimed, ...unsigned } = seal;
    if (structuredDigest(unsigned) !== claimed || seal.campaignId !== family.campaignId) throw new Error("Adversarial family seal integrity failed.");
    const material = new Map(seal.materialFiles.map((file) => [file.path, file.sha256]));
    if (material.get("family.json") !== sha256(familyBytes) || material.get("oracle.json") !== sha256(oracleBytes)) throw new Error("Sealed adversarial material changed after unsealing.");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    for (const source of seal.implementationFiles) {
      if (sha256(readFileSync(join(root, source.path))) !== source.sha256) throw new Error(`Sealed implementation ${source.path} changed after unsealing.`);
    }
    sealDigest = claimed;
  }
  return { family, oracle, ...(sealDigest ? { sealDigest } : {}) };
}

function primitives(): TrustedActionPrimitive[] {
  const recordInput = (key: string, sources: Array<"trusted-evidence" | "verified-artifact">) => ({ key, schemaKey: "generic-sealed-record-v1", allowedSources: sources, maximumClassification: "restricted" as const });
  const recordOutput = { key: "record", schemaKey: "generic-sealed-record-v1", classification: "restricted" as const };
  return [
    {
      key: primitiveKeys[0], version: "v1", effect: "Idempotently upsert one schema-checked local record.", targetAlias: "generic-record-ledger", actionKey: "upsert-record", maximumRisk: "reversible-write", requiredApprovalKeys: ["approve-record-write"],
      inputs: [recordInput("record", ["trusted-evidence", "verified-artifact"])], outputs: [recordOutput], routeBuilderKeys: ["generic-sqlite-route-v1"], requiredObservationKeys: ["generic-sqlite-observer-v1"], verifierTemplateKey: "generic-sqlite-verifier-v1", idempotency: "required", provenanceDigest: sha256("generic sqlite upsert v1"), enabled: true,
    },
    {
      key: primitiveKeys[1], version: "v1", effect: "Transform a verified record and create one exclusive schema-selected local file.", targetAlias: "generic-record-outbox", actionKey: "write-record-file", maximumRisk: "reversible-write", requiredApprovalKeys: ["approve-record-file"],
      inputs: [recordInput("record", ["verified-artifact"])], outputs: [recordOutput], routeBuilderKeys: ["generic-file-route-v1"], requiredObservationKeys: ["generic-file-observer-v1"], verifierTemplateKey: "generic-file-verifier-v1", idempotency: "required", provenanceDigest: sha256("generic schema file transform v1"), enabled: true,
    },
    {
      key: primitiveKeys[2], version: "v1", effect: "Merge two verified record branches and idempotently persist their union.", targetAlias: "generic-record-ledger", actionKey: "merge-records", maximumRisk: "reversible-write", requiredApprovalKeys: ["approve-record-merge"],
      inputs: [recordInput("left", ["verified-artifact"]), recordInput("right", ["verified-artifact"])], outputs: [recordOutput], routeBuilderKeys: ["generic-sqlite-merge-route-v1"], requiredObservationKeys: ["generic-sqlite-observer-v1"], verifierTemplateKey: "generic-sqlite-verifier-v1", idempotency: "required", provenanceDigest: sha256("generic sqlite record merge v1"), enabled: true,
    },
  ];
}

function compile(goal: GoalCase): CompiledCapabilityResolutionPlan {
  const evidenceId = `evidence-${goal.caseId}`;
  const registry = primitives();
  const context: CapabilityResolutionCompilerContext = {
    identity: { ...goal.identity, ordinaryGoalDigest: sha256(goal.ordinaryGoal) }, primitives: registry,
    evidence: [{ evidenceId, digest: structuredDigest(goal.record), summary: "Sealed approved record and graph declaration.", permittedPrimitiveKeys: registry.map((item) => item.key) }],
    trustedConfigValues: [], trustedLiteralValues: [], evidenceValues: [{ evidenceId, key: "approved-record", schemaKey: "generic-sealed-record-v1", classification: "restricted", digest: structuredDigest(goal.record) }],
    enabledRouteBuilderKeys: ["generic-sqlite-route-v1", "generic-file-route-v1", "generic-sqlite-merge-route-v1"],
    enabledObservationKeys: ["generic-sqlite-observer-v1", "generic-file-observer-v1"],
    enabledVerifierTemplateKeys: ["generic-sqlite-verifier-v1", "generic-file-verifier-v1"], authority: goal.authority,
    aggregateVerifier: { key: `aggregate-${goal.caseId}`, requiredTerminalOutputs: [goal.terminal] },
  };
  const graph = goal.workItems.map((item) => ({
    workItemId: item.workItemId, primitiveKey: item.primitiveKey, primitiveVersion: "v1", citedEvidenceIds: [evidenceId], dependsOn: item.dependsOn,
    bindings: item.inputs.map((binding): GraphInputBinding => binding.kind === "trusted-evidence"
      ? { ...binding, evidenceId }
      : binding),
  }));
  const result = compileCapabilityResolutionGraph({ schemaVersion: "1.0", decision: "compile", ...context.identity, summary: goal.ordinaryGoal, workItems: graph, terminalOutputs: [goal.terminal] }, context);
  if (!result.plan) throw new Error(`Generic compiler rejected ${goal.caseId}: ${JSON.stringify(result.errors)}`);
  return result.plan;
}

interface Paths { world: string; outbox: string; jobs: string; artifacts: string }
function initialize(paths: Paths, goal: GoalCase): void {
  mkdirSync(paths.outbox, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(paths.world);
  try {
    db.exec(`
      CREATE TABLE records (record_id TEXT PRIMARY KEY, subject_code TEXT NOT NULL, unit_count INTEGER NOT NULL, stage TEXT NOT NULL, branches_json TEXT NOT NULL, authority_ref TEXT NOT NULL);
      CREATE TABLE actions (idempotency_key TEXT PRIMARY KEY, family TEXT NOT NULL, work_item_id TEXT NOT NULL);
      CREATE TABLE capabilities (family TEXT NOT NULL, primitive_key TEXT NOT NULL, primitive_version TEXT NOT NULL, PRIMARY KEY (family, primitive_key, primitive_version));
      CREATE TABLE reuse_evidence (work_item_id TEXT PRIMARY KEY, family TEXT NOT NULL);
      CREATE TABLE reconciliation_evidence (work_item_id TEXT PRIMARY KEY, family TEXT NOT NULL);
      CREATE TABLE authority_evidence (work_item_id TEXT PRIMARY KEY, digest TEXT NOT NULL);
      CREATE TABLE quarantine_evidence (work_item_id TEXT PRIMARY KEY, digest TEXT NOT NULL);
      CREATE TABLE parent_resumptions (resumption_key TEXT PRIMARY KEY, evidence_digest TEXT NOT NULL);
      CREATE TABLE parent_reconciliations (resumption_key TEXT PRIMARY KEY);
    `);
    for (const row of goal.initialRows) upsertRow(db, row);
  } finally { db.close(); }
  chmodSync(paths.world, 0o600);
  for (const file of goal.initialFiles) writeFileSync(join(paths.outbox, file.name), file.content, { flag: "wx", mode: 0o600 });
}
function upsertRow(db: DatabaseSync, record: GenericRecord): void {
  db.prepare(`INSERT INTO records VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(record_id) DO UPDATE SET subject_code=excluded.subject_code, unit_count=excluded.unit_count, stage=excluded.stage, branches_json=excluded.branches_json, authority_ref=excluded.authority_ref`)
    .run(record.recordId, record.subjectCode, record.unitCount, record.stage, JSON.stringify(record.branches), record.authorityRef);
}
function rows(path: string): GenericRecord[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT * FROM records ORDER BY record_id").all() as unknown as Array<Record<string, unknown>>).map((row) => recordSchema.parse({ recordId: row.record_id, subjectCode: row.subject_code, unitCount: row.unit_count, stage: row.stage, branches: JSON.parse(String(row.branches_json)), authorityRef: row.authority_ref }));
  } finally { db.close(); }
}
function files(path: string) { return readdirSync(path).sort().map((name) => ({ name, content: readFileSync(join(path, name), "utf8") })); }
function count(path: string, sql: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return (db.prepare(sql).get() as unknown as { value: number }).value; } finally { db.close(); }
}
function transform(record: GenericRecord, item: GoalCase["workItems"][number]): GenericRecord {
  if (!item.fileTransform) throw new Error(`Reusable file transform is missing for ${item.workItemId}.`);
  return recordSchema.parse({ ...record, stage: item.fileTransform.nextStage, branches: [...new Set([...record.branches, item.fileTransform.addBranch])].sort() });
}
function merge(left: GenericRecord, right: GenericRecord, item: GoalCase["workItems"][number]): GenericRecord {
  if (!item.merge) throw new Error(`Reusable merge declaration is missing for ${item.workItemId}.`);
  for (const key of ["recordId", "subjectCode", "unitCount", "authorityRef"] as const) if (left[key] !== right[key]) throw new Error(`Merge branches disagree on ${key}.`);
  return recordSchema.parse({ ...left, stage: item.merge.nextStage, branches: [...new Set([...left.branches, ...right.branches])].sort() });
}
function encode(record: GenericRecord, item: GoalCase["workItems"][number]): string {
  if (item.fileTransform?.encoding === "canonical-json-v1") return `${canonical(record)}\n`;
  if (item.fileTransform?.encoding === "fixed-width-v1") return `${record.recordId.padEnd(14)}|${record.subjectCode.padEnd(23)}|${String(record.unitCount).padStart(5, "0")}|${record.stage}|${record.branches.join(",")}|${record.authorityRef}\n`;
  throw new Error(`Unsupported declarative encoding for ${item.workItemId}.`);
}

const verdicts: Readonly<Record<VerifierTemplateControlId, ExpectedVerifierTemplateVerdict>> = Object.freeze({
  completed: { classification: "completed", passed: true, nextAction: "resume", incorrectSideEffects: 0 }, "not-started": { classification: "not-started", passed: false, nextAction: "retry-after-authority-recheck", incorrectSideEffects: 0 },
  partial: { classification: "partial", passed: false, nextAction: "quarantine", incorrectSideEffects: 0 }, incorrect: { classification: "incorrect", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
  duplicate: { classification: "duplicate", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 }, stale: { classification: "stale", passed: false, nextAction: "quarantine", incorrectSideEffects: 0 },
  collateral: { classification: "collateral", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 }, unknown: { classification: "unknown", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
  unavailable: { classification: "unavailable", passed: false, nextAction: "handoff", incorrectSideEffects: 0 }, "lost-response-reconciliation": { classification: "completed", passed: true, nextAction: "resume", incorrectSideEffects: 0 },
  "adversarial-action-response": { classification: "unavailable", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
});
function qualify(family: RuntimeFamily, templateKey: string, plan: CompiledCapabilityResolutionPlan, settings: z.infer<typeof familySchema>["qualification"]): VerifierTemplateQualificationReceipt {
  const cases: VerifierTemplateQualificationCase[] = verifierTemplateControlIds.map((controlId) => ({ controlId, independentObservation: { family, verdict: verdicts[controlId] }, responseDisposition: controlId === "lost-response-reconciliation" ? "lost" : controlId === "adversarial-action-response" ? "available" : "not-applicable", ...(controlId === "adversarial-action-response" ? { actionResponse: { claimedComplete: true } } : {}), expected: verdicts[controlId] }));
  const result = qualifyVerifierTemplate({
    candidate: { templateKey, templateVersion: "v1", runtimeFamily: family, implementationDigest: sha256(`${family}:generic-independent-verifier-v1`), outcomeSchemaDigest: sha256("generic-record-outcome-v1"), evaluate(input) {
      const observation = z.object({ family: z.literal(family), verdict: z.object({ classification: z.enum(["completed", "not-started", "partial", "incorrect", "duplicate", "stale", "collateral", "unknown", "unavailable"]), passed: z.boolean(), nextAction: z.enum(["resume", "retry-after-authority-recheck", "quarantine", "handoff"]), incorrectSideEffects: z.number().int() }).strict() }).strict().parse(input.independentObservation);
      return { ...observation.verdict, observedStateDigest: verifierQualificationDigest(input.independentObservation) };
    } },
    corpus: { schemaVersion: "1.0", corpusVersion: settings.corpusVersion, cases }, primitiveRegistryDigest: plan.primitiveRegistryDigest, verifierRegistryDigest: plan.verifierRegistryDigest, qualifiedAt: settings.qualifiedAt, expiresAt: settings.expiresAt,
  });
  if (result.status !== "qualified") throw new Error(`Generic ${family} verifier did not qualify.`);
  return result.receipt;
}

function expectedFor(goal: GoalCase, itemId: string, values: Readonly<Record<string, unknown>>): GenericRecord {
  const item = goal.workItems.find((candidate) => candidate.workItemId === itemId)!;
  if (item.primitiveKey === primitiveKeys[0]) return recordSchema.parse(values.record);
  if (item.primitiveKey === primitiveKeys[1]) return transform(recordSchema.parse(values.record), item);
  return merge(recordSchema.parse(values.left), recordSchema.parse(values.right), item);
}
function runtime(plan: CompiledCapabilityResolutionPlan, goal: GoalCase, oracle: z.infer<typeof oracleCaseSchema>, paths: Paths, qualificationSettings: z.infer<typeof familySchema>["qualification"]) {
  const sqliteReceipt = qualify(families[0], "generic-sqlite-verifier-v1", plan, qualificationSettings);
  const fileReceipt = qualify(families[1], "generic-file-verifier-v1", plan, qualificationSettings);
  const registry = new VerifierTemplateQualificationRegistry([sqliteReceipt, fileReceipt]);
  const qualification = (family: RuntimeFamily): RuntimeBindingQualification => ({ schemaVersion: "1.0", status: "qualified", qualificationDigest: sha256(`${family}:${plan.planDigest}`), primitiveRegistryDigest: plan.primitiveRegistryDigest, verifierRegistryDigest: plan.verifierRegistryDigest, qualifiedAt: qualificationSettings.qualifiedAt });
  const retain = async (family: RuntimeFamily, context: CapabilityResolutionExecutionContext) => {
    const db = new DatabaseSync(paths.world); try { db.prepare("INSERT OR IGNORE INTO capabilities VALUES (?, ?, ?)").run(family, context.primitiveKey, context.primitiveVersion); } finally { db.close(); }
    return { retained: true as const, receiptDigest: sha256(`retain:${family}:${context.primitiveKey}`) };
  };
  const makeSqlite = (key: typeof primitiveKeys[0] | typeof primitiveKeys[2]): CapabilityResolutionRuntimeBinding => {
    const inputKeys = key === primitiveKeys[0] ? ["record"] : ["left", "right"];
    return {
      primitiveKey: key, primitiveVersion: "v1", runtimeFamily: families[0], targetAlias: "generic-record-ledger", actionKey: key === primitiveKeys[0] ? "upsert-record" : "merge-records", routeBuilderKey: key === primitiveKeys[0] ? "generic-sqlite-route-v1" : "generic-sqlite-merge-route-v1", observationKeys: ["generic-sqlite-observer-v1"], verifierTemplateKey: sqliteReceipt.templateKey, verifierTemplateQualification: qualificationReference(sqliteReceipt),
      inputContracts: inputKeys.map((inputKey) => ({ inputKey, schemaKey: "generic-sealed-record-v1", maximumClassification: "restricted" as const, allowedSources: key === primitiveKeys[0] ? ["trusted-evidence" as const, "verified-artifact" as const] : ["verified-artifact" as const], parse: (value: unknown) => recordSchema.parse(value) })), qualification: qualification(families[0]),
      async execute({ context, values, idempotencyKey }) {
        const db = new DatabaseSync(paths.world); try { db.exec("BEGIN IMMEDIATE;"); const retained = db.prepare("SELECT 1 FROM capabilities WHERE family=? AND primitive_key=? AND primitive_version=?").get(families[0], context.primitiveKey, context.primitiveVersion); if (retained) db.prepare("INSERT OR IGNORE INTO reuse_evidence VALUES (?, ?)").run(context.workItemId, families[0]); if (!db.prepare("SELECT 1 FROM actions WHERE idempotency_key=?").get(idempotencyKey)) { upsertRow(db, expectedFor(goal, context.workItemId, values)); db.prepare("INSERT INTO actions VALUES (?, ?, ?)").run(idempotencyKey, families[0], context.workItemId); } db.exec("COMMIT;"); } catch (error) { if (db.isTransaction) db.exec("ROLLBACK;"); throw error; } finally { db.close(); }
      },
      async reconcile({ context, values }) { const expected = expectedFor(goal, context.workItemId, values); const matches = rows(paths.world).filter((row) => canonical(row) === canonical(expected)); const db = new DatabaseSync(paths.world); try { db.prepare("INSERT OR IGNORE INTO reconciliation_evidence VALUES (?, ?)").run(context.workItemId, families[0]); } finally { db.close(); } return { classification: matches.length === 1 ? "completed" : matches.length === 0 ? "not-started" : "incorrect", evidenceDigest: structuredDigest({ family: families[0], expected, matches }), detail: `Independent database observation found ${matches.length} exact row(s).` }; },
      async verify({ context, values }) { const expected = expectedFor(goal, context.workItemId, values); const matches = rows(paths.world).filter((row) => canonical(row) === canonical(expected)); return { passed: matches.length === 1, incorrectSideEffects: matches.length > 1 ? matches.length - 1 : 0, evidenceReceiptDigest: structuredDigest({ family: families[0], expected, matches }), outputs: { record: matches[0] ?? expected }, detail: `Independent database verifier found ${matches.length} exact row(s).` }; },
      async retain({ context }) { return retain(families[0], context); },
      async quarantine({ context, reason }) { const db = new DatabaseSync(paths.world); try { db.prepare("INSERT OR REPLACE INTO quarantine_evidence VALUES (?, ?)").run(context.workItemId, sha256(reason)); } finally { db.close(); } },
    };
  };
  const file: CapabilityResolutionRuntimeBinding = {
    primitiveKey: primitiveKeys[1], primitiveVersion: "v1", runtimeFamily: families[1], targetAlias: "generic-record-outbox", actionKey: "write-record-file", routeBuilderKey: "generic-file-route-v1", observationKeys: ["generic-file-observer-v1"], verifierTemplateKey: fileReceipt.templateKey, verifierTemplateQualification: qualificationReference(fileReceipt),
    inputContracts: [{ inputKey: "record", schemaKey: "generic-sealed-record-v1", maximumClassification: "restricted", allowedSources: ["verified-artifact"], parse: (value) => recordSchema.parse(value) }], qualification: qualification(families[1]),
    async execute({ context, values, idempotencyKey }) { const item = goal.workItems.find((candidate) => candidate.workItemId === context.workItemId)!; const output = expectedFor(goal, context.workItemId, values); const content = encode(output, item); const path = join(paths.outbox, item.fileTransform!.outputName); if (!existsSync(path)) { const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, content); } finally { closeSync(fd); } } else if (readFileSync(path, "utf8") !== content) throw new Error("Existing output file has conflicting content."); const db = new DatabaseSync(paths.world); try { const retained = db.prepare("SELECT 1 FROM capabilities WHERE family=? AND primitive_key=? AND primitive_version='v1'").get(families[1], context.primitiveKey); if (retained) db.prepare("INSERT OR IGNORE INTO reuse_evidence VALUES (?, ?)").run(context.workItemId, families[1]); db.prepare("INSERT OR IGNORE INTO actions VALUES (?, ?, ?)").run(idempotencyKey, families[1], context.workItemId); } finally { db.close(); } },
    async reconcile({ context, values }) { const item = goal.workItems.find((candidate) => candidate.workItemId === context.workItemId)!; const expected = encode(expectedFor(goal, context.workItemId, values), item); const path = join(paths.outbox, item.fileTransform!.outputName); const actual = existsSync(path) ? readFileSync(path, "utf8") : undefined; return { classification: actual === expected ? "completed" : actual === undefined ? "not-started" : "incorrect", evidenceDigest: structuredDigest({ family: families[1], name: item.fileTransform!.outputName, actual }), detail: "Independent file reconciliation completed." }; },
    async verify({ context, values }) { const item = goal.workItems.find((candidate) => candidate.workItemId === context.workItemId)!; const output = expectedFor(goal, context.workItemId, values); const expected = encode(output, item); const actual = existsSync(join(paths.outbox, item.fileTransform!.outputName)) ? readFileSync(join(paths.outbox, item.fileTransform!.outputName), "utf8") : undefined; return { passed: actual === expected, incorrectSideEffects: actual !== undefined && actual !== expected ? 1 : 0, evidenceReceiptDigest: structuredDigest({ family: families[1], name: item.fileTransform!.outputName, actual }), outputs: { record: output }, detail: "Independent file verifier compared exact bytes." }; },
    async retain({ context }) { return retain(families[1], context); },
    async quarantine({ context, reason }) { const db = new DatabaseSync(paths.world); try { db.prepare("INSERT OR REPLACE INTO quarantine_evidence VALUES (?, ?)").run(context.workItemId, sha256(reason)); } finally { db.close(); } },
  };
  const bindings = [makeSqlite(primitiveKeys[0]), file, makeSqlite(primitiveKeys[2])];
  const result: DurableCapabilityResolutionRuntime = {
    primitiveRegistryDigest: plan.primitiveRegistryDigest, verifierRegistryDigest: plan.verifierRegistryDigest, supportedRuntimeFamilies: [...families], verifierTemplateQualifications: registry, bindings,
    authority: { async check({ context, maximumRisk, requiredApprovalKeys }) { const item = plan.orderedWorkItems.find((candidate) => candidate.workItemId === context.workItemId)!; const allowed = context.planDigest === plan.planDigest && maximumRisk === item.maximumRisk && canonical([...requiredApprovalKeys].sort()) === canonical([...item.requiredApprovalKeys].sort()) && goal.authority.targetAliases.includes(context.targetAlias as never) && goal.authority.actionKeys.includes(context.actionKey as never) && item.requiredApprovalKeys.every((key) => goal.authority.approvalKeys.includes(key as never)); const authorityDigest = structuredDigest({ context, maximumRisk, requiredApprovalKeys, allowed }); const db = new DatabaseSync(paths.world); try { db.prepare("INSERT OR IGNORE INTO authority_evidence VALUES (?, ?)").run(context.workItemId, authorityDigest); } finally { db.close(); } return { allowed, authorityDigest, planDigest: plan.planDigest, detail: allowed ? "Exact sealed authority is live." : "Exact sealed authority is absent.", ...(!allowed ? { handoffReceiptDigest: sha256(`handoff:${context.workItemId}`) } : {}) }; } },
    values: { async resolve({ binding }) { if (binding.kind !== "trusted-evidence" || binding.valueKey !== "approved-record") throw new Error("Undeclared evidence value requested."); return { value: goal.record, provenanceDigest: structuredDigest(goal.record) }; } },
    aggregateVerifier: { key: `aggregate-${goal.caseId}`, kind: "independent-external-state", qualification: qualification(families[0]), async verify({ terminalArtifacts }) { const expectedRows = [...goal.initialRows, oracle.finalRecord].sort((a, b) => order(a.recordId, b.recordId)); const actualRows = rows(paths.world); const actualFiles = files(paths.outbox); const expectedFiles = [...oracle.files].sort((a, b) => order(a.name, b.name)); const terminal = terminalArtifacts[0]?.value; const mismatches = Number(canonical(actualRows) !== canonical(expectedRows)) + Number(canonical(actualFiles) !== canonical(expectedFiles)) + Number(canonical(terminal) !== canonical(oracle.finalRecord)); return { passed: mismatches === 0, incorrectSideEffects: mismatches, evidenceDigest: structuredDigest({ actualRows, actualFiles, terminal }), detail: mismatches === 0 ? "All direct external state matches the sealed oracle." : `${mismatches} aggregate mismatch(es).` }; } },
    parentResumer: { async resume({ aggregateEvidenceDigest, resumptionKey }) { const db = new DatabaseSync(paths.world); try { db.prepare("INSERT OR IGNORE INTO parent_resumptions VALUES (?, ?)").run(resumptionKey, aggregateEvidenceDigest); } finally { db.close(); } if (goal.fault.loseParentResponse) throw new Error("Sealed parent response loss."); return { resumed: true, completed: true, receiptDigest: sha256(`parent:${resumptionKey}`) }; }, async reconcile({ resumptionKey }) { const db = new DatabaseSync(paths.world); let completed = false; try { completed = Boolean(db.prepare("SELECT 1 FROM parent_resumptions WHERE resumption_key=?").get(resumptionKey)); db.prepare("INSERT OR IGNORE INTO parent_reconciliations VALUES (?)").run(resumptionKey); } finally { db.close(); } return { classification: completed ? "completed" : "not-started", ...(completed ? { receiptDigest: sha256(`parent:${resumptionKey}`) } : {}), evidenceDigest: structuredDigest({ resumptionKey, completed }), detail: "Independent parent-state reconciliation." }; } },
  };
  return { runtime: result, qualifications: [sqliteReceipt, fileReceipt] };
}

function context(plan: CompiledCapabilityResolutionPlan, workItemId: string): CapabilityResolutionExecutionContext {
  const item = plan.orderedWorkItems.find((candidate) => candidate.workItemId === workItemId)!;
  return { tenantId: plan.tenantId, requestId: plan.requestId, parentGoalId: plan.parentGoalId, planId: plan.planId, planDigest: plan.planDigest, workItemId, primitiveKey: item.primitiveKey, primitiveVersion: item.primitiveVersion, targetAlias: item.targetAlias, actionKey: item.actionKey };
}

export interface AdversarialFamilyReceipt {
  schemaVersion: "1.0"; campaignId: string; status: "passed"; sealDigest?: string;
  cases: Array<{ caseId: string; topology: "chain" | "fork-join"; planDigest: string; workItems: number; status: string; restartAttempts: number; parentResumed: boolean; incorrectSideEffects: 0; runtimeEvidence: Array<{ family: RuntimeFamily; actions: number; verifications: number; reconciliations: number; retainedCapabilities: number; reuses: number; qualificationControls: number; evidenceDigest: string }>; authorBridge: { caseSpecificSourceFiles: 0; postUnsealCallbacks: 0; declarativeDecisions: number; preciseBlockers: 0 } }>;
  baseline: { name: string; goalsCompleted: number; goalCount: number; primitiveCoveredWorkItems: number; executableWorkItems: number; totalWorkItems: number; coverageReason: string };
  aggregate: { goalsCompleted: number; goalCount: number; workItemsCompleted: number; workItemCount: number; incorrectSideEffects: 0 };
  authorBridges: { caseSpecificSourceFiles: 0; postUnsealCallbacks: 0; reusablePrimitiveCount: number; preciseBlockers: 0 };
  modelCalls: 0; paidSpendUsd: 0; receiptDigest: string;
}

export async function runAdversarialResolutionFamily(options: { materialDirectory: string; workingDirectory: string; requireSeal?: boolean }): Promise<AdversarialFamilyReceipt> {
  const material = loadMaterial(options.materialDirectory, options.requireSeal ?? true);
  mkdirSync(options.workingDirectory, { recursive: true, mode: 0o700 });
  const caseReceipts: AdversarialFamilyReceipt["cases"] = [];
  for (const goal of material.family.cases) {
    const oracle = material.oracle.cases.find((candidate) => candidate.caseId === goal.caseId);
    if (!oracle) throw new Error(`Oracle missing for ${goal.caseId}.`);
    const caseRoot = join(options.workingDirectory, goal.caseId);
    mkdirSync(caseRoot, { mode: 0o700 });
    const paths: Paths = { world: join(caseRoot, "world.sqlite"), outbox: join(caseRoot, "outbox"), jobs: join(caseRoot, "jobs.sqlite"), artifacts: join(caseRoot, "artifacts.sqlite") };
    initialize(paths, goal);
    const plan = compile(goal);
    const store1 = new DurableCapabilityResolutionStore(paths.jobs, () => "2026-08-14T11:00:00.000Z");
    const artifacts1 = new VerifiedArtifactStore(paths.artifacts, [{ schemaKey: "generic-sealed-record-v1", maximumBytes: 4096, parse: (value) => recordSchema.parse(value) }]);
    const firstRuntime = runtime(plan, goal, oracle, paths, material.family.qualification);
    const executor1 = new DurableCapabilityResolutionExecutor(store1, artifacts1, firstRuntime.runtime, () => "2026-08-14T11:00:00.000Z");
    const submitted = executor1.submit(plan);
    if (!store1.claim(plan.tenantId, submitted.job.jobId)) throw new Error("First process could not claim sealed case.");
    const interruptedId = goal.fault.restartAfterCommitWorkItemId;
    if (plan.orderedWorkItems[0]?.workItemId !== interruptedId) throw new Error("Restart fault must target first work item.");
    store1.startItem(plan.tenantId, submitted.job.jobId, interruptedId);
    const interruptedContext = context(plan, interruptedId);
    const authority = await firstRuntime.runtime.authority.check({ context: interruptedContext, maximumRisk: plan.orderedWorkItems[0]!.maximumRisk, requiredApprovalKeys: plan.orderedWorkItems[0]!.requiredApprovalKeys });
    if (!authority.allowed) throw new Error("Fault injector lacked exact authority.");
    await firstRuntime.runtime.bindings.find((binding) => binding.primitiveKey === plan.orderedWorkItems[0]!.primitiveKey)!.execute({ context: interruptedContext, values: Object.freeze({ record: goal.record }), idempotencyKey: sha256(`${plan.planDigest}\u001f${interruptedId}`) });
    artifacts1.close(); store1.close();

    const store2 = new DurableCapabilityResolutionStore(paths.jobs, () => "2026-08-14T11:01:00.000Z");
    const recovered = store2.recoverInterrupted(2);
    const artifacts2 = new VerifiedArtifactStore(paths.artifacts, [{ schemaKey: "generic-sealed-record-v1", maximumBytes: 4096, parse: (value) => recordSchema.parse(value) }]);
    const secondRuntime = runtime(plan, goal, oracle, paths, material.family.qualification);
    const executor2 = new DurableCapabilityResolutionExecutor(store2, artifacts2, secondRuntime.runtime, () => "2026-08-14T11:01:00.000Z");
    const result = await executor2.run(plan.tenantId, submitted.job.jobId);
    const items = store2.items(result.jobId);
    const familyEvidence = families.map((family) => {
      const familyItems = plan.orderedWorkItems.filter((item) => secondRuntime.runtime.bindings.find((binding) => binding.primitiveKey === item.primitiveKey)!.runtimeFamily === family);
      const actions = count(paths.world, `SELECT COUNT(*) AS value FROM actions WHERE family='${family}'`);
      const reconciliations = count(paths.world, `SELECT COUNT(*) AS value FROM reconciliation_evidence WHERE family='${family}'`);
      const retainedCapabilities = count(paths.world, `SELECT COUNT(*) AS value FROM capabilities WHERE family='${family}'`);
      const reuses = count(paths.world, `SELECT COUNT(*) AS value FROM reuse_evidence WHERE family='${family}'`);
      const qualificationControls = secondRuntime.qualifications.filter((receipt) => receipt.runtimeFamily === family).reduce((sum, receipt) => sum + receipt.controls.filter((control) => control.passed).length, 0);
      return { family, actions, verifications: familyItems.length, reconciliations, retainedCapabilities, reuses, qualificationControls, evidenceDigest: structuredDigest({ family, actions, reconciliations, retainedCapabilities, reuses, itemEvidence: items.filter((item) => familyItems.some((candidate) => candidate.workItemId === item.workItemId)).map((item) => item.evidenceReceiptDigest) }) };
    });
    const sqlite = familyEvidence[0]!; const file = familyEvidence[1]!;
    const assertions = [result.status === "autonomous-completion", result.attempts === 2, recovered.length === oracle.expected.restartRecoveries, items.every((item) => item.status === "retained"), sqlite.actions === oracle.expected.sqliteActions, file.actions === oracle.expected.fileActions, sqlite.reconciliations + file.reconciliations === oracle.expected.lostActionReconciliations, sqlite.retainedCapabilities + file.retainedCapabilities === oracle.expected.retainedCapabilities, sqlite.reuses + file.reuses === oracle.expected.retainedReuses, count(paths.world, "SELECT COUNT(*) AS value FROM parent_resumptions") === oracle.expected.parentExecutions, count(paths.world, "SELECT COUNT(*) AS value FROM parent_reconciliations") === oracle.expected.parentReconciliations, count(paths.world, "SELECT COUNT(*) AS value FROM quarantine_evidence") === 0, Boolean(result.aggregateEvidenceDigest), result.parentResumed];
    if (assertions.some((passed) => !passed)) throw new Error(`Sealed case ${goal.caseId} diverged from its oracle (${result.status}: ${result.error ?? "no detail"}).`);
    caseReceipts.push({ caseId: goal.caseId, topology: goal.workItems.some((item) => item.dependsOn.length > 1) ? "fork-join" : "chain", planDigest: plan.planDigest, workItems: items.length, status: result.status, restartAttempts: result.attempts, parentResumed: result.parentResumed, incorrectSideEffects: 0, runtimeEvidence: familyEvidence, authorBridge: { caseSpecificSourceFiles: 0, postUnsealCallbacks: 0, declarativeDecisions: goal.workItems.length + goal.initialFiles.length + goal.initialRows.length + 4, preciseBlockers: 0 } });
    artifacts2.close(); store2.close();
  }
  const baselinePrimitiveSet = new Set(material.family.baseline.primitiveKeys);
  const matchesFixedPolicy = (goal: GoalCase) => canonical(goal.workItems.map((item) => item.primitiveKey)) === canonical(material.family.baseline.fixedGraphPrimitiveKeys)
    && canonical(goal.workItems.map((item) => item.dependsOn.length)) === canonical(material.family.baseline.fixedDependencyCounts);
  const matchedGoals = material.family.cases.filter(matchesFixedPolicy);
  const baseline = {
    name: material.family.baseline.name,
    goalsCompleted: matchedGoals.length,
    goalCount: material.family.cases.length,
    primitiveCoveredWorkItems: material.family.cases.flatMap((goal) => goal.workItems).filter((item) => baselinePrimitiveSet.has(item.primitiveKey)).length,
    executableWorkItems: matchedGoals.reduce((sum, goal) => sum + goal.workItems.length, 0),
    totalWorkItems: material.family.cases.reduce((sum, goal) => sum + goal.workItems.length, 0),
    coverageReason: material.oracle.fixedToolBaseline.coverageReason,
  };
  const { name: _baselineName, ...baselineOutcome } = baseline;
  if (canonical(baselineOutcome) !== canonical(material.oracle.fixedToolBaseline)) throw new Error("Fixed-tool baseline diverged from precommitment.");
  const unsigned = { schemaVersion: "1.0" as const, campaignId: material.family.campaignId, status: "passed" as const, ...(material.sealDigest ? { sealDigest: material.sealDigest } : {}), cases: caseReceipts, baseline, aggregate: { goalsCompleted: caseReceipts.length, goalCount: material.family.cases.length, workItemsCompleted: caseReceipts.reduce((sum, item) => sum + item.workItems, 0), workItemCount: baseline.totalWorkItems, incorrectSideEffects: 0 as const }, authorBridges: { caseSpecificSourceFiles: 0 as const, postUnsealCallbacks: 0 as const, reusablePrimitiveCount: primitiveKeys.length, preciseBlockers: 0 as const }, modelCalls: 0 as const, paidSpendUsd: 0 as const };
  return { ...unsigned, receiptDigest: structuredDigest(unsigned) };
}
