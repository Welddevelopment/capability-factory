import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

export const composedRecoveryClassifications = [
  "completed",
  "not-started",
  "partial",
  "incorrect",
  "duplicate",
  "stale",
  "collateral",
  "unknown",
  "unavailable",
  "lost-response",
] as const;
export type ComposedRecoveryClassification = typeof composedRecoveryClassifications[number];
export type ReconciledRecoveryClassification = Exclude<ComposedRecoveryClassification, "lost-response">;

export const composedRecoveryFaultBoundaries = [
  "before-reconciliation",
  "lost-response-recorded",
  "after-independent-observation",
  "before-authority-recheck",
  "after-authority-recheck",
  "before-retry-consumption",
  "after-retry-consumption",
  "before-retention",
  "before-retained-reuse",
  "before-parent-resumption",
  "lost-parent-response",
  "before-parent-reconciliation",
  "after-parent-reconciliation",
  "before-parent-commit",
] as const;
export type ComposedRecoveryFaultBoundary = typeof composedRecoveryFaultBoundaries[number];
export type ComposedRecoveryFaultInjector = (boundary: ComposedRecoveryFaultBoundary) => void;

const contextSchema = z.object({
  schemaVersion: z.literal("1.0"),
  tenantId: identifier,
  parentGoalId: identifier,
  planId: identifier,
  planDigest: digestSchema,
  workItemId: identifier,
  stateVersion: z.number().int().nonnegative(),
  runtimeFamily: identifier,
  capabilityKey: identifier,
  capabilityVersion: identifier,
  capabilityQualificationDigest: digestSchema,
  capabilityMaterialDigest: digestSchema,
  idempotencyKey: digestSchema,
}).strict();
export type ComposedRecoveryContext = z.infer<typeof contextSchema>;

const evidenceSchema = z.object({
  schemaVersion: z.literal("1.0"),
  observerKey: identifier,
  classification: z.enum(composedRecoveryClassifications.slice(0, -1) as [ReconciledRecoveryClassification, ...ReconciledRecoveryClassification[]]),
  observationDigest: digestSchema,
  incorrectSideEffects: z.number().int().nonnegative(),
  tenantId: identifier,
  parentGoalId: identifier,
  planId: identifier,
  planDigest: digestSchema,
  workItemId: identifier,
  stateVersion: z.number().int().nonnegative(),
  runtimeFamily: identifier,
  capabilityKey: identifier,
  capabilityVersion: identifier,
  capabilityQualificationDigest: digestSchema,
  capabilityMaterialDigest: digestSchema,
  observedAt: timestampSchema,
}).strict();
export type IndependentRecoveryEvidence = z.infer<typeof evidenceSchema>;

const authoritySchema = z.object({
  schemaVersion: z.literal("1.0"),
  allowed: z.boolean(),
  authorityDigest: digestSchema,
  tenantId: identifier,
  parentGoalId: identifier,
  planId: identifier,
  planDigest: digestSchema,
  workItemId: identifier,
  stateVersion: z.number().int().nonnegative(),
  runtimeFamily: identifier,
  capabilityKey: identifier,
  capabilityVersion: identifier,
  checkedAt: timestampSchema,
  expiresAt: timestampSchema,
}).strict();
export type RecoveryAuthorityReceipt = z.infer<typeof authoritySchema>;

export type ComposedRecoveryTransition =
  | "verified-completion"
  | "retry-authorized-once"
  | "quarantine"
  | "quarantine-and-invalidate-retained"
  | "precise-handoff";

export interface ComposedRecoveryReceipt {
  schemaVersion: "1.0";
  recoveryId: string;
  context: ComposedRecoveryContext;
  enteredState: ComposedRecoveryClassification;
  reconciledClassification: ReconciledRecoveryClassification;
  transition: ComposedRecoveryTransition;
  independentEvidence: IndependentRecoveryEvidence;
  authorityRecheck?: RecoveryAuthorityReceipt;
  retryPermitId?: string;
  retryStateVersion?: number;
  verifiedCompletion: boolean;
  quarantine: boolean;
  invalidateRetainedCapability: boolean;
  handoffReason?: string;
  createdAt: string;
  integrityDigest: string;
}

