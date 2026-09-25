import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ApprovedOpenApiNormalizationResult } from "./approved-openapi-normalizer.js";
import {
  compileReviewedHttpBindings,
  type CompiledHttpBindingPair,
  type CustomerLocalCredentialResolver,
  type CustomerLocalHttpTransport,
} from "./http-binding-compiler.js";
import { proposeHttpBindings, type HttpBindingFactoryFacts, type HttpBindingFactoryResult } from "./http-binding-factory.js";
import type { GenericAcceptanceCampaignStore } from "./generic-acceptance-executor.js";
import {
  DurableOnboardingPreparationWorkflow,
  onboardingPreparationDigest,
  type ConfirmOnboardingPreparationInput,
  type OnboardingPreparationSnapshot,
  type StartOnboardingPreparationInput,
} from "./onboarding-preparation-workflow.js";
import {
  buildOnboardingReadinessReceipt,
  type OnboardingReadinessReceipt,
} from "./onboarding-readiness-receipt.js";
import { redactText } from "./redaction.js";
import {
  deriveOnboardingCleanPackage,
  projectOnboardingCleanPackagePreview,
  type OnboardingCleanPackage,
} from "./onboarding-clean-package.js";
import {
  cleanPackageAuthoringAnswerSubmissionSchema,
  cleanPackageAuthoringInputSchema,
  DurableCleanPackageAuthoringWorkflow,
  projectCleanPackageAuthoringSnapshot,
} from "./onboarding-clean-package-authoring.js";
import {
  assessOnboardingDecisionAnswers,
  exportPortableCoachSession,
  importPortableCoachSession,
  projectOnboardingDecisionCoach,
  type PortableCoachSession,
} from "./onboarding-decision-coach.js";
import { qualifyCustomerLocalBindings, type BindingQualificationReceipt, type BindingQualificationRuntime } from "./customer-local-binding-qualification.js";

export const ONBOARDING_PRODUCTIZATION_API_VERSION = "1.0" as const;

