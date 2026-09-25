import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { projectPilotSetup } from "../../apps/console/server/pilot-setup.js";
import { createPilotAdapterScaffold, type PilotAdapterIntake } from "./pilot-adapter-scaffold.js";
import {
  REQUIRED_PILOT_ADAPTER_CASES,
  runPilotAdapterAcceptance,
  type ControlledPilotAdapter,
  type PilotAdapterAcceptanceResult,
} from "./pilot-adapter.js";
import { assessPilotContractingReadiness, pilotContractingReadinessSchema } from "./pilot-contracting-readiness.js";
import { assessPilotCustomerIntake, pilotCustomerIntakeSchema } from "./pilot-customer-intake.js";
import { assessPilotEngagement, pilotEngagementSchema } from "./pilot-engagement.js";
import { buildPilotPackageSidecar, PilotPackageManager } from "./pilot-package.js";
import { CUSTOMER_PILOT_ACTIVATION_GATES } from "./pilot-readiness.js";
import { assessPilotSandboxSecurity, pilotSecurityProfileSchema } from "./pilot-security-profile.js";

export interface PilotConversionRehearsalReport {
  schemaVersion: "1.0";
  rehearsalId: string;
  fictionalDryRun: true;
  customerEvidence: false;
  modelCalls: 0;
  paidCalls: 0;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  adapter: { files: number; descriptorChecksPassed: boolean; acceptanceCases: number; incorrectSideEffects: number };
  package: { ready: boolean; sidecarReadyEndpoint: boolean; evidenceExportSha256: string };
  assessments: {
    intake: ReturnType<typeof assessPilotCustomerIntake>;
    security: ReturnType<typeof assessPilotSandboxSecurity>;
    contracting: ReturnType<typeof assessPilotContractingReadiness>;
    engagement: ReturnType<typeof assessPilotEngagement>;
  };
  console: { activationReady: boolean; passedGates: number; totalGates: number };
  claimBoundary: string;
  completedAt: string;
}

