import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  REQUIRED_PILOT_ADAPTER_CASES,
  type PilotAdapterAcceptanceCase,
  type PilotAdapterAcceptanceResult,
} from "./pilot-adapter.js";

export const GENERIC_ACCEPTANCE_EXECUTOR_SCHEMA_VERSION = "1.0" as const;

export type GenericAcceptanceCaseStatus =
  | "declared-not-run"
  | "executing"
  | "reconciliation-required"
  | "passed"
  | "failed"
  | "safety-aborted";

export type GenericAcceptanceCampaignStatus =
  | "prepared"
  | "running"
  | "awaiting-reconciliation"
  | "completed"
  | "failed"
  | "safety-aborted";

export interface GenericAcceptanceAttemptContext {
  campaignId: string;
  caseId: PilotAdapterAcceptanceCase;
  attemptId: string;
  attemptNumber: number;
  declarationDigest: string;
  previousReceiptHash?: string;
}

/**
 * The reusable executor owns campaign safety and accounting. This deliberately
 * narrow binding is the only place where a customer world may perform or
 * reconcile case-specific behavior.
 */
export interface GenericAcceptanceBinding {
  bindingId: string;
  bindingVersion: string;
  /** Digest of the reviewed customer-world implementation and contracts. */
  bindingDigest: string;
  caseIds: readonly PilotAdapterAcceptanceCase[];
  execute(caseId: PilotAdapterAcceptanceCase, context: GenericAcceptanceAttemptContext): Promise<PilotAdapterAcceptanceResult>;
  /**
   * Reconcile a case whose process ended after execution began but before a
   * valid result was durably recorded. It must inspect independent external
   * state; it must never blindly repeat the action.
   */
  reconcileInterrupted?(
    caseId: PilotAdapterAcceptanceCase,
    context: GenericAcceptanceAttemptContext,
  ): Promise<PilotAdapterAcceptanceResult>;
}

export interface GenericAcceptanceEvidenceReceipt {
  schemaVersion: typeof GENERIC_ACCEPTANCE_EXECUTOR_SCHEMA_VERSION;
  campaignId: string;
  caseId: PilotAdapterAcceptanceCase;
  attemptId: string;
  attemptNumber: number;
  source: "execution" | "interrupted-reconciliation";
  bindingId: string;
  bindingVersion: string;
  bindingDigest: string;
  declarationDigest: string;
  result: PilotAdapterAcceptanceResult;
  previousReceiptHash?: string;
  receiptHash: string;
}

export interface GenericAcceptanceCaseRecord {
  caseId: PilotAdapterAcceptanceCase;
  status: GenericAcceptanceCaseStatus;
  attemptCount: number;
  activeAttemptId?: string;
  activeAttemptStartedAt?: string;
  latestReceiptHash?: string;
  lastError?: string;
}

export interface GenericAcceptanceCampaignState {
  schemaVersion: typeof GENERIC_ACCEPTANCE_EXECUTOR_SCHEMA_VERSION;
  campaignId: string;
  declarationDigest: string;
  bindingId: string;
  bindingVersion: string;
  bindingDigest: string;
  requiredCaseOrder: PilotAdapterAcceptanceCase[];
  status: GenericAcceptanceCampaignStatus;
  revision: number;
  cases: GenericAcceptanceCaseRecord[];
  receipts: GenericAcceptanceEvidenceReceipt[];
  createdAt: string;
  updatedAt: string;
}

export interface GenericAcceptanceCampaignSummary {
  campaignId: string;
  status: GenericAcceptanceCampaignStatus;
  passed: boolean;
  abortedForSafety: boolean;
  awaitingReconciliation: boolean;
  declaredCases: number;
  executedCases: number;
  reconciledCases: number;
  passedCases: number;
  failedCases: PilotAdapterAcceptanceCase[];
  notRunCases: PilotAdapterAcceptanceCase[];
  incorrectSideEffects: number;
  latestReceiptHash?: string;
  state: GenericAcceptanceCampaignState;
}

