import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";
import {
  providerWorkBoardDigest,
  providerWorkTaskDefinitions,
  DurableCustomerLocalProviderWorkBoard,
  assertCoordinatedProviderWorkBoundary,
  readProgressiveProviderWorkSource,
  type ProviderWorkEvidenceCoordinator,
  type ProviderWorkBoardSnapshot,
  type ProviderWorkEvidence,
  type ProviderWorkJourneyReader,
  type ProviderWorkTaskId,
} from "./customer-local-provider-work-board.js";
import {
  compileSdkSemanticContract,
  sdkSemanticDigest,
  type SdkSemanticContract,
} from "./customer-local-sdk-semantic-compiler.js";
import { sdkWorkPackDigest, type SdkImplementationWorkPack } from "./customer-local-sdk-work-pack.js";
import { sdkSemanticDraftDigest } from "./customer-local-sdk-semantic-drafting.js";

export const PROVIDER_TASK_CANDIDATE_COMPILER_VERSION = "1.0" as const;

const digestPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[a-zA-Z][a-zA-Z0-9_.-]{1,119}$/;
const secretPattern = /(?:bearer\s+[a-z0-9._~+/=-]+|(?:password|secret|token|api[_ -]?key)\s*[:=]\s*[^\s,;}]+|CF_CANARY_[A-Z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)-?[a-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b)/i;
const credentialAliasReference = /^cred\.[a-z][a-z0-9_.-]{1,63}$/;
const supportedReturnShapes = new Set(["Promise<Record<string, string | number | boolean | null>>"]);
const supportedErrorShapes = new Set(["SdkError", "Unauthorized", "Conflict", "RateLimited", "TimeoutBeforeCommit"]);
const supportedSourceKinds = new Set(["typescript-declarations", "reference-json", "mcp-descriptor", "minimal-sdk-index"]);
const expectedRoles = ["action", "no-write-probe", "reconciliation-readback", "independent-observer"] as const;
const supportedTaskIds = [
  "sdk-source-review",
  "action-runtime",
  "no-write-probe",
  "stable-identity",
  "idempotency-reconciliation",
  "independent-observer",
  "freshness-outcome",
] as const satisfies readonly ProviderWorkTaskId[];
type SupportedTaskId = typeof supportedTaskIds[number];

const canonical = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};
const bytesDigest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const omit = <T extends Record<string, unknown>>(value: T, key: string) => { const copy = { ...value }; delete copy[key]; return copy; };

export interface CurrentProviderWorkBoardReader {
  read(boardId: string, tenantId: string): ProviderWorkBoardSnapshot;
}

export interface ProviderTaskTypedValidationReceipt {
  schemaVersion: "1.0";
  validatorId:
    | "cf052-reviewed-sdk-source-v1"
    | "cf052-action-surface-v1"
    | "cf052-no-write-probe-surface-v1"
    | "cf052-stable-identity-v1"
    | "cf052-idempotency-reconciliation-v1"
    | "cf052-independent-observer-v1"
    | "cf052-freshness-outcome-v1";
  taskId: SupportedTaskId;
  boardId: string;
  boardSnapshotDigest: string;
  boardEvidenceDigest: string;
  artifactContentDigest: string;
  implementationDigest: string | null;
  workPackDigest: string;
  contractDigest: string;
  semanticSurfaceDigest: string;
  providerImplementationBehaviorProven: false;
  executionAuthorityEffect: "none";
  activationEffect: "none";
  receiptDigest: string;
}

export interface ProviderTaskCandidateConfig {
  schemaVersion: "1.0";
  compilerVersion: typeof PROVIDER_TASK_CANDIDATE_COMPILER_VERSION;
  state: "generated-interface-scaffold-not-qualified";
  board: { boardId: string; tenantId: string; providerId: string; journeyId: string; snapshotDigest: string; revision: number; sourceEventStateDigest: string };
  semantic: { contractDigest: string; workPackDigest: string; compilerImplementationDigest: string };
  surfaces: Array<{
    role: "action" | "no-write-probe" | "reconciliation-readback" | "independent-observer";
    methodDigest: string;
    implementationEvidenceDigest: string;
    credentialAliasReference: string;
    credentialFieldsAliasOnly: true;
    recognizedSecretShapedMaterialDetected: false;
    authorityGranted: false;
  }>;
  validationReceiptDigests: string[];
  strictSubset: {
    flatRequiredPrimitiveParametersOnly: true;
    noCustomAuthentication: true;
    noStreaming: true;
    noArbitraryTransformsOrCode: true;
    noPagination: true;
    reconcileBeforeRetry: true;
    blindRetryAllowed: false;
    separateActionProbeReconcileObserver: true;
  };
  readiness: {
    candidateInterfaceScaffoldGenerated: true;
    acceptanceHarnessOnly: true;
    providerBehaviorProven: false;
    credentialsResolved: false;
    authorityAttached: false;
    independentObserverQualified: false;
    conformancePassed: false;
    acceptancePassed: false;
    customerExecutable: false;
    activated: false;
  };
  remainingWork: string[];
  executionAuthorityEffect: "none";
  activationEffect: "none";
  configDigest: string;
}

export interface ProviderTaskCandidateArtifact {
  config: ProviderTaskCandidateConfig;
  moduleSource: string;
  moduleSourceDigest: string;
  candidateDigest: string;
}

export type ProviderTaskCandidateCompilationResult =
  | { state: "blocked"; blockers: string[]; remainingWork: string[]; candidate: null }
  | { state: "candidate-generated-not-qualified"; blockers: []; remainingWork: string[]; candidate: ProviderTaskCandidateArtifact };

const taskValidatorIds: Record<SupportedTaskId, ProviderTaskTypedValidationReceipt["validatorId"]> = {
  "sdk-source-review": "cf052-reviewed-sdk-source-v1",
  "action-runtime": "cf052-action-surface-v1",
  "no-write-probe": "cf052-no-write-probe-surface-v1",
  "stable-identity": "cf052-stable-identity-v1",
  "idempotency-reconciliation": "cf052-idempotency-reconciliation-v1",
  "independent-observer": "cf052-independent-observer-v1",
  "freshness-outcome": "cf052-freshness-outcome-v1",
};

function assertEvidence(evidence: ProviderWorkEvidence, taskId: SupportedTaskId, board: ProviderWorkBoardSnapshot) {
  const definition = providerWorkTaskDefinitions().find(item => item.taskId === taskId)!;
  if (evidence.taskId !== taskId || evidence.boardId !== board.boardId || evidence.tenantId !== board.tenantId || evidence.providerId !== board.providerId || evidence.journeyId !== board.journeyId || evidence.sourceIdentityDigest !== board.sourceIdentityDigest || evidence.sourceEventStateDigest !== board.sourceEventStateDigest || evidence.journeyDigest !== board.journeyDigest || evidence.cumulativeLineageDigest !== board.cumulativeLineageDigest || evidence.releaseManifestDigest !== board.releaseManifestDigest || evidence.readinessReceiptDigest !== board.readinessReceiptDigest) throw new Error(`CF-052 rejected stale or cross-boundary ${taskId} evidence.`);
  if (evidence.evidenceDigest !== providerWorkBoardDigest(omit(evidence as unknown as Record<string, unknown>, "evidenceDigest")) || evidence.artifact.materialDigest !== providerWorkBoardDigest(omit(evidence.artifact as unknown as Record<string, unknown>, "materialDigest")) || evidence.proof.proofDigest !== providerWorkBoardDigest(omit(evidence.proof as unknown as Record<string, unknown>, "proofDigest"))) throw new Error(`CF-052 rejected mutated ${taskId} evidence.`);
  if (evidence.artifact.kind !== definition.requiredArtifactKind || evidence.proof.surface !== definition.requiredProofSurface || evidence.proof.evidenceClass !== definition.requiredEvidenceClass || evidence.proof.artifactDigest !== evidence.artifact.contentDigest || evidence.executionAuthorityEffect !== "none" || evidence.activationEffect !== "none" || evidence.artifact.generatedStub || evidence.artifact.declarationOnly || !evidence.proof.passed || evidence.proof.actionResponseUsed) throw new Error(`CF-052 rejected ineligible ${taskId} evidence.`);
  if (definition.requiredArtifactKind === "executable-implementation" && (!evidence.artifact.executable || evidence.artifact.implementationDigest !== evidence.artifact.contentDigest)) throw new Error(`CF-052 requires exact completed implementation evidence for ${taskId}.`);
}

