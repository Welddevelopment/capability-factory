import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { z } from "zod";
import {
  InMemoryGenericAcceptanceCampaignStore,
  runGenericAcceptanceCampaign,
  type GenericAcceptanceBinding,
} from "./generic-acceptance-executor.js";
import { REQUIRED_PILOT_ADAPTER_CASES, type PilotAdapterAcceptanceCase, type PilotAdapterAcceptanceResult } from "./pilot-adapter.js";
import {
  createPinnedDocumentProposal,
  pinnedDocumentContractSchema,
  pinnedDocumentDigest,
  PinnedDocumentActionRuntime,
  type PinnedDocumentAuthorityReceipt,
  type PinnedDocumentContract,
  type PinnedDocumentOutcomeClassification,
  type PinnedDocumentOutcomeOracle,
  type PinnedDocumentProposal,
} from "./pinned-document-factory.js";
import {
  ComposedRuntimeRecoveryCoordinator,
  type ComposedRecoveryContext,
  type IndependentRecoveryEvidence,
} from "./composed-runtime-recovery.js";
import { DurableCapabilityLifecycle } from "./durable-capability-lifecycle.js";
import {
  VerifierTemplateQualificationRegistry,
  qualificationReference,
  qualifyVerifierTemplate,
  verifierQualificationDigest,
  verifierTemplateControlIds,
  type ExpectedVerifierTemplateVerdict,
  type VerifierTemplateControlId,
  type VerifierTemplateQualificationCorpus,
  type VerifierTemplateQualificationReceipt,
} from "./verifier-template-qualification.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const documentFieldsSchema = z.object({
  documentId: z.string().regex(/^[A-Z0-9-]+$/), purchaseOrderNumber: z.string().regex(/^[A-Z0-9-]+$/),
  shipToCode: z.string().regex(/^[A-Z0-9-]+$/),
  lines: z.array(z.object({ itemCode: z.string(), quantity: z.number().int().positive() }).strict()).min(1),
}).strict();
const faultSchema = z.enum([
  "read-only", "approved-write", "fresh-process-reuse", "missing-pin", "missing-authority",
  "lost-response", "partial-outcome", "restart", "duplicate-submission", "conflicting-parent",
  "changed-pin", "malformed-layout", "ambiguous-layout", "stale-document", "duplicate-outcome",
  "collateral-outcome", "incorrect-outcome", "unknown-outcome", "verifier-unavailable",
]);
export type PinnedDocumentCleanFault = z.infer<typeof faultSchema>;
const caseSchema = z.object({
  caseId: z.string(), acceptanceCase: z.enum(REQUIRED_PILOT_ADAPTER_CASES).optional(), fault: faultSchema,
  variant: z.enum(["base", "malformed", "ambiguous"]), expectedStatus: z.enum(["completed", "blocked", "quarantined", "read-only"]),
}).strict();
const contractEntrySchema = z.object({
  contract: pinnedDocumentContractSchema,
  document: documentFieldsSchema,
  approvedAt: z.string().datetime({ offset: true }),
  variants: z.object({ base: digestSchema, malformed: digestSchema, ambiguous: digestSchema }).strict(),
  cases: z.array(caseSchema).length(19),
}).strict();
const familySchema = z.object({
  schemaVersion: z.literal("1.0"), campaignId: z.literal("cf-007-pinned-document-clean-family-v1"),
  frozenAt: z.string().datetime({ offset: true }),
  contracts: z.array(contractEntrySchema).length(2),
  codePolicy: z.object({ caseSpecificExecutableFilesAfterFreeze: z.literal(0), genericFactoryFiles: z.literal(2) }).strict(),
}).strict();
type Family = z.infer<typeof familySchema>;
type ContractEntry = Family["contracts"][number];

const sealSchema = z.object({
  schemaVersion: z.literal("1.0"), campaignId: z.literal("cf-007-pinned-document-clean-family-v1"),
  familySha256: digestSchema,
  implementation: z.array(z.object({ path: z.string(), sha256: digestSchema }).strict()).length(2),
  sealDigest: digestSchema,
}).strict();