export interface GenericAcceptanceCampaignStore {
  load(campaignId: string): Promise<GenericAcceptanceCampaignState | null>;
  save(state: GenericAcceptanceCampaignState, expectedRevision: number | null): Promise<void>;
}

interface StoredCampaignEnvelope {
  schemaVersion: typeof GENERIC_ACCEPTANCE_EXECUTOR_SCHEMA_VERSION;
  state: GenericAcceptanceCampaignState;
  integrityDigest: string;
}

const identifier = /^[a-z][a-z0-9_-]{2,159}$/;
const semver = /^\d+\.\d+\.\d+$/;
const sha256 = /^[a-f0-9]{64}$/;

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

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function exactRequiredOrder(caseIds: readonly PilotAdapterAcceptanceCase[]): boolean {
  return caseIds.length === REQUIRED_PILOT_ADAPTER_CASES.length
    && caseIds.every((caseId, index) => caseId === REQUIRED_PILOT_ADAPTER_CASES[index]);
}

function assertCampaignId(campaignId: string): void {
  if (!identifier.test(campaignId)) throw new Error("Acceptance campaign ID must be a stable lowercase identifier.");
}

function assertBinding(binding: GenericAcceptanceBinding): void {
  if (!identifier.test(binding.bindingId)) throw new Error("Acceptance binding ID must be a stable lowercase identifier.");
  if (!semver.test(binding.bindingVersion)) throw new Error("Acceptance binding version must use semantic versioning.");
  if (!sha256.test(binding.bindingDigest)) throw new Error("Acceptance binding must provide a reviewed SHA-256 digest.");
  if (!exactRequiredOrder(binding.caseIds)) {
    throw new Error("Acceptance binding must declare all ten mandatory cases in the precommitted order.");
  }
}

function assertStoredIdentity(state: GenericAcceptanceCampaignState, binding: GenericAcceptanceBinding, declarationDigest: string): void {
  if (state.declarationDigest !== declarationDigest) throw new Error("Acceptance declaration changed after campaign preparation.");
  if (state.bindingId !== binding.bindingId || state.bindingVersion !== binding.bindingVersion || state.bindingDigest !== binding.bindingDigest) {
    throw new Error("Acceptance binding identity changed after campaign preparation.");
  }
  if (!exactRequiredOrder(state.requiredCaseOrder)) throw new Error("Stored acceptance case order is invalid.");
}

function validateResult(result: PilotAdapterAcceptanceResult, expectedCaseId: PilotAdapterAcceptanceCase): void {
  if (result.caseId !== expectedCaseId) {
    throw new Error(`Acceptance binding returned ${result.caseId} while running ${expectedCaseId}.`);
  }
  if (!Number.isInteger(result.intendedWrites) || result.intendedWrites < 0) {
    throw new Error(`Acceptance case ${expectedCaseId} returned an invalid intended-write count.`);
  }
  if (!Number.isInteger(result.incorrectSideEffects) || result.incorrectSideEffects < 0) {
    throw new Error(`Acceptance case ${expectedCaseId} returned an invalid incorrect-side-effect count.`);
  }
  if (result.checks.length === 0 || new Set(result.checks.map((item) => item.id)).size !== result.checks.length) {
    throw new Error(`Acceptance case ${expectedCaseId} must return non-empty, uniquely identified checks.`);
  }
  if (result.artifactReferences.length === 0 || new Set(result.artifactReferences).size !== result.artifactReferences.length) {
    throw new Error(`Acceptance case ${expectedCaseId} must return non-empty, unique evidence references.`);
  }
  if (result.artifactReferences.some((reference) => /^(?:action-?response|execution-?response|self-?reported):/i.test(reference))) {
    throw new Error(`Acceptance case ${expectedCaseId} cannot use an action response as independent evidence.`);
  }
  if (!Number.isFinite(Date.parse(result.completedAt))) {
    throw new Error(`Acceptance case ${expectedCaseId} returned an invalid completion timestamp.`);
  }
  const failedChecks = result.checks.filter((item) => !item.passed);
  if (result.passed && (failedChecks.length > 0 || result.incorrectSideEffects > 0)) {
    throw new Error(`Acceptance case ${expectedCaseId} claimed success despite failed checks or surviving incorrect effects.`);
  }
  if (!result.passed && failedChecks.length === 0) {
    throw new Error(`Acceptance case ${expectedCaseId} claimed failure without a failed check.`);
  }
}

