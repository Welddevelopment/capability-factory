import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  generateAcceptancePlanFromReviewedContracts,
  onboardingAcceptanceSourceDigest,
  type OnboardingAcceptancePlan,
  type ReviewedOnboardingContractsInput,
} from "./onboarding-acceptance-factory.js";
import {
  discoverAdapterProposal,
  type AdapterDiscoveryInput,
  type AdapterDiscoveryProposal,
} from "./onboarding-adapter-factory.js";
import {
  compileAuthorityWizard,
  proposeExternalOutcomeVerifier,
  type AuthorityWizardAnswers,
  type AuthorityWizardCompilation,
  type ProvisionalVerifierContract,
  type VerifierFactoryIntake,
} from "./onboarding-verifier-authority.js";

export const ONBOARDING_PREPARATION_WORKFLOW_VERSION = "1.0" as const;

const identifier = z.string().min(2).max(180).regex(/^[a-zA-Z][a-zA-Z0-9_.-]+$/);
const semanticVersion = z.string().regex(/^\d+\.\d+\.\d+$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/).refine((value) => !/^0+$/.test(value), "Digest cannot be an all-zero placeholder.");

export interface StartOnboardingPreparationInput {
  schemaVersion: typeof ONBOARDING_PREPARATION_WORKFLOW_VERSION;
  sessionId: string;
  tenantId: string;
  adapterId: string;
  adapterVersion: string;
  adapter: AdapterDiscoveryInput;
  verifier: VerifierFactoryIntake;
  authority: AuthorityWizardAnswers;
  executionDriverId: string;
  duplicatePrevention: ReviewedOnboardingContractsInput["duplicatePrevention"];
  resetStrategy: ReviewedOnboardingContractsInput["resetStrategy"];
  persistence: ReviewedOnboardingContractsInput["persistence"];
}

export interface ConfirmOnboardingPreparationInput {
  sessionId: string;
  expectedInputDigest: string;
  expectedSnapshotDigest: string;
  review: ReviewedOnboardingContractsInput["review"];
}

export type OnboardingPreparationStatus =
  | "blocked"
  | "review-required"
  | "acceptance-scaffold-ready";

export interface OnboardingPreparationReceipt {
  readiness: "blocked" | "review-required" | "comparison-preparation-ready";
  activation: "not-activated";
  adapterProposalState: "proposal-only";
  verifierState: ProvisionalVerifierContract["status"];
  authorityState: AuthorityWizardCompilation["status"];
  acceptanceState: "not-generated" | "declared-not-run";
  suppliedByCustomerOrEngineer: string[];
  generatedByCapabilityFactory: string[];
  confirmationsRequired: string[];
  implementationWorkRemaining: string[];
  evidenceBoundary: string;
}

export interface OnboardingPreparationSnapshot {
  schemaVersion: typeof ONBOARDING_PREPARATION_WORKFLOW_VERSION;
  sessionId: string;
  tenantId: string;
  adapterId: string;
  adapterVersion: string;
  status: OnboardingPreparationStatus;
  activation: "not-activated";
  inputDigest: string;
  revision: number;
  adapterProposal: AdapterDiscoveryProposal;
  verifierContract: ProvisionalVerifierContract;
  authorityCompilation: AuthorityWizardCompilation;
  acceptancePlan?: OnboardingAcceptancePlan;
  blockers: string[];
  receipt: OnboardingPreparationReceipt;
  createdAt: string;
  updatedAt: string;
  snapshotDigest: string;
}

export interface OnboardingPreparationEvent {
  sequence: number;
  sessionId: string;
  eventType: "preparation-proposed" | "preparation-reviewed";
  snapshotDigest: string;
  occurredAt: string;
}