export interface RetainedCapabilityReuseReceipt {
  schemaVersion: "1.0";
  reuseId: string;
  tenantId: string;
  runtimeFamily: string;
  capabilityKey: string;
  capabilityVersion: string;
  capabilityQualificationDigest: string;
  retainedEvidenceDigest: string;
  consumerPlanDigest: string;
  consumerWorkItemId: string;
  reusedAt: string;
  integrityDigest: string;
}

export interface ParentResumptionBinding {
  schemaVersion: "1.0";
  tenantId: string;
  parentGoalId: string;
  planId: string;
  planDigest: string;
  stateVersion: number;
}

export interface ParentResumptionReceipt {
  schemaVersion: "1.0";
  resumptionKey: string;
  binding: ParentResumptionBinding;
  aggregateEvidenceDigest: string;
  itemRecoveryDigests: string[];
  externalReceiptDigest: string;
  externalEvidenceDigest: string;
  reconciledAfterLostResponse: boolean;
  completedAt: string;
  integrityDigest: string;
}

export interface ParentResumptionDriver {
  resume(input: {
    binding: ParentResumptionBinding;
    aggregateEvidenceDigest: string;
    itemRecoveryDigests: string[];
    resumptionKey: string;
  }): Promise<{ completed: true; receiptDigest: string; evidenceDigest: string }>;
  reconcile(input: {
    binding: ParentResumptionBinding;
    aggregateEvidenceDigest: string;
    resumptionKey: string;
  }): Promise<{
    classification: ReconciledRecoveryClassification;
    receiptDigest?: string;
    evidenceDigest: string;
    detail: string;
  }>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Recovery material cannot contain non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Recovery material must contain plain structured values.");
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  throw new Error("Recovery material cannot contain undefined, functions, symbols or bigint values.");
}

export function composedRecoveryDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Maps the pre-existing bounded document/file-transfer driver vocabulary. */
export function normalizeBoundedDriverOutcome(
  outcome: "complete" | "not-started" | "partial" | "incorrect" | "unknown",
): ReconciledRecoveryClassification {
  return outcome === "complete" ? "completed" : outcome;
}

function unsignedRecovery(receipt: ComposedRecoveryReceipt): Omit<ComposedRecoveryReceipt, "integrityDigest"> {
  const { integrityDigest: _integrityDigest, ...unsigned } = receipt;
  return unsigned;
}

function unsignedReuse(receipt: RetainedCapabilityReuseReceipt): Omit<RetainedCapabilityReuseReceipt, "integrityDigest"> {
  const { integrityDigest: _integrityDigest, ...unsigned } = receipt;
  return unsigned;
}

function unsignedParent(receipt: ParentResumptionReceipt): Omit<ParentResumptionReceipt, "integrityDigest"> {
  const { integrityDigest: _integrityDigest, ...unsigned } = receipt;
  return unsigned;
}

export function assertComposedRecoveryReceiptIntegrity(receipt: ComposedRecoveryReceipt): void {
  contextSchema.parse(receipt.context);
  evidenceSchema.parse(receipt.independentEvidence);
  if (receipt.authorityRecheck) authoritySchema.parse(receipt.authorityRecheck);
  if (receipt.integrityDigest !== composedRecoveryDigest(unsignedRecovery(receipt))) {
    throw new Error("Recovery receipt integrity failed.");
  }
}

function assertEvidenceBinding(context: ComposedRecoveryContext, evidence: IndependentRecoveryEvidence): void {
  for (const [label, left, right] of [
    ["tenant", evidence.tenantId, context.tenantId],
    ["parent goal", evidence.parentGoalId, context.parentGoalId],
    ["plan identity", evidence.planId, context.planId],
    ["plan", evidence.planDigest, context.planDigest],
    ["work item", evidence.workItemId, context.workItemId],
    ["runtime family", evidence.runtimeFamily, context.runtimeFamily],
    ["capability", evidence.capabilityKey, context.capabilityKey],
    ["capability version", evidence.capabilityVersion, context.capabilityVersion],
    ["capability qualification", evidence.capabilityQualificationDigest, context.capabilityQualificationDigest],
    ["capability material", evidence.capabilityMaterialDigest, context.capabilityMaterialDigest],
  ] as const) if (left !== right) throw new Error(`Independent recovery evidence is not bound to the exact ${label}.`);
  if (evidence.stateVersion !== context.stateVersion) throw new Error("Independent recovery evidence is not bound to the exact state version.");
}