function receiptFor(
  state: GenericAcceptanceCampaignState,
  record: GenericAcceptanceCaseRecord,
  source: GenericAcceptanceEvidenceReceipt["source"],
  result: PilotAdapterAcceptanceResult,
): GenericAcceptanceEvidenceReceipt {
  if (!record.activeAttemptId) throw new Error(`Acceptance case ${record.caseId} has no active attempt identity.`);
  const previousReceiptHash = state.receipts.at(-1)?.receiptHash;
  const withoutHash = {
    schemaVersion: GENERIC_ACCEPTANCE_EXECUTOR_SCHEMA_VERSION,
    campaignId: state.campaignId,
    caseId: record.caseId,
    attemptId: record.activeAttemptId,
    attemptNumber: record.attemptCount,
    source,
    bindingId: state.bindingId,
    bindingVersion: state.bindingVersion,
    bindingDigest: state.bindingDigest,
    declarationDigest: state.declarationDigest,
    result: clone(result),
    ...(previousReceiptHash ? { previousReceiptHash } : {}),
  };
  return { ...withoutHash, receiptHash: digest(withoutHash) };
}

function summarize(state: GenericAcceptanceCampaignState): GenericAcceptanceCampaignSummary {
  const failedCases = state.cases.filter((item) => item.status === "failed" || item.status === "safety-aborted").map((item) => item.caseId);
  const notRunCases = state.cases.filter((item) => item.status === "declared-not-run").map((item) => item.caseId);
  const incorrectSideEffects = state.receipts.reduce((total, item) => total + item.result.incorrectSideEffects, 0);
  const reconciledCases = state.receipts.filter((item) => item.source === "interrupted-reconciliation").length;
  const latestReceiptHash = state.receipts.at(-1)?.receiptHash;
  return {
    campaignId: state.campaignId,
    status: state.status,
    passed: state.status === "completed" && state.cases.every((item) => item.status === "passed") && incorrectSideEffects === 0,
    abortedForSafety: state.status === "safety-aborted",
    awaitingReconciliation: state.status === "awaiting-reconciliation",
    declaredCases: state.cases.length,
    executedCases: state.receipts.length,
    reconciledCases,
    passedCases: state.cases.filter((item) => item.status === "passed").length,
    failedCases,
    notRunCases,
    incorrectSideEffects,
    ...(latestReceiptHash ? { latestReceiptHash } : {}),
    state: clone(state),
  };
}

function fileNameForCampaign(campaignId: string): string {
  assertCampaignId(campaignId);
  return `${campaignId}.generic-acceptance.json`;
}

/** Customer-local JSON store with tamper detection and atomic replacement. */
export class JsonFileGenericAcceptanceCampaignStore implements GenericAcceptanceCampaignStore {
  constructor(private readonly directory: string) {}

  async load(campaignId: string): Promise<GenericAcceptanceCampaignState | null> {
    const filePath = path.join(this.directory, fileNameForCampaign(campaignId));
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const envelope = JSON.parse(raw) as StoredCampaignEnvelope;
    if (envelope.schemaVersion !== GENERIC_ACCEPTANCE_EXECUTOR_SCHEMA_VERSION) {
      throw new Error("Unsupported generic acceptance campaign schema.");
    }
    if (envelope.integrityDigest !== digest(envelope.state)) {
      throw new Error("Generic acceptance campaign state failed its integrity check.");
    }
    if (envelope.state.campaignId !== campaignId) throw new Error("Generic acceptance campaign file has the wrong identity.");
    return clone(envelope.state);
  }

