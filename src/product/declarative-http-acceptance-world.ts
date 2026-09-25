import { createHash } from "node:crypto";
import {
  compileReviewedHttpBindings,
  httpActionGrantDigest,
  type CompiledHttpBindingPair,
  type CustomerLocalCredentialResolver,
  type CustomerLocalHttpTransport,
  type HttpActionExecutionGrant,
} from "./http-binding-compiler.js";
import type { GenericAcceptanceAttemptContext, GenericAcceptanceBinding } from "./generic-acceptance-executor.js";
import type { HttpBindingFactoryResult } from "./http-binding-factory.js";
import { onboardingAcceptanceBindingId, type OnboardingCompilationRuntime } from "./onboarding-productization-sidecar.js";
import { bindingQualificationDigest, bindingQualificationSchemaDigests, qualifyCustomerLocalBindings, type BindingQualificationRuntime, type OpaqueCredentialBinding, type ReviewedTransportProfile } from "./customer-local-binding-qualification.js";
import { REQUIRED_PILOT_ADAPTER_CASES, type PilotAdapterAcceptanceCase, type PilotAdapterAcceptanceResult } from "./pilot-adapter.js";

export interface DeclarativeHttpAcceptanceWorldConfig {
  fixtureId: string;
  tenantId: string;
  sessionId: string;
  serverUrl: string;
  actionDriverId: string;
  actionSourceId: string;
  observerDriverId: string;
  observerSourceId: string;
  actionCredentialAlias: string;
  observerCredentialAlias: string;
  stableInputKey: string;
  conflictInputKey: string;
  workflowInput: Record<string, string | number | boolean>;
  alternativeConflictValue: string | number | boolean;
  qualifiedAt: string;
  expiresAt: string;
  now: string;
  sourceDigest?: string;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export class DeclarativeHttpAcceptanceWorld {
  readonly records = new Map<string, Record<string, unknown>>();
  readonly missingCredentialAliases = new Set<string>();
  writes = 0;
  loseNextActionResponse = false;
  collateralClean = true;
  readonly credentialBindings = new Map<string, OpaqueCredentialBinding>();

  constructor(readonly config: DeclarativeHttpAcceptanceWorldConfig) {}

  reset(): void {
    this.records.clear();
    this.missingCredentialAliases.clear();
    this.writes = 0;
    this.loseNextActionResponse = false;
    this.collateralClean = true;
  }

  runtime(factoryResult?: HttpBindingFactoryResult): OnboardingCompilationRuntime {
    const actionTransport: CustomerLocalHttpTransport = {
      driverId: this.config.actionDriverId,
      sourceId: this.config.actionSourceId,
      serverUrl: this.config.serverUrl,
      implementationDigest: hash("declarative-http-action-transport-v1"),
      supportedMethods: ["POST", "PUT", "PATCH", "DELETE"],
      independentlyAuthenticated: true,
      independentFromDriverIds: [],
      perform: async (request, credential) => {
        if (credential.alias !== this.config.actionCredentialAlias) throw new Error("Action credential boundary mismatch.");
        const body = structuredClone(request.body ?? {});
        const existing = this.records.get(request.reconciliationKey);
        if (existing && stable(existing) !== stable(body)) throw new Error("Conflicting reconciliation-key reuse.");
        if (!existing) {
          this.records.set(request.reconciliationKey, body);
          this.writes += 1;
        }
        if (this.loseNextActionResponse) {
          this.loseNextActionResponse = false;
          throw new Error("Simulated response loss after commit.");
        }
        return { status: 201, headers: {}, body: { accepted: true } };
      },
    };
    const observerTransport: CustomerLocalHttpTransport = {
      driverId: this.config.observerDriverId,
      sourceId: this.config.observerSourceId,
      serverUrl: this.config.serverUrl,
      implementationDigest: hash("declarative-http-observer-transport-v1"),
      supportedMethods: ["GET", "HEAD"],
      independentlyAuthenticated: true,
      independentFromDriverIds: [this.config.actionDriverId],
      perform: async (request, credential) => {
        if (credential.alias !== this.config.observerCredentialAlias) throw new Error("Observer credential boundary mismatch.");
        const reference = request.query[Object.keys(request.query)[0] ?? ""] ?? request.reconciliationKey;
        const record = this.records.get(reference);
        return { status: 200, headers: {}, body: { items: record ? [structuredClone(record)] : [], server_time: this.config.now, collateral_clean: this.collateralClean } };
      },
    };
    const credentialResolver: CustomerLocalCredentialResolver = {
      resolverId: `${this.config.fixtureId}-resolver`,
      implementationDigest: hash("declarative-http-credential-resolver-v1"),
      allowedAliases: [this.config.actionCredentialAlias, this.config.observerCredentialAlias],
      resolve: async (alias) => this.missingCredentialAliases.has(alias) ? null : { alias, value: `opaque-local-handle-${alias}` },
    };
    const actionDeclaration = factoryResult?.actionBinding, observerDeclaration = factoryResult?.observerBinding;
    const sourceDigest = this.config.sourceDigest ?? actionDeclaration?.provenance.normalizedMaterialDigest ?? hash(`source:${this.config.fixtureId}`);
    const schemas = factoryResult && actionDeclaration && observerDeclaration ? bindingQualificationSchemaDigests(factoryResult) : { actionRequest: hash("action-request-schema"), actionResponse: hash("action-response-schema"), observerRequest: hash("observer-request-schema"), observerResponse: hash("observer-response-schema") };
    const profile = (role: "action" | "observer", transport: CustomerLocalHttpTransport): ReviewedTransportProfile => { const declaration = role === "action" ? actionDeclaration : observerDeclaration; return ({ role, driverId: transport.driverId, sourceId: transport.sourceId, serverUrl: transport.serverUrl, path: declaration?.operation.pathTemplate ?? "unbound", method: declaration?.operation.method ?? (role === "action" ? "POST" : "GET"), requestSchemaDigest: role === "action" ? schemas.actionRequest : schemas.observerRequest, responseSchemaDigest: role === "action" ? schemas.actionResponse : schemas.observerResponse, sourceDigest, implementationDigest: transport.implementationDigest, tlsPolicy: "https-required", timeoutMilliseconds: 10_000, maximumRequestsPerMinute: 60, reconcileBeforeRetry: true, blindRetryAllowed: false, independentlyAuthenticated: transport.independentlyAuthenticated, independentFromDriverIds: transport.independentFromDriverIds, reviewedAt: this.config.qualifiedAt, expiresAt: this.config.expiresAt }); };
    const actionProfile = profile("action", actionTransport), observerProfile = profile("observer", observerTransport);
    if (actionDeclaration && observerDeclaration) {
      for (const [alias, scope] of [[this.config.actionCredentialAlias, `${actionDeclaration.operation.method} ${actionDeclaration.operation.pathTemplate}`], [this.config.observerCredentialAlias, `${observerDeclaration.operation.method} ${observerDeclaration.operation.pathTemplate}`]] as const) if (!this.credentialBindings.has(alias)) this.credentialBindings.set(alias, { alias, handleDigest: hash(`handle:${alias}:1`), providerDigest: hash("declarative-secret-provider-v1"), resolverImplementationDigest: hash("declarative-http-credential-resolver-v1"), revision: 1, scopes: [scope], revoked: false, qualifiedAt: this.config.qualifiedAt, expiresAt: this.config.expiresAt });
    }
    const qualificationRuntime: BindingQualificationRuntime = {
      credentialInspector: { inspect: (alias) => structuredClone(this.credentialBindings.get(alias) ?? null) },
      actionProfile,
      observerProfile,
      probeTransport: (role) => {
        const selected = role === "action" ? actionProfile : observerProfile;
        return { reachable: true, endpointDigest: bindingQualificationDigest({ role, driverId: selected.driverId, sourceId: selected.sourceId, serverUrl: selected.serverUrl, path: selected.path, method: selected.method, implementationDigest: selected.implementationDigest }), checkedAt: this.config.qualifiedAt };
      },
      assertCurrent: () => {},
    };
    return {
      actionTransport,
      observerTransport,
      credentialResolver,
      primitiveRegistryDigest: hash("declarative-http-primitive-registry-v1"),
      verifierRegistryDigest: hash("declarative-http-verifier-registry-v1"),
      qualificationRuntime,
    };
  }

  inject(reference: string, record: Record<string, unknown>): void {
    this.records.set(reference, structuredClone(record));
  }
}

export function compileDeclarativeHttpPair(factoryResult: HttpBindingFactoryResult, world: DeclarativeHttpAcceptanceWorld): CompiledHttpBindingPair {
  const runtime = world.runtime(factoryResult);
  if (!runtime.qualificationRuntime) throw new Error("Declarative fixture qualification runtime is unavailable.");
  const qualificationRuntime = runtime.qualificationRuntime;
  const receipt = qualifyCustomerLocalBindings({ tenantId: world.config.tenantId, sessionId: world.config.sessionId, packageDigest: hash(`package:${world.config.fixtureId}`), sourceDigest: qualificationRuntime.actionProfile.sourceDigest, factoryResult, actionTransport: runtime.actionTransport, observerTransport: runtime.observerTransport, credentialResolver: runtime.credentialResolver, runtime: qualificationRuntime, qualifiedAt: world.config.qualifiedAt, expiresAt: world.config.expiresAt });
  return compileReviewedHttpBindings({
    factoryResult,
    ...runtime,
    customerLocalQualification: { receipt, runtime: qualificationRuntime },
    qualifiedAt: world.config.qualifiedAt,
    expiresAt: world.config.expiresAt,
    now: () => Date.parse(world.config.now),
  });
}

function result(config: DeclarativeHttpAcceptanceWorldConfig, caseId: PilotAdapterAcceptanceCase, passed: boolean, intendedWrites: number, detail: string): PilotAdapterAcceptanceResult {
  return { caseId, passed, intendedWrites, incorrectSideEffects: 0, checks: [{ id: `${caseId}-result`, passed, detail }], artifactReferences: [`memory://${config.fixtureId}/${caseId}`], completedAt: config.now };
}

export class DeclarativeCompiledHttpAcceptanceBinding implements GenericAcceptanceBinding {
  readonly bindingVersion = "1.0.0";
  readonly caseIds = [...REQUIRED_PILOT_ADAPTER_CASES];
  readonly bindingDigest: string;
  readonly bindingId: string;

