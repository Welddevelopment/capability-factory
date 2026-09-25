import { DatabaseSync } from "node:sqlite";
import { compileStructuredSdkSemanticContract, structuredSdkDigest, type StructuredSdkSemanticContract } from "./customer-local-sdk-structured-semantic-compiler.js";
import { DurableStructuredSdkSemanticDraftWorkflow, type StructuredSdkDraftAnswerValue, type StructuredSdkDraftQuestion, type StructuredSdkDraftSnapshot, type StructuredSdkDraftSource } from "./customer-local-sdk-structured-semantic-drafting.js";
import { extractApprovedStructuredSdkSchemaIndex, structuredSdkSourceBytesDigest, type StructuredSdkSchemaReview } from "./customer-local-sdk-structured-schema-extractor.js";
import type { SdkImplementationWorkPack } from "./customer-local-sdk-work-pack.js";
import type { SdkSemanticContract } from "./customer-local-sdk-semantic-compiler.js";

export const CUSTOMER_LOCAL_SDK_STRUCTURED_ONBOARDING_VERSION = "1.0" as const;

const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{1,119}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const recognizedSecret = /(?:bearer\s+[a-z0-9._~+/=-]+|(?:password|secret|token|api[_ -]?key)\s*[:=]\s*[^\s,;}]+|CF_CANARY_[A-Z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)-?[a-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b)/i;

export interface StructuredSdkOnboardingInput {
  schemaVersion: "1.0";
  journeyId: string;
  tenantId: string;
  sourceBytes: string;
  expectedSourceDigest: string;
  localReference: string;
  workPack: SdkImplementationWorkPack;
  schemaReviews: StructuredSdkSchemaReview[];
  baseContract: SdkSemanticContract;
  workflowSourceDigest: string;
  availableInputs: StructuredSdkDraftSource["availableInputs"];
  createdAt: string;
}

export interface StructuredSdkOnboardingReceipt {
  schemaVersion: "1.0";
  journeyVersion: typeof CUSTOMER_LOCAL_SDK_STRUCTURED_ONBOARDING_VERSION;
  state: "structured-review-in-progress" | "structured-review-ready" | "compiled-acceptance-only";
  journeyId: string;
  tenantId: string;
  providerId: string;
  inputDigest: string;
  sourceBytesDigest: string;
  workPackDigest: string;
  schemaIndexDigest: string;
  baseContractDigest: string;
  draftSnapshotDigest: string;
  compiledContractDigest: string | null;
  compiledImplementationDigest: string | null;
  stages: {
    sourceBytesPinned: true;
    exactSchemaReviewsAccepted: true;
    structuredSchemaIndexReady: true;
    structuredMappingsComplete: boolean;
    structuredContractReviewed: boolean;
    acceptanceOnlyCompiled: boolean;
    bindingQualified: false;
    customerEnvironmentAccepted: false;
    executionAuthorized: false;
    activated: false;
  };
  decisions: { total: number; answered: number; ready: number; blocked: number };
  questions: StructuredSdkDraftQuestion[];
  blockers: string[];
  customerExecutable: false;
  executionAuthorityEffect: "none";
  activationEffect: "none";
  checkedAt: string;
  receiptDigest: string;
}

interface StoredJourney { input_json: string; input_digest: string }

function inputDigest(input: StructuredSdkOnboardingInput): string {
  return structuredSdkDigest(input);
}

function assertInput(input: StructuredSdkOnboardingInput, now: string): void {
  if (input.schemaVersion !== "1.0" || !identifier.test(input.journeyId) || !identifier.test(input.tenantId) || !digestPattern.test(input.expectedSourceDigest) || !digestPattern.test(input.workflowSourceDigest) || !Number.isFinite(Date.parse(input.createdAt)) || Date.parse(input.createdAt) > Date.parse(now) || structuredSdkSourceBytesDigest(input.sourceBytes) !== input.expectedSourceDigest || recognizedSecret.test(input.sourceBytes)) throw new Error("Structured SDK onboarding input failed identity, digest, time or secret preflight validation.");
}