function assertAuthorityBinding(context: ComposedRecoveryContext, authority: RecoveryAuthorityReceipt): void {
  for (const [label, left, right] of [
    ["tenant", authority.tenantId, context.tenantId],
    ["parent goal", authority.parentGoalId, context.parentGoalId],
    ["plan identity", authority.planId, context.planId],
    ["plan", authority.planDigest, context.planDigest],
    ["work item", authority.workItemId, context.workItemId],
    ["runtime family", authority.runtimeFamily, context.runtimeFamily],
    ["capability", authority.capabilityKey, context.capabilityKey],
    ["capability version", authority.capabilityVersion, context.capabilityVersion],
  ] as const) if (left !== right) throw new Error(`Authority recheck is not bound to the exact ${label}.`);
  if (authority.stateVersion !== context.stateVersion) throw new Error("Authority recheck is not bound to the exact state version.");
}

function transitionFor(classification: ReconciledRecoveryClassification): {
  transition: ComposedRecoveryTransition;
  verifiedCompletion: boolean;
  quarantine: boolean;
  invalidateRetainedCapability: boolean;
} {
  switch (classification) {
    case "completed": return { transition: "verified-completion", verifiedCompletion: true, quarantine: false, invalidateRetainedCapability: false };
    case "not-started": return { transition: "retry-authorized-once", verifiedCompletion: false, quarantine: false, invalidateRetainedCapability: false };
    case "stale":
    case "partial":
    case "incorrect":
    case "duplicate":
    case "collateral":
      return { transition: "quarantine-and-invalidate-retained", verifiedCompletion: false, quarantine: true, invalidateRetainedCapability: true };
    case "unknown":
    case "unavailable":
      return { transition: "precise-handoff", verifiedCompletion: false, quarantine: false, invalidateRetainedCapability: false };
  }
}

interface RecoveryRow { receipt_json: string }
interface RetryRow { context_json: string; authority_json: string; used: number; next_state_version: number }
interface RetainedRow {
  capability_version: string;
  qualification_digest: string;
  evidence_digest: string;
  status: "active" | "invalidated";
}
interface ParentRow { binding_json: string; status: "pending" | "completed"; attempts: number; receipt_json: string | null }

/**
 * Customer-local durable state machine shared by composed runtime families.
 * It never treats an action response as proof and never retries without a
 * separately bound, live authority receipt and a one-use durable permit.
 */