  constructor(
    private readonly world: DeclarativeHttpAcceptanceWorld,
    private pair: CompiledHttpBindingPair,
    private readonly compileFresh: () => CompiledHttpBindingPair,
  ) {
    this.bindingDigest = pair.pairDigest;
    this.bindingId = onboardingAcceptanceBindingId(world.config.tenantId, world.config.sessionId, pair.pairDigest);
  }

  private reference(label: string): string {
    return `${this.world.config.fixtureId}-${label}`;
  }

  private workflowInput(reference: string, conflict = false): Record<string, string | number | boolean> {
    return {
      ...structuredClone(this.world.config.workflowInput),
      [this.world.config.stableInputKey]: reference,
      ...(conflict ? { [this.world.config.conflictInputKey]: this.world.config.alternativeConflictValue } : {}),
    };
  }

  private grant(pair: CompiledHttpBindingPair, reference: string): HttpActionExecutionGrant {
    const payload: Omit<HttpActionExecutionGrant, "grantDigest"> = {
      schemaVersion: "1.0", decision: "authorized",
      authorityCompilationDigest: this.factoryAuthorityDigest(pair),
      actionDeclarationDigest: pair.action.declarationDigest,
      targetAlias: this.factoryTarget(pair), operationId: this.factoryOperation(pair), method: "POST",
      parentGoalId: `goal-${reference}`, workItemId: `item-${reference}`,
      authorizedAt: new Date(Date.parse(this.world.config.now) - 60_000).toISOString(),
      expiresAt: new Date(Date.parse(this.world.config.now) + 60_000).toISOString(),
    };
    return { ...payload, grantDigest: httpActionGrantDigest(payload) };
  }