function sha256(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function adapterIntake(): PilotAdapterIntake {
  return {
    schemaVersion: "1.0",
    adapterId: "fictional_conversion_rehearsal",
    adapterVersion: "1.0.0",
    environmentId: "fictional_customer_sandbox",
    scopeKeys: ["approved_draft_order_scope"],
    workflowKeys: ["create_approved_draft_order"],
    targetAliases: ["customer_erp"],
    credentialAliases: ["customer_erp_writer"],
    documentation: [{ targetAlias: "customer_erp", sourcePath: "erp-api.md", mediaType: "text/markdown" }],
    operations: [
      { name: "read_draft_order", targetAlias: "customer_erp", method: "GET", consequence: "read", retrySafety: "not-applicable", outcomeVerifierKey: "direct_order_state" },
      { name: "create_draft_order", targetAlias: "customer_erp", method: "POST", consequence: "write", retrySafety: "reconcile-before-retry", outcomeVerifierKey: "direct_order_state" },
    ],
  };
}

function acceptanceResult(caseId: (typeof REQUIRED_PILOT_ADAPTER_CASES)[number]): PilotAdapterAcceptanceResult {
  return {
    caseId,
    passed: true,
    intendedWrites: ["approved-write", "lost-response-reconciliation"].includes(caseId) ? 1 : 0,
    incorrectSideEffects: 0,
    checks: [{ id: `rehearsal-${caseId}`, passed: true, detail: "The deterministic fictional rehearsal contract passed." }],
    artifactReferences: [`rehearsal://acceptance/${caseId}`],
    completedAt: new Date().toISOString(),
  };
}

export async function runPilotConversionRehearsal(rootDirectory: string): Promise<PilotConversionRehearsalReport> {
  const root = path.resolve(rootDirectory);
  if (fs.existsSync(root)) throw new Error("Rehearsal output must not already exist.");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const docs = path.join(root, "trusted-documentation"); fs.mkdirSync(docs, { mode: 0o700 });
  fs.writeFileSync(path.join(docs, "erp-api.md"), "# Fictional ERP API\nGET /draft-orders/:id\nPOST /draft-orders with Idempotency-Key.\n", { mode: 0o600 });
  const intakeDraft = adapterIntake();
  const scaffold = createPilotAdapterScaffold({
    intake: intakeDraft,
    documentationRoot: docs,
    outputDirectory: path.join(root, "adapter-scaffold"),
    productImport: "capability-factory/product",
  });
  const adapter: ControlledPilotAdapter = {
    descriptor: scaffold.descriptor,
    scopes: { resolve: async () => undefined },
    runtimes: { open: async () => undefined },
    preflight: async () => [{ id: "fictional-sandbox", passed: true, detail: "The disposable rehearsal sandbox is resettable." }],
    acceptance: { caseIds: [...REQUIRED_PILOT_ADAPTER_CASES], run: async (caseId) => acceptanceResult(caseId) },
  };
  const acceptance = await runPilotAdapterAcceptance(adapter);

  const runtimePath = path.join(root, "runtime.mjs");
  fs.writeFileSync(runtimePath, "export const createPilotRuntime = () => { throw new Error('Use the injected rehearsal runtime only.'); };\n", { mode: 0o600 });
  const manager = new PilotPackageManager(path.join(root, "customer-local-package"), { portProbe: async () => true });
  manager.initialize({ installationId: "fictional-rehearsal-installation", tenantId: "fictional_rehearsal_tenant", productVersion: "0.1.0", adapterRuntimePath: runtimePath, port: 43179 });
  const packageReadiness = await manager.readiness();
  const built = await buildPilotPackageSidecar(manager, async () => ({
    adapter,
    planner: { propose: async () => { throw new Error("The readiness rehearsal must not invoke a planner."); } },
  }));
  const readyResponse = await built.app.inject({ method: "GET", url: "/ready" });
  await built.close();

  const customerIntake = pilotCustomerIntakeSchema.parse({
    schemaVersion: "1.0",
    company: { alias: "fictional-agent-company", website: "https://example.com", stage: "Fictional early-stage company", productSummary: "Deploys an action-taking B2B agent into customer systems." },
    contacts: { technicalOwner: "fictional-technical-owner", economicOwner: "fictional-economic-owner", securityOwner: "fictional-security-owner", incidentOwner: "fictional-incident-owner" },
    recentBlocker: { happenedInRealDeployment: true, when: "Fictional rehearsal input", ordinaryGoal: "Create one approved draft order and record its reference.", exactBlockedAction: "Create one draft order through an authenticated customer API.", system: "Fictional customer ERP", mechanism: "authenticated-http-api", engineerHours: 16, delayDays: 3, economicEffect: "Fictional deployment delay for process testing only.", currentWorkaround: "An engineer builds the missing action manually.", strategicIpOrOverhead: "mostly-overhead", existingToolAttempted: "Fictional trusted-source search returned no exact fit." },
    safeEnvironment: { available: true, kind: "customer-sandbox", production: false, personalData: false, resettable: true, owner: "fictional-technical-owner" },
    authority: { allowedActionsKnown: true, forbiddenActionsKnown: true, credentialAliasesDefined: true, credentialValuesIncluded: false, approvalOwner: "fictional-technical-owner", revocationOwner: "fictional-security-owner" },
    verification: { independentSourceAvailable: true, sourceDescription: "Direct fictional sandbox state read.", exactSuccessStateKnown: true, collateralStateDefined: true },
    documentation: { available: true, customerApprovedForLocalUse: true, sourceDescription: "Pinned fictional API documentation." },
    commercial: { willingnessToDiscussPaidPilot: "yes", buyingOwnerKnown: true, contractingPathAvailable: true, notes: "Fictional agreement solely for workflow rehearsal." },
    adapterDraft: intakeDraft,
  });
  const security = pilotSecurityProfileSchema.parse({
    schemaVersion: "1.0", engagementId: "fictional-conversion-rehearsal",
    environment: { execution: "customer-local", sidecarExposure: "localhost-only", productionAccess: false, personalDataAllowed: false, fictionalOrSandboxDataOnly: true },
    credentials: { externalCredentialValuesLeaveCustomerBoundary: false, requestsContainAliasesOnly: true, owner: "fictional-security-owner", rotationProcedure: "Rotate in the customer-local secret store and rerun readiness.", revocationProcedure: "Revoke locally and halt the runtime." },
    model: { enabled: false, provider: "disabled-for-deterministic-rehearsal", modelId: "none", seesCredentialValues: false, allowedContext: [], providerRetentionStatement: "No model call occurs in this deterministic rehearsal.", customerApproved: true },
    network: { targetAliases: ["customer_erp"], redirectsBlocked: true, localhostControlBoundary: true, arbitraryEgressAllowed: false },
    controls: { declarativeHttpOnly: true, arbitraryGeneratedCodeExecution: false, leastPrivilegeMethods: true, writeIdempotencyOrReconciliation: true, independentCapabilityVerification: true, independentOutcomeVerification: true, blindRetryBlocked: true, redactedAudit: true, customerHaltControl: true, responseAndTimeLimits: true, acceptanceCampaignRequired: true },
    retention: { runtimeStateDays: 30, auditDays: 90, evidenceDays: 90, deletionOwner: "fictional-security-owner", deletionProcedure: "Delete the private rehearsal installation after export and expiry." },
    incident: { customerContact: "fictional-incident-owner", capabilityFactoryContact: "fictional-cf-owner", haltProcedure: "Set the customer-local runtime to halted.", unknownOutcomeProcedure: "Reconcile external state before any retry and escalate if still unknown.", notificationTargetHours: 4 },
    assurance: { penetrationTestCompleted: false, securityCertification: false, cyberInsuranceConfirmed: false, formalSla: false, statement: "No certification, penetration-test, insurance or formal-SLA claim is made by this rehearsal." },
    customerApprovals: { technical: true, security: true, dataOwner: true, incidentOwner: true },
    evidenceReferences: ["rehearsal://security/profile"],
  });
  const contracting = pilotContractingReadinessSchema.parse({
    schemaVersion: "1.0", assessedAt: new Date().toISOString(), founderAge: 15, parentOrGuardianInvolved: true, qualifiedUkLegalAdviceReceived: true, qualifiedUkTaxAdviceReceived: true,
    contractingParty: { kind: "professionally-advised-other", legalName: "Fictional approved contracting party", registrationOrTaxReference: "fictional-reference", authorizedSigner: "fictional-adult-signatory", signerAuthorityConfirmed: true },
    intellectualProperty: { existingIpOwnerIdentified: true, newIpTermsDefined: true, customerInputsLicenceDefined: true, openSourceReviewComplete: true },
    money: { bankAccountConfirmed: true, invoiceIssuerConfirmed: true, paymentProvider: "Fictional approved invoice path", adultRepresentativeConfirmedWhereRequired: true, currencyAndTaxTreatmentReviewed: true, recordKeepingOwner: "fictional-adult-signatory" },
    legalDocuments: { pilotOrderReviewed: true, confidentialityPathReviewed: true, dataProtectionRolesReviewed: true, liabilityAndTerminationReviewed: true, publicityConsentSeparate: true },
    insurance: { requirementAssessed: true, cyberStatus: "not-held-disclosed", professionalIndemnityStatus: "not-held-disclosed" },
    educationAndWork: { currentSchoolObligationsReviewed: true, post16EducationOrTrainingPathReviewed: true, workloadPlanRecorded: true, guardianApproved: true },
    notes: "Fictional pass state proves gate composition only; it is not legal or tax advice and does not describe Joel's current readiness.",
  });
  const engagement = pilotEngagementSchema.parse({
    schemaVersion: "1.0", engagementId: "fictional-conversion-rehearsal", companyAlias: "fictional-agent-company", status: "agreed", phase: "customer-sandbox",
    qualification: { recentBlockedDeployment: true, authenticatedHttpResidual: true, economicImpactDescribed: true, buyVsBuildUnknownOrFavorable: true, technicalOwnerNamed: true, economicOwnerNamed: true, detail: "Fictional qualification for process rehearsal." },
    workflow: { ordinaryGoal: customerIntake.recentBlocker.ordinaryGoal, missingAction: "create_draft_order", targetAliases: ["customer_erp"], allowedActions: ["read_draft_order", "create_draft_order"], forbiddenActions: ["delete_order", "production_access"], completionSummary: "Exactly one approved draft exists and its reference is recorded; unrelated state is unchanged." },
    environment: { kind: "customer-sandbox", fictionalDataOnly: true, productionAccess: false, personalDataAllowed: false },
    owners: { technical: "fictional-technical-owner", economic: "fictional-economic-owner", security: "fictional-security-owner", incident: "fictional-incident-owner" },
    commercial: { setup: { currency: "USD", amount: 2500, basis: "one-time", status: "customer-agreed" }, recurring: { currency: "USD", amount: 1500, basis: "monthly", status: "customer-agreed" }, paymentPathConfirmed: true, contractingPathConfirmed: true },
    successCriteria: { originalGoalCompleted: true, independentExternalVerification: true, incorrectSideEffects: 0, duplicateWrites: 0, unauthorizedWrites: 0, freshProcessReuse: true, safeMissingAuthorityHandoff: true, customerConfirmsRepresentative: true },
    measurement: { baselineEngineerHours: 16, baselineDelayDays: 3, targetEngineerHoursSaved: 8, targetDelayDaysSaved: 1, notes: "Fictional measurement contract." },
    stopConditions: ["Any unauthorized write.", "Any duplicate write.", "Any unresolved incorrect side effect.", "Any unknown outcome without reconciliation.", "Any credential leaving the customer boundary."],
    activationEvidence: CUSTOMER_PILOT_ACTIVATION_GATES.map((gate) => ({ gate, status: "passed", summary: `Fictional rehearsal evidence for ${gate}.`, artifactReferences: [`rehearsal://activation/${gate}`] })),
  });

  const assessments = {
    intake: assessPilotCustomerIntake(customerIntake), security: assessPilotSandboxSecurity(security),
    contracting: assessPilotContractingReadiness(contracting), engagement: assessPilotEngagement(engagement),
  };
  const preliminary = {
    fictionalDryRun: true, customerEvidence: false, modelCalls: 0, paidCalls: 0,
    adapterAcceptance: { passed: acceptance.passed, completedCases: acceptance.completedCases, incorrectSideEffects: acceptance.incorrectSideEffects },
    packageReadiness: { ready: packageReadiness.ready }, assessments,
  };
  const preliminaryPath = path.join(root, "rehearsal-input-report.json");
  fs.writeFileSync(preliminaryPath, `${JSON.stringify(preliminary, null, 2)}\n`, { mode: 0o600 });
  const evidencePath = path.join(root, "sanitized-evidence-export.json");
  const evidence = await manager.exportEvidence({ reportPath: preliminaryPath, outputPath: evidencePath });
  const consoleProjection = projectPilotSetup({
    engagement, customerIntake, securityProfile: security, contractingReadiness: contracting,
    packageReadiness,
    acceptance: { passed: acceptance.passed, caseCount: acceptance.completedCases, incorrectSideEffects: acceptance.incorrectSideEffects, artifactReferences: acceptance.results.flatMap((result) => result.artifactReferences) },
    evidenceExports: [{ label: "Fictional conversion rehearsal", createdAt: evidence.exportedAt, sha256: evidence.suppliedReportSha256 }],
    capabilityHealth: { checkedAt: new Date().toISOString(), checked: 1, healthy: 1, quarantined: 0 },
  }, { operationalMode: "running", auditPassed: true, openHandoffs: 0, activeCapabilities: 1, quarantinedCapabilities: 0 });
  const accessToken = manager.readAccessTokenForLocalClient(); const continuationSecret = manager.readContinuationSecretForLocalRuntime();
  const exportedBytes = fs.readFileSync(evidencePath, "utf8");
  const checks = [
    { id: "intake", passed: assessments.intake.adapterScaffoldReady && assessments.intake.paidPilotDiscussionReady, detail: "Customer intake can create the adapter scaffold and enter a paid-pilot discussion." },
    { id: "adapter-scaffold", passed: scaffold.checks.every((check) => check.passed), detail: "Generated descriptor passed trusted validation." },
    { id: "adapter-acceptance", passed: acceptance.passed && acceptance.incorrectSideEffects === 0, detail: "All deterministic fictional acceptance contracts ran in fixed order." },
    { id: "package-readiness", passed: packageReadiness.ready, detail: "The customer-local package passed its pre-start checks." },
    { id: "sidecar-ready", passed: readyResponse.statusCode === 200 && readyResponse.json().status === "ready", detail: "The assembled sidecar returned ready without binding a network socket." },
    { id: "security", passed: assessments.security.ready, detail: "The fictional security boundary has no unresolved gate." },
    { id: "contracting", passed: assessments.contracting.readyToSignAndCollectPayment, detail: "The fictional professionally-advised contracting scenario has no unresolved gate." },
    { id: "engagement", passed: assessments.engagement.activationReady, detail: "The fictional engagement includes every activation artifact and owner." },
    { id: "evidence-redaction", passed: !exportedBytes.includes(accessToken) && !exportedBytes.includes(continuationSecret), detail: "The immutable export excludes both generated customer-local secrets." },
    { id: "console-projection", passed: consoleProjection.activationReady, detail: "The console projects every fictional gate as passed while preserving the explicit activation-decision boundary." },
  ];
  return {
    schemaVersion: "1.0", rehearsalId: "fictional-conversion-rehearsal", fictionalDryRun: true, customerEvidence: false, modelCalls: 0, paidCalls: 0,
    checks,
    adapter: { files: scaffold.files.length, descriptorChecksPassed: scaffold.checks.every((check) => check.passed), acceptanceCases: acceptance.completedCases, incorrectSideEffects: acceptance.incorrectSideEffects },
    package: { ready: packageReadiness.ready, sidecarReadyEndpoint: readyResponse.statusCode === 200, evidenceExportSha256: sha256(evidencePath) },
    assessments,
    console: { activationReady: consoleProjection.activationReady, passedGates: consoleProjection.summary.passed, totalGates: consoleProjection.summary.total },
    claimBoundary: "This proves that the local conversion workflow composes against fictional data. It is not a customer, legal approval, production deployment, demand signal or reliability verdict.",
    completedAt: new Date().toISOString(),
  };
}