interface StoredPreparationSource {
  executionDriverId: string;
  duplicatePrevention: ReviewedOnboardingContractsInput["duplicatePrevention"];
  resetStrategy: ReviewedOnboardingContractsInput["resetStrategy"];
  persistence: ReviewedOnboardingContractsInput["persistence"];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function snapshotPayload(snapshot: Omit<OnboardingPreparationSnapshot, "snapshotDigest"> | OnboardingPreparationSnapshot): unknown {
  const { snapshotDigest: _snapshotDigest, ...payload } = snapshot as OnboardingPreparationSnapshot;
  return payload;
}

function finalizeSnapshot(snapshot: Omit<OnboardingPreparationSnapshot, "snapshotDigest">): OnboardingPreparationSnapshot {
  return { ...snapshot, snapshotDigest: digest(snapshot) };
}

function assertSnapshotIntegrity(snapshot: OnboardingPreparationSnapshot): void {
  if (digest(snapshotPayload(snapshot)) !== snapshot.snapshotDigest) {
    throw new Error("Durable onboarding preparation snapshot failed its integrity check.");
  }
}

function validateStartMetadata(input: StartOnboardingPreparationInput): void {
  if (input.schemaVersion !== ONBOARDING_PREPARATION_WORKFLOW_VERSION) throw new Error("Unsupported onboarding preparation schema version.");
  identifier.parse(input.sessionId);
  identifier.parse(input.tenantId);
  identifier.parse(input.adapterId);
  semanticVersion.parse(input.adapterVersion);
  identifier.parse(input.executionDriverId);
}

function proposalCanReachReview(proposal: AdapterDiscoveryProposal): boolean {
  const requested = proposal.operations.filter((operation) => operation.requestedByWorkflow.value);
  return requested.length > 0
    && proposal.scopeWorkflow.operationIds.status !== "unknown"
    && requested.every((operation) => operation.consequence.value !== "unknown")
    && requested.every((operation) => operation.targetAlias.value.length > 0);
}

function receiptFor(
  status: OnboardingPreparationStatus,
  adapter: AdapterDiscoveryProposal,
  verifier: ProvisionalVerifierContract,
  authority: AuthorityWizardCompilation,
  acceptancePlan?: OnboardingAcceptancePlan,
): OnboardingPreparationReceipt {
  const adapterUnknowns = adapter.unknowns.map((item) => item.value);
  const supersededProposalBlockers = acceptancePlan
    ? new Set(["authority-unconfigured", "verifier-unconfigured", "acceptance-not-run", "reconciliation-unproven"])
    : new Set<string>();
  const implementationWorkRemaining = unique([
    ...adapterUnknowns,
    ...adapter.engineeringBlockers
      .filter((item) => !supersededProposalBlockers.has(item.blockerId))
      .map((item) => item.fact.value),
    ...verifier.unknowns,
    ...verifier.blockers,
    ...authority.blockers,
    ...(acceptancePlan?.blockers ?? []),
    ...(acceptancePlan ? ["Execute every declared acceptance case and review its independent evidence before activation."] : []),
  ]);
  return {
    readiness: status === "acceptance-scaffold-ready"
      ? "comparison-preparation-ready"
      : status === "review-required" ? "review-required" : "blocked",
    activation: "not-activated",
    adapterProposalState: "proposal-only",
    verifierState: verifier.status,
    authorityState: authority.status,
    acceptanceState: acceptancePlan ? "declared-not-run" : "not-generated",
    suppliedByCustomerOrEngineer: [
      "bounded workflow and observable business outcome",
      "approved system material and credential aliases",
      "explicit authority, approval, limit, retry and handoff answers",
      "approved independent observation surface and disposable reset strategy",
    ],
    generatedByCapabilityFactory: [
      "provenance-bound adapter and operation proposal",
      "provisional verifier contract and ordinary-language authority compilation",
      "fixed ten-case acceptance scaffold after exact review",
      "integrity-bound readiness receipt and durable event history",
    ],
    confirmationsRequired: status === "review-required"
      ? [
        "review exact adapter, verifier and authority digests",
        "bind the customer-local authority runtime and independent observation adapter",
        "confirm the disposable environment and duplicate-prevention mechanism",
      ]
      : status === "blocked" ? ["resolve every named blocker before consequential review"] : [],
    implementationWorkRemaining,
    evidenceBoundary: acceptancePlan
      ? "The acceptance campaign is declared, not executed. Preparation readiness grants no authority, proves no case, and activates nothing."
      : "Generated proposals are non-executable and non-authorizing. They are not passing evidence or activation approval.",
  };
}

/**
 * Customer-local, preparation-only workflow. It makes the existing factories
 * resumable and integrity-bound while deliberately stopping before execution,
 * acceptance evidence, or activation.
 */
export class DurableOnboardingPreparationWorkflow {
  private readonly database: DatabaseSync;
  private readonly now: () => string;