export class ComposedRuntimeRecoveryCoordinator {
  private readonly database: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => string = () => new Date().toISOString()) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS composed_recovery_receipts (
        recovery_id TEXT PRIMARY KEY, context_digest TEXT UNIQUE NOT NULL,
        receipt_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS composed_retry_permits (
        permit_id TEXT PRIMARY KEY, context_json TEXT NOT NULL, authority_json TEXT NOT NULL,
        next_state_version INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS composed_retained_capabilities (
        tenant_id TEXT NOT NULL, runtime_family TEXT NOT NULL, capability_key TEXT NOT NULL,
        capability_version TEXT NOT NULL, qualification_digest TEXT NOT NULL,
        evidence_digest TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, runtime_family, capability_key)
      );
      CREATE TABLE IF NOT EXISTS composed_reuse_receipts (
        reuse_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS composed_parent_resumptions (
        resumption_key TEXT PRIMARY KEY, binding_json TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, receipt_json TEXT
      );
      PRAGMA user_version = 1;
    `);
  }

  recover(input: {
    context: ComposedRecoveryContext;
    responseDisposition: "available" | "lost";
    independentEvidence: IndependentRecoveryEvidence;
    authorityRecheck?: RecoveryAuthorityReceipt;
    fault?: ComposedRecoveryFaultInjector;
  }): ComposedRecoveryReceipt {
    const context = contextSchema.parse(input.context);
    const evidence = evidenceSchema.parse(input.independentEvidence);
    input.fault?.("before-reconciliation");
    if (input.responseDisposition === "lost") input.fault?.("lost-response-recorded");
    assertEvidenceBinding(context, evidence);
    input.fault?.("after-independent-observation");
    const semantics = transitionFor(evidence.classification);
    if (evidence.classification === "completed" && evidence.incorrectSideEffects !== 0) {
      throw new Error("Completed recovery cannot be verified while incorrect side effects remain.");
    }
    if (["not-started", "partial", "stale", "unknown", "unavailable"].includes(evidence.classification)
      && evidence.incorrectSideEffects !== 0) {
      throw new Error(`Recovery classification ${evidence.classification} cannot hide incorrect side effects.`);
    }

    let authority: RecoveryAuthorityReceipt | undefined;
    let retryPermitId: string | undefined;
    let retryStateVersion: number | undefined;
    let handoffReason: string | undefined;
    if (evidence.classification === "not-started") {
      input.fault?.("before-authority-recheck");
      if (!input.authorityRecheck) throw new Error("Not-started recovery requires a fresh authority recheck.");
      authority = authoritySchema.parse(input.authorityRecheck);
      assertAuthorityBinding(context, authority);
      if (!authority.allowed) throw new Error("Not-started recovery cannot retry because live authority was denied.");
      if (Date.parse(authority.checkedAt) > Date.parse(this.now()) || Date.parse(authority.expiresAt) <= Date.parse(this.now())) {
        throw new Error("Not-started recovery cannot retry because live authority is not active.");
      }
      input.fault?.("after-authority-recheck");
      retryStateVersion = context.stateVersion + 1;
      retryPermitId = `retry.${composedRecoveryDigest({ context, authority, retryStateVersion }).slice(0, 40)}`;
    } else if (semantics.transition === "precise-handoff") {
      handoffReason = `Independent recovery classified ${evidence.classification}; no retry or completion is authorized.`;
    }

    const createdAt = this.now();
    const enteredState = input.responseDisposition === "lost" ? "lost-response" as const : evidence.classification;
    const recoveryId = `recovery.${composedRecoveryDigest({ context, enteredState, evidence }).slice(0, 40)}`;
    const unsigned: Omit<ComposedRecoveryReceipt, "integrityDigest"> = {
      schemaVersion: "1.0",
      recoveryId,
      context,
      enteredState,
      reconciledClassification: evidence.classification,
      ...semantics,
      independentEvidence: evidence,
      ...(authority ? { authorityRecheck: authority } : {}),
      ...(retryPermitId ? { retryPermitId } : {}),
      ...(retryStateVersion !== undefined ? { retryStateVersion } : {}),
      ...(handoffReason ? { handoffReason } : {}),
      createdAt,
    };
    const receipt: ComposedRecoveryReceipt = { ...unsigned, integrityDigest: composedRecoveryDigest(unsigned) };
    const contextDigest = composedRecoveryDigest(context);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.database.prepare("SELECT receipt_json FROM composed_recovery_receipts WHERE context_digest = ?")
        .get(contextDigest) as unknown as RecoveryRow | undefined;
      if (existing) {
        const parsed = JSON.parse(existing.receipt_json) as ComposedRecoveryReceipt;
        assertComposedRecoveryReceiptIntegrity(parsed);
        if (parsed.integrityDigest !== receipt.integrityDigest) throw new Error("This recovery state version already has a different decision receipt.");
        this.database.exec("COMMIT;");
        return parsed;
      }
      this.database.prepare("INSERT INTO composed_recovery_receipts VALUES (?, ?, ?, ?)")
        .run(recoveryId, contextDigest, JSON.stringify(receipt), createdAt);
      if (retryPermitId && authority && retryStateVersion !== undefined) {
        this.database.prepare("INSERT INTO composed_retry_permits (permit_id, context_json, authority_json, next_state_version) VALUES (?, ?, ?, ?)")
          .run(retryPermitId, JSON.stringify(context), JSON.stringify(authority), retryStateVersion);
      }
      if (receipt.invalidateRetainedCapability) this.invalidateBoundCapability(context);
      this.database.exec("COMMIT;");
      return receipt;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  consumeRetry(input: {
    permitId: string;
    context: ComposedRecoveryContext;
    authorityRecheck: RecoveryAuthorityReceipt;
    fault?: ComposedRecoveryFaultInjector;
  }): { authorized: true; priorStateVersion: number; nextStateVersion: number } {
    const context = contextSchema.parse(input.context);
    const authority = authoritySchema.parse(input.authorityRecheck);
    assertAuthorityBinding(context, authority);
    if (!authority.allowed) throw new Error("A denied authority receipt cannot consume a retry permit.");
    if (Date.parse(authority.checkedAt) > Date.parse(this.now()) || Date.parse(authority.expiresAt) <= Date.parse(this.now())) {
      throw new Error("Retry authority is not active at consumption time.");
    }
    input.fault?.("before-retry-consumption");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database.prepare("SELECT * FROM composed_retry_permits WHERE permit_id = ?")
        .get(input.permitId) as unknown as RetryRow | undefined;
      if (!row) throw new Error("Retry permit was not found.");
      if (row.used === 1) throw new Error("Retry permit has already been consumed.");
      if (canonical(JSON.parse(row.context_json)) !== canonical(context)) throw new Error("Retry permit is not bound to this exact recovery context.");
      if (canonical(JSON.parse(row.authority_json)) !== canonical(authority)) throw new Error("Retry permit is not bound to this exact authority recheck.");
      const updated = this.database.prepare("UPDATE composed_retry_permits SET used = 1, consumed_at = ? WHERE permit_id = ? AND used = 0")
        .run(this.now(), input.permitId);
      if (updated.changes !== 1) throw new Error("Retry permit could not be consumed exactly once.");
      input.fault?.("after-retry-consumption");
      this.database.exec("COMMIT;");
      return { authorized: true, priorStateVersion: context.stateVersion, nextStateVersion: row.next_state_version };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  retain(receipt: ComposedRecoveryReceipt, fault?: ComposedRecoveryFaultInjector): void {
    assertComposedRecoveryReceiptIntegrity(receipt);
    if (!receipt.verifiedCompletion || receipt.transition !== "verified-completion") {
      throw new Error("Only independently verified completion can retain a capability.");
    }
    fault?.("before-retention");
    const context = receipt.context;
    this.database.prepare(`
      INSERT INTO composed_retained_capabilities
        (tenant_id, runtime_family, capability_key, capability_version, qualification_digest, evidence_digest, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(tenant_id, runtime_family, capability_key) DO UPDATE SET
        capability_version=excluded.capability_version,
        qualification_digest=excluded.qualification_digest,
        evidence_digest=excluded.evidence_digest,
        status='active', updated_at=excluded.updated_at
    `).run(
      context.tenantId, context.runtimeFamily, context.capabilityKey, context.capabilityVersion,
      context.capabilityQualificationDigest, receipt.independentEvidence.observationDigest, this.now(),
    );
  }

  reuse(input: {
    tenantId: string;
    runtimeFamily: string;
    capabilityKey: string;
    capabilityVersion: string;
    capabilityQualificationDigest: string;
    consumerPlanDigest: string;
    consumerWorkItemId: string;
    fault?: ComposedRecoveryFaultInjector;
  }): RetainedCapabilityReuseReceipt {
    identifier.parse(input.tenantId); identifier.parse(input.runtimeFamily); identifier.parse(input.capabilityKey);
    identifier.parse(input.capabilityVersion); identifier.parse(input.consumerWorkItemId);
    digestSchema.parse(input.capabilityQualificationDigest); digestSchema.parse(input.consumerPlanDigest);
    input.fault?.("before-retained-reuse");
    const row = this.database.prepare(`
      SELECT capability_version, qualification_digest, evidence_digest, status
      FROM composed_retained_capabilities WHERE tenant_id = ? AND runtime_family = ? AND capability_key = ?
    `).get(input.tenantId, input.runtimeFamily, input.capabilityKey) as unknown as RetainedRow | undefined;
    if (!row || row.status !== "active") throw new Error("No active retained capability is available for this exact family and key.");
    if (row.capability_version !== input.capabilityVersion) throw new Error("Retained capability version changed; reuse is blocked.");
    if (row.qualification_digest !== input.capabilityQualificationDigest) throw new Error("Retained capability qualification changed; reuse is blocked.");
    const reusedAt = this.now();
    const reuseId = `reuse.${composedRecoveryDigest({
      tenantId: input.tenantId,
      runtimeFamily: input.runtimeFamily,
      capabilityKey: input.capabilityKey,
      capabilityVersion: input.capabilityVersion,
      capabilityQualificationDigest: input.capabilityQualificationDigest,
      consumerPlanDigest: input.consumerPlanDigest,
      consumerWorkItemId: input.consumerWorkItemId,
      retainedEvidenceDigest: row.evidence_digest,
    }).slice(0, 40)}`;
    const unsigned: Omit<RetainedCapabilityReuseReceipt, "integrityDigest"> = {
      schemaVersion: "1.0", reuseId,
      tenantId: input.tenantId, runtimeFamily: input.runtimeFamily, capabilityKey: input.capabilityKey,
      capabilityVersion: input.capabilityVersion, capabilityQualificationDigest: input.capabilityQualificationDigest,
      retainedEvidenceDigest: row.evidence_digest, consumerPlanDigest: input.consumerPlanDigest,
      consumerWorkItemId: input.consumerWorkItemId, reusedAt,
    };
    const receipt = { ...unsigned, integrityDigest: composedRecoveryDigest(unsigned) };
    this.database.prepare("INSERT OR IGNORE INTO composed_reuse_receipts VALUES (?, ?)").run(reuseId, JSON.stringify(receipt));
    return receipt;
  }

  retainedStatus(tenantId: string, runtimeFamily: string, capabilityKey: string): "active" | "invalidated" | "missing" {
    const row = this.database.prepare(`SELECT capability_version, qualification_digest, evidence_digest, status
      FROM composed_retained_capabilities WHERE tenant_id=? AND runtime_family=? AND capability_key=?`)
      .get(tenantId, runtimeFamily, capabilityKey) as unknown as RetainedRow | undefined;
    return row?.status ?? "missing";
  }

  async resumeParent(input: {
    binding: ParentResumptionBinding;
    aggregateEvidenceDigest: string;
    itemReceipts: ComposedRecoveryReceipt[];
    driver: ParentResumptionDriver;
    fault?: ComposedRecoveryFaultInjector;
  }): Promise<ParentResumptionReceipt> {
    const bindingSchema = z.object({
      schemaVersion: z.literal("1.0"), tenantId: identifier, parentGoalId: identifier,
      planId: identifier, planDigest: digestSchema, stateVersion: z.number().int().nonnegative(),
    }).strict();
    const binding = bindingSchema.parse(input.binding);
    digestSchema.parse(input.aggregateEvidenceDigest);
    if (input.itemReceipts.length === 0) throw new Error("Parent resumption requires at least one verified work item.");
    for (const receipt of input.itemReceipts) {
      assertComposedRecoveryReceiptIntegrity(receipt);
      if (!receipt.verifiedCompletion || receipt.context.tenantId !== binding.tenantId
        || receipt.context.parentGoalId !== binding.parentGoalId || receipt.context.planId !== binding.planId
        || receipt.context.planDigest !== binding.planDigest) {
        throw new Error("Parent resumption item evidence is incomplete or belongs to another bound plan.");
      }
    }
    const itemRecoveryDigests = [...new Set(input.itemReceipts.map((item) => item.integrityDigest))].sort();
    if (itemRecoveryDigests.length !== input.itemReceipts.length) throw new Error("Parent resumption cannot accept duplicate work-item evidence.");
    const resumptionKey = `parent.${composedRecoveryDigest({ binding, aggregateEvidenceDigest: input.aggregateEvidenceDigest, itemRecoveryDigests }).slice(0, 40)}`;
    const bindingJson = canonical({ binding, aggregateEvidenceDigest: input.aggregateEvidenceDigest, itemRecoveryDigests });
    this.database.prepare("INSERT OR IGNORE INTO composed_parent_resumptions (resumption_key, binding_json, status) VALUES (?, ?, 'pending')")
      .run(resumptionKey, bindingJson);
    const before = this.database.prepare("SELECT * FROM composed_parent_resumptions WHERE resumption_key = ?")
      .get(resumptionKey) as unknown as ParentRow;
    if (before.binding_json !== bindingJson) throw new Error("Parent resumption key is bound to different evidence.");
    if (before.status === "completed" && before.receipt_json) {
      const receipt = JSON.parse(before.receipt_json) as ParentResumptionReceipt;
      if (receipt.integrityDigest !== composedRecoveryDigest(unsignedParent(receipt))) throw new Error("Parent resumption receipt integrity failed.");
      return receipt;
    }

    let external: { receiptDigest: string; evidenceDigest: string };
    let reconciledAfterLostResponse = before.attempts > 0;
    if (before.attempts === 0) {
      input.fault?.("before-parent-resumption");
      const claimed = this.database.prepare("UPDATE composed_parent_resumptions SET attempts=1 WHERE resumption_key=? AND attempts=0")
        .run(resumptionKey);
      if (claimed.changes !== 1) throw new Error("Parent resumption could not be claimed exactly once.");
      try {
        external = await input.driver.resume({ binding, aggregateEvidenceDigest: input.aggregateEvidenceDigest, itemRecoveryDigests, resumptionKey });
        digestSchema.parse(external.receiptDigest); digestSchema.parse(external.evidenceDigest);
      } catch {
        reconciledAfterLostResponse = true;
        input.fault?.("lost-parent-response");
        input.fault?.("before-parent-reconciliation");
        const reconciled = await input.driver.reconcile({ binding, aggregateEvidenceDigest: input.aggregateEvidenceDigest, resumptionKey });
        input.fault?.("after-parent-reconciliation");
        digestSchema.parse(reconciled.evidenceDigest);
        if (reconciled.classification !== "completed" || !reconciled.receiptDigest) {
          throw new Error(`Parent resumption remains unresolved after ${reconciled.classification}: ${reconciled.detail}`);
        }
        digestSchema.parse(reconciled.receiptDigest);
        external = { receiptDigest: reconciled.receiptDigest, evidenceDigest: reconciled.evidenceDigest };
      }
    } else {
      input.fault?.("before-parent-reconciliation");
      const reconciled = await input.driver.reconcile({ binding, aggregateEvidenceDigest: input.aggregateEvidenceDigest, resumptionKey });
      input.fault?.("after-parent-reconciliation");
      digestSchema.parse(reconciled.evidenceDigest);
      if (reconciled.classification !== "completed" || !reconciled.receiptDigest) {
        throw new Error(`Parent resumption remains unresolved after ${reconciled.classification}: ${reconciled.detail}`);
      }
      digestSchema.parse(reconciled.receiptDigest);
      external = { receiptDigest: reconciled.receiptDigest, evidenceDigest: reconciled.evidenceDigest };
    }

    input.fault?.("before-parent-commit");
    const completedAt = this.now();
    const unsigned: Omit<ParentResumptionReceipt, "integrityDigest"> = {
      schemaVersion: "1.0", resumptionKey, binding, aggregateEvidenceDigest: input.aggregateEvidenceDigest,
      itemRecoveryDigests, externalReceiptDigest: external.receiptDigest,
      externalEvidenceDigest: external.evidenceDigest, reconciledAfterLostResponse, completedAt,
    };
    const receipt = { ...unsigned, integrityDigest: composedRecoveryDigest(unsigned) };
    this.database.prepare("UPDATE composed_parent_resumptions SET status='completed', receipt_json=? WHERE resumption_key=?")
      .run(JSON.stringify(receipt), resumptionKey);
    return receipt;
  }

  close(): void { this.database.close(); }

  private invalidateBoundCapability(context: ComposedRecoveryContext): void {
    this.database.prepare(`UPDATE composed_retained_capabilities SET status='invalidated', updated_at=?
      WHERE tenant_id=? AND runtime_family=? AND capability_key=?`)
      .run(this.now(), context.tenantId, context.runtimeFamily, context.capabilityKey);
  }
}