export class DurableStructuredSdkOnboardingJourney {
  private readonly database: DatabaseSync;
  private readonly drafts: DurableStructuredSdkSemanticDraftWorkflow;
  constructor(private readonly path: string, private readonly clock: { now(): string }) {
    this.database = new DatabaseSync(path);
    this.database.exec("CREATE TABLE IF NOT EXISTS structured_sdk_onboarding_journeys (journey_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, input_json TEXT NOT NULL, input_digest TEXT NOT NULL, created_at TEXT NOT NULL)");
    this.drafts = new DurableStructuredSdkSemanticDraftWorkflow(path, clock);
  }

  start(inputValue: StructuredSdkOnboardingInput): StructuredSdkOnboardingReceipt {
    const input = structuredClone(inputValue);
    assertInput(input, this.clock.now());
    if (this.database.prepare("SELECT 1 FROM structured_sdk_onboarding_journeys WHERE journey_id = ?").get(input.journeyId)) throw new Error("Structured SDK onboarding journey already exists.");
    const digest = inputDigest(input);
    this.database.prepare("INSERT INTO structured_sdk_onboarding_journeys (journey_id, tenant_id, input_json, input_digest, created_at) VALUES (?, ?, ?, ?, ?)").run(input.journeyId, input.tenantId, JSON.stringify(input), digest, input.createdAt);
    try { this.ensureDraft(input); }
    catch (error) { this.database.prepare("DELETE FROM structured_sdk_onboarding_journeys WHERE journey_id = ?").run(input.journeyId); throw error; }
    return this.read(input.journeyId);
  }

  read(journeyId: string): StructuredSdkOnboardingReceipt {
    const { input, digest } = this.load(journeyId);
    const { source, snapshot } = this.ensureDraft(input);
    return this.receipt(input, digest, source, snapshot);
  }

  answer(input: { journeyId: string; expectedReceiptDigest: string; questionId: string; value: StructuredSdkDraftAnswerValue; reviewerAlias: string; reviewedAt: string; sourcePointer: string; sourceDigest: string }): StructuredSdkOnboardingReceipt {
    const current = this.read(input.journeyId);
    if (current.receiptDigest !== input.expectedReceiptDigest || current.state === "compiled-acceptance-only") throw new Error("Structured SDK onboarding answer is stale or the journey is already compiled.");
    const { input: stored } = this.load(input.journeyId);
    const snapshot = this.drafts.read(stored.journeyId);
    this.drafts.answer({ sessionId: stored.journeyId, expectedSnapshotDigest: snapshot.snapshotDigest, expectedRevision: snapshot.revision, questionId: input.questionId, value: input.value, reviewerAlias: input.reviewerAlias, reviewedAt: input.reviewedAt, sourcePointer: input.sourcePointer, sourceDigest: input.sourceDigest });
    return this.read(input.journeyId);
  }