  constructor(databasePath = ":memory:", options: { now?: () => string } = {}) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.now = options.now ?? (() => new Date().toISOString());
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS onboarding_preparations (
        session_id TEXT PRIMARY KEY,
        input_digest TEXT NOT NULL,
        source_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS onboarding_preparation_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `);
  }

  start(input: StartOnboardingPreparationInput): OnboardingPreparationSnapshot {
    validateStartMetadata(input);
    const inputDigest = digest(input);
    const existing = this.database.prepare("SELECT input_digest FROM onboarding_preparations WHERE session_id = ?").get(input.sessionId) as { input_digest: string } | undefined;
    if (existing) {
      if (existing.input_digest !== inputDigest) throw new Error("Onboarding session identity is already bound to different input.");
      return this.read(input.sessionId);
    }

    const adapterProposal = discoverAdapterProposal(input.adapter);
    const verifierResult = proposeExternalOutcomeVerifier(input.verifier);
    const verifierContract = verifierResult.contract;
    const authorityCompilation = compileAuthorityWizard(input.authority);
    const canReview = proposalCanReachReview(adapterProposal)
      && verifierResult.status === "proposed"
      && verifierContract.status === "provisional-review-required"
      && authorityCompilation.status === "review-required"
      && authorityCompilation.candidateAuthority !== undefined;
    const status: OnboardingPreparationStatus = canReview ? "review-required" : "blocked";
    const blockers = unique([
      ...(canReview ? [] : adapterProposal.engineeringBlockers.map((item) => item.blockerId)),
      ...verifierContract.blockers,
      ...authorityCompilation.blockers,
      ...(verifierResult.status === "rejected" ? verifierResult.validationErrors : []),
      ...authorityCompilation.validationErrors,
    ]);
    const timestamp = this.now();
    const snapshot = finalizeSnapshot({
      schemaVersion: ONBOARDING_PREPARATION_WORKFLOW_VERSION,
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      adapterId: input.adapterId,
      adapterVersion: input.adapterVersion,
      status,
      activation: "not-activated",
      inputDigest,
      revision: 1,
      adapterProposal,
      verifierContract,
      authorityCompilation,
      blockers,
      receipt: receiptFor(status, adapterProposal, verifierContract, authorityCompilation),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const source: StoredPreparationSource = {
      executionDriverId: input.executionDriverId,
      duplicatePrevention: input.duplicatePrevention,
      resetStrategy: structuredClone(input.resetStrategy),
      persistence: structuredClone(input.persistence),
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO onboarding_preparations (session_id, input_digest, source_json, snapshot_json, snapshot_digest)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.sessionId, inputDigest, JSON.stringify(source), JSON.stringify(snapshot), snapshot.snapshotDigest);
      this.appendEvent(input.sessionId, "preparation-proposed", snapshot.snapshotDigest, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return structuredClone(snapshot);
  }

  confirmReview(input: ConfirmOnboardingPreparationInput): OnboardingPreparationSnapshot {
    identifier.parse(input.sessionId);
    digestSchema.parse(input.expectedInputDigest);
    digestSchema.parse(input.expectedSnapshotDigest);
    const current = this.read(input.sessionId);
    if (current.inputDigest !== input.expectedInputDigest) throw new Error("Onboarding review input digest does not match the durable session.");
    if (current.snapshotDigest !== input.expectedSnapshotDigest) throw new Error("Onboarding review is stale; reload the latest durable snapshot.");
    if (current.status !== "review-required") throw new Error("Onboarding preparation is not eligible for consequential review.");
    const row = this.database.prepare("SELECT source_json FROM onboarding_preparations WHERE session_id = ?").get(input.sessionId) as { source_json: string } | undefined;
    if (!row) throw new Error("Onboarding preparation session does not exist.");
    const source = JSON.parse(row.source_json) as StoredPreparationSource;
    const plan = generateAcceptancePlanFromReviewedContracts({
      adapterId: current.adapterId,
      adapterVersion: current.adapterVersion,
      adapterProposal: current.adapterProposal,
      verifierContract: current.verifierContract,
      authorityCompilation: current.authorityCompilation,
      executionDriverId: source.executionDriverId,
      duplicatePrevention: source.duplicatePrevention,
      resetStrategy: source.resetStrategy,
      persistence: source.persistence,
      review: structuredClone(input.review),
    });
    const status: OnboardingPreparationStatus = plan.blockers.length === 0 ? "acceptance-scaffold-ready" : "blocked";
    const timestamp = this.now();
    const { snapshotDigest: _previousSnapshotDigest, ...currentPayload } = current;
    const updated = finalizeSnapshot({
      ...currentPayload,
      status,
      activation: "not-activated",
      revision: current.revision + 1,
      acceptancePlan: plan,
      blockers: [...plan.blockers],
      receipt: receiptFor(status, current.adapterProposal, current.verifierContract, current.authorityCompilation, plan),
      updatedAt: timestamp,
    });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE onboarding_preparations
        SET snapshot_json = ?, snapshot_digest = ?
        WHERE session_id = ? AND snapshot_digest = ?
      `).run(JSON.stringify(updated), updated.snapshotDigest, input.sessionId, input.expectedSnapshotDigest);
      if (Number(result.changes) !== 1) throw new Error("Onboarding preparation changed concurrently; review was not recorded.");
      this.appendEvent(input.sessionId, "preparation-reviewed", updated.snapshotDigest, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return structuredClone(updated);
  }