  async save(state: GenericAcceptanceCampaignState, expectedRevision: number | null): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const existing = await this.load(state.campaignId);
    if (expectedRevision === null ? existing !== null : existing?.revision !== expectedRevision) {
      throw new Error("Generic acceptance campaign revision conflict; refusing to overwrite newer accounting state.");
    }
    const filePath = path.join(this.directory, fileNameForCampaign(state.campaignId));
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const envelope: StoredCampaignEnvelope = {
      schemaVersion: GENERIC_ACCEPTANCE_EXECUTOR_SCHEMA_VERSION,
      state: clone(state),
      integrityDigest: digest(state),
    };
    await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, filePath);
  }
}

export class InMemoryGenericAcceptanceCampaignStore implements GenericAcceptanceCampaignStore {
  private readonly states = new Map<string, GenericAcceptanceCampaignState>();

  async load(campaignId: string): Promise<GenericAcceptanceCampaignState | null> {
    return this.states.has(campaignId) ? clone(this.states.get(campaignId)!) : null;
  }

  async save(state: GenericAcceptanceCampaignState, expectedRevision: number | null): Promise<void> {
    const existing = this.states.get(state.campaignId);
    if (expectedRevision === null ? existing !== undefined : existing?.revision !== expectedRevision) {
      throw new Error("Generic acceptance campaign revision conflict; refusing to overwrite newer accounting state.");
    }
    this.states.set(state.campaignId, clone(state));
  }
}

export interface PrepareGenericAcceptanceCampaignOptions {
  campaignId: string;
  declarationDigest: string;
  binding: GenericAcceptanceBinding;
  store: GenericAcceptanceCampaignStore;
  now?: () => string;
}

/** Persist the ten declared cases without implying that any case was executed. */
export async function prepareGenericAcceptanceCampaign(
  options: PrepareGenericAcceptanceCampaignOptions,
): Promise<GenericAcceptanceCampaignSummary> {
  assertCampaignId(options.campaignId);
  assertBinding(options.binding);
  if (!sha256.test(options.declarationDigest)) throw new Error("Acceptance declaration must provide a reviewed SHA-256 digest.");
  const existing = await options.store.load(options.campaignId);
  if (existing) {
    assertStoredIdentity(existing, options.binding, options.declarationDigest);
    return summarize(existing);
  }
  const now = (options.now ?? (() => new Date().toISOString()))();
  const state: GenericAcceptanceCampaignState = {
    schemaVersion: GENERIC_ACCEPTANCE_EXECUTOR_SCHEMA_VERSION,
    campaignId: options.campaignId,
    declarationDigest: options.declarationDigest,
    bindingId: options.binding.bindingId,
    bindingVersion: options.binding.bindingVersion,
    bindingDigest: options.binding.bindingDigest,
    requiredCaseOrder: [...REQUIRED_PILOT_ADAPTER_CASES],
    status: "prepared",
    revision: 0,
    cases: REQUIRED_PILOT_ADAPTER_CASES.map((caseId) => ({ caseId, status: "declared-not-run", attemptCount: 0 })),
    receipts: [],
    createdAt: now,
    updatedAt: now,
  };
  await options.store.save(state, null);
  return summarize(state);
}

export interface RunGenericAcceptanceCampaignOptions extends PrepareGenericAcceptanceCampaignOptions {}

async function persist(
  store: GenericAcceptanceCampaignStore,
  state: GenericAcceptanceCampaignState,
  now: () => string,
): Promise<void> {
  const expectedRevision = state.revision;
  state.revision += 1;
  state.updatedAt = now();
  await store.save(state, expectedRevision);
}