function semanticSurface(taskId: SupportedTaskId, contract: SdkSemanticContract, workPack: SdkImplementationWorkPack): unknown {
  if (taskId === "sdk-source-review") return { providerId: workPack.providerId, sdkSourceDigest: workPack.sdkSourceDigest, workPackDigest: workPack.workPackDigest, roles: workPack.roles.map(item => ({ role: item.review.role, methodDigest: item.methodDigest })) };
  if (taskId === "action-runtime") return { role: contract.roles.find(item => item.role === "action"), mappings: contract.parameterMappings.filter(item => item.role === "action"), policy: contract.policy };
  if (taskId === "no-write-probe") return { role: contract.roles.find(item => item.role === "no-write-probe"), mappings: contract.parameterMappings.filter(item => item.role === "no-write-probe"), policy: contract.policy };
  if (taskId === "stable-identity") return contract.stableIdentity;
  if (taskId === "idempotency-reconciliation") return { idempotency: contract.idempotency, reconciliation: contract.reconciliation };
  if (taskId === "independent-observer") return { role: contract.roles.find(item => item.role === "independent-observer"), observer: contract.observer, observerCredential: contract.credentials.observer };
  return { outcome: contract.outcome, pagination: contract.pagination };
}

function createProviderTaskTypedValidationReceipts(input: { board: ProviderWorkBoardSnapshot; contract: SdkSemanticContract; workPack: SdkImplementationWorkPack }): ProviderTaskTypedValidationReceipt[] {
  const currentDigest = providerWorkBoardDigest(omit(input.board as unknown as Record<string, unknown>, "snapshotDigest"));
  if (input.board.schemaVersion !== "1.2" || input.board.snapshotDigest !== currentDigest || input.board.providerId !== input.workPack.providerId || input.contract.providerId !== input.board.providerId || input.contract.workPackDigest !== input.workPack.workPackDigest) throw new Error("CF-052 typed validation received a stale or cross-provider board/contract/work-pack chain.");
  const { workPackDigest, ...workPackBody } = input.workPack;
  if (workPackDigest !== sdkWorkPackDigest(workPackBody)) throw new Error("CF-052 rejected a mutated SDK work pack.");
  return supportedTaskIds.map(taskId => {
    const task = input.board.tasks.find(item => item.taskId === taskId);
    if (!task || task.status !== "completed" || !task.evidence) throw new Error(`CF-052 typed validation requires completed ${taskId} evidence.`);
    assertEvidence(task.evidence, taskId, input.board);
    const surfaceDigest = sdkSemanticDigest(semanticSurface(taskId, input.contract, input.workPack));
    const body = {
      schemaVersion: "1.0" as const,
      validatorId: taskValidatorIds[taskId],
      taskId,
      boardId: input.board.boardId,
      boardSnapshotDigest: input.board.snapshotDigest,
      boardEvidenceDigest: task.evidence.evidenceDigest,
      artifactContentDigest: task.evidence.artifact.contentDigest,
      implementationDigest: task.evidence.artifact.implementationDigest,
      workPackDigest: input.workPack.workPackDigest,
      contractDigest: input.contract.contractDigest,
      semanticSurfaceDigest: surfaceDigest,
      providerImplementationBehaviorProven: false as const,
      executionAuthorityEffect: "none" as const,
      activationEffect: "none" as const,
    };
    return { ...body, receiptDigest: providerWorkBoardDigest(body) };
  });
}

function strictSubsetBlockers(contract: SdkSemanticContract, workPack: SdkImplementationWorkPack): string[] {
  const blockers: string[] = [];
  const primitive = /^(?:string|number|boolean)$/;
  const { workPackDigest, ...workPackBody } = workPack;
  if (workPackDigest !== sdkWorkPackDigest(workPackBody)) blockers.push("The SDK work-pack digest is stale or forged.");
  if (contract.providerId !== workPack.providerId || contract.workPackDigest !== workPack.workPackDigest || contract.sdkSourceDigest !== workPack.sdkSourceDigest) blockers.push("The semantic contract is stale or belongs to another provider/work pack.");
  const contractBody = omit(contract as unknown as Record<string, unknown>, "contractDigest");
  if (contract.contractDigest !== sdkSemanticDigest(contractBody)) blockers.push("The semantic contract digest is stale or forged.");
  if (containsSecretLikeString(workPack) || containsSecretLikeString(contract)) blockers.push("A source object contains raw-secret-like material; CF-052 accepts alias references only.");
  const workPackRoleNames = workPack.roles.map(item => item.review.role), contractRoleNames = contract.roles.map(item => item.role);
  if (workPack.roles.length !== 4 || new Set(workPackRoleNames).size !== 4 || expectedRoles.some(role => !workPackRoleNames.includes(role))) blockers.push("The SDK work pack must contain exactly one of each required role and no fifth role.");
  if (contract.roles.length !== 4 || new Set(contractRoleNames).size !== 4 || expectedRoles.some(role => !contractRoleNames.includes(role))) blockers.push("The semantic contract must contain exactly one of each required role and no fifth role.");
  const methodIdentities = new Set<string>(), methodDigests = new Set<string>();
  for (const role of workPack.roles) {
    if (!identifierPattern.test(role.method.module) || typeof role.method.className !== "string" || !identifierPattern.test(role.method.className) || !identifierPattern.test(role.method.methodName)) blockers.push(`${role.review.role}: provider method identity is not in the bounded identifier subset.`);
    const methodIdentity = `${role.method.module}::${role.method.className}::${role.method.methodName}::${role.method.overloadId ?? ""}`;
    if (methodIdentities.has(methodIdentity) || methodDigests.has(role.methodDigest)) blockers.push(`${role.review.role}: method identity or digest is conflated with another required surface.`);
    methodIdentities.add(methodIdentity); methodDigests.add(role.methodDigest);
    if (role.methodDigest !== sdkWorkPackDigest(role.method)) blockers.push(`${role.review.role}: method digest is stale or forged.`);
    if (role.provenance.sdkSourceDigest !== workPack.sdkSourceDigest || role.provenance.sourcePointer !== role.method.sourcePointer || !supportedSourceKinds.has(role.provenance.sourceKind) || !/^(?:fixture:\/\/[a-zA-Z0-9_.\/-]+|file:\/\/[a-zA-Z0-9_.\/-]+|[a-zA-Z0-9_.\/-]+)$/.test(role.provenance.localReference) || role.provenance.localReference.includes("..") || role.review.module !== role.method.module || role.review.className !== role.method.className || role.review.methodName !== role.method.methodName || role.review.overloadId !== role.method.overloadId || role.review.expectedSourcePointer !== role.method.sourcePointer || !role.review.exactOneToOne) blockers.push(`${role.review.role}: reviewed method identity/provenance is not self-consistent with the declared SDK source identity.`);
    for (const parameter of role.method.parameters) {
      if (!parameter.required) blockers.push(`${role.review.role}.${parameter.name}: optional parameters are unsupported because omission semantics are not proven.`);
      if (!primitive.test(parameter.type.trim())) blockers.push(`${role.review.role}.${parameter.name}: nested, collection, union or custom parameter type ${parameter.type} is unsupported.`);
      if (isAuthShapedIdentifier(parameter.name)) blockers.push(`${role.review.role}.${parameter.name}: authentication-shaped parameters cannot be supplied through workflow mappings.`);
    }
    if (role.method.pagination !== "none") blockers.push(`${role.review.role}: pagination/streaming is outside the strict candidate subset.`);
    if (/stream|iterator|iterable|readable|observable|subscription/i.test(role.method.returnType)) blockers.push(`${role.review.role}: streaming return behavior is unsupported.`);
    if (!supportedReturnShapes.has(role.method.returnType)) blockers.push(`${role.review.role}: return shape ${role.method.returnType} is outside the exact bounded allowlist.`);
    if (role.method.errorTypes.length === 0 || role.method.errorTypes.some(item => !supportedErrorShapes.has(item))) blockers.push(`${role.review.role}: custom or unknown error behavior is outside the exact allowlist.`);
    const expectedAlias = role.review.role === "action" || role.review.role === "no-write-probe" ? contract.credentials.action.alias : contract.credentials.observer.alias;
    if (!credentialAliasReference.test(expectedAlias) || role.method.authAliasRequirements.length !== 1 || role.method.authAliasRequirements[0] !== expectedAlias) blockers.push(`${role.review.role}: custom, raw, multiple or cross-surface authentication is unsupported; one exact cred.* alias reference is required.`);
  }
  const expressions = [...contract.parameterMappings.map(item => item.expression), contract.stableIdentity.expression, contract.idempotency.expression, ...contract.idempotency.conflictIdentity];
  for (const expression of expressions) if (expression.source !== "workflow-input" && expression.source !== "trusted-context") blockers.push("A value expression uses a source outside the exact workflow-input/trusted-context allowlist.");
  for (const mapping of contract.parameterMappings) if (!identifierPattern.test(mapping.parameter) || !identifierPattern.test(mapping.expression.key) || isAuthShapedIdentifier(mapping.parameter) || isAuthShapedIdentifier(mapping.expression.key) || !["identity", "string", "number", "boolean"].includes(mapping.expression.convert)) blockers.push(`${mapping.role}.${mapping.parameter}: auth-shaped data or arbitrary transform/code is unsupported.`);
  if (contract.pagination.roles.some(item => item.mode !== "not-paginated")) blockers.push("Cursor pagination is intentionally unsupported by CF-052 v1.");
  if (new Set(contract.roles.map(item => item.role)).size !== 4) blockers.push("Action, no-write probe, reconciliation and independent observer must remain four separate surfaces.");
  for (const contractRole of contract.roles) {
    const role = workPack.roles.find(item => item.review.role === contractRole.role);
    if (!role || contractRole.methodDigest !== role.methodDigest) blockers.push(`${contractRole.role}: semantic role is stale or substituted against the exact SDK method.`);
  }
  const action = workPack.roles.find(item => item.review.role === "action"), observer = workPack.roles.find(item => item.review.role === "independent-observer");
  if (!action || !observer || action.methodDigest === observer.methodDigest || action.method.module === observer.method.module || contract.observer.authIndependent !== true || contract.observer.differentMethodFromAction !== true || contract.credentials.action.alias === contract.credentials.observer.alias) blockers.push("Action and observer must have distinct reviewed method identities and credential aliases; transport/process independence remains a later qualification gate.");
  return [...new Set(blockers)];
}