  read(sessionId: string): OnboardingPreparationSnapshot {
    identifier.parse(sessionId);
    const row = this.database.prepare(`
      SELECT input_digest, snapshot_json, snapshot_digest
      FROM onboarding_preparations WHERE session_id = ?
    `).get(sessionId) as { input_digest: string; snapshot_json: string; snapshot_digest: string } | undefined;
    if (!row) throw new Error("Onboarding preparation session does not exist.");
    const snapshot = JSON.parse(row.snapshot_json) as OnboardingPreparationSnapshot;
    assertSnapshotIntegrity(snapshot);
    if (snapshot.inputDigest !== row.input_digest || snapshot.snapshotDigest !== row.snapshot_digest) {
      throw new Error("Durable onboarding preparation metadata does not match its snapshot.");
    }
    return structuredClone(snapshot);
  }

  events(sessionId: string): OnboardingPreparationEvent[] {
    identifier.parse(sessionId);
    this.read(sessionId);
    const rows = this.database.prepare(`
      SELECT sequence, session_id, event_type, snapshot_digest, occurred_at
      FROM onboarding_preparation_events WHERE session_id = ? ORDER BY sequence ASC
    `).all(sessionId) as Array<{ sequence: number; session_id: string; event_type: OnboardingPreparationEvent["eventType"]; snapshot_digest: string; occurred_at: string }>;
    return rows.map((row) => ({
      sequence: row.sequence,
      sessionId: row.session_id,
      eventType: row.event_type,
      snapshotDigest: row.snapshot_digest,
      occurredAt: row.occurred_at,
    }));
  }

  close(): void {
    this.database.close();
  }

  private appendEvent(sessionId: string, eventType: OnboardingPreparationEvent["eventType"], snapshotDigest: string, occurredAt: string): void {
    this.database.prepare(`
      INSERT INTO onboarding_preparation_events (session_id, event_type, snapshot_digest, occurred_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, eventType, snapshotDigest, occurredAt);
  }
}

export function onboardingPreparationDigest(value: unknown): string {
  return onboardingAcceptanceSourceDigest(value);
}