  // The compiler deliberately hides declarations behind executable adapters.
  // The reviewed values are captured once from the factory result in v1.
  private authorityDigest = "";
  private targetAlias = "";
  private operationId = "";

  bindReviewedIdentity(factoryResult: HttpBindingFactoryResult): this {
    if (!factoryResult.actionBinding) throw new Error("Declarative acceptance requires one reviewed action binding.");
    this.authorityDigest = factoryResult.actionBinding.provenance.authorityCompilationDigest;
    this.targetAlias = factoryResult.actionBinding.targetAlias;
    this.operationId = factoryResult.actionBinding.operation.operationId;
    return this;
  }

  private factoryAuthorityDigest(_pair: CompiledHttpBindingPair): string {
    if (!this.authorityDigest) throw new Error("Reviewed factory identity was not bound to acceptance.");
    return this.authorityDigest;
  }
  private factoryTarget(_pair: CompiledHttpBindingPair): string {
    if (!this.targetAlias) throw new Error("Reviewed target identity was not bound to acceptance.");
    return this.targetAlias;
  }
  private factoryOperation(_pair: CompiledHttpBindingPair): string {
    if (!this.operationId) throw new Error("Reviewed operation identity was not bound to acceptance.");
    return this.operationId;
  }

  private actionInput(pair: CompiledHttpBindingPair, reference: string, conflict = false) {
    return { requestId: `request-${reference}`, parentGoalId: `goal-${reference}`, workItemId: `item-${reference}`, workflowInput: this.workflowInput(reference, conflict), trustedContext: {}, grant: this.grant(pair, reference) };
  }

  private observationInput(reference: string, conflict = false) {
    return { requestId: `observe-${reference}`, parentGoalId: `goal-${reference}`, workItemId: `item-${reference}`, workflowInput: this.workflowInput(reference, conflict), trustedContext: {}, operationStartedAtEpochMs: Date.parse(this.world.config.now) - 1_000 };
  }