  review(input: { journeyId: string; expectedReceiptDigest: string; reviewerAlias: string; reviewedAt: string; expiresAt: string; dryRun?: boolean }): StructuredSdkOnboardingReceipt {
    const current = this.read(input.journeyId);
    if (current.receiptDigest !== input.expectedReceiptDigest) throw new Error("Structured SDK onboarding final review is stale.");
    const { input: stored, digest } = this.load(input.journeyId);
    const { source, snapshot } = this.ensureDraft(stored);
    const reviewed = this.drafts.review({ sessionId: stored.journeyId, expectedSnapshotDigest: snapshot.snapshotDigest, expectedRevision: snapshot.revision, reviewerAlias: input.reviewerAlias, reviewedAt: input.reviewedAt, expiresAt: input.expiresAt, ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }) });
    return this.receipt(stored, digest, source, reviewed);
  }

  close(): void {
    this.drafts.close();
    this.database.close();
  }

  private load(journeyId: string): { input: StructuredSdkOnboardingInput; digest: string } {
    const row = this.database.prepare("SELECT input_json, input_digest FROM structured_sdk_onboarding_journeys WHERE journey_id = ?").get(journeyId) as StoredJourney | undefined;
    if (!row) throw new Error("Structured SDK onboarding journey was not found.");
    const input = JSON.parse(row.input_json) as StructuredSdkOnboardingInput;
    if (row.input_digest !== inputDigest(input)) throw new Error("Structured SDK onboarding immutable input failed integrity validation.");
    assertInput(input, this.clock.now());
    return { input, digest: row.input_digest };
  }

  private source(input: StructuredSdkOnboardingInput): StructuredSdkDraftSource {
    const schemaIndex = extractApprovedStructuredSdkSchemaIndex({ sourceBytes: input.sourceBytes, expectedSourceDigest: input.expectedSourceDigest, localReference: input.localReference, workPack: input.workPack, reviews: input.schemaReviews });
    return { schemaVersion: "1.0", sessionId: input.journeyId, tenantId: input.tenantId, workPack: input.workPack, schemaIndex, baseContract: input.baseContract, workflowSourceDigest: input.workflowSourceDigest, availableInputs: input.availableInputs, createdAt: input.createdAt };
  }

  private ensureDraft(input: StructuredSdkOnboardingInput): { source: StructuredSdkDraftSource; snapshot: StructuredSdkDraftSnapshot } {
    const source = this.source(input);
    try { return { source, snapshot: this.drafts.read(input.journeyId) }; }
    catch (error) {
      if (!(error instanceof Error) || !/was not found/i.test(error.message)) throw error;
      return { source, snapshot: this.drafts.start(source) };
    }
  }

  private receipt(input: StructuredSdkOnboardingInput, digest: string, source: StructuredSdkDraftSource, snapshot: StructuredSdkDraftSnapshot): StructuredSdkOnboardingReceipt {
    let contract: StructuredSdkSemanticContract | null = snapshot.reviewedContract;
    let implementationDigest: string | null = null;
    if (contract) implementationDigest = compileStructuredSdkSemanticContract({ contract, workPack: source.workPack, schemaIndex: source.schemaIndex, now: this.clock.now() }).implementationDigest;
    const state = contract ? "compiled-acceptance-only" as const : snapshot.state === "review-ready" ? "structured-review-ready" as const : "structured-review-in-progress" as const;
    const blockers = contract ? ["Separate action and independent-observer bindings remain unqualified.", "Mandatory customer-local acceptance remains unrun.", "Customer execution and activation authority remain false."] : snapshot.blockers;
    const payload = {
      schemaVersion: "1.0" as const,
      journeyVersion: CUSTOMER_LOCAL_SDK_STRUCTURED_ONBOARDING_VERSION,
      state,
      journeyId: input.journeyId,
      tenantId: input.tenantId,
      providerId: input.workPack.providerId,
      inputDigest: digest,
      sourceBytesDigest: input.expectedSourceDigest,
      workPackDigest: input.workPack.workPackDigest,
      schemaIndexDigest: source.schemaIndex.indexDigest,
      baseContractDigest: input.baseContract.contractDigest,
      draftSnapshotDigest: snapshot.snapshotDigest,
      compiledContractDigest: contract?.contractDigest ?? null,
      compiledImplementationDigest: implementationDigest,
      stages: { sourceBytesPinned: true as const, exactSchemaReviewsAccepted: true as const, structuredSchemaIndexReady: true as const, structuredMappingsComplete: snapshot.blockers.length === 0, structuredContractReviewed: Boolean(contract), acceptanceOnlyCompiled: Boolean(contract), bindingQualified: false as const, customerEnvironmentAccepted: false as const, executionAuthorized: false as const, activated: false as const },
      decisions: { total: snapshot.metrics.questions, answered: snapshot.metrics.answered, ready: snapshot.metrics.ready, blocked: snapshot.metrics.blocked },
      questions: structuredClone(snapshot.questions),
      blockers,
      customerExecutable: false as const,
      executionAuthorityEffect: "none" as const,
      activationEffect: "none" as const,
      checkedAt: snapshot.updatedAt,
    };
    return { ...payload, receiptDigest: structuredSdkDigest(payload) };
  }
}