const secretShaped = /(?:bearer\s+[a-z0-9._~+\/-]{8,}|sk-[a-z0-9_-]{12,}|password\s*[:=]|(?:api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*["']?[^\s"']{6,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;

export interface OnboardingCompilationRuntime {
  actionTransport: CustomerLocalHttpTransport;
  observerTransport: CustomerLocalHttpTransport;
  credentialResolver: CustomerLocalCredentialResolver;
  primitiveRegistryDigest: string;
  verifierRegistryDigest: string;
  qualificationRuntime?: BindingQualificationRuntime;
}

export interface OnboardingCompilationRuntimeResolver {
  resolve(input: {
    tenantId: string;
    sessionId: string;
    preparation: OnboardingPreparationSnapshot;
    factoryResult: HttpBindingFactoryResult;
  }): OnboardingCompilationRuntime | undefined;
}

export interface OnboardingProductizationSidecarOptions {
  accessToken: string;
  tenantId: string;
  statePath: string;
  acceptanceStore: GenericAcceptanceCampaignStore;
  compilationRuntimes: OnboardingCompilationRuntimeResolver;
  now?: () => string;
}

export interface BindingRequestArtifact {
  schemaVersion: "1.0";
  normalization: ApprovedOpenApiNormalizationResult;
  facts: HttpBindingFactoryFacts;
  qualification: { qualifiedAt: string; expiresAt: string };
}

export interface AcceptanceLinkArtifact {
  schemaVersion: "1.0";
  campaignId: string;
  expectedPairDigest: string;
  expectedCampaignRevision: number;
  expectedLatestReceiptHash: string;
}

export interface CleanPackageImportConfirmationArtifact {
  schemaVersion: "1.0";
  packageDigest: string;
  decisionDigest: string;
  confirmation: "CONFIRM ALL 21 CONSEQUENTIAL DECISIONS";
  confirmedByAlias: string;
  confirmedAt: string;
  qualifiedAt: string;
  expiresAt: string;
}

interface ArtifactEnvelope<T> {
  schemaVersion: "1.0";
  tenantId: string;
  sessionId: string;
  stage: "package" | "package-confirmation" | "intake" | "review" | "bindings" | "qualification" | "acceptance-link";
  payload: T;
  payloadDigest: string;
  recordedAt: string;
  envelopeDigest: string;
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
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

export function onboardingAcceptanceBindingId(tenantId: string, sessionId: string, pairDigest: string): string {
  return `onboarding-${digest({ tenantId, sessionId, pairDigest }).slice(0, 32)}`;
}

function envelopePayload<T>(envelope: ArtifactEnvelope<T>): Omit<ArtifactEnvelope<T>, "envelopeDigest"> {
  const { envelopeDigest: _envelopeDigest, ...payload } = envelope;
  return payload;
}

export function assertOnboardingProductizationArtifactSafe(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    nodes += 1;
    if (nodes > 100_000) throw new Error("Onboarding artifact exceeds the bounded structural complexity limit.");
    if (item.depth > 64) throw new Error("Onboarding artifact exceeds the maximum nesting depth.");
    if (typeof item.value === "string") {
      if (item.value.length > 1_000_000) throw new Error("Onboarding artifact contains an oversized string field.");
      if (secretShaped.test(item.value)) throw new Error("Onboarding artifact contains a secret-shaped value; use a customer-local credential alias instead.");
    } else if (Array.isArray(item.value)) {
      if (item.value.length > 10_000) throw new Error("Onboarding artifact contains an oversized collection.");
      for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 });
    } else if (item.value !== null && typeof item.value === "object") {
      const entries = Object.entries(item.value as Record<string, unknown>);
      if (entries.length > 10_000) throw new Error("Onboarding artifact contains an oversized object.");
      for (const [key, child] of entries) {
        if (key.length > 500) throw new Error("Onboarding artifact contains an oversized object key.");
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Onboarding artifact contains a forbidden prototype-control key.");
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  const text = canonical(value);
  if (text.length > 10_000_000) throw new Error("Onboarding artifact exceeds the 10 MB customer-local limit.");
  if (secretShaped.test(text)) throw new Error("Onboarding artifact contains a secret-shaped value; use a customer-local credential alias instead.");
}

class OnboardingArtifactStore {
  private readonly database: DatabaseSync;
  private readonly now: () => string;

  constructor(databasePath: string, now: () => string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.now = now;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS onboarding_productization_artifacts (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        envelope_digest TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id, stage)
      );
    `);
  }

  put<T>(tenantId: string, sessionId: string, stage: ArtifactEnvelope<T>["stage"], payload: T): ArtifactEnvelope<T> {
    assertOnboardingProductizationArtifactSafe(payload);
    const existing = this.get<T>(tenantId, sessionId, stage);
    const payloadDigest = digest(payload);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest) throw new Error(`Onboarding ${stage} conflicts with the exact artifact already bound to this session.`);
      return existing;
    }
    const withoutDigest = { schemaVersion: "1.0" as const, tenantId, sessionId, stage, payload: structuredClone(payload), payloadDigest, recordedAt: this.now() };
    const envelope = { ...withoutDigest, envelopeDigest: digest(withoutDigest) };
    this.database.prepare(`INSERT INTO onboarding_productization_artifacts (tenant_id, session_id, stage, envelope_json, envelope_digest) VALUES (?, ?, ?, ?, ?)`)
      .run(tenantId, sessionId, stage, JSON.stringify(envelope), envelope.envelopeDigest);
    return structuredClone(envelope);
  }

  get<T>(tenantId: string, sessionId: string, stage: ArtifactEnvelope<T>["stage"]): ArtifactEnvelope<T> | undefined {
    const row = this.database.prepare(`SELECT envelope_json, envelope_digest FROM onboarding_productization_artifacts WHERE tenant_id = ? AND session_id = ? AND stage = ?`)
      .get(tenantId, sessionId, stage) as { envelope_json: string; envelope_digest: string } | undefined;
    if (!row) return undefined;
    const envelope = JSON.parse(row.envelope_json) as ArtifactEnvelope<T>;
    if (envelope.tenantId !== tenantId || envelope.sessionId !== sessionId || envelope.stage !== stage
      || envelope.envelopeDigest !== row.envelope_digest
      || digest(envelope.payload) !== envelope.payloadDigest
      || digest(envelopePayload(envelope)) !== envelope.envelopeDigest) {
      throw new Error(`Stored onboarding ${stage} artifact failed its integrity or tenant check.`);
    }
    assertOnboardingProductizationArtifactSafe(envelope.payload);
    return structuredClone(envelope);
  }

  close(): void {
    this.database.close();
  }
}

function sameToken(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const leftBytes = createHash("sha256").update(left).digest();
  const rightBytes = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftBytes, rightBytes);
}

function snapshotProjection(snapshot: OnboardingPreparationSnapshot): unknown {
  return {
    schemaVersion: snapshot.schemaVersion,
    sessionId: snapshot.sessionId,
    tenantId: snapshot.tenantId,
    adapterId: snapshot.adapterId,
    adapterVersion: snapshot.adapterVersion,
    status: snapshot.status,
    activation: snapshot.activation,
    revision: snapshot.revision,
    inputDigest: snapshot.inputDigest,
    snapshotDigest: snapshot.snapshotDigest,
    blockers: snapshot.blockers,
    receipt: snapshot.receipt,
    reviewArtifacts: snapshot.status === "review-required" ? {
      adapterProposalDigest: onboardingPreparationDigest(snapshot.adapterProposal),
      verifierContractDigest: onboardingPreparationDigest(snapshot.verifierContract),
      authorityCompilationDigest: onboardingPreparationDigest(snapshot.authorityCompilation),
      note: "These are generated artifact digests for exact review, not repository-internal object identifiers or authority grants.",
    } : undefined,
    acceptance: snapshot.acceptancePlan ? {
      planId: snapshot.acceptancePlan.planId,
      state: snapshot.acceptancePlan.status,
      declaredCases: snapshot.acceptancePlan.cases.length,
      executable: false,
      passed: false,
    } : undefined,
  };
}

function bindingProjection(factoryResult: HttpBindingFactoryResult, pair: CompiledHttpBindingPair, qualification?: BindingQualificationReceipt): unknown {
  return {
    state: pair.state,
    activated: false,
    customerValidated: false,
    factoryResultDigest: factoryResult.resultDigest,
    actionDeclarationDigest: pair.action.declarationDigest,
    observerDeclarationDigest: pair.observer.declarationDigest,
    pairDigest: pair.pairDigest,
    credentialAndTransportQualification: qualification ? { state: qualification.state, receiptDigest: qualification.receiptDigest, expiresAt: qualification.expiresAt, executionAuthorityEffect: qualification.executionAuthorityEffect, activationEffect: qualification.activationEffect } : undefined,
    verifierQualification: pair.observer.qualification,
    evidenceBoundary: pair.evidenceBoundary,
  };
}

function parseSessionId(request: FastifyRequest): string {
  const value = (request.params as { sessionId?: unknown }).sessionId;
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{1,179}$/.test(value)) throw new Error("Invalid onboarding session identity.");
  return value;
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Onboarding request failed.";
  return redactText(raw)
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(/((?:password|api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1_000);
}

function errorReply(reply: FastifyReply, error: unknown): { error: string } {
  const message = safeErrorMessage(error);
  const conflict = /conflict|stale|already bound|different|changed|revision/i.test(message);
  reply.code(conflict ? 409 : 400);
  return { error: message };
}

/**
 * One authenticated customer-local API over the existing durable preparation
 * workflow and generic acceptance store. It has no activation route.
 */
export function createOnboardingProductizationSidecar(options: OnboardingProductizationSidecarOptions): FastifyInstance {
  if (options.accessToken.length < 16) throw new Error("Onboarding sidecar access token must contain at least 16 characters.");
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{1,179}$/.test(options.tenantId)) throw new Error("Onboarding sidecar tenant ID is invalid.");
  const now = options.now ?? (() => new Date().toISOString());
  const workflow = new DurableOnboardingPreparationWorkflow(options.statePath, { now });
  const authoring = new DurableCleanPackageAuthoringWorkflow(options.statePath, { now });
  const artifacts = new OnboardingArtifactStore(options.statePath, now);
  const app = Fastify({ logger: false, bodyLimit: 10_000_000 });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode === 413 ? 413 : 400;
    void reply.code(status).send({ error: status === 413 ? "Onboarding request body exceeds the configured limit." : safeErrorMessage(error) });
  });

  const authorize = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = request.headers["x-capability-sidecar-token"];
    if (typeof token !== "string" || !sameToken(token, options.accessToken)) {
      await reply.code(401).send({ error: "Unauthorized" });
    }
  };

  function ownedSnapshot(sessionId: string): OnboardingPreparationSnapshot {
    const snapshot = workflow.read(sessionId);
    if (snapshot.tenantId !== options.tenantId) throw new Error("Onboarding session belongs to another tenant.");
    return snapshot;
  }

  function compileBindings(sessionId: string, request: BindingRequestArtifact): { factoryResult: HttpBindingFactoryResult; pair: CompiledHttpBindingPair; qualificationReceipt: BindingQualificationReceipt } {
    const snapshot = ownedSnapshot(sessionId);
    const factoryResult = proposeHttpBindings({ schemaVersion: "1.0", normalization: request.normalization, authorityCompilation: snapshot.authorityCompilation, facts: request.facts });
    const runtime = options.compilationRuntimes.resolve({ tenantId: options.tenantId, sessionId, preparation: snapshot, factoryResult });
    if (!runtime) throw new Error("Customer-local compilation runtime is not configured for this documented session.");
    if (!runtime.qualificationRuntime) throw new Error("Customer-local credential and split-transport qualification runtime is missing.");
    const pkg = artifacts.get<OnboardingCleanPackage>(options.tenantId, sessionId, "package")?.payload;
    if (pkg && runtime.qualificationRuntime.actionProfile.sourceDigest !== pkg.approvedDocument.sourceOpenApiSha256) throw new Error("Customer-local transport qualification is bound to different approved package source material.");
    const qualificationReceipt = qualifyCustomerLocalBindings({ tenantId: options.tenantId, sessionId, packageDigest: pkg ? digest(pkg) : snapshot.inputDigest, sourceDigest: runtime.qualificationRuntime.actionProfile.sourceDigest, factoryResult, actionTransport: runtime.actionTransport, observerTransport: runtime.observerTransport, credentialResolver: runtime.credentialResolver, runtime: runtime.qualificationRuntime, qualifiedAt: request.qualification.qualifiedAt, expiresAt: request.qualification.expiresAt });
    const pair = compileReviewedHttpBindings({
      factoryResult,
      ...runtime,
      qualifiedAt: request.qualification.qualifiedAt,
      expiresAt: request.qualification.expiresAt,
      customerLocalQualification: { receipt: qualificationReceipt, runtime: runtime.qualificationRuntime },
      now: () => Date.parse(now()),
    });
    return { factoryResult, pair, qualificationReceipt };
  }

  function rebuildBindings(sessionId: string): { factoryResult: HttpBindingFactoryResult; pair: CompiledHttpBindingPair; qualificationReceipt: BindingQualificationReceipt } {
    const request = artifacts.get<BindingRequestArtifact>(options.tenantId, sessionId, "bindings")?.payload;
    if (!request) throw new Error("Reviewed binding inputs have not been recorded for this session.");
    return compileBindings(sessionId, request);
  }

  app.get("/health", async () => ({ status: "ok", boundary: "customer-local-onboarding" }));

  app.post("/v1/onboarding/authoring/sessions", { preHandler: authorize }, async (request, reply) => {
    try {
      assertOnboardingProductizationArtifactSafe(request.body);
      const input = cleanPackageAuthoringInputSchema.parse(request.body);
      if (input.tenantId !== options.tenantId) throw new Error("Clean-package authoring input belongs to another tenant.");
      const snapshot = authoring.start(input);
      reply.code(202);
      return projectCleanPackageAuthoringSnapshot(snapshot);
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.get("/v1/onboarding/authoring/sessions/:sessionId", { preHandler: authorize }, async (request, reply) => {
    try {
      const snapshot = authoring.read(parseSessionId(request));
      if (snapshot.tenantId !== options.tenantId) throw new Error("Clean-package authoring session belongs to another tenant.");
      return projectCleanPackageAuthoringSnapshot(snapshot);
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.post("/v1/onboarding/authoring/sessions/:sessionId/answers", { preHandler: authorize }, async (request, reply) => {
    try {
      assertOnboardingProductizationArtifactSafe(request.body);
      const sessionId = parseSessionId(request);
      const current = authoring.read(sessionId);
      if (current.tenantId !== options.tenantId) throw new Error("Clean-package authoring session belongs to another tenant.");
      const submission = cleanPackageAuthoringAnswerSubmissionSchema.parse(request.body);
      if (submission.authoringSessionId !== sessionId) throw new Error("Authoring answers are bound to a different session.");
      const snapshot = authoring.answer(submission);
      reply.code(202);
      return projectCleanPackageAuthoringSnapshot(snapshot);
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.get("/v1/onboarding/authoring/sessions/:sessionId/package", { preHandler: authorize }, async (request, reply) => {
    try {
      const snapshot = authoring.read(parseSessionId(request));
      if (snapshot.tenantId !== options.tenantId) throw new Error("Clean-package authoring session belongs to another tenant.");
      if (snapshot.status !== "package-draft-ready" || !snapshot.packageDraft) {
        throw new Error("Only a complete explicitly confirmed authoring revision can be handed to CF-026 preview/import.");
      }
      return {
        schemaVersion: "1.0",
        authoringSessionId: snapshot.authoringSessionId,
        authoringRevision: snapshot.revision,
        authoringSnapshotDigest: snapshot.snapshotDigest,
        package: snapshot.packageDraft,
        nextCalls: {
          preview: "POST /v1/onboarding/packages/preview",
          import: "POST /v1/onboarding/packages/import after exact CF-026 preview confirmation",
        },
        executionAuthorityEffect: "none",
        activationEffect: "none",
      };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.get("/v1/onboarding/authoring/sessions/:sessionId/coach", { preHandler: authorize }, async (request, reply) => {
    try {
      const snapshot = authoring.read(parseSessionId(request));
      if (snapshot.tenantId !== options.tenantId) throw new Error("Clean-package authoring session belongs to another tenant.");
      return projectOnboardingDecisionCoach(snapshot);
    } catch (error) { return errorReply(reply, error); }
  });

  app.post("/v1/onboarding/authoring/sessions/:sessionId/coach/assess", { preHandler: authorize }, async (request, reply) => {
    try {
      assertOnboardingProductizationArtifactSafe(request.body);
      const snapshot = authoring.read(parseSessionId(request));
      if (snapshot.tenantId !== options.tenantId) throw new Error("Clean-package authoring session belongs to another tenant.");
      const body = structuredClone(request.body) as { answers?: Array<{ questionId: string; value: unknown }> };
      if (!Array.isArray(body.answers) || body.answers.length > 64) throw new Error("Coach assessment requires a bounded answer list.");
      return assessOnboardingDecisionAnswers(snapshot, body.answers);
    } catch (error) { return errorReply(reply, error); }
  });

  app.post("/v1/onboarding/authoring/sessions/:sessionId/coach/export", { preHandler: authorize }, async (request, reply) => {
    try {
      assertOnboardingProductizationArtifactSafe(request.body);
      const snapshot = authoring.read(parseSessionId(request));
      if (snapshot.tenantId !== options.tenantId) throw new Error("Clean-package authoring session belongs to another tenant.");
      const body = structuredClone(request.body) as { expiresAt?: string };
      if (typeof body.expiresAt !== "string") throw new Error("Portable coach export requires an expiry timestamp.");
      return exportPortableCoachSession(snapshot, { tenantId: options.tenantId, issuedAt: now(), expiresAt: body.expiresAt, signingKey: options.accessToken });
    } catch (error) { return errorReply(reply, error); }
  });

  app.post("/v1/onboarding/authoring/sessions/:sessionId/coach/import", { preHandler: authorize }, async (request, reply) => {
    try {
      assertOnboardingProductizationArtifactSafe(request.body);
      const snapshot = authoring.read(parseSessionId(request));
      if (snapshot.tenantId !== options.tenantId) throw new Error("Clean-package authoring session belongs to another tenant.");
      return importPortableCoachSession(structuredClone(request.body) as PortableCoachSession, { tenantId: options.tenantId, authoringSessionId: snapshot.authoringSessionId, sourceInputDigest: snapshot.sourceInputDigest, snapshotDigest: snapshot.snapshotDigest, signingKey: options.accessToken, now: now() });
    } catch (error) { return errorReply(reply, error); }
  });

  app.post("/v1/onboarding/packages/preview", { preHandler: authorize }, async (request, reply) => {
    try {
      assertOnboardingProductizationArtifactSafe(request.body);
      const derivation = deriveOnboardingCleanPackage(request.body);
      if (derivation.package.tenantId !== options.tenantId) throw new Error("Onboarding package belongs to another tenant.");
      return projectOnboardingCleanPackagePreview(derivation);
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.post("/v1/onboarding/packages/import", { preHandler: authorize }, async (request, reply) => {
    try {
      assertOnboardingProductizationArtifactSafe(request.body);
      const body = structuredClone(request.body) as {
        package: OnboardingCleanPackage;
        confirmation: CleanPackageImportConfirmationArtifact;
      };
      const derivation = deriveOnboardingCleanPackage(body.package);
      if (derivation.package.tenantId !== options.tenantId) throw new Error("Onboarding package belongs to another tenant.");
      if (!body.confirmation
        || body.confirmation.schemaVersion !== "1.0"
        || body.confirmation.packageDigest !== derivation.packageDigest
        || body.confirmation.decisionDigest !== derivation.decisionDigest
        || body.confirmation.confirmation !== "CONFIRM ALL 21 CONSEQUENTIAL DECISIONS"
        || !/^[a-zA-Z][a-zA-Z0-9_.-]{1,179}$/.test(body.confirmation.confirmedByAlias)
        || !Number.isFinite(Date.parse(body.confirmation.confirmedAt))
        || !Number.isFinite(Date.parse(body.confirmation.qualifiedAt))
        || !Number.isFinite(Date.parse(body.confirmation.expiresAt))
        || Date.parse(body.confirmation.expiresAt) <= Date.parse(body.confirmation.qualifiedAt)) {
        throw new Error("Clean-package import requires exact confirmation of the current 21-decision preview.");
      }

      const existingPackage = artifacts.get<OnboardingCleanPackage>(options.tenantId, derivation.package.sessionId, "package");
      if (!existingPackage) {
        try {
          ownedSnapshot(derivation.package.sessionId);
          throw new Error("Existing onboarding session was not created through the clean-package import contract.");
        } catch (error) {
          if (!(error instanceof Error) || !/does not exist/i.test(error.message)) throw error;
        }
      }
      artifacts.put(options.tenantId, derivation.package.sessionId, "package", derivation.package);
      artifacts.put(options.tenantId, derivation.package.sessionId, "package-confirmation", body.confirmation);
      artifacts.put(options.tenantId, derivation.package.sessionId, "intake", derivation.intake);
      const current = workflow.start(derivation.intake);
      const runtime = options.compilationRuntimes.resolve({ tenantId: options.tenantId, sessionId: derivation.package.sessionId, preparation: current, factoryResult: derivation.bindingPreview });
      if (!runtime) throw new Error("Customer-local compilation runtime is not configured for this documented package.");
      const proposalEvent = workflow.events(derivation.package.sessionId).find((event) => event.eventType === "preparation-proposed");
      if (!proposalEvent) throw new Error("Clean-package session is missing its durable proposal event.");
      const review: ConfirmOnboardingPreparationInput = {
        sessionId: derivation.package.sessionId,
        expectedInputDigest: current.inputDigest,
        expectedSnapshotDigest: proposalEvent.snapshotDigest,
        review: {
          adapterProposalDigest: onboardingPreparationDigest(current.adapterProposal),
          verifierContractDigest: onboardingPreparationDigest(current.verifierContract),
          authorityCompilationDigest: onboardingPreparationDigest(current.authorityCompilation),
          authorityRuntimeBindingDigest: onboardingPreparationDigest({ actionTransport: runtime.actionTransport.implementationDigest, credentialResolver: runtime.credentialResolver.implementationDigest }),
          observationAdapterBindingDigest: onboardingPreparationDigest({ observerTransport: runtime.observerTransport.implementationDigest, primitiveRegistry: runtime.primitiveRegistryDigest, verifierRegistry: runtime.verifierRegistryDigest }),
          confirmedByAlias: body.confirmation.confirmedByAlias,
          confirmedAt: body.confirmation.confirmedAt,
        },
      };
      let reviewed: OnboardingPreparationSnapshot;
      const existingReview = artifacts.get<ConfirmOnboardingPreparationInput>(options.tenantId, derivation.package.sessionId, "review");
      if (existingReview) {
        if (existingReview.payloadDigest !== digest(review)) throw new Error("Clean-package confirmation conflicts with the exact review already recorded.");
        reviewed = ownedSnapshot(derivation.package.sessionId);
      } else if (current.status === "review-required") {
        reviewed = workflow.confirmReview(review);
        artifacts.put(options.tenantId, derivation.package.sessionId, "review", review);
      } else {
        reviewed = ownedSnapshot(derivation.package.sessionId);
        if (reviewed.status !== "acceptance-scaffold-ready") throw new Error("Clean-package preparation is not eligible for compilation.");
        const recovered = reviewed.acceptancePlan?.derivationReceipt;
        if (!recovered
          || recovered.adapterProposalDigest !== review.review.adapterProposalDigest
          || recovered.verifierContractDigest !== review.review.verifierContractDigest
          || recovered.authorityCompilationDigest !== review.review.authorityCompilationDigest
          || recovered.authorityRuntimeBindingDigest !== review.review.authorityRuntimeBindingDigest
          || recovered.observationAdapterBindingDigest !== review.review.observationAdapterBindingDigest
          || recovered.confirmedByAlias !== review.review.confirmedByAlias
          || recovered.confirmedAt !== review.review.confirmedAt) {
          throw new Error("Clean-package review cannot be recovered from the durable artifact chain.");
        }
        artifacts.put(options.tenantId, derivation.package.sessionId, "review", review);
      }
      const bindingRequest: BindingRequestArtifact = {
        schemaVersion: "1.0",
        normalization: derivation.normalization,
        facts: derivation.bindingFacts,
        qualification: { qualifiedAt: body.confirmation.qualifiedAt, expiresAt: body.confirmation.expiresAt },
      };
      const existingBindings = artifacts.get<BindingRequestArtifact>(options.tenantId, derivation.package.sessionId, "bindings");
      if (existingBindings && existingBindings.payloadDigest !== digest(bindingRequest)) throw new Error("Clean-package compilation conflicts with the exact binding request already recorded.");
      const built = compileBindings(derivation.package.sessionId, bindingRequest);
      artifacts.put(options.tenantId, derivation.package.sessionId, "bindings", bindingRequest);
      reply.code(202);
      return {
        importState: "confirmed-compiled-acceptance-only",
        executionAuthorityEffect: "none",
        activationEffect: "none",
        packageDigest: derivation.packageDigest,
        decisionDigest: derivation.decisionDigest,
        preparation: snapshotProjection(reviewed),
        bindings: bindingProjection(built.factoryResult, built.pair),
        exactNextGate: "Execute and link the fixed acceptance campaign; import and compilation do not fabricate passing evidence.",
      };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.get("/v1/onboarding/packages/:sessionId", { preHandler: authorize }, async (request, reply) => {
    try {
      const sessionId = parseSessionId(request);
      ownedSnapshot(sessionId);
      const pkg = artifacts.get<OnboardingCleanPackage>(options.tenantId, sessionId, "package")?.payload;
      if (!pkg) throw new Error("This onboarding session was not created from a clean-package import.");
      const derivation = deriveOnboardingCleanPackage(pkg);
      const packageEnvelope = artifacts.get<OnboardingCleanPackage>(options.tenantId, sessionId, "package");
      const confirmation = artifacts.get<CleanPackageImportConfirmationArtifact>(options.tenantId, sessionId, "package-confirmation");
      const intake = artifacts.get<StartOnboardingPreparationInput>(options.tenantId, sessionId, "intake");
      const review = artifacts.get<ConfirmOnboardingPreparationInput>(options.tenantId, sessionId, "review");
      const bindings = artifacts.get<BindingRequestArtifact>(options.tenantId, sessionId, "bindings");
      return {
        schemaVersion: "1.0",
        package: pkg,
        preview: projectOnboardingCleanPackagePreview(derivation),
        importState: bindings ? "confirmed-compiled-acceptance-only" : confirmation ? "confirmed-preparation-incomplete" : "preview-only",
        recordedArtifactDigests: {
          package: packageEnvelope?.payloadDigest,
          confirmation: confirmation?.payloadDigest,
          intake: intake?.payloadDigest,
          review: review?.payloadDigest,
          bindings: bindings?.payloadDigest,
        },
        executionAuthorityEffect: "none",
        activationEffect: "none",
      };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.post("/v1/onboarding/sessions", { preHandler: authorize }, async (request, reply) => {
    try {
      const input = structuredClone(request.body) as StartOnboardingPreparationInput;
      assertOnboardingProductizationArtifactSafe(input);
      if (input.tenantId !== options.tenantId) throw new Error("Onboarding intake belongs to another tenant.");
      const snapshot = workflow.start(input);
      artifacts.put(options.tenantId, snapshot.sessionId, "intake", input);
      reply.code(202);
      return snapshotProjection(snapshot);
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.get("/v1/onboarding/sessions/:sessionId", { preHandler: authorize }, async (request, reply) => {
    try {
      return snapshotProjection(ownedSnapshot(parseSessionId(request)));
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.get("/v1/onboarding/sessions/:sessionId/events", { preHandler: authorize }, async (request, reply) => {
    try {
      const sessionId = parseSessionId(request);
      ownedSnapshot(sessionId);
      return { sessionId, events: workflow.events(sessionId) };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.post("/v1/onboarding/sessions/:sessionId/review", { preHandler: authorize }, async (request, reply) => {
    try {
      const sessionId = parseSessionId(request);
      const input = structuredClone(request.body) as ConfirmOnboardingPreparationInput;
      assertOnboardingProductizationArtifactSafe(input);
      if (input.sessionId !== sessionId) throw new Error("Review body is bound to a different onboarding session.");
      const existingReview = artifacts.get<ConfirmOnboardingPreparationInput>(options.tenantId, sessionId, "review");
      let snapshot: OnboardingPreparationSnapshot;
      if (existingReview) {
        if (existingReview.payloadDigest !== digest(input)) throw new Error("Onboarding review conflicts with the exact review already recorded.");
        snapshot = ownedSnapshot(sessionId);
      } else {
        const current = ownedSnapshot(sessionId);
        if (current.status === "review-required") {
          snapshot = workflow.confirmReview(input);
        } else if (current.status === "acceptance-scaffold-ready"
          && current.inputDigest === input.expectedInputDigest
          && workflow.events(sessionId).some((event) => event.snapshotDigest === input.expectedSnapshotDigest && event.eventType === "preparation-proposed")
          && current.acceptancePlan?.derivationReceipt?.adapterProposalDigest === input.review.adapterProposalDigest
          && current.acceptancePlan.derivationReceipt.verifierContractDigest === input.review.verifierContractDigest
          && current.acceptancePlan.derivationReceipt.authorityCompilationDigest === input.review.authorityCompilationDigest
          && current.acceptancePlan.derivationReceipt.authorityRuntimeBindingDigest === input.review.authorityRuntimeBindingDigest
          && current.acceptancePlan.derivationReceipt.observationAdapterBindingDigest === input.review.observationAdapterBindingDigest
          && current.acceptancePlan.derivationReceipt.confirmedByAlias === input.review.confirmedByAlias
          && current.acceptancePlan.derivationReceipt.confirmedAt === input.review.confirmedAt) {
          snapshot = current;
        } else {
          throw new Error("Onboarding review cannot be recovered from the durable artifact chain.");
        }
        artifacts.put(options.tenantId, sessionId, "review", input);
      }
      reply.code(202);
      return snapshotProjection(snapshot);
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.post("/v1/onboarding/sessions/:sessionId/bindings", { preHandler: authorize }, async (request, reply) => {
    try {
      const sessionId = parseSessionId(request);
      ownedSnapshot(sessionId);
      const input = structuredClone(request.body) as BindingRequestArtifact;
      assertOnboardingProductizationArtifactSafe(input);
      if (input.schemaVersion !== "1.0") throw new Error("Unsupported onboarding binding request version.");
      const existing = artifacts.get<BindingRequestArtifact>(options.tenantId, sessionId, "bindings");
      if (existing && existing.payloadDigest !== digest(input)) throw new Error("Onboarding bindings conflict with the exact artifact already bound to this session.");
      const built = compileBindings(sessionId, input);
      artifacts.put(options.tenantId, sessionId, "bindings", input);
      artifacts.put(options.tenantId, sessionId, "qualification", built.qualificationReceipt);
      reply.code(202);
      return bindingProjection(built.factoryResult, built.pair, built.qualificationReceipt);
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.get("/v1/onboarding/sessions/:sessionId/qualification", { preHandler: authorize }, async (request, reply) => {
    try {
      const sessionId = parseSessionId(request);
      ownedSnapshot(sessionId);
      const stored = artifacts.get<BindingQualificationReceipt>(options.tenantId, sessionId, "qualification");
      if (!stored) throw new Error("Customer-local credential and split-transport qualification has not been recorded.");
      return stored.payload;
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.post("/v1/onboarding/sessions/:sessionId/acceptance-link", { preHandler: authorize }, async (request, reply) => {
    try {
      const sessionId = parseSessionId(request);
      const input = structuredClone(request.body) as AcceptanceLinkArtifact;
      assertOnboardingProductizationArtifactSafe(input);
      if (input.schemaVersion !== "1.0") throw new Error("Unsupported acceptance-link version.");
      const { pair } = rebuildBindings(sessionId);
      if (input.expectedPairDigest !== pair.pairDigest) throw new Error("Acceptance link belongs to a different compiled pair.");
      const campaign = await options.acceptanceStore.load(input.campaignId);
      if (!campaign) throw new Error("Referenced acceptance campaign does not exist in the customer-local store.");
      if (campaign.bindingId !== onboardingAcceptanceBindingId(options.tenantId, sessionId, pair.pairDigest)
        || campaign.declarationDigest !== pair.pairDigest || campaign.bindingDigest !== pair.pairDigest
        || campaign.revision !== input.expectedCampaignRevision
        || campaign.receipts.at(-1)?.receiptHash !== input.expectedLatestReceiptHash) {
        throw new Error("Acceptance campaign identity, revision, or evidence head does not match the exact link.");
      }
      artifacts.put(options.tenantId, sessionId, "acceptance-link", input);
      reply.code(202);
      return { campaignId: campaign.campaignId, status: campaign.status, revision: campaign.revision, declaredCases: campaign.requiredCaseOrder.length, evidenceReceipts: campaign.receipts.length, latestReceiptHash: campaign.receipts.at(-1)?.receiptHash, activationEffect: "none" };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.get("/v1/onboarding/sessions/:sessionId/readiness", { preHandler: authorize }, async (request, reply): Promise<OnboardingReadinessReceipt | { error: string }> => {
    try {
      const sessionId = parseSessionId(request);
      const preparation = ownedSnapshot(sessionId);
      const intake = artifacts.get<StartOnboardingPreparationInput>(options.tenantId, sessionId, "intake")?.payload;
      const acceptanceLink = artifacts.get<AcceptanceLinkArtifact>(options.tenantId, sessionId, "acceptance-link")?.payload;
      if (!intake || !acceptanceLink) throw new Error("Onboarding intake or exact acceptance link is missing.");
      const { factoryResult, pair } = rebuildBindings(sessionId);
      const campaign = await options.acceptanceStore.load(acceptanceLink.campaignId);
      if (!campaign) throw new Error("Linked acceptance campaign is unavailable.");
      if (campaign.bindingId !== onboardingAcceptanceBindingId(options.tenantId, sessionId, pair.pairDigest)) {
        throw new Error("Linked acceptance campaign belongs to another tenant or onboarding session.");
      }
      return buildOnboardingReadinessReceipt({
        schemaVersion: "1.0",
        intake,
        preparation,
        factoryResult,
        compiledPair: pair,
        acceptanceCampaign: campaign,
        expectation: {
          sessionId,
          inputDigest: preparation.inputDigest,
          snapshotDigest: preparation.snapshotDigest,
          snapshotRevision: preparation.revision,
          factoryResultDigest: factoryResult.resultDigest,
          compiledPairDigest: pair.pairDigest,
          campaignId: acceptanceLink.campaignId,
          campaignRevision: acceptanceLink.expectedCampaignRevision,
          latestAcceptanceReceiptHash: acceptanceLink.expectedLatestReceiptHash,
        },
        evaluatedAt: now(),
        maximumEvidenceAgeSeconds: 90 * 24 * 60 * 60,
      });
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.addHook("onClose", async () => {
    authoring.close();
    workflow.close();
    artifacts.close();
  });
  return app;
}