  private expectedRecord(reference: string, conflict = false): Record<string, unknown> {
    const record: Record<string, unknown> = {};
    const input = this.workflowInput(reference, conflict);
    for (const [key, value] of Object.entries(input)) record[key] = value;
    return record;
  }

  private async writeAndObserve(reference: string, pair = this.pair, loseResponse = false, conflict = false) {
    if (loseResponse) this.world.loseNextActionResponse = true;
    let lost = false;
    try { await pair.action.execute(this.actionInput(pair, reference, conflict)); }
    catch (error) { if (/response loss/i.test(String(error))) lost = true; else throw error; }
    return { observed: await pair.observer.observe(this.observationInput(reference, conflict)), lost };
  }

  async execute(caseId: PilotAdapterAcceptanceCase, _context: GenericAcceptanceAttemptContext): Promise<PilotAdapterAcceptanceResult> {
    this.world.reset();
    if (caseId === "read-only-happy-path") {
      const reference = this.reference("read"); this.world.inject(reference, this.expectedRecord(reference));
      const observed = await this.pair.observer.observe(this.observationInput(reference));
      return result(this.world.config, caseId, observed.passed && this.world.writes === 0, 0, "Independent read passed with zero writes.");
    }
    if (caseId === "approved-write") {
      const { observed } = await this.writeAndObserve(this.reference("approved"));
      return result(this.world.config, caseId, observed.passed && this.world.writes === 1, 1, "Approved write passed independent observation.");
    }
    if (caseId === "fresh-process-reuse") {
      const fresh = this.compileFresh(); const { observed } = await this.writeAndObserve(this.reference("reuse"), fresh);
      return result(this.world.config, caseId, observed.passed && fresh.pairDigest === this.pair.pairDigest, 1, "Fresh compiled process preserved reviewed identity.");
    }
    if (caseId === "missing-credential") {
      this.world.missingCredentialAliases.add(this.world.config.actionCredentialAlias);
      let blocked = false; try { await this.pair.action.execute(this.actionInput(this.pair, this.reference("credential"))); } catch { blocked = true; }
      return result(this.world.config, caseId, blocked && this.world.writes === 0, 0, "Missing credential stopped before transport.");
    }
    if (caseId === "missing-permission") {
      const input = this.actionInput(this.pair, this.reference("permission")); delete (input as { grant?: unknown }).grant;
      let blocked = false; try { await this.pair.action.execute(input); } catch { blocked = true; }
      return result(this.world.config, caseId, blocked && this.world.writes === 0, 0, "Missing exact grant stopped before transport.");
    }
    if (caseId === "lost-response-reconciliation") {
      const { observed, lost } = await this.writeAndObserve(this.reference("lost"), this.pair, true);
      return result(this.world.config, caseId, lost && observed.passed && this.world.writes === 1, 1, "Lost response reconciled without retry.");
    }
    if (caseId === "wrong-or-partial-outcome") {
      const reference = this.reference("partial"); const wrong = this.expectedRecord(reference); wrong[this.world.config.conflictInputKey] = this.world.config.alternativeConflictValue; this.world.inject(reference, wrong);
      const observed = await this.pair.observer.observe(this.observationInput(reference));
      return result(this.world.config, caseId, !observed.passed && observed.classification === "partial", 0, "Partial external outcome was rejected.");
    }
    if (caseId === "sidecar-restart") {
      const reference = this.reference("restart"); const before = await this.writeAndObserve(reference); const fresh = this.compileFresh(); const after = await fresh.observer.observe(this.observationInput(reference));
      return result(this.world.config, caseId, before.observed.passed && after.passed && fresh.pairDigest === this.pair.pairDigest, 1, "Fresh process recovered reviewed pair and external state.");
    }
    if (caseId === "duplicate-submission") {
      const reference = this.reference("duplicate"); await this.pair.action.execute(this.actionInput(this.pair, reference)); await this.pair.action.execute(this.actionInput(this.pair, reference)); const observed = await this.pair.observer.observe(this.observationInput(reference));
      return result(this.world.config, caseId, observed.passed && this.world.writes === 1, 1, "Duplicate submission produced one write.");
    }
    const reference = this.reference("conflict"); await this.pair.action.execute(this.actionInput(this.pair, reference)); let blocked = false; try { await this.pair.action.execute(this.actionInput(this.pair, reference, true)); } catch { blocked = true; }
    return result(this.world.config, caseId, blocked && this.world.writes === 1, 1, "Conflicting parent reuse stopped without a second write.");
  }
}