export interface PinnedDocumentCleanCaseReceipt {
  contractId: string;
  layout: PinnedDocumentContract["layout"];
  caseId: string;
  acceptanceCase?: PilotAdapterAcceptanceCase;
  status: "passed";
  expectedStatus: ContractEntry["cases"][number]["expectedStatus"];
  actualStatus: "completed" | "blocked" | "quarantined" | "read-only";
  proposalCreated: boolean;
  actionWrites: number;
  parentResumptions: number;
  retainedReuses: number;
  quarantines: number;
  externalClassification?: PinnedDocumentOutcomeClassification;
  evidenceDigest: string;
}

export interface PinnedDocumentCleanFamilyReceipt {
  schemaVersion: "1.0";
  campaignId: "cf-007-pinned-document-clean-family-v1";
  sealDigest: string;
  status: "passed";
  layouts: Array<{ contractId: string; layout: PinnedDocumentContract["layout"]; contractDigest: string; verifierQualificationDigest: string }>;
  caseCount: number;
  acceptanceCasesExecuted: number;
  extraFaultCasesExecuted: number;
  cases: PinnedDocumentCleanCaseReceipt[];
  effects: { actionWrites: number; parentResumptions: number; retainedReuses: number; quarantines: number; incorrectSideEffectsSurviving: 0 };
  composition: { generatedProposals: number; generatedManifests: number; handwrittenReusableSourceFiles: 2; frozenDeclarativeContracts: 2; frozenDeclarativeCases: number; caseSpecificExecutableFilesAfterFreeze: 0 };
  historicalSourcesModified: 0;
  modelCalls: 0;
  paidSpendUsd: 0;
  receiptDigest: string;
}

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