function normalizeIdentifier(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isAuthShapedIdentifier(value: string): boolean {
  const normalized = normalizeIdentifier(value), compact = normalized.replace(/_/g, "");
  return /(?:^|_)(?:auth|authorization|credential|credentials|password|passwd|secret|token|api_key|access_token|bearer_token|client_secret|authorization_header)(?:$|_)/.test(normalized) || /^(?:apikey|accesstoken|bearertoken|clientsecret|authorizationheader|credential|credentials|password|secret|token)$/.test(compact);
}

function containsSecretLikeString(value: unknown): boolean {
  if (typeof value === "string") return secretPattern.test(value);
  if (Array.isArray(value)) return value.some(containsSecretLikeString);
  if (value !== null && typeof value === "object") return Object.values(value as Record<string, unknown>).some(containsSecretLikeString);
  return false;
}

function remainingWork(board: ProviderWorkBoardSnapshot): string[] {
  const task = (id: ProviderWorkTaskId) => board.tasks.find(item => item.taskId === id);
  const work: string[] = [
    "Resolve customer-local credential aliases externally; fields in the draft are alias-only and the scan detected no recognized secret-shaped material, but absence of every possible opaque credential value is not proved.",
    "Attach and enforce current customer authority immediately before any consequential action.",
    "Bind real provider transports and prove provider-specific request/response behavior.",
    "Qualify the separately authenticated read-only observer as genuinely independent external proof.",
  ];
  for (const id of ["credentials-authority", "negative-controls", "plugin-conformance", "binding-qualification", "mandatory-acceptance", "signed-release", "host-doctor"] as const) {
    const current = task(id);
    if (!current || current.status !== "completed") work.push(`Complete ${id}: ${current?.expectedArtifact ?? "required provider-work evidence is unavailable"}`);
  }
  work.push("A separate activation decision remains required even after every evidence gate passes.");
  return work;
}

function candidateModuleSource(config: Omit<ProviderTaskCandidateConfig, "configDigest">): string {
  const embedded = JSON.stringify(config);
  return `// Generated by Capability Factory CF-052. Do not edit.\nconst descriptor = Object.freeze(${embedded});\nexport { descriptor };\nfunction requireAcceptanceContext(context) {\n  if (!context || context.mode !== \"isolated-acceptance\") throw new Error(\"CF-052 candidate is restricted to an isolated acceptance harness.\");\n  if (!context.bindings || typeof context.bindings !== \"object\") throw new Error(\"Exact candidate runtime bindings are missing.\");\n}\nfunction binding(context, role) {\n  requireAcceptanceContext(context);\n  const candidate = context.bindings[role];\n  const surface = descriptor.surfaces.find((item) => item.role === role);\n  if (!candidate || candidate.implementationEvidenceDigest !== surface.implementationEvidenceDigest || typeof candidate.invoke !== \"function\") throw new Error(\"Runtime binding is absent or does not match exact reviewed implementation evidence.\");\n  return candidate;\n}\nexport async function action(input, context) {\n  requireAcceptanceContext(context);\n  if (!context.authority || typeof context.authority.check !== \"function\") throw new Error(\"Explicit action-time authority checker is missing.\");\n  const decision = await context.authority.check({ input, descriptor });\n  if (!decision || decision.allowed !== true || typeof decision.decisionDigest !== \"string\") throw new Error(\"Action-time authority was not explicitly granted.\");\n  return binding(context, \"action\").invoke({ input, decisionDigest: decision.decisionDigest });\n}\nexport async function probe(input, context) { return binding(context, \"no-write-probe\").invoke({ input }); }\nexport async function reconcile(input, context) { return binding(context, \"reconciliation-readback\").invoke({ input, blindRetryAllowed: false }); }\nexport async function observe(input, context) { return binding(context, \"independent-observer\").invoke({ input, actionResponseEligibleAsProof: false }); }\n`;
}

export interface ProviderTaskCandidateCompileInput { boardReader: CurrentProviderWorkBoardReader; boardId: string; tenantId: string; contract: SdkSemanticContract; workPack: SdkImplementationWorkPack; typedReceipts: ProviderTaskTypedValidationReceipt[]; now: string }

function buildProviderTaskCandidateUnsealed(input: ProviderTaskCandidateCompileInput): ProviderTaskCandidateCompilationResult {
  const board = input.boardReader.read(input.boardId, input.tenantId);
  if (board.boardId !== input.boardId || board.tenantId !== input.tenantId || board.snapshotDigest !== providerWorkBoardDigest(omit(board as unknown as Record<string, unknown>, "snapshotDigest"))) throw new Error("CF-052 requires the exact current integrity-bound provider work-board snapshot.");
  const blockers: string[] = [];
  for (const taskId of supportedTaskIds) {
    const task = board.tasks.find(item => item.taskId === taskId);
    if (!task || task.status !== "completed" || !task.evidence) blockers.push(`${taskId}: exact completed provider work-board evidence is required.`);
  }
  const residual = remainingWork(board);
  if (blockers.length) return { state: "blocked", blockers, remainingWork: residual, candidate: null };
  const expectedReceipts = createProviderTaskTypedValidationReceipts({ board, contract: input.contract, workPack: input.workPack });
  if (input.typedReceipts.length !== expectedReceipts.length || canonical(input.typedReceipts) !== canonical(expectedReceipts)) throw new Error("CF-052 typed evidence receipts are missing, stale, reordered or substituted.");
  const compiled = compileSdkSemanticContract({ contract: input.contract, workPack: input.workPack, now: input.now });
  const subsetBlockers = strictSubsetBlockers(input.contract, input.workPack);
  if (subsetBlockers.length) return { state: "blocked", blockers: subsetBlockers, remainingWork: residual, candidate: null };
  const evidenceByTask = new Map(board.tasks.filter(item => item.evidence).map(item => [item.taskId, item.evidence!]));
  const roleTask: Record<SdkSemanticContract["roles"][number]["role"], SupportedTaskId> = { action: "action-runtime", "no-write-probe": "no-write-probe", "reconciliation-readback": "idempotency-reconciliation", "independent-observer": "independent-observer" };
  const configBody = {
    schemaVersion: "1.0" as const,
    compilerVersion: PROVIDER_TASK_CANDIDATE_COMPILER_VERSION,
    state: "generated-interface-scaffold-not-qualified" as const,
    board: { boardId: board.boardId, tenantId: board.tenantId, providerId: board.providerId, journeyId: board.journeyId, snapshotDigest: board.snapshotDigest, revision: board.revision, sourceEventStateDigest: board.sourceEventStateDigest },
    semantic: { contractDigest: input.contract.contractDigest, workPackDigest: input.workPack.workPackDigest, compilerImplementationDigest: compiled.implementationDigest },
    surfaces: input.contract.roles.map(role => ({ role: role.role, methodDigest: role.methodDigest, implementationEvidenceDigest: evidenceByTask.get(roleTask[role.role])!.artifact.implementationDigest!, credentialAliasReference: role.role === "action" || role.role === "no-write-probe" ? input.contract.credentials.action.alias : input.contract.credentials.observer.alias, credentialFieldsAliasOnly: true as const, recognizedSecretShapedMaterialDetected: false as const, authorityGranted: false as const })),
    validationReceiptDigests: expectedReceipts.map(item => item.receiptDigest),
    strictSubset: { flatRequiredPrimitiveParametersOnly: true as const, noCustomAuthentication: true as const, noStreaming: true as const, noArbitraryTransformsOrCode: true as const, noPagination: true as const, reconcileBeforeRetry: true as const, blindRetryAllowed: false as const, separateActionProbeReconcileObserver: true as const },
    readiness: { candidateInterfaceScaffoldGenerated: true as const, acceptanceHarnessOnly: true as const, providerBehaviorProven: false as const, credentialsResolved: false as const, authorityAttached: false as const, independentObserverQualified: false as const, conformancePassed: false as const, acceptancePassed: false as const, customerExecutable: false as const, activated: false as const },
    remainingWork: residual,
    executionAuthorityEffect: "none" as const,
    activationEffect: "none" as const,
  };
  const config: ProviderTaskCandidateConfig = { ...configBody, configDigest: sdkSemanticDigest(configBody) };
  const moduleSource = candidateModuleSource(configBody);
  if (secretPattern.test(moduleSource) || secretPattern.test(canonical(config))) throw new Error("CF-052 candidate output contains secret-like material.");
  const moduleSourceDigest = bytesDigest(moduleSource);
  const candidateDigest = sdkSemanticDigest({ configDigest: config.configDigest, moduleSourceDigest });
  return { state: "candidate-generated-not-qualified", blockers: [], remainingWork: residual, candidate: { config, moduleSource, moduleSourceDigest, candidateDigest } };
}

/**
 * Deliberately sealed public boundary. The draft implementation above remains private so
 * its shape can be reviewed, but no caller can turn the unaudited CF-051/CF-046 board into
 * output. A later explicit patch may open this only after the dependency passes re-audit.
 */
export function compileProviderTaskCandidate(_input: ProviderTaskCandidateCompileInput): never {
  throw new Error("CF-052 board-to-candidate compilation is dependency-blocked until the revised CF-051 evidence chain passes independent re-audit.");
}

// Keep the draft statically checked without exposing it as a supported producer.
void buildProviderTaskCandidateUnsealed;

export interface Cf052AuthorityReceipt {
  schemaVersion: "1.0";
  candidateIdentityDigest: string;
  exactInputDigest: string;
  tenantId: string;
  scope: string;
  target: string;
  policyVersion: string;
  issuedAt: string;
  expiresAt: string;
  signerKeyId: string;
  signature: string;
}
export interface Cf052StrictImplementationBundle {
  localProvider: Cf052StrictLocalProviderHandle;
  authorityPublicKeyPem: string;
  authorityPublicKeyDigest: string;
  authoritySignerKeyId: string;
  currentTime(): string;
}

const CF052_ACTION_PROCESS_SOURCE = `import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
const digest=value=>createHash("sha256").update(value).digest("hex");
const [statePath,launchNonce,processToken]=process.argv.slice(2),sourceDigest=digest(readFileSync(fileURLToPath(import.meta.url))),processKeyDigest=digest(processToken),read=()=>JSON.parse(readFileSync(statePath,"utf8")),save=value=>{const next=statePath+".next";writeFileSync(next,JSON.stringify(value));renameSync(next,statePath);};
let identity;const server=http.createServer((request,response)=>{let raw="";request.on("data",chunk=>raw+=chunk);request.on("end",()=>{if(request.method!=="POST"||request.headers["x-cf052-process-token"]!==processToken){response.statusCode=403;return response.end();}const body=raw?JSON.parse(raw):{},input=body.input||{},stableId=String(input.orderRef||"");let result;if(request.url==="/identity")result=identity;else if(request.url==="/probe"){const state=read(),record=state.records[stableId];result={reachable:true,writeCount:0,stableId,baselineVersion:state.sequence,preexistingRecordVersion:record?record.version:null,serverTimestamp:state.serverTimestamp};}else if(request.url==="/reconcile"){const state=read(),record=state.records[stableId];result={classification:record?"completed":"not-started",stableId,matchCount:record?1:0,observedVersion:record?record.version:null,observedAt:record?record.updatedAt:state.serverTimestamp,serverSequence:state.sequence,writeCount:0};}else if(request.url==="/action"){const state=read(),exists=Boolean(state.records[stableId]);if(!exists){state.sequence++;state.serverTimestamp=new Date(Math.max(Date.now(),Date.parse(state.serverTimestamp)+1)).toISOString();state.records[stableId]={stableId,version:state.sequence,updatedAt:state.serverTimestamp};state.writes++;save(state);}const record=state.records[stableId];result={status:exists?"already-exists":"committed",stableId,totalBusinessWrites:state.writes,committedVersion:record.version,committedAt:record.updatedAt};}else{response.statusCode=404;return response.end();}const encoded=JSON.stringify(result);response.setHeader("content-type","application/json");response.setHeader("content-length",Buffer.byteLength(encoded));response.end(encoded);});});
server.listen(0,"127.0.0.1",()=>{const endpoint=\`http://127.0.0.1:\${server.address().port}/\`;identity={plane:"action",pid:process.pid,launchNonce,processKeyDigest,sourceDigest,endpoint};process.stdout.write(JSON.stringify(identity)+"\\n");});process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
`;
const CF052_OBSERVER_PROCESS_SOURCE = `import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
const digest=value=>createHash("sha256").update(value).digest("hex");
const [statePath,launchNonce,processToken]=process.argv.slice(2),sourceDigest=digest(readFileSync(fileURLToPath(import.meta.url))),processKeyDigest=digest(processToken),read=()=>JSON.parse(readFileSync(statePath,"utf8"));
let identity;const server=http.createServer((request,response)=>{let raw="";request.on("data",chunk=>raw+=chunk);request.on("end",()=>{if(request.method!=="POST"||request.headers["x-cf052-process-token"]!==processToken){response.statusCode=403;return response.end();}const body=raw?JSON.parse(raw):{},stableId=String((body.input||{}).orderRef||"");let result;if(request.url==="/identity")result=identity;else if(request.url==="/observe"){const state=read(),record=state.records[stableId],observationClock=new Date().toISOString();result={classification:record?"completed":"not-started",stableId,matchCount:record?1:0,observedVersion:record?record.version:null,observedAt:record?record.updatedAt:state.serverTimestamp,observationClock,serverSequence:state.sequence,collateralClean:Object.keys(state.records).every(key=>state.records[key].stableId===key&&Number.isInteger(state.records[key].version)&&typeof state.records[key].updatedAt==="string"),writeCount:0};}else{response.statusCode=404;return response.end();}const encoded=JSON.stringify(result);response.setHeader("content-type","application/json");response.setHeader("content-length",Buffer.byteLength(encoded));response.end(encoded);});});
server.listen(0,"127.0.0.1",()=>{const endpoint=\`http://127.0.0.1:\${server.address().port}/\`;identity={plane:"observer",pid:process.pid,launchNonce,processKeyDigest,sourceDigest,endpoint};process.stdout.write(JSON.stringify(identity)+"\\n");});process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
`;
type Cf052ProcessIdentity = { plane: "action" | "observer"; pid: number; launchNonce: string; processKeyDigest: string; sourceDigest: string; endpoint: string };
type Cf052LaunchReceipt = { schemaVersion: "1.0"; launcherPublicKeyDigest: string; action: Cf052ProcessIdentity; observer: Cf052ProcessIdentity; issuedAt: string; signature: string; receiptDigest: string };
export interface Cf052StrictLocalProviderHandle { readonly launchReceiptDigest: string; }
type Cf052LocalProviderPrivate = { action: ChildProcessWithoutNullStreams; observer: ChildProcessWithoutNullStreams; actionToken: string; observerToken: string; receipt: Cf052LaunchReceipt; publicKeyPem: string; statePath: string; actionSourcePath: string; observerSourcePath: string };
const cf052LocalProviders = new WeakMap<object, Cf052LocalProviderPrivate>();

async function launchOneCf052Process(input: { scriptPath: string; statePath: string; launchNonce: string; processToken: string; plane: "action" | "observer" }): Promise<{ child: ChildProcessWithoutNullStreams; identity: Cf052ProcessIdentity }> {
  const child = spawn(process.execPath, [input.scriptPath, input.statePath, input.launchNonce, input.processToken], { stdio: ["pipe", "pipe", "pipe"] });
  const line = await new Promise<string>((resolveLine, reject) => { let stderr = ""; const timeout = setTimeout(() => reject(new Error(`CF-052 ${input.plane} process did not start.`)), 3000); child.once("error", reject); child.stderr.on("data", chunk => stderr += chunk.toString()); child.stdout.once("data", chunk => { clearTimeout(timeout); resolveLine(chunk.toString().trim()); }); child.once("exit", code => { if (code) reject(new Error(`CF-052 ${input.plane} process exited ${code}: ${stderr}`)); }); });
  const identity = JSON.parse(line) as Cf052ProcessIdentity;
  const expectedSourceDigest = bytesDigest(readFileSync(input.scriptPath));
  if (identity.plane !== input.plane || identity.pid !== child.pid || identity.launchNonce !== input.launchNonce || identity.processKeyDigest !== bytesDigest(input.processToken) || identity.sourceDigest !== expectedSourceDigest || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(identity.endpoint)) { child.kill("SIGTERM"); throw new Error(`CF-052 ${input.plane} process identity did not match its module-owned launch.`); }
  return { child, identity: deepFreeze(identity) };
}

export async function launchCf052StrictLocalProvider(input: { artifactRoot: string; now: string }): Promise<Cf052StrictLocalProviderHandle> {
  const root = resolve(input.artifactRoot); mkdirSync(root, { recursive: true, mode: 0o700 });
  const actionDigest = bytesDigest(CF052_ACTION_PROCESS_SOURCE), observerDigest = bytesDigest(CF052_OBSERVER_PROCESS_SOURCE);
  const actionPath = join(root, `${actionDigest}-action.mjs`), observerPath = join(root, `${observerDigest}-observer.mjs`), statePath = join(root, `${randomBytes(16).toString("hex")}-world.json`);
  for (const [filePath, source] of [[actionPath, CF052_ACTION_PROCESS_SOURCE], [observerPath, CF052_OBSERVER_PROCESS_SOURCE]] as const) { try { writeFileSync(filePath, source, { encoding: "utf8", mode: 0o600, flag: "wx" }); } catch { if (readFileSync(filePath, "utf8") !== source) throw new Error("CF-052 content-addressed provider process source was substituted."); } if (bytesDigest(readFileSync(filePath)) !== bytesDigest(source)) throw new Error("CF-052 provider process source bytes changed after materialization."); }
  const launchedAt = new Date().toISOString();
  writeFileSync(statePath, JSON.stringify({ records: { "CF052-STALE-CONTROL": { stableId: "CF052-STALE-CONTROL", version: 0, updatedAt: "2000-01-01T00:00:00.000Z" }, "CF052-FUTURE-CONTROL": { stableId: "CF052-FUTURE-CONTROL", version: 1, updatedAt: "2999-01-01T00:00:00.000Z" } }, writes: 0, sequence: 0, serverTimestamp: launchedAt }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  const actionNonce = randomBytes(32).toString("hex"), observerNonce = randomBytes(32).toString("hex"), actionToken = randomBytes(32).toString("hex"), observerToken = randomBytes(32).toString("hex");
  const action = await launchOneCf052Process({ scriptPath: actionPath, statePath, launchNonce: actionNonce, processToken: actionToken, plane: "action" });
  let observer: Awaited<ReturnType<typeof launchOneCf052Process>>;
  try { observer = await launchOneCf052Process({ scriptPath: observerPath, statePath, launchNonce: observerNonce, processToken: observerToken, plane: "observer" }); } catch (error) { action.child.kill("SIGTERM"); throw error; }
  if (action.child.pid === observer.child.pid || action.identity.launchNonce === observer.identity.launchNonce || action.identity.processKeyDigest === observer.identity.processKeyDigest || action.identity.endpoint === observer.identity.endpoint) { action.child.kill("SIGTERM"); observer.child.kill("SIGTERM"); throw new Error("CF-052 action and observer must be distinct actual child processes with distinct nonces and process keys."); }
  const keys = generateKeyPairSync("ed25519"), publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString(), launcherPublicKeyDigest = bytesDigest(keys.publicKey.export({ type: "spki", format: "der" }));
  const body = { schemaVersion: "1.0" as const, launcherPublicKeyDigest, action: action.identity, observer: observer.identity, issuedAt: input.now }, signature = sign(null, Buffer.from(canonical(body)), keys.privateKey).toString("base64"), receiptBody = { ...body, signature }, receipt: Cf052LaunchReceipt = deepFreeze({ ...receiptBody, receiptDigest: providerWorkBoardDigest(receiptBody) });
  const handle: Cf052StrictLocalProviderHandle = Object.freeze({ launchReceiptDigest: receipt.receiptDigest });
  cf052LocalProviders.set(handle, { action: action.child, observer: observer.child, actionToken, observerToken, receipt, publicKeyPem, statePath, actionSourcePath: actionPath, observerSourcePath: observerPath });
  return handle;
}

export function closeCf052StrictLocalProvider(handle: Cf052StrictLocalProviderHandle): void { const local = cf052LocalProviders.get(handle as object); if (!local) throw new Error("CF-052 local provider handle is forged, cloned, stale or already closed."); local.action.kill("SIGTERM"); local.observer.kill("SIGTERM"); cf052LocalProviders.delete(handle as object); }

const CF052_ACTION_CANDIDATE_SOURCE = `async function call(route, payload, transport) {
  const response = await fetch(new URL(route, transport.endpoint), { method: "POST", redirect: "error", headers: { "content-type": "application/json", "x-cf052-process-token": transport.processToken }, body: JSON.stringify(payload), signal: AbortSignal.timeout(2000) });
  if (!response.ok || Number(response.headers.get("content-length") || "0") > 65536) throw new Error("CF-052 action transport rejected the bounded request.");
  return response.json();
}
export async function identify(transport) { return call("/identity", {}, transport); }
export async function probe(input, transport) { return call("/probe", { input }, transport); }
export async function action(input, authority, transport) { return call("/action", { input, authority }, transport); }
export async function reconcile(input, transport) { return call("/reconcile", { input }, transport); }
`;
const CF052_OBSERVER_CANDIDATE_SOURCE = `async function call(route, payload, transport) {
  const response = await fetch(new URL(route, transport.endpoint), { method: "POST", redirect: "error", headers: { "content-type": "application/json", "x-cf052-process-token": transport.processToken }, body: JSON.stringify(payload), signal: AbortSignal.timeout(2000) });
  if (!response.ok || Number(response.headers.get("content-length") || "0") > 65536) throw new Error("CF-052 observer transport rejected the bounded request.");
  return response.json();
}
export async function identify(transport) { return call("/identity", {}, transport); }
export async function observe(input, transport) { return call("/observe", { input }, transport); }
`;
type Cf052TransportBinding = Readonly<{ endpoint: string; processToken: string }>;
type Cf052ActionCandidateModule = {
  identify(transport: Cf052TransportBinding): Promise<Cf052ProcessIdentity>;
  probe(input: Record<string, unknown>, transport: Cf052TransportBinding): Promise<{ reachable: true; writeCount: 0; stableId: string; baselineVersion: number; preexistingRecordVersion: number | null; serverTimestamp: string }>;
  action(input: Record<string, unknown>, authority: Cf052AuthorityReceipt, transport: Cf052TransportBinding): Promise<{ status: "committed" | "already-exists"; stableId: string; totalBusinessWrites: number; committedVersion: number; committedAt: string }>;
  reconcile(input: Record<string, unknown>, transport: Cf052TransportBinding): Promise<{ classification: "completed" | "not-started"; stableId: string; matchCount: 0 | 1; observedVersion: number | null; observedAt: string; serverSequence: number; writeCount: 0 }>;
};
type Cf052ObserverCandidateModule = {
  identify(transport: Cf052TransportBinding): Promise<Cf052ProcessIdentity>;
  observe(input: Record<string, unknown>, transport: Cf052TransportBinding): Promise<{ classification: "completed" | "not-started"; stableId: string; matchCount: 0 | 1; observedVersion: number | null; observedAt: string; observationClock: string; serverSequence: number; collateralClean: true; writeCount: 0 }>;
};
async function loadExactCandidateModule<T>(source: string): Promise<T> {
  const url = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
  return await import(url) as T;
}

function snapshotPlainBounded(input: unknown): Readonly<Record<string, unknown>> {
  let units = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (++units > 512 || depth > 12) throw new Error("CF-052 input exceeds the bounded plain-data envelope.");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("CF-052 input contains a non-finite number."); return value; }
    if (typeof value !== "object" || utilTypes.isProxy(value)) throw new Error("CF-052 input must be plain bounded data without proxies, functions, symbols or accessors.");
    if (Reflect.ownKeys(value).some(key => typeof key === "symbol")) throw new Error("CF-052 input cannot contain symbol keys.");
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value), keys = Object.keys(descriptors).filter(key => key !== "length");
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new Error("CF-052 arrays must be dense plain data without custom properties.");
      return Object.freeze(keys.map(key => { const descriptor = descriptors[key]!; if (!("value" in descriptor) || descriptor.get || descriptor.set) throw new Error("CF-052 input cannot contain accessors or serialization hooks."); return copy(descriptor.value, depth + 1); }));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("CF-052 input must have a plain object prototype.");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || descriptor.get || descriptor.set || key === "toJSON") throw new Error("CF-052 input cannot contain accessors or serialization hooks.");
      result[key] = copy(descriptor.value, depth + 1);
    }
    return Object.freeze(result);
  };
  const snapshot = copy(input, 0);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("CF-052 input root must be a plain object.");
  if (Buffer.byteLength(canonical(snapshot), "utf8") > 32_768) throw new Error("CF-052 input exceeds the byte limit.");
  return snapshot as Readonly<Record<string, unknown>>;
}
export interface Cf052JoinedCandidate {
  state: "qualified-local-candidate-not-accepted-not-activated";
  descriptor: Readonly<Record<string, unknown>>;
  candidateIdentityDigest: string;
  qualificationReceiptDigest: string;
  typedTaskReceiptDigests: Record<"action-runtime" | "no-write-probe" | "stable-identity" | "idempotency-reconciliation" | "independent-observer" | "freshness-outcome", string>;
  manualAndUnknownResidual: string[];
  action(input: Record<string, unknown>, authority: Cf052AuthorityReceipt): Promise<{ status: "committed" | "already-exists"; stableId: string; totalBusinessWrites: number; committedVersion: number; committedAt: string }>;
  probe(input: Record<string, unknown>): Promise<{ reachable: true; writeCount: 0; stableId: string; baselineVersion: number; preexistingRecordVersion: number | null; serverTimestamp: string }>;
  reconcile(input: Record<string, unknown>): Promise<{ classification: "completed" | "not-started"; stableId: string; matchCount: 0 | 1; observedVersion: number | null; observedAt: string; serverSequence: number; writeCount: 0 }>;
  observe(input: Record<string, unknown>): Promise<{ classification: "completed" | "not-started"; stableId: string; matchCount: 0 | 1; observedVersion: number | null; observedAt: string; observationClock: string; serverSequence: number; collateralClean: true; writeCount: 0 }>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function authorityPayload(receipt: Cf052AuthorityReceipt) { const { signature: _signature, ...payload } = receipt; return payload; }
function verifyAuthority(receipt: Cf052AuthorityReceipt, expected: { candidateIdentityDigest: string; exactInputDigest: string; tenantId: string; scope: string; target: string; policyVersion: string; now: string }, bundle: Cf052StrictImplementationBundle) {
  const publicKey = createPublicKey(bundle.authorityPublicKeyPem), publicDer = publicKey.export({ type: "spki", format: "der" });
  const issued = Date.parse(receipt.issuedAt), expires = Date.parse(receipt.expiresAt), current = Date.parse(expected.now);
  if (bytesDigest(publicDer) !== bundle.authorityPublicKeyDigest || receipt.schemaVersion !== "1.0" || receipt.signerKeyId !== bundle.authoritySignerKeyId || receipt.candidateIdentityDigest !== expected.candidateIdentityDigest || receipt.exactInputDigest !== expected.exactInputDigest || receipt.tenantId !== expected.tenantId || receipt.scope !== expected.scope || receipt.target !== expected.target || receipt.policyVersion !== expected.policyVersion || !Number.isFinite(issued) || !Number.isFinite(expires) || !Number.isFinite(current) || issued > current || expires <= issued || expires <= current || !verify(null, Buffer.from(canonical(authorityPayload(receipt))), publicKey, Buffer.from(receipt.signature, "base64"))) throw new Error("Typed current authority receipt is missing, stale, cross-input, cross-tenant, cross-scope, cross-target, cross-policy or incorrectly signed.");
}
function deriveCf052Freshness(input: { baselineVersion: number; operationStartedAt: string; observedVersion: number | null; observedAt: string; observationClock: string; maximumAgeSeconds: number }): { fresh: boolean; ageMilliseconds: number | null; reasons: string[] } {
  const operationStarted = Date.parse(input.operationStartedAt), observed = Date.parse(input.observedAt), clock = Date.parse(input.observationClock), maximumAgeMilliseconds = input.maximumAgeSeconds * 1000, reasons: string[] = [];
  if (!Number.isInteger(input.observedVersion) || input.observedVersion! <= input.baselineVersion) reasons.push("observed-version-did-not-advance");
  if (!Number.isFinite(operationStarted) || !Number.isFinite(observed) || !Number.isFinite(clock)) reasons.push("timestamp-invalid");
  if (Number.isFinite(observed) && Number.isFinite(operationStarted) && observed < operationStarted) reasons.push("observed-before-operation-start");
  if (Number.isFinite(observed) && Number.isFinite(clock) && observed > clock) reasons.push("observation-is-future-dated");
  const ageMilliseconds = Number.isFinite(observed) && Number.isFinite(clock) ? clock - observed : null;
  if (ageMilliseconds !== null && ageMilliseconds > maximumAgeMilliseconds) reasons.push("observation-exceeds-maximum-age");
  return { fresh: reasons.length === 0, ageMilliseconds, reasons };
}
function requireCf052LocalProvider(handle: Cf052StrictLocalProviderHandle): Cf052LocalProviderPrivate {
  const local = cf052LocalProviders.get(handle as object);
  if (!local || local.action.exitCode !== null || local.observer.exitCode !== null || local.action.pid === local.observer.pid) throw new Error("CF-052 requires a live module-owned local-provider handle with distinct child processes.");
  const { receiptDigest, ...receiptBody } = local.receipt, { signature, ...signedBody } = receiptBody, publicKey = createPublicKey(local.publicKeyPem);
  if (handle.launchReceiptDigest !== receiptDigest || receiptDigest !== providerWorkBoardDigest(receiptBody) || bytesDigest(publicKey.export({ type: "spki", format: "der" })) !== signedBody.launcherPublicKeyDigest || !verify(null, Buffer.from(canonical(signedBody)), publicKey, Buffer.from(signature, "base64")) || local.receipt.action.pid !== local.action.pid || local.receipt.observer.pid !== local.observer.pid || local.receipt.action.launchNonce === local.receipt.observer.launchNonce || local.receipt.action.processKeyDigest === local.receipt.observer.processKeyDigest || local.receipt.action.endpoint === local.receipt.observer.endpoint || bytesDigest(local.actionToken) !== local.receipt.action.processKeyDigest || bytesDigest(local.observerToken) !== local.receipt.observer.processKeyDigest || bytesDigest(readFileSync(local.actionSourcePath)) !== local.receipt.action.sourceDigest || bytesDigest(readFileSync(local.observerSourcePath)) !== local.receipt.observer.sourceDigest) throw new Error("CF-052 module-owned provider launch receipt or materialized process source is forged, stale, self-attested or conflated.");
  return local;
}

export async function compileJoinedProviderTaskCandidate(input: {
  board: DurableCustomerLocalProviderWorkBoard;
  coordinator: ProviderWorkEvidenceCoordinator;
  source: ProviderWorkJourneyReader;
  boardId: string;
  tenantId: string;
  contract: SdkSemanticContract;
  workPack: SdkImplementationWorkPack;
  implementation: Cf052StrictImplementationBundle;
  qualificationInput: Record<string, unknown>;
  qualificationAuthority(input: { candidateIdentityDigest: string; exactInputDigest: string; tenantId: string; scope: string; target: string; policyVersion: string; now: string }): Cf052AuthorityReceipt;
  target: string;
  policyVersion: string;
  now: string;
}): Promise<Cf052JoinedCandidate> {
  assertCoordinatedProviderWorkBoundary(input.board, input.coordinator);
  if (input.implementation.currentTime() !== input.now) throw new Error("CF-052 qualification time must come from the exact current implementation clock.");
  if (Object.getPrototypeOf(input.board) !== DurableCustomerLocalProviderWorkBoard.prototype) throw new Error("CF-052 requires the exact durable CF-051 provider work-board implementation, not a reader, subclass or prototype-forged substitute.");
  const board = input.board.read(input.boardId, input.tenantId);
  if (board.originMode !== "cf041-progressive" || board.importedStage !== "cf041-semantic-review" || board.tenantId !== input.tenantId || board.snapshotDigest !== providerWorkBoardDigest(omit(board as unknown as Record<string, unknown>, "snapshotDigest"))) throw new Error("CF-052 requires the exact current progressive CF-051 board state.");
  const anchor = readProgressiveProviderWorkSource(input.source, board.journeyId, board.tenantId, board.providerId, input.now);
  const semanticDraft = anchor.semanticDraft, { snapshotDigest: persistedSemanticDigest, ...semanticBody } = semanticDraft;
  if (persistedSemanticDigest !== sdkSemanticDraftDigest(semanticBody) || semanticDraft.state !== "reviewed-contract-ready" || !semanticDraft.reviewedContract || semanticDraft.snapshotDigest !== board.semanticDraftDigest || semanticDraft.workPackDigest !== board.workPackDigest || canonical(semanticDraft.reviewedContract) !== canonical(input.contract)) throw new Error("CF-052 semantic contract must equal the exact integrity-checked CF-041 reviewed contract; substitution of mappings, scope, outcome or policy is rejected.");
  if (canonical(anchor.workPack) !== canonical(input.workPack)) throw new Error("CF-052 work pack must equal the exact persisted CF-036 reviewed mapping.");
  const sourceReview = board.tasks.find(item => item.taskId === "sdk-source-review")?.evidence?.typedValidation;
  if (!sourceReview || sourceReview.validatorId !== "cf051-cf036-reviewed-source" || sourceReview.taskId !== "sdk-source-review" || sourceReview.workPackDigest !== input.workPack.workPackDigest || sourceReview.semanticDraftDigest !== board.semanticDraftDigest) throw new Error("CF-052 requires the exact retained CF-051 typed reviewed-source envelope.");
  const subsetBlockers = strictSubsetBlockers(input.contract, input.workPack);
  if (subsetBlockers.length) throw new Error(`CF-052 strict subset rejected: ${subsetBlockers.join(" ")}`);
  const required = supportedTaskIds.filter(id => id !== "sdk-source-review");
  if (containsSecretLikeString(input.implementation)) throw new Error("CF-052 implementation input contains recognized secret-shaped material.");
  const localProvider = requireCf052LocalProvider(input.implementation.localProvider);
  const actionDigest = bytesDigest(CF052_ACTION_CANDIDATE_SOURCE), observerDigest = bytesDigest(CF052_OBSERVER_CANDIDATE_SOURCE);
  if (!digestPattern.test(actionDigest) || !digestPattern.test(observerDigest) || actionDigest === observerDigest || localProvider.receipt.action.sourceDigest !== bytesDigest(CF052_ACTION_PROCESS_SOURCE) || localProvider.receipt.observer.sourceDigest !== bytesDigest(CF052_OBSERVER_PROCESS_SOURCE)) throw new Error("Exact action/observer candidate or module-owned provider-process source bytes are missing or conflated.");
  const descriptorBody = { schemaVersion: "1.0", boundary: "cf052-strict-local-candidate", tenantId: input.tenantId, providerId: board.providerId, boardSnapshotDigest: board.snapshotDigest, sourceTypedValidationDigest: sourceReview.validationReceiptDigest, contractDigest: input.contract.contractDigest, workPackDigest: input.workPack.workPackDigest, actionSourceDigest: actionDigest, observerSourceDigest: observerDigest, localProviderLaunchReceiptDigest: localProvider.receipt.receiptDigest, actionProcess: localProvider.receipt.action, observerProcess: localProvider.receipt.observer, authorityPublicKeyDigest: input.implementation.authorityPublicKeyDigest, authoritySignerKeyId: input.implementation.authoritySignerKeyId, target: input.target, policyVersion: input.policyVersion, customerExecutable: false, accepted: false, activated: false };
  const qualificationInput = snapshotPlainBounded(input.qualificationInput);
  const candidateIdentityDigest = providerWorkBoardDigest(descriptorBody), exactInputDigest = providerWorkBoardDigest(qualificationInput), actionScope = input.contract.credentials.action.exactScope;
  const qualificationAuthority = input.qualificationAuthority({ candidateIdentityDigest, exactInputDigest, tenantId: input.tenantId, scope: actionScope, target: input.target, policyVersion: input.policyVersion, now: input.now });
  verifyAuthority(qualificationAuthority, { candidateIdentityDigest, exactInputDigest, tenantId: input.tenantId, scope: actionScope, target: input.target, policyVersion: input.policyVersion, now: input.now }, input.implementation);
  const actionCandidate = await loadExactCandidateModule<Cf052ActionCandidateModule>(CF052_ACTION_CANDIDATE_SOURCE);
  const observerCandidate = await loadExactCandidateModule<Cf052ObserverCandidateModule>(CF052_OBSERVER_CANDIDATE_SOURCE);
  if (typeof actionCandidate.identify !== "function" || typeof actionCandidate.probe !== "function" || typeof actionCandidate.action !== "function" || typeof actionCandidate.reconcile !== "function" || typeof observerCandidate.identify !== "function" || typeof observerCandidate.observe !== "function") throw new Error("Generated CF-052 candidate bytes do not expose the exact strict runtime surfaces.");
  const actionTransport = deepFreeze({ endpoint: localProvider.receipt.action.endpoint, processToken: localProvider.actionToken }), observerTransport = deepFreeze({ endpoint: localProvider.receipt.observer.endpoint, processToken: localProvider.observerToken });
  const actionIdentity = await actionCandidate.identify(actionTransport), observerIdentity = await observerCandidate.identify(observerTransport);
  if (canonical(actionIdentity) !== canonical(localProvider.receipt.action) || canonical(observerIdentity) !== canonical(localProvider.receipt.observer)) throw new Error("Module-owned provider process challenge is stale, substituted or conflated.");
  const probe = await actionCandidate.probe(qualificationInput, actionTransport);
  if (!probe.reachable || probe.writeCount !== 0 || !Number.isInteger(probe.baselineVersion) || probe.baselineVersion < 0 || probe.preexistingRecordVersion !== null || probe.stableId !== String(qualificationInput.orderRef) || !Number.isFinite(Date.parse(probe.serverTimestamp))) throw new Error("No-write probe mutated state, failed reachability or omitted the trusted pre-action version/timestamp baseline.");
  const freshnessContract = input.contract.outcome.freshness;
  if (freshnessContract.notBefore !== "operation-start" || !Number.isFinite(freshnessContract.maximumAgeSeconds) || freshnessContract.maximumAgeSeconds < 1) throw new Error("CF-052 requires the exact persisted operation-start freshness rule and a positive bounded maximum age.");
  const first = await actionCandidate.action(qualificationInput, qualificationAuthority, actionTransport), reconciliation = await actionCandidate.reconcile(qualificationInput, actionTransport);
  let observation = await observerCandidate.observe(qualificationInput, observerTransport);
  for (let attempt = 0; attempt < 3 && Date.parse(observation.observedAt) > Date.parse(observation.observationClock) && Date.parse(observation.observedAt) - Date.parse(observation.observationClock) <= 25; attempt++) { await new Promise(resolveDelay => setTimeout(resolveDelay, 2)); observation = await observerCandidate.observe(qualificationInput, observerTransport); }
  const second = await actionCandidate.action(qualificationInput, qualificationAuthority, actionTransport);
  const derivedFreshness = deriveCf052Freshness({ baselineVersion: probe.baselineVersion, operationStartedAt: probe.serverTimestamp, observedVersion: observation.observedVersion, observedAt: observation.observedAt, observationClock: observation.observationClock, maximumAgeSeconds: freshnessContract.maximumAgeSeconds });
  const fresh = derivedFreshness.fresh && observation.observedVersion === first.committedVersion && observation.observedVersion === reconciliation.observedVersion && observation.serverSequence >= observation.observedVersion! && observation.observedAt === first.committedAt && observation.observedAt === reconciliation.observedAt;
  if (first.status !== "committed" || second.status !== "already-exists" || first.totalBusinessWrites !== 1 || second.totalBusinessWrites !== 1 || !Number.isInteger(first.committedVersion) || first.committedVersion <= probe.baselineVersion || !Number.isFinite(Date.parse(first.committedAt)) || reconciliation.classification !== "completed" || reconciliation.matchCount !== 1 || reconciliation.writeCount !== 0 || observation.classification !== "completed" || observation.matchCount !== 1 || !observation.collateralClean || observation.writeCount !== 0 || !fresh || first.stableId !== reconciliation.stableId || first.stableId !== observation.stableId || first.stableId !== second.stableId || second.committedVersion !== first.committedVersion || second.committedAt !== first.committedAt) throw new Error(`CF-052 local qualification failed action, duplicate prevention, reconciliation or compiler-derived independent freshness/outcome controls: ${canonical({ probe, first, reconciliation, observation, second, fresh })}`);
  const staleControlInput = deepFreeze({ orderRef: "CF052-STALE-CONTROL" }), staleObservation = await observerCandidate.observe(staleControlInput, observerTransport), staleDerived = deriveCf052Freshness({ baselineVersion: probe.baselineVersion, operationStartedAt: probe.serverTimestamp, observedVersion: staleObservation.observedVersion, observedAt: staleObservation.observedAt, observationClock: staleObservation.observationClock, maximumAgeSeconds: freshnessContract.maximumAgeSeconds });
  if (staleObservation.classification !== "completed" || staleObservation.matchCount !== 1 || staleObservation.observedVersion !== 0 || staleObservation.writeCount !== 0 || staleDerived.fresh) throw new Error("CF-052 stale-present negative control was incorrectly accepted as fresh.");
  const overWindowObservedAt = new Date(Date.parse(probe.serverTimestamp) + 1).toISOString(), overWindowClock = new Date(Date.parse(overWindowObservedAt) + (freshnessContract.maximumAgeSeconds * 1000) + 1).toISOString(), overWindowDerived = deriveCf052Freshness({ baselineVersion: probe.baselineVersion, operationStartedAt: probe.serverTimestamp, observedVersion: probe.baselineVersion + 1, observedAt: overWindowObservedAt, observationClock: overWindowClock, maximumAgeSeconds: freshnessContract.maximumAgeSeconds });
  if (overWindowDerived.fresh || !overWindowDerived.reasons.includes("observation-exceeds-maximum-age")) throw new Error("CF-052 over-window post-baseline negative control was incorrectly accepted as fresh.");
  const futureControlInput = deepFreeze({ orderRef: "CF052-FUTURE-CONTROL" }), futureObservation = await observerCandidate.observe(futureControlInput, observerTransport), futureDerived = deriveCf052Freshness({ baselineVersion: probe.baselineVersion, operationStartedAt: probe.serverTimestamp, observedVersion: futureObservation.observedVersion, observedAt: futureObservation.observedAt, observationClock: futureObservation.observationClock, maximumAgeSeconds: freshnessContract.maximumAgeSeconds });
  if (futureObservation.classification !== "completed" || futureObservation.matchCount !== 1 || futureObservation.observedVersion !== 1 || futureObservation.writeCount !== 0 || futureDerived.fresh || !futureDerived.reasons.includes("observation-is-future-dated")) throw new Error("CF-052 actual future-dated durable-state control was incorrectly accepted as fresh.");
  const freshnessEvidence = deepFreeze({ contract: { notBefore: freshnessContract.notBefore, maximumAgeSeconds: freshnessContract.maximumAgeSeconds }, baselineVersion: probe.baselineVersion, operationStartedAt: probe.serverTimestamp, observedVersion: observation.observedVersion, observedAt: observation.observedAt, observationClock: observation.observationClock, observationAgeMilliseconds: derivedFreshness.ageMilliseconds, serverSequence: observation.serverSequence, exactStableId: observation.stableId, actionCommittedVersion: first.committedVersion, compilerDerivedFresh: fresh, reconciliation: { stableId: reconciliation.stableId, observedVersion: reconciliation.observedVersion, observedAt: reconciliation.observedAt, serverSequence: reconciliation.serverSequence, classification: reconciliation.classification, matchCount: reconciliation.matchCount, writeCount: reconciliation.writeCount }, staleControl: { exactInput: staleControlInput, stableId: staleObservation.stableId, observedVersion: staleObservation.observedVersion, observedAt: staleObservation.observedAt, observationClock: staleObservation.observationClock, result: staleDerived }, overWindowPostBaselineControl: { exactInput: { orderRef: "compiler-derived-over-window-control" }, baselineVersion: probe.baselineVersion, observedVersion: probe.baselineVersion + 1, observedAt: overWindowObservedAt, observationClock: overWindowClock, maximumAgeSeconds: freshnessContract.maximumAgeSeconds, result: overWindowDerived }, futureObservationControl: { exactInput: futureControlInput, observation: futureObservation, result: futureDerived } });
  const reviewedSourceEvidenceDigest = board.tasks.find(item => item.taskId === "sdk-source-review")!.evidence!.evidenceDigest;
  const taskEvidence = Object.fromEntries(required.map(taskId => [taskId, providerWorkBoardDigest({ taskId, reviewedSourceEvidenceDigest, contractDigest: input.contract.contractDigest, workPackDigest: input.workPack.workPackDigest, boardSnapshotDigest: board.snapshotDigest })])) as Record<typeof required[number], string>;
  const typedTaskReceiptDigests = Object.freeze({
    "action-runtime": providerWorkBoardDigest({ taskId: "action-runtime", evidence: taskEvidence["action-runtime"], implementationDigest: actionDigest, first, second }),
    "no-write-probe": providerWorkBoardDigest({ taskId: "no-write-probe", evidence: taskEvidence["no-write-probe"], implementationDigest: actionDigest, probe }),
    "stable-identity": providerWorkBoardDigest({ taskId: "stable-identity", evidence: taskEvidence["stable-identity"], stableId: first.stableId }),
    "idempotency-reconciliation": providerWorkBoardDigest({ taskId: "idempotency-reconciliation", evidence: taskEvidence["idempotency-reconciliation"], first, second, reconciliation }),
    "independent-observer": providerWorkBoardDigest({ taskId: "independent-observer", evidence: taskEvidence["independent-observer"], implementationDigest: observerDigest, launchReceiptDigest: localProvider.receipt.receiptDigest, observation }),
    "freshness-outcome": providerWorkBoardDigest({ taskId: "freshness-outcome", evidence: taskEvidence["freshness-outcome"], freshnessEvidence }),
  });
  const qualificationReceiptDigest = providerWorkBoardDigest({ candidateIdentityDigest, exactInputDigest, typedTaskReceiptDigests, probe, first, reconciliation, observation, freshnessEvidence, staleObservation, second });
  const descriptor = deepFreeze({ ...descriptorBody, candidateIdentityDigest, qualificationReceiptDigest, typedTaskReceiptDigests });
  const checkAndAct = async (data: Record<string, unknown>, authority: Cf052AuthorityReceipt) => { const snapshot = snapshotPlainBounded(data), dataDigest = providerWorkBoardDigest(snapshot), current = input.implementation.currentTime(); verifyAuthority(authority, { candidateIdentityDigest, exactInputDigest: dataDigest, tenantId: input.tenantId, scope: actionScope, target: input.target, policyVersion: input.policyVersion, now: current }, input.implementation); return actionCandidate.action(snapshot, authority, actionTransport); };
  const manualAndUnknownResidual = Object.freeze(["Approved source bytes remain identity-only until a typed source-byte receipt binds them.", "The six CF-052 local qualification receipts are not written back as completed CF-046 board tasks; only the CF-051 reviewed-source task is durably completed on that board.", "Customer-local credential alias resolution remains external.", "Customer-environment conformance and mandatory acceptance remain unrun.", "Registry binding, signed release, host doctor and activation remain separate gates.", "Only flat required primitive parameters, allowlisted returns/errors and non-paginated calls are supported."]);
  return Object.freeze({ state: "qualified-local-candidate-not-accepted-not-activated" as const, descriptor, candidateIdentityDigest, qualificationReceiptDigest, typedTaskReceiptDigests, manualAndUnknownResidual: [...manualAndUnknownResidual], action: checkAndAct, probe: (data: Record<string, unknown>) => actionCandidate.probe(snapshotPlainBounded(data), actionTransport), reconcile: (data: Record<string, unknown>) => actionCandidate.reconcile(snapshotPlainBounded(data), actionTransport), observe: (data: Record<string, unknown>) => observerCandidate.observe(snapshotPlainBounded(data), observerTransport) });
}

export function compileProviderTaskCandidatePrimitive(input: { contract: SdkSemanticContract; workPack: SdkImplementationWorkPack; now: string }): { state: "isolated-compiler-primitive-dependency-blocked"; blockers: string[]; semanticCompilerImplementationDigest: null; selfConsistentDraftIdentity: string | null; approvedSourceBytesTypedBound: false; strictSubsetAccepted: boolean; executionAuthorityEffect: "none"; activationEffect: "none" } {
  const blockers = strictSubsetBlockers(input.contract, input.workPack);
  let selfConsistentDraftIdentity: string | null = null;
  if (blockers.length === 0) {
    try { selfConsistentDraftIdentity = compileSdkSemanticContract({ contract: input.contract, workPack: input.workPack, now: input.now }).implementationDigest; }
    catch (error) { blockers.push(error instanceof Error ? error.message : "The existing semantic compiler rejected this contract."); }
  }
  blockers.push("CF-051 source synchronization and typed-provenance re-audit has not passed; provider work-board evidence cannot yet be trusted as the candidate producer input.");
  return { state: "isolated-compiler-primitive-dependency-blocked", blockers: [...new Set(blockers)], semanticCompilerImplementationDigest: null, selfConsistentDraftIdentity, approvedSourceBytesTypedBound: false, strictSubsetAccepted: blockers.length === 1, executionAuthorityEffect: "none", activationEffect: "none" };
}

function writeProviderTaskCandidate(input: { outputRoot: string; artifact: ProviderTaskCandidateArtifact }): { directory: string; configPath: string; modulePath: string; candidateDigest: string } {
  if (!digestPattern.test(input.artifact.candidateDigest) || input.artifact.moduleSourceDigest !== bytesDigest(input.artifact.moduleSource) || input.artifact.config.configDigest !== sdkSemanticDigest(omit(input.artifact.config as unknown as Record<string, unknown>, "configDigest")) || input.artifact.candidateDigest !== sdkSemanticDigest({ configDigest: input.artifact.config.configDigest, moduleSourceDigest: input.artifact.moduleSourceDigest })) throw new Error("CF-052 candidate artifact failed content-address validation.");
  const root = resolve(input.outputRoot), directory = resolve(root, input.artifact.candidateDigest);
  if (!directory.startsWith(`${root}${sep}`)) throw new Error("CF-052 candidate output escaped its root.");
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const configPath = join(directory, "candidate-config.json"), modulePath = join(directory, "candidate-runtime.mjs");
  writeFileSync(configPath, `${JSON.stringify(input.artifact.config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  writeFileSync(modulePath, input.artifact.moduleSource, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { directory, configPath, modulePath, candidateDigest: input.artifact.candidateDigest };
}

void createProviderTaskTypedValidationReceipts;
void writeProviderTaskCandidate;