function attemptContext(state: GenericAcceptanceCampaignState, record: GenericAcceptanceCaseRecord): GenericAcceptanceAttemptContext {
  if (!record.activeAttemptId) throw new Error(`Acceptance case ${record.caseId} has no active attempt identity.`);
  const previousReceiptHash = state.receipts.at(-1)?.receiptHash;
  return {
    campaignId: state.campaignId,
    caseId: record.caseId,
    attemptId: record.activeAttemptId,
    attemptNumber: record.attemptCount,
    declarationDigest: state.declarationDigest,
    ...(previousReceiptHash ? { previousReceiptHash } : {}),
  };
}

/**
 * Execute or safely resume a fixed ten-case campaign. An interrupted case is
 * never executed a second time: only its explicit independent reconciliation
 * binding may resolve it.
 */
export async function runGenericAcceptanceCampaign(
  options: RunGenericAcceptanceCampaignOptions,
): Promise<GenericAcceptanceCampaignSummary> {
  await prepareGenericAcceptanceCampaign(options);
  const now = options.now ?? (() => new Date().toISOString());
  const state = await options.store.load(options.campaignId);
  if (!state) throw new Error("Prepared generic acceptance campaign could not be loaded.");
  assertStoredIdentity(state, options.binding, options.declarationDigest);
  if (["completed", "failed", "safety-aborted"].includes(state.status)) return summarize(state);

  state.status = "running";
  await persist(options.store, state, now);

  for (const caseId of REQUIRED_PILOT_ADAPTER_CASES) {
    const record = state.cases.find((item) => item.caseId === caseId);
    if (!record) throw new Error(`Stored acceptance campaign is missing ${caseId}.`);
    if (record.status === "passed" || record.status === "failed") continue;
    if (record.status === "safety-aborted") {
      state.status = "safety-aborted";
      await persist(options.store, state, now);
      return summarize(state);
    }

    const isReconciliation = record.status === "executing" || record.status === "reconciliation-required";
    if (!isReconciliation) {
      record.attemptCount += 1;
      record.activeAttemptId = randomUUID();
      record.activeAttemptStartedAt = now();
      record.status = "executing";
      delete record.lastError;
      await persist(options.store, state, now);
    } else if (!options.binding.reconcileInterrupted) {
      record.status = "reconciliation-required";
      record.lastError = "Execution began without a durable result; this binding has no independent reconciliation implementation.";
      state.status = "awaiting-reconciliation";
      await persist(options.store, state, now);
      return summarize(state);
    }

    let result: PilotAdapterAcceptanceResult;
    try {
      result = isReconciliation
        ? await options.binding.reconcileInterrupted!(caseId, attemptContext(state, record))
        : await options.binding.execute(caseId, attemptContext(state, record));
      validateResult(result, caseId);
    } catch (error) {
      record.status = "reconciliation-required";
      record.lastError = error instanceof Error ? error.message : String(error);
      state.status = "awaiting-reconciliation";
      await persist(options.store, state, now);
      return summarize(state);
    }

    const receipt = receiptFor(state, record, isReconciliation ? "interrupted-reconciliation" : "execution", result);
    state.receipts.push(receipt);
    record.latestReceiptHash = receipt.receiptHash;
    delete record.activeAttemptId;
    delete record.activeAttemptStartedAt;
    delete record.lastError;
    record.status = result.incorrectSideEffects > 0 ? "safety-aborted" : result.passed ? "passed" : "failed";
    if (result.incorrectSideEffects > 0) {
      state.status = "safety-aborted";
      await persist(options.store, state, now);
      return summarize(state);
    }
    await persist(options.store, state, now);
  }

  state.status = state.cases.every((item) => item.status === "passed") ? "completed" : "failed";
  await persist(options.store, state, now);
  return summarize(state);
}