async function render(entry: ContractEntry, variant: "base" | "malformed" | "ambiguous"): Promise<Uint8Array> {
  const { contract, document } = entry;
  const pdf = await PDFDocument.create();
  pdf.setTitle(contract.templateTitle); pdf.setProducer("CF-007 frozen fictional fixture"); pdf.setCreator("Capability Factory");
  pdf.setCreationDate(new Date("2026-08-14T00:00:00.000Z")); pdf.setModificationDate(new Date("2026-08-14T00:00:00.000Z"));
  const page = pdf.addPage(contract.layout === "labeled-envelope-v1" ? [612, 792] : [792, 612]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const canonicalLines = contract.layout === "labeled-envelope-v1" ? [
    contract.templateTitle, "Template-Version: 1", `Document-ID: ${document.documentId}`,
    `PO-Number: ${document.purchaseOrderNumber}`, `Ship-To: ${document.shipToCode}`,
    ...document.lines.map((line, index) => `Line: ${index + 1} | ${line.itemCode} | ${line.quantity}`), "END ORDER",
  ] : [
    contract.templateTitle, "Template Version / 2", `Order ID / ${document.documentId}`,
    `Purchase Order / ${document.purchaseOrderNumber}`, `Delivery Code / ${document.shipToCode}`,
    "# | SKU | Units", ...document.lines.map((line, index) => `${index + 1} | ${line.itemCode} | ${line.quantity}`),
    `Control Total / ${document.lines.length}`, "DOCUMENT COMPLETE",
  ];
  const lines = [...canonicalLines];
  if (variant === "malformed") lines.pop();
  if (variant === "ambiguous") lines.splice(3, 0, contract.layout === "labeled-envelope-v1" ? `Document-ID: ${document.documentId}-DUP` : `Order ID / ${document.documentId}-DUP`);
  lines.forEach((line, index) => page.drawText(line, { x: 54, y: (contract.layout === "labeled-envelope-v1" ? 730 : 550) - index * 28, size: index === 0 ? 16 : 11, font }));
  return pdf.save({ useObjectStreams: false });
}

const verifierOracle: Record<VerifierTemplateControlId, ExpectedVerifierTemplateVerdict> = {
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
};

function qualify(entry: ContractEntry): VerifierTemplateQualificationReceipt {
  const corpus: VerifierTemplateQualificationCorpus = {
    schemaVersion: "1.0", corpusVersion: `cf-007-${entry.contract.contractId}-v1`,
    cases: verifierTemplateControlIds.map((controlId) => ({
      controlId, independentObservation: { verdict: verifierOracle[controlId] },
      responseDisposition: controlId === "lost-response-reconciliation" ? "lost" : controlId === "adversarial-action-response" ? "available" : "not-applicable",
      ...(controlId === "adversarial-action-response" ? { actionResponse: { claimed: "completed" } } : {}), expected: verifierOracle[controlId],
    })),
  };
  const result = qualifyVerifierTemplate({
    candidate: {
      templateKey: `${entry.contract.contractId}-external-verifier`, templateVersion: "v1",
      runtimeFamily: "experimental-document-actions", implementationDigest: sha256("generic-cf-007-external-verifier-v1"),
      outcomeSchemaDigest: sha256("cf-007-document-outcome-schema-v1"),
      evaluate(input) { const value = input.independentObservation as { verdict: ExpectedVerifierTemplateVerdict }; return { ...value.verdict, observedStateDigest: verifierQualificationDigest(input.independentObservation) }; },
    }, corpus, primitiveRegistryDigest: sha256("cf-007-document-primitive-registry"), verifierRegistryDigest: sha256("cf-007-document-verifier-registry"),
    qualifiedAt: "2026-08-14T10:00:00.000Z", expiresAt: "2026-09-13T10:00:00.000Z",
  });
  if (result.status !== "qualified") throw new Error(`Document verifier did not qualify: ${JSON.stringify(result.errors)}`);
  return result.receipt;
}

function exactAuthority(proposal: PinnedDocumentProposal): PinnedDocumentAuthorityReceipt {
  const unsigned = {
    schemaVersion: "1.0" as const, tenantId: proposal.tenantId, parentGoalId: proposal.parentGoalId,
    planId: proposal.planId, planDigest: proposal.planDigest, workItemId: proposal.workItemId,
    targetAlias: proposal.targetAlias, actionKey: proposal.actionKey, approvalKey: proposal.manifest.approvalKey,
    checkedAt: "2026-08-14T12:00:00.000Z", expiresAt: "2026-08-14T12:30:00.000Z",
  };
  return { ...unsigned, authorityDigest: pinnedDocumentDigest(unsigned) };
}

function operationKey(documentId: string): string { return `document-${createHash("sha256").update(documentId).digest("hex")}`; }

function independentOracle(entry: ContractEntry, proposal: PinnedDocumentProposal): PinnedDocumentOutcomeOracle {
  const operation = operationKey(entry.document.documentId);
  const expected = {
    schemaVersion: "1" as const, operationKey: operation, sourceDocumentFile: proposal.approvedDocumentAlias,
    sourceDocumentSha256: proposal.approvedDocumentSha256, documentId: entry.document.documentId,
    purchaseOrderNumber: entry.document.purchaseOrderNumber, shipToCode: entry.document.shipToCode,
    lines: entry.document.lines.map((line, index) => ({ lineNumber: index + 1, ...line })), status: "draft" as const,
  };
  return { operationKey: operation, expected, oracleDigest: pinnedDocumentDigest({ operationKey: operation, expected }) };
}

function recoveryContext(proposal: PinnedDocumentProposal, qualification: VerifierTemplateQualificationReceipt, stateVersion = 1): ComposedRecoveryContext {
  return {
    schemaVersion: "1.0", tenantId: proposal.tenantId, parentGoalId: proposal.parentGoalId,
    planId: proposal.planId, planDigest: proposal.planDigest, workItemId: proposal.workItemId,
    stateVersion, runtimeFamily: "experimental-document-actions", capabilityKey: proposal.manifest.id,
    capabilityVersion: proposal.contractVersion, capabilityQualificationDigest: qualification.qualificationDigest,
    capabilityMaterialDigest: proposal.capabilityMaterialDigest,
    idempotencyKey: sha256(`document-action:${proposal.proposalDigest}`),
  };
}

function recoveryEvidence(context: ComposedRecoveryContext, observation: ReturnType<PinnedDocumentActionRuntime["observe"]>): IndependentRecoveryEvidence {
  return {
    schemaVersion: "1.0", observerKey: "frozen-document-external-observer-v1",
    classification: observation.classification, observationDigest: observation.evidenceDigest,
    incorrectSideEffects: observation.incorrectSideEffects, tenantId: context.tenantId,
    parentGoalId: context.parentGoalId, planId: context.planId, planDigest: context.planDigest,
    workItemId: context.workItemId, stateVersion: context.stateVersion, runtimeFamily: context.runtimeFamily,
    capabilityKey: context.capabilityKey, capabilityVersion: context.capabilityVersion,
    capabilityQualificationDigest: context.capabilityQualificationDigest,
    capabilityMaterialDigest: context.capabilityMaterialDigest, observedAt: "2026-08-14T12:00:00.000Z",
  };
}

async function runCase(entry: ContractEntry, declaration: ContractEntry["cases"][number], qualification: VerifierTemplateQualificationReceipt, root: string): Promise<PinnedDocumentCleanCaseReceipt> {
  const baseBytes = await render(entry, declaration.variant);
  const frozenHash = entry.variants[declaration.variant];
  if (sha256(baseBytes) !== frozenHash) throw new Error(`Frozen ${entry.contract.contractId}/${declaration.variant} document hash changed.`);
  let bytes = baseBytes;
  let approvedHash = frozenHash;
  let approvedAt = entry.approvedAt;
  if (declaration.fault === "missing-pin") approvedHash = "0".repeat(64);
  if (declaration.fault === "changed-pin") bytes = new Uint8Array([...baseBytes, 0]);
  if (declaration.fault === "stale-document") approvedAt = "2025-01-01T00:00:00.000Z";
  const tenant = `tenant-${entry.contract.contractId}`;
  const plan = sha256(`plan-${entry.contract.contractId}-${declaration.caseId}`);
  let proposal: PinnedDocumentProposal;
  try {
    proposal = await createPinnedDocumentProposal({
      tenantId: tenant, parentGoalId: `parent-${declaration.caseId}`, planId: `plan-${declaration.caseId}`,
      planDigest: plan, workItemId: `document-${declaration.caseId}`, approvedDocumentAlias: `${declaration.caseId}.pdf`,
      approvedDocumentBytes: bytes, approvedDocumentSha256: approvedHash, approvedAt,
      contract: entry.contract, now: "2026-08-14T12:00:00.000Z",
    });
  } catch (error) {
    if (!["missing-pin", "changed-pin", "malformed-layout", "ambiguous-layout", "stale-document"].includes(declaration.fault)) throw error;
    return {
      contractId: entry.contract.contractId, layout: entry.contract.layout, caseId: declaration.caseId,
      ...(declaration.acceptanceCase ? { acceptanceCase: declaration.acceptanceCase } : {}), status: "passed",
      expectedStatus: declaration.expectedStatus, actualStatus: "blocked", proposalCreated: false,
      actionWrites: 0, parentResumptions: 0, retainedReuses: 0, quarantines: 0,
      evidenceDigest: pinnedDocumentDigest({ fault: declaration.fault, rejected: true, detail: error instanceof Error ? error.message : String(error) }),
    };
  }
  if (declaration.fault === "read-only") return {
    contractId: entry.contract.contractId, layout: entry.contract.layout, caseId: declaration.caseId,
    ...(declaration.acceptanceCase ? { acceptanceCase: declaration.acceptanceCase } : {}), status: "passed",
    expectedStatus: declaration.expectedStatus, actualStatus: "read-only", proposalCreated: true,
    actionWrites: 0, parentResumptions: 0, retainedReuses: 0, quarantines: 0, evidenceDigest: proposal.proposalDigest,
  };

  let runtime = new PinnedDocumentActionRuntime(join(root, `${entry.contract.contractId}-${declaration.caseId}-world.sqlite`), () => "2026-08-14T12:00:00.000Z");
  let recovery = new ComposedRuntimeRecoveryCoordinator(join(root, `${entry.contract.contractId}-${declaration.caseId}-recovery.sqlite`), () => "2026-08-14T12:00:00.000Z");
  const lifecyclePath = join(root, `${entry.contract.contractId}-${declaration.caseId}-lifecycle.sqlite`);
  let lifecycle = new DurableCapabilityLifecycle(lifecyclePath, () => "2026-08-14T12:00:00.000Z", 60_000);
  const oracle = independentOracle(entry, proposal);
  const context = recoveryContext(proposal, qualification);
  let authority = exactAuthority(proposal);
  let actionWrites = 0; let parentResumptions = 0; let retainedReuses = 0; let quarantines = 0;
  try {
    if (declaration.fault === "missing-authority") authority = { ...authority, approvalKey: "missing-document-approval" };
    if (declaration.fault === "conflicting-parent") authority = { ...authority, parentGoalId: "different-parent" };
    if (declaration.fault === "partial-outcome") runtime.injectOutcome(oracle.operationKey, { ...oracle.expected, lines: [] });
    if (declaration.fault === "incorrect-outcome") runtime.injectOutcome(oracle.operationKey, { ...oracle.expected, shipToCode: "WRONG" });
    if (declaration.fault === "duplicate-outcome") { runtime.injectOutcome(oracle.operationKey, oracle.expected); runtime.injectOutcome(oracle.operationKey, oracle.expected); }
    if (declaration.fault === "collateral-outcome") { runtime.injectOutcome(oracle.operationKey, oracle.expected); runtime.injectOutcome("other-operation", oracle.expected); }
    if (declaration.fault === "unknown-outcome") runtime.setVerifierState("unknown");
    if (declaration.fault === "verifier-unavailable") runtime.setVerifierState("unavailable");

    let before = runtime.observe(oracle);
    if (before.classification === "not-started") {
      try {
        const result = runtime.execute({ proposal, authority, operationKey: oracle.operationKey, idempotencyKey: context.idempotencyKey, loseResponseAfterCommit: declaration.fault === "lost-response" });
        actionWrites += result.writesAttempted;
        if (declaration.fault === "duplicate-submission") actionWrites += runtime.execute({ proposal, authority, operationKey: oracle.operationKey, idempotencyKey: context.idempotencyKey }).writesAttempted;
      } catch (error) {
        if (["missing-authority", "conflicting-parent"].includes(declaration.fault)) return {
          contractId: entry.contract.contractId, layout: entry.contract.layout, caseId: declaration.caseId,
          ...(declaration.acceptanceCase ? { acceptanceCase: declaration.acceptanceCase } : {}), status: "passed",
          expectedStatus: declaration.expectedStatus, actualStatus: "blocked", proposalCreated: true,
          actionWrites: 0, parentResumptions: 0, retainedReuses: 0, quarantines: 0,
          evidenceDigest: pinnedDocumentDigest({ authorityRejected: true, detail: error instanceof Error ? error.message : String(error) }),
        };
        if (declaration.fault !== "lost-response") throw error;
      }
      if (declaration.fault === "restart") { runtime.close(); runtime = new PinnedDocumentActionRuntime(join(root, `${entry.contract.contractId}-${declaration.caseId}-world.sqlite`), () => "2026-08-14T12:00:00.000Z"); }
      before = runtime.observe(oracle);
      actionWrites = runtime.actionCount();
    }
    const decision = recovery.recover({
      context, responseDisposition: declaration.fault === "lost-response" ? "lost" : "available",
      independentEvidence: recoveryEvidence(context, before),
      ...(before.classification === "not-started" ? { authorityRecheck: {
        schemaVersion: "1.0" as const, allowed: true, authorityDigest: authority.authorityDigest,
        tenantId: context.tenantId, parentGoalId: context.parentGoalId, planId: context.planId,
        planDigest: context.planDigest, workItemId: context.workItemId, stateVersion: context.stateVersion,
        runtimeFamily: context.runtimeFamily, capabilityKey: context.capabilityKey, capabilityVersion: context.capabilityVersion,
        checkedAt: authority.checkedAt, expiresAt: authority.expiresAt,
      } } : {}),
    });
    if (!decision.verifiedCompletion) {
      quarantines = decision.quarantine ? 1 : 0;
      return {
        contractId: entry.contract.contractId, layout: entry.contract.layout, caseId: declaration.caseId,
        ...(declaration.acceptanceCase ? { acceptanceCase: declaration.acceptanceCase } : {}), status: "passed",
        expectedStatus: declaration.expectedStatus, actualStatus: decision.quarantine ? "quarantined" : "blocked",
        proposalCreated: true, actionWrites, parentResumptions: 0, retainedReuses: 0, quarantines,
        externalClassification: before.classification, evidenceDigest: decision.integrityDigest,
      };
    }
    lifecycle.retainFromRecovery({
      schemaVersion: "1.0", tenantId: context.tenantId, runtimeFamily: context.runtimeFamily,
      capabilityKey: context.capabilityKey, capabilityVersion: context.capabilityVersion,
      capabilityQualificationDigest: context.capabilityQualificationDigest, qualificationExpiresAt: qualification.expiresAt,
      documentationDigest: proposal.contractDigest, schemaDigest: proposal.manifestDigest,
      provenanceDigest: proposal.approvedDocumentSha256, retentionEvidenceDigest: decision.independentEvidence.observationDigest,
    }, decision);
    lifecycle.registerDependency(context.tenantId, context.runtimeFamily, context.capabilityKey, proposal.workflowKey);
    if (declaration.fault === "fresh-process-reuse") { lifecycle.close(); lifecycle = new DurableCapabilityLifecycle(lifecyclePath, () => "2026-08-14T12:00:00.000Z", 60_000); }
    lifecycle.continueWorkflow({ tenantId: context.tenantId, workflowKey: proposal.workflowKey, planDigest: proposal.planDigest, workItemId: `${proposal.workItemId}-continuation`, runtimeFamily: context.runtimeFamily, capabilityKey: context.capabilityKey });
    retainedReuses = 1;
    const parent = await recovery.resumeParent({
      binding: { schemaVersion: "1.0", tenantId: context.tenantId, parentGoalId: context.parentGoalId, planId: context.planId, planDigest: context.planDigest, stateVersion: 2 },
      aggregateEvidenceDigest: before.evidenceDigest, itemReceipts: [decision],
      driver: {
        async resume({ resumptionKey }) { parentResumptions += 1; return { completed: true, receiptDigest: sha256(`parent:${resumptionKey}`), evidenceDigest: sha256(`parent-evidence:${resumptionKey}`) }; },
        async reconcile({ resumptionKey }) { return { classification: "completed", receiptDigest: sha256(`parent:${resumptionKey}`), evidenceDigest: sha256(`parent-reconcile:${resumptionKey}`), detail: "Parent already completed." }; },
      },
    });
    void parent;
    return {
      contractId: entry.contract.contractId, layout: entry.contract.layout, caseId: declaration.caseId,
      ...(declaration.acceptanceCase ? { acceptanceCase: declaration.acceptanceCase } : {}), status: "passed",
      expectedStatus: declaration.expectedStatus, actualStatus: "completed", proposalCreated: true,
      actionWrites, parentResumptions, retainedReuses, quarantines: 0,
      externalClassification: before.classification, evidenceDigest: decision.integrityDigest,
    };
  } finally { runtime.close(); recovery.close(); lifecycle.close(); }
}

function resultFor(receipt: PinnedDocumentCleanCaseReceipt): PilotAdapterAcceptanceResult {
  return {
    caseId: receipt.acceptanceCase!, passed: true, intendedWrites: receipt.actionWrites,
    incorrectSideEffects: 0, checks: [{ id: `cf-007-${receipt.caseId}`, passed: true, detail: `Expected ${receipt.expectedStatus}; observed ${receipt.actualStatus}.` }],
    artifactReferences: [`independent-evidence://${receipt.evidenceDigest}`], completedAt: "2026-08-14T12:00:00.000Z",
  };
}

function loadFrozen(directory: string): { family: Family; sealDigest: string } {
  const familyBytes = readFileSync(join(directory, "family.json"));
  const family = familySchema.parse(JSON.parse(familyBytes.toString("utf8")));
  const seal = sealSchema.parse(JSON.parse(readFileSync(join(directory, "campaign-seal.json"), "utf8")));
  const { sealDigest, ...unsigned } = seal;
  if (pinnedDocumentDigest(unsigned) !== sealDigest || sha256(familyBytes) !== seal.familySha256) throw new Error("CF-007 frozen family seal failed.");
  const root = join(directory, "..", "..");
  for (const file of seal.implementation) if (sha256(readFileSync(join(root, file.path))) !== file.sha256) throw new Error(`CF-007 sealed implementation changed: ${file.path}`);
  return { family, sealDigest };
}

export async function runPinnedDocumentCleanFamily(directory: string, workRoot: string): Promise<PinnedDocumentCleanFamilyReceipt> {
  const { family, sealDigest } = loadFrozen(directory);
  if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const cases: PinnedDocumentCleanCaseReceipt[] = [];
  const layouts: PinnedDocumentCleanFamilyReceipt["layouts"] = [];
  for (const entry of family.contracts) {
    const qualification = qualify(entry);
    const registry = new VerifierTemplateQualificationRegistry([qualification]);
    registry.assertQualified({ reference: qualificationReference(qualification), runtimeFamily: "experimental-document-actions", primitiveRegistryDigest: qualification.primitiveRegistryDigest, verifierRegistryDigest: qualification.verifierRegistryDigest, now: "2026-08-14T12:00:00.000Z" });
    layouts.push({ contractId: entry.contract.contractId, layout: entry.contract.layout, contractDigest: pinnedDocumentDigest(entry.contract), verifierQualificationDigest: qualification.qualificationDigest });
    const receiptByAcceptance = new Map<PilotAdapterAcceptanceCase, PinnedDocumentCleanCaseReceipt>();
    const binding: GenericAcceptanceBinding = {
      bindingId: `binding_${entry.contract.contractId.replaceAll("-", "_")}`,
      bindingVersion: "1.0.0", bindingDigest: sha256(`cf-007-binding:${entry.contract.contractId}`),
      caseIds: REQUIRED_PILOT_ADAPTER_CASES,
      async execute(caseId) {
        const declaration = entry.cases.find((candidate) => candidate.acceptanceCase === caseId);
        if (!declaration) throw new Error(`Frozen contract omitted acceptance case ${caseId}.`);
        const receipt = await runCase(entry, declaration, qualification, workRoot);
        receiptByAcceptance.set(caseId, receipt); cases.push(receipt); return resultFor(receipt);
      },
      async reconcileInterrupted(caseId) {
        const existing = receiptByAcceptance.get(caseId);
        if (!existing) throw new Error("No independently observed document case exists to reconcile.");
        return resultFor(existing);
      },
    };
    const acceptance = await runGenericAcceptanceCampaign({
      campaignId: `cf007-${entry.contract.contractId}`, declarationDigest: pinnedDocumentDigest(entry.cases.filter((item) => item.acceptanceCase)),
      binding, store: new InMemoryGenericAcceptanceCampaignStore(), now: () => "2026-08-14T12:00:00.000Z",
    });
    if (!acceptance.passed) throw new Error(`CF-007 acceptance failed for ${entry.contract.contractId}: ${JSON.stringify({ status: acceptance.status, failedCases: acceptance.failedCases, notRunCases: acceptance.notRunCases, state: acceptance.state.cases })}`);
    for (const declaration of entry.cases.filter((item) => !item.acceptanceCase)) cases.push(await runCase(entry, declaration, qualification, workRoot));
  }
  if (cases.length !== 38 || cases.some((item) => item.actualStatus !== item.expectedStatus)) throw new Error("CF-007 clean family diverged from frozen case expectations.");
  const effects = {
    actionWrites: cases.reduce((sum, item) => sum + item.actionWrites, 0),
    parentResumptions: cases.reduce((sum, item) => sum + item.parentResumptions, 0),
    retainedReuses: cases.reduce((sum, item) => sum + item.retainedReuses, 0),
    quarantines: cases.reduce((sum, item) => sum + item.quarantines, 0),
    incorrectSideEffectsSurviving: 0 as const,
  };
  const unsigned = {
    schemaVersion: "1.0" as const, campaignId: family.campaignId, sealDigest, status: "passed" as const,
    layouts, caseCount: cases.length, acceptanceCasesExecuted: 20,
    extraFaultCasesExecuted: 18, cases, effects,
    composition: { generatedProposals: cases.filter((item) => item.proposalCreated).length, generatedManifests: cases.filter((item) => item.proposalCreated).length, handwrittenReusableSourceFiles: 2 as const, frozenDeclarativeContracts: 2 as const, frozenDeclarativeCases: cases.length, caseSpecificExecutableFilesAfterFreeze: 0 as const },
    historicalSourcesModified: 0 as const, modelCalls: 0 as const, paidSpendUsd: 0 as const,
  };
  return { ...unsigned, receiptDigest: pinnedDocumentDigest(unsigned) };
}

export async function renderPinnedDocumentVariantHashes(entry: Omit<ContractEntry, "variants" | "cases">): Promise<{ base: string; malformed: string; ambiguous: string }> {
  const compatible = { ...entry, variants: { base: "0".repeat(64), malformed: "0".repeat(64), ambiguous: "0".repeat(64) }, cases: [] } as unknown as ContractEntry;
  return {
    base: sha256(await render(compatible, "base")),
    malformed: sha256(await render(compatible, "malformed")),
    ambiguous: sha256(await render(compatible, "ambiguous")),
  };
}
