/**
 * @deprecated Use `local-declarative-exact-record-core.ts` as the canonical surface.
 * This compatibility implementation does not establish provider-family transfer.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { request as nodeHttpRequest } from "node:http";
import {
  existsSync,
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";
import type { Readable } from "node:stream";
import type { OutcomeReceipt } from "./contracts.js";
import { compileSdkSemanticContract, sdkSemanticDigest, type SdkSemanticContract } from "./customer-local-sdk-semantic-compiler.js";
import { sdkWorkPackDigest, type SdkImplementationWorkPack } from "./customer-local-sdk-work-pack.js";
import {
  assertCoordinatedProviderWorkBoundary,
  providerWorkBoardDigest,
  readProgressiveProviderWorkSource,
  DurableCustomerLocalProviderWorkBoard,
  type ProviderWorkEvidenceCoordinator,
  type ProviderWorkJourneyReader,
} from "./customer-local-provider-work-board.js";
import {
  validateGoalPlan,
  type GoalPlanProposal,
  type TrustedGoalScope,
  type ValidatedGoalPlan,
} from "./goal-coordination.js";
import {
  FileGoalCoordinationStore,
  GoalScheduler,
  goalPlanDigest,
  type GoalAggregateOutcomeReceipt,
  type GoalCoordinationEvent,
  type GoalCoordinationState,
  type GoalWorkItemExecutionResult,
} from "./goal-scheduler.js";
import {
  ComposedRuntimeRecoveryCoordinator,
  composedRecoveryDigest,
  type ComposedRecoveryContext,
  type ComposedRecoveryReceipt,
  type RetainedCapabilityReuseReceipt,
} from "./composed-runtime-recovery.js";

export const CF053_PROVIDER_NEUTRAL_TRANSFER_CORE_VERSION = "1.0" as const;
export const CF053_LOCAL_DECLARATIVE_EXACT_RECORD_CORE_VERSION = CF053_PROVIDER_NEUTRAL_TRANSFER_CORE_VERSION;

type Primitive = string | number | boolean;
type PrimitiveType = "string" | "number" | "boolean";

const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_.-]{1,119}$/;

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

export function cf053Digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function bytesDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function assertRegularBoundedFile(path: string, maximumBytes: number, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) throw new Error(`CF-053 ${label} must be one regular file within its byte bound.`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function boundedStageTree(path: string): void {
  let entries = 0, bytes = 0;
  const visit = (current: string): void => {
    const stat = lstatSync(current); entries += 1; if (entries > 512) throw new Error("CF-053 candidate stage exceeds its 512-entry cleanup inspection bound.");
    if (stat.isSymbolicLink()) throw new Error("CF-053 candidate stage cleanup refuses symbolic links.");
    if (stat.isFile()) { bytes += stat.size; if (bytes > 2 * 1024 * 1024) throw new Error("CF-053 candidate stage exceeds its 2 MiB cleanup inspection bound."); return; }
    if (!stat.isDirectory()) throw new Error("CF-053 candidate stage contains an unsupported filesystem entry.");
    for (const name of readdirSync(current)) visit(join(current, name));
  };
  visit(path);
}

function cleanupCf053OwnedCrashArtifacts(root: string, kind: "candidate-stage" | "world-next"): number {
  const expression = kind === "candidate-stage" ? /^([a-f0-9]{64})\.stage\.(\d+)\.([0-9a-f-]{36})$/ : /^state\.json\.(\d+)\.([0-9a-f-]{36})\.next$/;
  const eligible: string[] = [];
  for (const name of readdirSync(root)) {
    const match = expression.exec(name); if (!match) continue;
    const ownerPid = Number(match[kind === "candidate-stage" ? 2 : 1]), path = join(root, name), stat = lstatSync(path);
    if (isProcessAlive(ownerPid)) continue;
    if (kind === "candidate-stage" ? (!stat.isDirectory() || stat.isSymbolicLink()) : (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576)) throw new Error("CF-053 crash artifact matched the owned namespace but had an unsafe filesystem type or size.");
    if (kind === "candidate-stage") boundedStageTree(path);
    eligible.push(path);
  }
  if (eligible.length > 256) throw new Error("CF-053 crash-artifact cleanup exceeds its 256-item atomic inspection bound.");
  for (const path of eligible) rmSync(path, { recursive: kind === "candidate-stage", force: false });
  if (eligible.length) fsyncDirectory(root);
  return eligible.length;
}

function omit<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function boundedPrimitiveSnapshot(
  raw: unknown,
  fields: readonly Cf053InputField[],
): Readonly<Record<string, Primitive>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || utilTypes.isProxy(raw)) {
    throw new Error("CF-053 input must be one plain flat object.");
  }
  if (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null) {
    throw new Error("CF-053 input must have a plain object prototype.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const actualKeys = Reflect.ownKeys(raw);
  if (actualKeys.some((key) => typeof key === "symbol")) throw new Error("CF-053 input cannot contain symbol keys.");
  const expected = fields.map((field) => field.key).sort();
  const actual = (actualKeys as string[]).sort();
  if (canonical(expected) !== canonical(actual)) {
    throw new Error("CF-053 input must contain every required field exactly once and no extra fields.");
  }
  const result: Record<string, Primitive> = {};
  for (const field of fields) {
    const descriptor = descriptors[field.key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || field.key === "toJSON") {
      throw new Error("CF-053 input cannot contain accessors or serialization hooks.");
    }
    const value = descriptor.value;
    if (typeof value !== field.type || (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error(`CF-053 field ${field.key} must be one finite ${field.type} primitive.`);
    }
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > 4_096) throw new Error(`CF-053 field ${field.key} exceeds the 4 KiB string bound.`);
    result[field.key] = value as Primitive;
  }
  if (Buffer.byteLength(canonical(result), "utf8") > 16_384) throw new Error("CF-053 input exceeds the bounded byte limit.");
  return Object.freeze(result);
}

export interface Cf053SourceChainIdentity {
  cf041ReviewedContractDigest: string;
  cf051SourceReviewReceiptDigest: string;
  cf036WorkPackDigest: string;
  cf051BoardSnapshotDigest: string;
}

export interface Cf053InputField {
  key: string;
  type: PrimitiveType;
  required: true;
}

export interface Cf053ProviderNeutralContract {
  schemaVersion: "1.0";
  contractId: string;
  tenantId: string;
  sourceChain: Cf053SourceChainIdentity;
  workspaceIssuerPublicKeyDigest: string;
  inputSchema: Cf053InputField[];
  stableIdentityKeys: string[];
  exactOutcomeKeys: string[];
  actionScope: string;
  observerScope: string;
  targetAlias: string;
  policyVersion: string;
  maximumAgeSeconds: number;
  reconcileBeforeAction: true;
  blindRetryAllowed: false;
  separateObserverRequired: true;
  executionBinding?: {
    runtimeSemantics: "local-declarative-exact-record-v1";
    roles: Array<{ role: "action" | "no-write-probe" | "reconciliation-readback" | "independent-observer"; module: string; className: string; methodName: string; methodDigest: string; parameters: Array<{ parameter: string; inputKey: string; type: PrimitiveType }> }>;
    predicates: Array<{ key: string; path: string[]; operator: "exists" | "equals-input" | "equals-confirmed" | "count-equals"; inputKey?: string; expected?: string | number | boolean | null }>;
    duplicatePath: string[];
    collateralPredicates: Array<{ key: string; path: string[]; operator: "exists" | "equals-input" | "equals-confirmed" | "count-equals"; inputKey?: string; expected?: string | number | boolean | null }>;
    freshnessPath: string[];
    bindingDigest: string;
  };
  contractDigest: string;
}

export function createCf053ProviderNeutralContract(
  input: Omit<Cf053ProviderNeutralContract, "contractDigest">,
): Cf053ProviderNeutralContract {
  const contract = { ...structuredClone(input), contractDigest: cf053Digest(input) };
  assertCf053Contract(contract);
  return Object.freeze(contract);
}

export interface Cf053DerivedContractHandle { readonly contractDigest: string }
const derivedContractHandles = new WeakMap<object, Cf053ProviderNeutralContract>();

/**
 * The frozen transfer entrypoint. Unlike the development factory above, this derives the
 * executable contract from the exact persisted CF-036/041/051 chain and accepts only the
 * small trusted deployment facts that those upstream artifacts do not contain.
 */
export function deriveCf053ProviderNeutralContract(input: {
  board: DurableCustomerLocalProviderWorkBoard;
  coordinator: ProviderWorkEvidenceCoordinator;
  reader: ProviderWorkJourneyReader;
  boardId: string;
  tenantId: string;
  trustedDeployment: { tenantId: string; targetAlias: string; policyVersion: string; workspaceTrustRootDirectory: string };
}): Cf053DerivedContractHandle {
  const now = new Date().toISOString();
  if (Object.getPrototypeOf(input.board) !== DurableCustomerLocalProviderWorkBoard.prototype) throw new Error("CF-053 requires the exact durable CF-051 work board, not a reader, snapshot, subclass or prototype-forged substitute.");
  assertCoordinatedProviderWorkBoundary(input.board, input.coordinator);
  const board = input.board.read(input.boardId, input.tenantId);
  const anchor = readProgressiveProviderWorkSource(input.reader, board.journeyId, input.tenantId, board.providerId, now);
  const workPack = anchor.workPack;
  const semanticContract = anchor.semanticDraft.reviewedContract;
  if (!semanticContract) throw new Error("CF-053 exact CF-041 source has no reviewed semantic contract.");
  const sourceTask = board.tasks.find((task) => task.taskId === "sdk-source-review"), sourceReview = sourceTask?.evidence?.typedValidation;
  if (!sourceReview) throw new Error("CF-053 exact durable CF-051 board has no typed source-review evidence.");
  const { workPackDigest, ...workPackBody } = workPack;
  const contractBody = omit(semanticContract as unknown as Record<string, unknown>, "contractDigest");
  if (workPackDigest !== sdkWorkPackDigest(workPackBody) || semanticContract.contractDigest !== sdkSemanticDigest(contractBody)) throw new Error("CF-053 exact CF-036/041 source identity failed.");
  // Reuse the existing semantic compiler's complete contract/work-pack integrity validation.
  compileSdkSemanticContract({ contract: semanticContract, workPack, now });
  if (board.snapshotDigest !== providerWorkBoardDigest(omit(board as unknown as Record<string, unknown>, "snapshotDigest")) || board.originMode !== "cf041-progressive" || board.importedStage !== "cf041-semantic-review" || board.tenantId !== input.tenantId || input.tenantId !== input.trustedDeployment.tenantId || board.providerId !== workPack.providerId || board.workPackDigest !== workPack.workPackDigest || board.semanticDraftDigest !== anchor.semanticDraft.snapshotDigest || board.sourceIdentityDigest !== anchor.sourceIdentityDigest || board.sourceEventCount !== anchor.sourceEventCount || board.sourceEventHeadDigest !== anchor.sourceEventHeadDigest || board.sourceEventStateDigest !== anchor.sourceEventStateDigest || board.journeyDigest !== anchor.journeyDigest || board.journeyRevision !== anchor.journeyRevision || board.cumulativeLineageDigest !== anchor.cumulativeLineageDigest || board.releaseManifestDigest !== anchor.releaseManifestDigest || board.readinessReceiptDigest !== anchor.readinessReceiptDigest || canonical(semanticContract) !== canonical(anchor.semanticDraft.reviewedContract)) throw new Error("CF-053 exact progressive CF-051 board/source identity failed.");
  const completed = board.tasks.filter((task) => task.status === "completed");
  const { validationReceiptDigest, ...validationBody } = sourceReview;
  if (validationReceiptDigest !== providerWorkBoardDigest(validationBody) || completed.length !== 1 || sourceTask?.status !== "completed" || sourceReview.validatorId !== "cf051-cf036-reviewed-source" || sourceReview.validatorVersion !== "1" || sourceReview.taskId !== "sdk-source-review" || sourceReview.sourceStage !== "cf041-semantic-review" || sourceReview.sourceArtifactDigest !== anchor.snapshot.artifacts["cf036-sdk-work-pack"]?.artifactDigest || sourceReview.workPackDigest !== workPack.workPackDigest || sourceReview.semanticDraftDigest !== anchor.semanticDraft.snapshotDigest || sourceReview.sourceEventCount !== anchor.sourceEventCount || sourceReview.sourceEventHeadDigest !== anchor.sourceEventHeadDigest) throw new Error("CF-053 requires exactly the integrity-recomputed retained CF-051 source-review proof and no producer-certified later task.");
  if (!IDENTIFIER.test(input.trustedDeployment.tenantId) || !IDENTIFIER.test(input.trustedDeployment.targetAlias) || !IDENTIFIER.test(input.trustedDeployment.policyVersion)) throw new Error("CF-053 trusted deployment identity is malformed.");
  const fieldTypes = new Map<string, PrimitiveType>();
  for (const mapping of semanticContract.parameterMappings) {
    if (mapping.expression.source !== "workflow-input") throw new Error("CF-053 frozen transfer subset does not promote trusted-context values into runtime input.");
    const role = workPack.roles.find((candidate) => candidate.review.role === mapping.role), parameter = role?.method.parameters.find((candidate) => candidate.name === mapping.parameter);
    if (!parameter?.required || !["string", "number", "boolean"].includes(parameter.type)) throw new Error("CF-053 transfer derivation found an unsupported optional or non-primitive parameter.");
    const type = parameter.type as PrimitiveType, prior = fieldTypes.get(mapping.expression.key);
    if (prior && prior !== type) throw new Error("CF-053 one workflow input has conflicting primitive types across reviewed methods.");
    fieldTypes.set(mapping.expression.key, type);
  }
  if (semanticContract.stableIdentity.expression.source !== "workflow-input" || semanticContract.idempotency.expression.source !== "workflow-input") throw new Error("CF-053 stable identity/idempotency must derive from explicit workflow input.");
  const outcomeKeys = semanticContract.outcome.predicates.filter((predicate) => predicate.operator === "equals-input").map((predicate) => predicate.inputKey!).filter(Boolean);
  if (outcomeKeys.length === 0) throw new Error("CF-053 transfer requires at least one exact input-bound independent outcome predicate.");
  const roles = semanticContract.roles.map((semanticRole) => {
    const reviewed = workPack.roles.find((candidate) => candidate.review.role === semanticRole.role)!;
    return {
      role: semanticRole.role,
      module: reviewed.method.module,
      className: reviewed.method.className!,
      methodName: reviewed.method.methodName,
      methodDigest: reviewed.methodDigest,
      parameters: semanticContract.parameterMappings.filter((mapping) => mapping.role === semanticRole.role).map((mapping) => ({ parameter: mapping.parameter, inputKey: mapping.expression.key, type: fieldTypes.get(mapping.expression.key)! })),
    };
  });
  const bindingBody = { runtimeSemantics: "local-declarative-exact-record-v1" as const, roles, predicates: semanticContract.outcome.predicates.map(({ fact: _fact, ...predicate }) => predicate), duplicatePath: semanticContract.outcome.duplicate.collectionPath, collateralPredicates: semanticContract.outcome.collateral.map(({ fact: _fact, ...predicate }) => predicate), freshnessPath: semanticContract.outcome.freshness.path };
  const sourceChain = {
    cf041ReviewedContractDigest: semanticContract.contractDigest,
    cf051SourceReviewReceiptDigest: sourceReview.validationReceiptDigest,
    cf036WorkPackDigest: workPack.workPackDigest,
    cf051BoardSnapshotDigest: board.snapshotDigest,
  };
  const workspaceIssuer = provisionCf053WorkspaceIssuer({ rootDirectory: input.trustedDeployment.workspaceTrustRootDirectory, authorityContextDigest: cf053Digest({ tenantId: input.tenantId, targetAlias: input.trustedDeployment.targetAlias, policyVersion: input.trustedDeployment.policyVersion, sourceChain }) });
  const body: Omit<Cf053ProviderNeutralContract, "contractDigest"> = {
    schemaVersion: "1.0",
    contractId: semanticContract.contractId,
    tenantId: input.trustedDeployment.tenantId,
    sourceChain,
    workspaceIssuerPublicKeyDigest: workspaceIssuer.publicKeyDigest,
    inputSchema: [...fieldTypes].sort(([left], [right]) => left.localeCompare(right)).map(([key, type]) => ({ key, type, required: true as const })),
    stableIdentityKeys: [semanticContract.stableIdentity.expression.key],
    exactOutcomeKeys: [...new Set(outcomeKeys)],
    actionScope: semanticContract.credentials.action.exactScope,
    observerScope: semanticContract.credentials.observer.exactScope,
    targetAlias: input.trustedDeployment.targetAlias,
    policyVersion: input.trustedDeployment.policyVersion,
    maximumAgeSeconds: semanticContract.outcome.freshness.maximumAgeSeconds,
    reconcileBeforeAction: true,
    blindRetryAllowed: false,
    separateObserverRequired: true,
    executionBinding: { ...bindingBody, bindingDigest: cf053Digest(bindingBody) },
  };
  const contract = createCf053ProviderNeutralContract(body), handle = Object.freeze({ contractDigest: contract.contractDigest });
  derivedContractHandles.set(handle, contract);
  return handle;
}

function assertCf053Contract(contract: Cf053ProviderNeutralContract): void {
  if (Buffer.byteLength(canonical(contract), "utf8") > 131_072) throw new Error("CF-053 contract exceeds the 128 KiB bound.");
  if (contract.schemaVersion !== "1.0" || contract.contractDigest !== cf053Digest(omit(contract as unknown as Record<string, unknown>, "contractDigest"))) {
    throw new Error("CF-053 contract identity or integrity failed.");
  }
  if (![contract.contractId, contract.tenantId, contract.targetAlias, contract.policyVersion].every((value) => IDENTIFIER.test(value))) {
    throw new Error("CF-053 contract identifiers are malformed.");
  }
  if (!contract.actionScope.trim() || contract.actionScope.length > 240 || !contract.observerScope.trim() || contract.observerScope.length > 240) throw new Error("CF-053 action or observer scope is missing or unbounded.");
  if (Object.values(contract.sourceChain).some((digest) => !DIGEST.test(digest)) || !DIGEST.test(contract.workspaceIssuerPublicKeyDigest)) throw new Error("CF-053 requires exact CF-036/041/051 source-chain and pre-runtime workspace-issuer digests.");
  if (contract.inputSchema.length === 0 || contract.inputSchema.length > 24) throw new Error("CF-053 input schema must contain one to twenty-four fields.");
  if (new Set(contract.inputSchema.map((field) => field.key)).size !== contract.inputSchema.length) throw new Error("CF-053 input fields must be unique.");
  for (const field of contract.inputSchema) {
    if (!IDENTIFIER.test(field.key) || !["string", "number", "boolean"].includes(field.type) || field.required !== true) {
      throw new Error("CF-053 supports only named, required, flat string/number/boolean inputs.");
    }
  }
  const known = new Set(contract.inputSchema.map((field) => field.key));
  if (contract.stableIdentityKeys.length === 0 || new Set(contract.stableIdentityKeys).size !== contract.stableIdentityKeys.length || contract.stableIdentityKeys.some((key) => !known.has(key))) {
    throw new Error("CF-053 stable identity keys must be a non-empty exact subset of the input schema.");
  }
  if (contract.exactOutcomeKeys.length === 0 || new Set(contract.exactOutcomeKeys).size !== contract.exactOutcomeKeys.length || contract.exactOutcomeKeys.some((key) => !known.has(key))) {
    throw new Error("CF-053 outcome keys must be a non-empty exact subset of the input schema.");
  }
  if (!Number.isInteger(contract.maximumAgeSeconds) || contract.maximumAgeSeconds < 1 || contract.maximumAgeSeconds > 300) throw new Error("CF-053 freshness window is invalid.");
  if (!contract.reconcileBeforeAction || contract.blindRetryAllowed || !contract.separateObserverRequired) throw new Error("CF-053 safe retry and observer boundaries cannot be weakened.");
  if (contract.executionBinding) {
    const { bindingDigest, ...bindingBody } = contract.executionBinding;
    if (contract.executionBinding.runtimeSemantics !== "local-declarative-exact-record-v1" || bindingDigest !== cf053Digest(bindingBody) || contract.executionBinding.roles.length !== 4 || new Set(contract.executionBinding.roles.map((role) => role.role)).size !== 4 || contract.executionBinding.roles.some((role) => !IDENTIFIER.test(role.module) || !IDENTIFIER.test(role.className) || !IDENTIFIER.test(role.methodName) || !DIGEST.test(role.methodDigest) || role.parameters.some((parameter) => !known.has(parameter.inputKey) || !IDENTIFIER.test(parameter.parameter) || parameter.type !== contract.inputSchema.find((field) => field.key === parameter.inputKey)?.type)) || contract.executionBinding.predicates.length === 0 || contract.executionBinding.predicates.some((predicate) => predicate.path.length === 0) || contract.executionBinding.collateralPredicates.length === 0 || contract.executionBinding.collateralPredicates.some((predicate) => predicate.path.length === 0) || contract.executionBinding.duplicatePath.length === 0 || contract.executionBinding.freshnessPath.length === 0) throw new Error("CF-053 reviewed execution binding is incomplete, mutated or outside the exact-record local declarative runtime.");
    if (canonical(contract.executionBinding.roles.map((role) => role.role).sort()) !== canonical(["action", "independent-observer", "no-write-probe", "reconciliation-readback"])) throw new Error("CF-053 reviewed execution binding must contain exactly the four supported roles.");
    if (contract.executionBinding.predicates.length > 24 || contract.executionBinding.collateralPredicates.length > 24 || contract.executionBinding.roles.some((role) => role.parameters.length > 24) || [...contract.executionBinding.predicates, ...contract.executionBinding.collateralPredicates].some((predicate) => predicate.path.length > 8 || predicate.path.some((part) => !IDENTIFIER.test(part))) || contract.executionBinding.duplicatePath.length > 8 || contract.executionBinding.freshnessPath.length > 8) throw new Error("CF-053 reviewed execution binding exceeds bounded role, predicate or path limits.");
    const exactInputPredicateKeys = contract.executionBinding.predicates.filter((predicate) => predicate.operator === "equals-input" && predicate.path.length === 1 && predicate.inputKey === predicate.path[0]).map((predicate) => predicate.inputKey!);
    if (new Set(exactInputPredicateKeys).size !== contract.exactOutcomeKeys.length || contract.exactOutcomeKeys.some((key) => !exactInputPredicateKeys.includes(key)) || canonical(contract.executionBinding.duplicatePath) !== canonical(["matches"]) || canonical(contract.executionBinding.freshnessPath) !== canonical(["observedAt"]) || contract.executionBinding.collateralPredicates.length !== 1 || contract.executionBinding.collateralPredicates[0]!.operator !== "equals-confirmed" || canonical(contract.executionBinding.collateralPredicates[0]!.path) !== canonical(["collateralClean"]) || contract.executionBinding.collateralPredicates[0]!.expected !== true || contract.executionBinding.roles.some((role) => role.parameters.length !== contract.inputSchema.length || role.parameters.some((parameter) => parameter.parameter !== parameter.inputKey))) throw new Error("CF-053 production runtime supports only the exact reviewed flat identity-mapped role shape with root equals-input predicates, matches duplicate path, collateralClean=true and observedAt freshness.");
  }
}

interface RegistryEntry {
  contract: Cf053ProviderNeutralContract;
  candidateDigest: string;
  actionSourceDigest: string;
  observerSourceDigest: string;
  buildOrdinal: 1;
  builtAt: string;
  entryDigest: string;
}

interface RegistryFile {
  schemaVersion: "1.0";
  entries: RegistryEntry[];
  registryDigest: string;
}

export interface Cf053CandidateHandle {
  readonly candidateDigest: string;
  readonly source: "built" | "retained";
}

interface CandidatePrivate {
  entry: RegistryEntry;
  registryPath: string;
  candidateDirectory: string;
  boundary: "derived" | "development";
  trustedWorkspacePublicKeyDigest?: string;
}

const candidateHandles = new WeakMap<object, CandidatePrivate>();

export interface Cf053ProductionCandidateCausalLineage {
  candidateDigest: string;
  contractDigest: string;
  contractId: string;
  tenantId: string;
  targetAlias: string;
  sourceChain: Cf053ProviderNeutralContract["sourceChain"];
  inputSchema: Cf053ProviderNeutralContract["inputSchema"];
  stableIdentityKeys: string[];
  exactOutcomeKeys: string[];
  actionScope: string;
  observerScope: string;
  executionBinding: NonNullable<Cf053ProviderNeutralContract["executionBinding"]>;
}

/**
 * Narrow causal-join projection. The projection can only be obtained from the exact opaque
 * production-derived candidate handle; development candidates and cloned public shapes fail.
 */
export function inspectCf053ProductionCandidateCausalLineage(handle: Cf053CandidateHandle): Readonly<Cf053ProductionCandidateCausalLineage> {
  const candidate = candidateHandles.get(handle as object);
  if (!candidate || candidate.boundary !== "derived" || candidate.entry.candidateDigest !== handle.candidateDigest) throw new Error("CF-053 causal lineage requires the exact opaque production-derived candidate handle.");
  assertCf053Contract(candidate.entry.contract);
  const registry = readRegistry(candidate.registryPath), matches = registry.entries.filter((entry) => entry.candidateDigest === handle.candidateDigest);
  if (matches.length !== 1 || matches[0]!.entryDigest !== candidate.entry.entryDigest) throw new Error("CF-053 causal lineage candidate is stale, substituted or absent from its exact registry.");
  const contract = candidate.entry.contract;
  if (!contract.executionBinding) throw new Error("CF-053 causal lineage candidate has no reviewed execution binding.");
  return Object.freeze(structuredClone({ candidateDigest: candidate.entry.candidateDigest, contractDigest: contract.contractDigest, contractId: contract.contractId, tenantId: contract.tenantId, targetAlias: contract.targetAlias, sourceChain: contract.sourceChain, inputSchema: contract.inputSchema, stableIdentityKeys: contract.stableIdentityKeys, exactOutcomeKeys: contract.exactOutcomeKeys, actionScope: contract.actionScope, observerScope: contract.observerScope, executionBinding: contract.executionBinding }));
}

const ACTION_PROCESS_SOURCE = String.raw`import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
const digest=value=>createHash("sha256").update(typeof value==="string"?value:canonical(value)).digest("hex");
const canonical=value=>Array.isArray(value)?"["+value.map(canonical).join(",")+"]":value&&typeof value==="object"?"{"+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+":"+canonical(item)).join(",")+"}":JSON.stringify(value);
import { DatabaseSync } from "node:sqlite";
const [statePath,launchNonce,processToken,candidateDigest,authoritySignerKeyId,authorityPublicKeyDigest,inputSchemaEncoded,bindingEncoded,generationDbPath,generationReservationId,boundary,contractDigest,worldIdentityDigest,parentPlanDigest,expectedStableIdsDigest]=process.argv.slice(2),sourceDigest=createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),processKeyDigest=digest(processToken),inputSchema=JSON.parse(Buffer.from(inputSchemaEncoded,"base64").toString("utf8")),binding=JSON.parse(Buffer.from(bindingEncoded,"base64").toString("utf8"));
const read=()=>{const stat=lstatSync(statePath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576)throw new Error("durable-state-file-rejected");const wrapped=JSON.parse(readFileSync(statePath,"utf8"));if(wrapped.stateDigest!==digest(wrapped.body)||!validateWorld(wrapped.body))throw new Error("durable-state-integrity");return wrapped.body};
const save=body=>{if(!validateWorld(body))throw new Error("durable-state-save-rejected");const next=statePath+"."+process.pid+"."+randomUUID()+".next",bytes=JSON.stringify({body,stateDigest:digest(body)});if(Buffer.byteLength(bytes)>1048576)throw new Error("durable-state-size-rejected");const descriptor=openSync(next,"wx",0o600);try{writeFileSync(descriptor,bytes);fsyncSync(descriptor)}finally{closeSync(descriptor)}renameSync(next,statePath);const directory=openSync(dirname(statePath),"r");try{fsyncSync(directory)}finally{closeSync(directory)}};
const authorityPayload=receipt=>{const {signature,...body}=receipt;return body};
const validateInput=input=>{if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("input-shape-rejected");const expected=inputSchema.map(field=>field.key).sort(),actual=Object.keys(input).sort();if(canonical(expected)!==canonical(actual))throw new Error("input-shape-rejected");for(const field of inputSchema){const value=input[field.key];if(typeof value!==field.type||(field.type==="number"&&!Number.isFinite(value))||(field.type==="string"&&Buffer.byteLength(value)>4096)||value&&typeof value==="object")throw new Error("input-shape-rejected")}return digest(input)};
const validateWorld=state=>{if(!state||canonical(Object.keys(state).sort())!==canonical(["candidateDigest","contractDigest","expectedStableIdsDigest","parentPlanDigest","records","schemaVersion","sequence","serverTimestamp","worldIdentityDigest","writes"].sort())||state.schemaVersion!=="1.0"||state.candidateDigest!==candidateDigest||state.contractDigest!==contractDigest||state.worldIdentityDigest!==worldIdentityDigest||state.parentPlanDigest!==parentPlanDigest||state.expectedStableIdsDigest!==expectedStableIdsDigest||!Number.isInteger(state.sequence)||state.sequence<0||!Number.isInteger(state.writes)||state.writes<0||!Number.isFinite(Date.parse(state.serverTimestamp))||!state.records||typeof state.records!=="object"||Array.isArray(state.records)||Object.keys(state.records).length>100)return false;const records=Object.entries(state.records),versions=[];for(const [id,record] of records){if(!/^[a-f0-9]{64}$/.test(id)||!record||canonical(Object.keys(record).sort())!==canonical(["exactInputDigest","input","stableId","updatedAt","version"].sort())||record.stableId!==id||record.exactInputDigest!==validateInput(record.input)||!Number.isInteger(record.version)||record.version<1||record.version>state.sequence||!Number.isFinite(Date.parse(record.updatedAt))||Date.parse(record.updatedAt)>Date.parse(state.serverTimestamp))return false;versions.push(record.version)}return state.writes===records.length&&state.sequence===(versions.length?Math.max(...versions):0)&&new Set(versions).size===versions.length&&versions.every((version,index)=>version===index+1)};
const validateBinding=(role,payload)=>{const exact=binding.roles.find(item=>item.role===role);if(!exact||payload.bindingDigest!==binding.bindingDigest||payload.bindingRole!==role||payload.methodDigest!==exact.methodDigest)throw new Error("reviewed-binding-rejected");const expected=Object.fromEntries(exact.parameters.map(item=>[item.parameter,payload.input[item.inputKey]]));if(canonical(expected)!==canonical(payload.parameters))throw new Error("reviewed-parameter-serialization-rejected")};
const verifyAuthority=(receipt,expected)=>{const body=authorityPayload(receipt),key=createPublicKey(receipt.publicKeyPem),actualKeyDigest=createHash("sha256").update(key.export({type:"spki",format:"der"})).digest("hex");if(body.schemaVersion!=="1.0"||body.signerKeyId!==authoritySignerKeyId||actualKeyDigest!==authorityPublicKeyDigest||body.candidateDigest!==candidateDigest||body.candidateDigest!==expected.candidateDigest||body.exactInputDigest!==expected.exactInputDigest||body.stableId!==expected.stableId||body.expectedStableIdsDigest!==expected.expectedStableIdsDigest||(boundary==="derived"&&body.expectedStableIdsDigest!==expectedStableIdsDigest)||body.processGenerationDigest!==expected.processGenerationDigest||body.parentPlanDigest!==expected.parentPlanDigest||(boundary==="derived"&&body.parentPlanDigest!==parentPlanDigest)||body.workItemId!==expected.workItemId||body.authorityPolicyDigest!==expected.authorityPolicyDigest||body.tenantId!==expected.tenantId||body.targetAlias!==expected.targetAlias||body.actionScope!==expected.actionScope||body.policyVersion!==expected.policyVersion||Date.parse(body.issuedAt)>Date.now()||Date.parse(body.expiresAt)<=Date.now()||!verify(null,Buffer.from(canonical(body)),key,Buffer.from(receipt.signature,"base64")))throw new Error("authority-rejected");const db=new DatabaseSync(generationDbPath,{readOnly:true}),row=db.prepare("SELECT status, receipt_digest AS receiptDigest FROM cf053_generations WHERE reservation_id=?").get(generationReservationId);db.close();if(!row||row.status!=="active"||(boundary==="derived"&&row.receiptDigest!==body.processGenerationDigest))throw new Error("inactive-process-generation")};
let identity;const server=http.createServer((request,response)=>{let raw="",rawBytes=0,overflow=false;request.on("data",chunk=>{rawBytes+=chunk.length;if(rawBytes>65536){overflow=true;return}raw+=chunk});request.on("end",()=>{try{const declared=request.headers["content-length"];if(!declared||!/^\d{1,6}$/.test(String(declared))||Number(declared)>65536||Number(declared)!==rawBytes||overflow)throw new Error("request-size-rejected");if(request.method!=="POST"||request.headers["x-cf053-process-token"]!==processToken)throw new Error("unauthorized-process");const payload=raw?JSON.parse(raw):{},state=read(),stableId=String(payload.stableId||"");let result;if(request.url==="/identity")result=identity;else if(request.url==="/probe"){validateBinding("no-write-probe",payload);validateInput(payload.input);result={reachable:true,writeCount:0,stableId,serverSequence:state.sequence,serverTimestamp:state.serverTimestamp};}else if(request.url==="/reconcile"){validateBinding("reconciliation-readback",payload);validateInput(payload.input);const record=state.records[stableId];result={classification:record?"completed":"not-started",stableId,matchCount:record?1:0,exactInputDigest:record?.exactInputDigest??null,record:record?.input??null,observedVersion:record?.version??null,observedAt:record?.updatedAt??state.serverTimestamp,serverSequence:state.sequence,totalBusinessWrites:state.writes,writeCount:0};}else if(request.url==="/action"){validateBinding("action",payload);const computedInputDigest=validateInput(payload.input);if(computedInputDigest!==payload.exactInputDigest||computedInputDigest!==payload.expected.exactInputDigest)throw new Error("input-digest-rejected");verifyAuthority(payload.authority,{...payload.expected,candidateDigest,stableId});const existing=state.records[stableId];if(existing&&existing.exactInputDigest!==payload.exactInputDigest)throw new Error("stable-identity-conflict");if(!existing){state.sequence+=1;state.serverTimestamp=new Date(Math.max(Date.now(),Date.parse(state.serverTimestamp)+1)).toISOString();state.records[stableId]={stableId,exactInputDigest:computedInputDigest,input:payload.input,version:state.sequence,updatedAt:state.serverTimestamp};state.writes+=1;save(state)}const record=(existing||state.records[stableId]);result={status:existing?"already-exists":"committed",stableId,exactInputDigest:record.exactInputDigest,committedVersion:record.version,committedAt:record.updatedAt,totalBusinessWrites:(existing?state:read()).writes};}else if(request.url==="/summary")result={records:state.records,sequence:state.sequence,totalBusinessWrites:state.writes,serverTimestamp:state.serverTimestamp};else throw new Error("unknown-route");const encoded=JSON.stringify(result);if(Buffer.byteLength(encoded)>65536)throw new Error("response-size-rejected");response.setHeader("content-type","application/json");response.setHeader("content-length",Buffer.byteLength(encoded));response.end(encoded)}catch(error){response.statusCode=409;const message=(error instanceof Error?error.message:"process-error").slice(0,4096),encoded=JSON.stringify({error:message});response.setHeader("content-type","application/json");response.setHeader("content-length",Buffer.byteLength(encoded));response.end(encoded)}})});
server.listen(0,"127.0.0.1",()=>{try{const address=server.address();identity={plane:"action",pid:process.pid,launchNonce,processKeyDigest,sourceDigest,candidateDigest,bindingDigest:binding.bindingDigest,authoritySignerKeyId,authorityPublicKeyDigest,endpoint:"http://127.0.0.1:"+address.port+"/"};const db=new DatabaseSync(generationDbPath);db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");const changed=db.prepare("UPDATE cf053_generations SET action_pid=?,action_nonce=?,action_source_digest=?,action_token_digest=?,action_endpoint=?,action_recovery_token=? WHERE reservation_id=? AND status='pending'").run(process.pid,launchNonce,sourceDigest,processKeyDigest,identity.endpoint,processToken,generationReservationId);if(changed.changes!==1)throw new Error("action-self-registration-cas");db.exec("COMMIT;");db.close();process.stdout.write(JSON.stringify(identity)+"\n")}catch(error){server.close(()=>process.exit(71))}});process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
`;

const OBSERVER_PROCESS_SOURCE = String.raw`import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import { fileURLToPath } from "node:url";
const canonical=value=>Array.isArray(value)?"["+value.map(canonical).join(",")+"]":value&&typeof value==="object"?"{"+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+":"+canonical(item)).join(",")+"}":JSON.stringify(value),digest=value=>createHash("sha256").update(typeof value==="string"?value:canonical(value)).digest("hex");
const [statePath,launchNonce,processToken,candidateDigest,_authoritySigner,_authorityDigest,schemaEncoded,bindingEncoded,_generationDb,_generationReservation,boundary,contractDigest,worldIdentityDigest,parentPlanDigest,expectedStableIdsDigest]=process.argv.slice(2),sourceDigest=createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),processKeyDigest=digest(processToken),binding=JSON.parse(Buffer.from(bindingEncoded,"base64").toString("utf8")),inputSchema=JSON.parse(Buffer.from(schemaEncoded,"base64").toString("utf8"));
const validateInput=input=>{if(!input||typeof input!=="object"||Array.isArray(input))return false;const expected=inputSchema.map(field=>field.key).sort(),actual=Object.keys(input).sort();if(canonical(expected)!==canonical(actual))return false;return inputSchema.every(field=>typeof input[field.key]===field.type&&(field.type!=="number"||Number.isFinite(input[field.key]))&&(field.type!=="string"||Buffer.byteLength(input[field.key])<=4096)&&!(input[field.key]&&typeof input[field.key]==="object"))};
const validateWorld=state=>{if(!state||canonical(Object.keys(state).sort())!==canonical(["candidateDigest","contractDigest","expectedStableIdsDigest","parentPlanDigest","records","schemaVersion","sequence","serverTimestamp","worldIdentityDigest","writes"].sort())||state.schemaVersion!=="1.0"||state.candidateDigest!==candidateDigest||state.contractDigest!==contractDigest||state.worldIdentityDigest!==worldIdentityDigest||state.parentPlanDigest!==parentPlanDigest||state.expectedStableIdsDigest!==expectedStableIdsDigest||!Number.isInteger(state.sequence)||state.sequence<0||!Number.isInteger(state.writes)||state.writes<0||!Number.isFinite(Date.parse(state.serverTimestamp))||!state.records||typeof state.records!=="object"||Array.isArray(state.records)||Object.keys(state.records).length>100)return false;const records=Object.entries(state.records),versions=[];for(const [id,record] of records){if(!/^[a-f0-9]{64}$/.test(id)||!record||canonical(Object.keys(record).sort())!==canonical(["exactInputDigest","input","stableId","updatedAt","version"].sort())||record.stableId!==id||record.exactInputDigest!==digest(record.input)||!validateInput(record.input)||!Number.isInteger(record.version)||record.version<1||record.version>state.sequence||!Number.isFinite(Date.parse(record.updatedAt))||Date.parse(record.updatedAt)>Date.parse(state.serverTimestamp))return false;versions.push(record.version)}return state.writes===records.length&&state.sequence===(versions.length?Math.max(...versions):0)&&new Set(versions).size===versions.length&&versions.every((version,index)=>version===index+1)};
const read=()=>{const stat=lstatSync(statePath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576)throw new Error("durable-state-file-rejected");const wrapped=JSON.parse(readFileSync(statePath,"utf8"));if(wrapped.stateDigest!==digest(wrapped.body)||!validateWorld(wrapped.body))throw new Error("durable-state-integrity");return wrapped.body};
let identity;const server=http.createServer((request,response)=>{let raw="",rawBytes=0,overflow=false;request.on("data",chunk=>{rawBytes+=chunk.length;if(rawBytes>65536){overflow=true;return}raw+=chunk});request.on("end",()=>{try{const declared=request.headers["content-length"];if(!declared||!/^\d{1,6}$/.test(String(declared))||Number(declared)>65536||Number(declared)!==rawBytes||overflow)throw new Error("request-size-rejected");if(request.method!=="POST"||request.headers["x-cf053-process-token"]!==processToken)throw new Error("unauthorized-process");const payload=raw?JSON.parse(raw):{},state=read(),stableId=String(payload.stableId||"");let result;if(request.url==="/identity")result=identity;else if(request.url==="/observe"){const role=binding.roles.find(item=>item.role==="independent-observer");if(!role||payload.bindingDigest!==binding.bindingDigest||payload.bindingRole!=="independent-observer"||payload.methodDigest!==role.methodDigest)throw new Error("reviewed-binding-rejected");if(!Array.isArray(payload.expectedStableIds)||payload.expectedStableIds.length<1||payload.expectedStableIds.length>100||new Set(payload.expectedStableIds).size!==payload.expectedStableIds.length||(boundary==="derived"&&digest([...payload.expectedStableIds].sort())!==expectedStableIdsDigest))throw new Error("parent-stable-identity-set-rejected");const expected=Object.fromEntries(role.parameters.map(item=>[item.parameter,payload.input[item.inputKey]]));if(canonical(expected)!==canonical(payload.parameters))throw new Error("reviewed-parameter-serialization-rejected");const record=state.records[stableId],clock=new Date().toISOString(),otherIds=Object.keys(state.records).filter(id=>!payload.expectedStableIds.includes(id)),flat=record?.input??{};result={...flat,classification:!record?"not-started":record.exactInputDigest===payload.exactInputDigest?"completed":"incorrect",stableId,matches:record?[record.input]:[],matchCount:record?1:0,exactInputDigest:record?.exactInputDigest??null,record:record?.input??null,observedVersion:record?.version??null,observedAt:record?.updatedAt??state.serverTimestamp,observationClock:clock,serverSequence:state.sequence,collateralClean:otherIds.length===0,unexpectedStableIds:otherIds,totalBusinessWrites:state.writes,writeCount:0};}else if(request.url==="/summary")result={records:state.records,sequence:state.sequence,totalBusinessWrites:state.writes,serverTimestamp:state.serverTimestamp,observationClock:new Date().toISOString(),writeCount:0};else throw new Error("unknown-route");const encoded=JSON.stringify(result);if(Buffer.byteLength(encoded)>65536)throw new Error("response-size-rejected");response.setHeader("content-type","application/json");response.setHeader("content-length",Buffer.byteLength(encoded));response.end(encoded)}catch(error){response.statusCode=409;const message=(error instanceof Error?error.message:"process-error").slice(0,4096),encoded=JSON.stringify({error:message});response.setHeader("content-type","application/json");response.setHeader("content-length",Buffer.byteLength(encoded));response.end(encoded)}})});
server.listen(0,"127.0.0.1",()=>{try{const address=server.address();identity={plane:"observer",pid:process.pid,launchNonce,processKeyDigest,sourceDigest,candidateDigest,bindingDigest:binding.bindingDigest,endpoint:"http://127.0.0.1:"+address.port+"/"};const db=new DatabaseSync(_generationDb);db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");const changed=db.prepare("UPDATE cf053_generations SET observer_pid=?,observer_nonce=?,observer_source_digest=?,observer_token_digest=?,observer_endpoint=?,observer_recovery_token=? WHERE reservation_id=? AND status='pending'").run(process.pid,launchNonce,sourceDigest,processKeyDigest,identity.endpoint,processToken,_generationReservation);if(changed.changes!==1)throw new Error("observer-self-registration-cas");db.exec("COMMIT;");db.close();process.stdout.write(JSON.stringify(identity)+"\n")}catch(error){server.close(()=>process.exit(72))}});process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
`;

function registryEntry(contract: Cf053ProviderNeutralContract, now: string): Omit<RegistryEntry, "entryDigest"> {
  const actionSourceDigest = bytesDigest(ACTION_PROCESS_SOURCE);
  const observerSourceDigest = bytesDigest(OBSERVER_PROCESS_SOURCE);
  return {
    contract,
    candidateDigest: cf053Digest({
      compilerVersion: CF053_PROVIDER_NEUTRAL_TRANSFER_CORE_VERSION,
      contractDigest: contract.contractDigest,
      actionSourceDigest,
      observerSourceDigest,
    }),
    actionSourceDigest,
    observerSourceDigest,
    buildOrdinal: 1,
    builtAt: now,
  };
}

function readRegistry(path: string): RegistryFile {
  assertRegularBoundedFile(path, 32 * 1024 * 1024, "registry");
  const registry = JSON.parse(readFileSync(path, "utf8")) as RegistryFile;
  if (!Array.isArray(registry.entries) || registry.entries.length > 256) throw new Error("CF-053 registry exceeds its 256-candidate bound.");
  if (registry.schemaVersion !== "1.0" || registry.registryDigest !== cf053Digest({ schemaVersion: registry.schemaVersion, entries: registry.entries })) {
    throw new Error("CF-053 registry integrity failed.");
  }
  for (const entry of registry.entries) {
    if (entry.entryDigest !== cf053Digest(omit(entry as unknown as Record<string, unknown>, "entryDigest"))) throw new Error("CF-053 registry entry integrity failed.");
    assertCf053Contract(entry.contract);
    const expected = registryEntry(entry.contract, entry.builtAt);
    if (entry.candidateDigest !== expected.candidateDigest || entry.actionSourceDigest !== expected.actionSourceDigest || entry.observerSourceDigest !== expected.observerSourceDigest || entry.buildOrdinal !== 1) {
      throw new Error("CF-053 registry candidate identity was substituted.");
    }
  }
  return registry;
}

function writeRegistry(path: string, entries: RegistryEntry[]): void {
  const body = { schemaVersion: "1.0" as const, entries };
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const encoded = `${JSON.stringify({ ...body, registryDigest: cf053Digest(body) }, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) throw new Error("CF-053 registry exceeds its 32 MiB encoded bound.");
  const descriptor = openSync(temporary, "wx", 0o600);
  try { writeFileSync(descriptor, encoded); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  try { renameSync(temporary, path); fsyncDirectory(dirname(path)); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}

export class Cf053ContentAddressedCandidateRegistry {
  readonly registryPath: string;
  private readonly root: string;
  private readonly lockPath: string;

  constructor(rootDirectory: string) {
    this.root = resolve(rootDirectory);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.lockPath = join(this.root, "registry-lock.sqlite");
    const lock = new DatabaseSync(this.lockPath); lock.exec("PRAGMA busy_timeout=15000;");
    try { lock.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS registry_guard (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO registry_guard(id, revision) VALUES (1, 0); COMMIT;"); }
    catch (error) { try { lock.exec("ROLLBACK;"); } catch {} throw error; }
    finally { lock.close(); }
    this.registryPath = join(this.root, "registry.json");
    if (!existsSync(this.registryPath)) this.withLock(() => { if (!existsSync(this.registryPath)) writeRegistry(this.registryPath, []); });
    this.withLock(() => cleanupCf053OwnedCrashArtifacts(this.root, "candidate-stage"));
    readRegistry(this.registryPath);
  }

  private withLock<T>(operation: () => T): T {
    const database = new DatabaseSync(this.lockPath); database.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");
    try { const result = operation(); database.exec("UPDATE registry_guard SET revision = revision + 1 WHERE id = 1; COMMIT;"); return result; }
    catch (error) { try { database.exec("ROLLBACK;"); } catch {} throw error; }
    finally { database.close(); }
  }

  acquire(handle: Cf053DerivedContractHandle, now: string): Cf053CandidateHandle {
    const contract = derivedContractHandles.get(handle as object);
    if (!contract || contract.contractDigest !== handle.contractDigest || !contract.executionBinding) throw new Error("CF-053 production registry requires the exact unforgeable derived-contract handle.");
    return this.acquireInternal(contract, now, "derived");
  }

  /** Explicitly author-known development only; output is rejected by production launch/execute. */
  acquireDevelopment(contract: Cf053ProviderNeutralContract, now: string): Cf053CandidateHandle {
    return this.acquireInternal(contract, now, "development");
  }

  private acquireInternal(contract: Cf053ProviderNeutralContract, now: string, boundary: "derived" | "development"): Cf053CandidateHandle {
    assertCf053Contract(contract);
    const { entry, source } = this.withLock(() => {
    const registry = readRegistry(this.registryPath);
    const expected = registryEntry(contract, now);
    let entry = registry.entries.find((candidate) => candidate.candidateDigest === expected.candidateDigest);
    let source: Cf053CandidateHandle["source"] = "retained";
    if (!entry) {
      if (registry.entries.length >= 256) throw new Error("CF-053 registry candidate bound reached.");
      const body = registryEntry(contract, now);
      entry = { ...body, entryDigest: cf053Digest(body) };
      const directory = resolve(this.root, entry.candidateDigest);
      if (!directory.startsWith(`${this.root}${sep}`)) throw new Error("CF-053 candidate path escaped its registry root.");
      if (!existsSync(directory)) {
        const stage = `${directory}.stage.${process.pid}.${randomUUID()}`;
        try {
          mkdirSync(stage, { recursive: false, mode: 0o700 });
          for (const [name, contents] of [[`${entry.actionSourceDigest}.mjs`, ACTION_PROCESS_SOURCE], [`${entry.observerSourceDigest}.mjs`, OBSERVER_PROCESS_SOURCE], ["contract.json", `${JSON.stringify(contract, null, 2)}\n`]] as const) {
            if (Buffer.byteLength(contents) > 131_072) throw new Error("CF-053 candidate artifact exceeds its 128 KiB bound.");
            const path = join(stage, name), descriptor = openSync(path, "wx", 0o600); try { writeFileSync(descriptor, contents); fsyncSync(descriptor); } finally { closeSync(descriptor); }
          }
          fsyncDirectory(stage);
          renameSync(stage, directory);
          fsyncDirectory(this.root);
        } catch (error) {
          rmSync(stage, { recursive: true, force: true });
          throw error;
        }
      }
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() || realpathSync(dirname(directory)) !== realpathSync(this.root)) throw new Error("CF-053 candidate directory is not one exact regular child of its registry root.");
      for (const path of [join(directory, `${entry.actionSourceDigest}.mjs`), join(directory, `${entry.observerSourceDigest}.mjs`), join(directory, "contract.json")]) assertRegularBoundedFile(path, 131_072, "candidate artifact");
      if (bytesDigest(readFileSync(join(directory, `${entry.actionSourceDigest}.mjs`))) !== entry.actionSourceDigest || bytesDigest(readFileSync(join(directory, `${entry.observerSourceDigest}.mjs`))) !== entry.observerSourceDigest || canonical(JSON.parse(readFileSync(join(directory, "contract.json"), "utf8"))) !== canonical(contract)) throw new Error("CF-053 orphan candidate directory is partial or does not exactly match the candidate being adopted.");
      writeRegistry(this.registryPath, [...registry.entries, entry]);
      source = "built";
    } else if (canonical(entry.contract) !== canonical(contract)) {
      throw new Error("CF-053 content-address collision or contract substitution detected.");
    }
    const candidateDirectory = resolve(this.root, entry.candidateDigest);
    if (!lstatSync(candidateDirectory).isDirectory() || lstatSync(candidateDirectory).isSymbolicLink() || realpathSync(dirname(candidateDirectory)) !== realpathSync(this.root)) throw new Error("CF-053 retained candidate directory is not one exact regular child of its registry root.");
    for (const path of [join(candidateDirectory, `${entry.actionSourceDigest}.mjs`), join(candidateDirectory, `${entry.observerSourceDigest}.mjs`), join(candidateDirectory, "contract.json")]) assertRegularBoundedFile(path, 131_072, "retained candidate artifact");
    if (bytesDigest(readFileSync(join(candidateDirectory, `${entry.actionSourceDigest}.mjs`))) !== entry.actionSourceDigest || bytesDigest(readFileSync(join(candidateDirectory, `${entry.observerSourceDigest}.mjs`))) !== entry.observerSourceDigest || canonical(JSON.parse(readFileSync(join(candidateDirectory, "contract.json"), "utf8"))) !== canonical(contract)) {
      throw new Error("CF-053 retained candidate bytes or contract were tampered.");
    }
    return { entry, source };
    });
    const candidateDirectory = resolve(this.root, entry.candidateDigest);
    const handle = Object.freeze({ candidateDigest: entry.candidateDigest, source });
    candidateHandles.set(handle, { entry, registryPath: this.registryPath, candidateDirectory, boundary });
    return handle;
  }
}

/**
 * Reconstruct the opaque production-derived contract handle after a genuine process restart.
 *
 * This does not re-derive planning evidence or mint a new authority root. It accepts only a
 * content-addressed candidate already present in the durable registry, verifies the complete
 * retained artifact set, and proves that the pre-runtime workspace issuer is still the exact
 * issuer anchored by the retained contract's trusted planning context.
 */
export function reopenCf053DerivedContractFromDurableCandidate(input: {
  registryRootDirectory: string;
  candidateDigest: string;
  workspaceTrustRootDirectory: string;
}): Cf053DerivedContractHandle {
  if (!DIGEST.test(input.candidateDigest)) throw new Error("CF-053 durable reopen requires an exact candidate digest.");
  const registryRoot = resolve(input.registryRootDirectory);
  const workspaceTrustRoot = resolve(input.workspaceTrustRootDirectory);
  const registry = new Cf053ContentAddressedCandidateRegistry(registryRoot);
  const durableRegistry = readRegistry(registry.registryPath);
  const matches = durableRegistry.entries.filter((entry) => entry.candidateDigest === input.candidateDigest);
  if (matches.length !== 1) throw new Error("CF-053 durable reopen requires exactly one retained candidate registry entry.");
  const entry = matches[0]!;
  if (!entry.contract.executionBinding) throw new Error("CF-053 durable reopen rejects a candidate without the reviewed execution binding.");

  const candidateDirectory = resolve(registryRoot, entry.candidateDigest);
  if (!candidateDirectory.startsWith(`${registryRoot}${sep}`) || !lstatSync(candidateDirectory).isDirectory() || lstatSync(candidateDirectory).isSymbolicLink() || realpathSync(dirname(candidateDirectory)) !== realpathSync(registryRoot)) {
    throw new Error("CF-053 durable reopen candidate is not one exact regular child of its registry root.");
  }
  const actionPath = join(candidateDirectory, `${entry.actionSourceDigest}.mjs`);
  const observerPath = join(candidateDirectory, `${entry.observerSourceDigest}.mjs`);
  const contractPath = join(candidateDirectory, "contract.json");
  for (const path of [actionPath, observerPath, contractPath]) assertRegularBoundedFile(path, 131_072, "durable reopen candidate artifact");
  if (bytesDigest(readFileSync(actionPath)) !== entry.actionSourceDigest || bytesDigest(readFileSync(observerPath)) !== entry.observerSourceDigest || canonical(JSON.parse(readFileSync(contractPath, "utf8"))) !== canonical(entry.contract)) {
    throw new Error("CF-053 durable reopen candidate bytes or contract were tampered.");
  }

  const rootPath = join(workspaceTrustRoot, CF053_WORKSPACE_TRUST_ROOT_FILE);
  assertRegularBoundedFile(rootPath, 32_768, "durable reopen workspace trust root");
  const root = JSON.parse(readFileSync(rootPath, "utf8")) as { schemaVersion: string; authorityContextDigest: string; privateKeyPem: string; publicKeyPem: string; publicKeyDigest: string; rootDigest: string };
  const { rootDigest, ...rootBody } = root;
  const expectedAuthorityContextDigest = cf053Digest({
    tenantId: entry.contract.tenantId,
    targetAlias: entry.contract.targetAlias,
    policyVersion: entry.contract.policyVersion,
    sourceChain: entry.contract.sourceChain,
  });
  let privateKey: KeyObject;
  let publicKey: KeyObject;
  try {
    privateKey = createPrivateKey(root.privateKeyPem);
    publicKey = createPublicKey(root.publicKeyPem);
  } catch {
    throw new Error("CF-053 durable reopen workspace issuer key material is malformed.");
  }
  const derivedPublicKey = createPublicKey(privateKey);
  const publicKeyDigest = bytesDigest(publicKey.export({ type: "spki", format: "der" }));
  const derivedPublicKeyDigest = bytesDigest(derivedPublicKey.export({ type: "spki", format: "der" }));
  if (root.schemaVersion !== "1.0" || root.authorityContextDigest !== expectedAuthorityContextDigest || rootDigest !== cf053Digest(rootBody) || root.publicKeyDigest !== publicKeyDigest || derivedPublicKeyDigest !== publicKeyDigest || entry.contract.workspaceIssuerPublicKeyDigest !== publicKeyDigest) {
    throw new Error("CF-053 durable reopen workspace issuer does not match the retained trusted planning context.");
  }

  const handle = Object.freeze({ contractDigest: entry.contract.contractDigest });
  derivedContractHandles.set(handle, entry.contract);
  return handle;
}

interface ProcessIdentity {
  plane: "action" | "observer";
  pid: number;
  launchNonce: string;
  processKeyDigest: string;
  sourceDigest: string;
  candidateDigest: string;
  authoritySignerKeyId?: string;
  authorityPublicKeyDigest?: string;
  bindingDigest?: string;
  endpoint: string;
}

export interface Cf053LaunchReceipt {
  schemaVersion: "1.0";
  generation: number;
  predecessorReceiptDigest: string | null;
  launcherPublicKeyDigest: string;
  action: ProcessIdentity;
  observer: ProcessIdentity;
  issuedAt: string;
  signature: string;
  receiptDigest: string;
}

export interface Cf053ProcessHandle {
  readonly launchReceiptDigest: string;
}

interface ProcessPrivate {
  candidate: CandidatePrivate;
  action: Cf053ChildProcess;
  observer: Cf053ChildProcess;
  actionToken: string;
  observerToken: string;
  receipt: Cf053LaunchReceipt;
  publicKeyPem: string;
  statePath: string;
  generationDbPath: string;
  generationReservationId: string;
  worldIdentityDigest: string;
  parentPlanDigest: string;
  expectedStableIdsDigest: string;
  closed: boolean;
}

const processHandles = new WeakMap<object, ProcessPrivate>();
type Cf053ChildProcess = ChildProcessByStdio<null, Readable, Readable>;

async function launchProcess(input: { script: string; statePath: string; nonce: string; token: string; candidateDigest: string; contractDigest: string; worldIdentityDigest: string; parentPlanDigest: string; expectedStableIdsDigest: string; plane: "action" | "observer"; authoritySignerKeyId: string; authorityPublicKeyDigest: string; inputSchema: Cf053InputField[]; executionBinding: NonNullable<Cf053ProviderNeutralContract["executionBinding"]>; generationDbPath: string; generationReservationId: string; boundary: "derived" | "development" }): Promise<{ child: Cf053ChildProcess; identity: ProcessIdentity }> {
  const schemaEncoded = Buffer.from(canonical(input.inputSchema)).toString("base64");
  const bindingEncoded = Buffer.from(canonical(input.executionBinding)).toString("base64");
  const child = spawn(process.execPath, [input.script, input.statePath, input.nonce, input.token, input.candidateDigest, input.authoritySignerKeyId, input.authorityPublicKeyDigest, schemaEncoded, bindingEncoded, input.generationDbPath, input.generationReservationId, input.boundary, input.contractDigest, input.worldIdentityDigest, input.parentPlanDigest, input.expectedStableIdsDigest], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill("SIGKILL"); rejectPromise(new Error("CF-053 child launch timed out.")); } }, 3000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout) > 16_384) { if (!settled) { settled = true; clearTimeout(timer); child.kill("SIGKILL"); rejectPromise(new Error("CF-053 child launch stdout exceeded 16 KiB.")); } return; }
      const newline = stdout.indexOf("\n");
      if (settled || newline < 0) return;
      try {
        const identity = JSON.parse(stdout.slice(0, newline)) as ProcessIdentity;
        if (identity.plane !== input.plane || identity.pid !== child.pid || identity.launchNonce !== input.nonce || identity.processKeyDigest !== bytesDigest(input.token) || identity.sourceDigest !== bytesDigest(readFileSync(input.script)) || identity.candidateDigest !== input.candidateDigest || identity.bindingDigest !== input.executionBinding.bindingDigest || (input.plane === "action" && (identity.authoritySignerKeyId !== input.authoritySignerKeyId || identity.authorityPublicKeyDigest !== input.authorityPublicKeyDigest)) || !identity.endpoint.startsWith("http://127.0.0.1:")) throw new Error("identity mismatch");
        settled = true; clearTimeout(timer); resolvePromise({ child, identity });
      } catch { settled = true; clearTimeout(timer); child.kill("SIGKILL"); rejectPromise(new Error("CF-053 child returned an invalid process identity.")); }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); if (Buffer.byteLength(stderr) > 16_384 && !settled) { settled = true; clearTimeout(timer); child.kill("SIGKILL"); rejectPromise(new Error("CF-053 child launch stderr exceeded 16 KiB.")); } });
    child.once("exit", () => { if (!settled) { settled = true; clearTimeout(timer); rejectPromise(new Error(`CF-053 child exited during launch: ${stderr}`)); } });
  });
}

function initialWorld(candidateDigest: string, contractDigest: string, worldIdentityDigest: string, parentPlanDigest: string, expectedStableIdsDigest: string): { body: { schemaVersion: "1.0"; candidateDigest: string; contractDigest: string; worldIdentityDigest: string; parentPlanDigest: string; expectedStableIdsDigest: string; sequence: number; writes: number; serverTimestamp: string; records: Record<string, unknown> }; stateDigest: string } {
  const body = { schemaVersion: "1.0" as const, candidateDigest, contractDigest, worldIdentityDigest, parentPlanDigest, expectedStableIdsDigest, sequence: 0, writes: 0, serverTimestamp: new Date().toISOString(), records: {} };
  return { body, stateDigest: cf053Digest(body) };
}

interface GenerationReservation { reservationId: string; generation: number; predecessorReceiptDigest: string | null }
function generationDatabasePath(worldRoot: string): string { return join(resolve(worldRoot), "generation-state.sqlite"); }
function bootstrapGenerationDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=15000;");
  try {
    db.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS cf053_generations (reservation_id TEXT PRIMARY KEY, candidate_digest TEXT NOT NULL, world_identity_digest TEXT NOT NULL, generation INTEGER NOT NULL, predecessor_receipt_digest TEXT, receipt_digest TEXT, status TEXT NOT NULL CHECK(status IN ('pending','active','retired')), created_at TEXT NOT NULL, launcher_pid INTEGER, action_pid INTEGER, action_nonce TEXT, action_source_digest TEXT, action_token_digest TEXT, action_endpoint TEXT, action_recovery_token TEXT, observer_pid INTEGER, observer_nonce TEXT, observer_source_digest TEXT, observer_token_digest TEXT, observer_endpoint TEXT, observer_recovery_token TEXT, UNIQUE(candidate_digest, world_identity_digest, generation));");
    const columns = db.prepare("PRAGMA table_info(cf053_generations)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "launcher_pid")) db.exec("ALTER TABLE cf053_generations ADD COLUMN launcher_pid INTEGER;");
    for (const [column, type] of [["action_pid","INTEGER"],["action_nonce","TEXT"],["action_source_digest","TEXT"],["action_token_digest","TEXT"],["action_endpoint","TEXT"],["action_recovery_token","TEXT"],["observer_pid","INTEGER"],["observer_nonce","TEXT"],["observer_source_digest","TEXT"],["observer_token_digest","TEXT"],["observer_endpoint","TEXT"],["observer_recovery_token","TEXT"]] as const) if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE cf053_generations ADD COLUMN ${column} ${type};`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS cf053_one_active ON cf053_generations(candidate_digest, world_identity_digest) WHERE status='active'; CREATE UNIQUE INDEX IF NOT EXISTS cf053_one_pending ON cf053_generations(candidate_digest, world_identity_digest) WHERE status='pending'; COMMIT;");
  } catch (error) { try { db.exec("ROLLBACK;"); } catch {} throw error; }
  finally { db.close(); }
  chmodSync(path, 0o600);
}

function reserveGeneration(path: string, candidateDigest: string, worldIdentityDigest: string, now: string): GenerationReservation {
  const db = new DatabaseSync(path); db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");
  try {
    const pending = db.prepare("SELECT reservation_id FROM cf053_generations WHERE candidate_digest=? AND world_identity_digest=? AND status='pending'").get(candidateDigest, worldIdentityDigest);
    if (pending) throw new Error("CF-053 one pending launch already exists; recover it explicitly after proving its launcher is gone.");
    const predecessor = db.prepare("SELECT generation, receipt_digest AS receiptDigest FROM cf053_generations WHERE candidate_digest=? AND world_identity_digest=? AND status IN ('active','retired') ORDER BY generation DESC LIMIT 1").get(candidateDigest, worldIdentityDigest) as { generation: number; receiptDigest: string } | undefined;
    const reservationId = randomUUID(), generation = (predecessor?.generation ?? 0) + 1;
    db.prepare("INSERT INTO cf053_generations(reservation_id,candidate_digest,world_identity_digest,generation,predecessor_receipt_digest,receipt_digest,status,created_at,launcher_pid) VALUES(?,?,?,?,?,NULL,'pending',?,?)").run(reservationId, candidateDigest, worldIdentityDigest, generation, predecessor?.receiptDigest ?? null, now, process.pid);
    db.exec("COMMIT;"); return { reservationId, generation, predecessorReceiptDigest: predecessor?.receiptDigest ?? null };
  } catch (error) { try { db.exec("ROLLBACK;"); } catch {} throw error; } finally { db.close(); }
}
function cancelGeneration(path: string, reservationId: string): void { const db = new DatabaseSync(path); db.prepare("DELETE FROM cf053_generations WHERE reservation_id=? AND status='pending'").run(reservationId); db.close(); }
function readActiveGeneration(path: string, candidateDigest: string, worldIdentityDigest: string): { generation: number; receiptDigest: string } | null { const db = new DatabaseSync(path,{readOnly:true}); const row=db.prepare("SELECT generation, receipt_digest AS receiptDigest FROM cf053_generations WHERE candidate_digest=? AND world_identity_digest=? AND status='active'").get(candidateDigest,worldIdentityDigest) as {generation:number;receiptDigest:string}|undefined;db.close();return row??null }

interface RecoveryChildIdentity { pid:number|null;nonce:string|null;sourceDigest:string|null;tokenDigest:string|null;endpoint:string|null;recoveryToken:string|null;plane:"action"|"observer" }
function challengeRecoveryChild(candidateDigest: string, child: RecoveryChildIdentity): boolean {
  if (!child.pid || !child.nonce || !child.sourceDigest || !child.tokenDigest || !child.endpoint || !child.recoveryToken || !isProcessAlive(child.pid)) return false;
  if (bytesDigest(child.recoveryToken) !== child.tokenDigest || !child.endpoint.startsWith("http://127.0.0.1:")) throw new Error("CF-053 persisted recovery child credential or endpoint identity is malformed.");
  const script = `const http=require('node:http');const [endpoint,token]=process.argv.slice(1);const body='{}';const req=http.request(new URL('/identity',endpoint),{method:'POST',headers:{'content-length':String(Buffer.byteLength(body)),'x-cf053-process-token':token}},res=>{let out='';res.on('data',c=>out+=c);res.on('end',()=>{if(res.statusCode!==200)process.exit(3);process.stdout.write(out)})});req.setTimeout(1000,()=>req.destroy());req.on('error',()=>process.exit(4));req.end(body);`;
  let identity: ProcessIdentity; try { identity = JSON.parse(execFileSync(process.execPath,["-e",script,child.endpoint,child.recoveryToken],{encoding:"utf8",timeout:1500,maxBuffer:16_384})) as ProcessIdentity; } catch { return false; }
  return identity.plane===child.plane&&identity.pid===child.pid&&identity.launchNonce===child.nonce&&identity.sourceDigest===child.sourceDigest&&identity.processKeyDigest===child.tokenDigest&&identity.candidateDigest===candidateDigest&&identity.endpoint===child.endpoint;
}

export type Cf053AbandonedGenerationRecoveryTarget =
  | { lifecycle: "pending"; reservationId?: string }
  | { lifecycle: "active"; reservationId?: string; receiptDigest: string };

export function recoverCf053AbandonedGeneration(input: { candidate: Cf053CandidateHandle; worldRoot: string; target: Cf053AbandonedGenerationRecoveryTarget }): boolean {
  const candidate = candidateHandles.get(input.candidate as object);
  if (!candidate) throw new Error("CF-053 generation recovery requires the exact opaque candidate handle.");
  if (input.target.lifecycle === "active" && !/^[a-f0-9]{64}$/.test(input.target.receiptDigest)) throw new Error("CF-053 active recovery requires the exact receipt digest.");
  if (input.target.reservationId !== undefined && !/^[0-9a-f-]{36}$/.test(input.target.reservationId)) throw new Error("CF-053 generation recovery reservation identity is malformed.");
  const worldRoot = resolve(input.worldRoot); mkdirSync(worldRoot, { recursive: true, mode: 0o700 });
  const statePath = join(worldRoot, "state.json"), worldIdentityDigest = cf053Digest({ statePath: resolve(statePath) }), path = generationDatabasePath(worldRoot);
  bootstrapGenerationDatabase(path);
  const db = new DatabaseSync(path); db.exec("PRAGMA busy_timeout=5000;");
  try {
    const row = db.prepare("SELECT reservation_id AS reservationId,status,receipt_digest AS receiptDigest,launcher_pid AS launcherPid,action_pid AS actionPid,action_nonce AS actionNonce,action_source_digest AS actionSourceDigest,action_token_digest AS actionTokenDigest,action_endpoint AS actionEndpoint,action_recovery_token AS actionRecoveryToken,observer_pid AS observerPid,observer_nonce AS observerNonce,observer_source_digest AS observerSourceDigest,observer_token_digest AS observerTokenDigest,observer_endpoint AS observerEndpoint,observer_recovery_token AS observerRecoveryToken FROM cf053_generations WHERE candidate_digest=? AND world_identity_digest=? AND status=?").get(candidate.entry.candidateDigest, worldIdentityDigest, input.target.lifecycle) as {reservationId:string;status:"pending"|"active";receiptDigest:string|null;launcherPid:number|null;actionPid:number|null;actionNonce:string|null;actionSourceDigest:string|null;actionTokenDigest:string|null;actionEndpoint:string|null;actionRecoveryToken:string|null;observerPid:number|null;observerNonce:string|null;observerSourceDigest:string|null;observerTokenDigest:string|null;observerEndpoint:string|null;observerRecoveryToken:string|null}|undefined;
    if (!row) return false;
    if (input.target.reservationId !== undefined && row.reservationId !== input.target.reservationId) throw new Error("CF-053 generation recovery reservation identity did not match the exact lifecycle target.");
    if (input.target.lifecycle === "active" && row.receiptDigest !== input.target.receiptDigest) throw new Error("CF-053 active recovery receipt identity did not match the exact lifecycle target.");
    if (row.launcherPid && isProcessAlive(row.launcherPid)) throw new Error("CF-053 generation launcher PID is still alive; recovery refuses to act.");
    const children: RecoveryChildIdentity[] = [{plane:"action",pid:row.actionPid,nonce:row.actionNonce,sourceDigest:row.actionSourceDigest,tokenDigest:row.actionTokenDigest,endpoint:row.actionEndpoint,recoveryToken:row.actionRecoveryToken},{plane:"observer",pid:row.observerPid,nonce:row.observerNonce,sourceDigest:row.observerSourceDigest,tokenDigest:row.observerTokenDigest,endpoint:row.observerEndpoint,recoveryToken:row.observerRecoveryToken}];
    for(const child of children){if(child.pid&&isProcessAlive(child.pid)){if(!challengeRecoveryChild(candidate.entry.candidateDigest,child))throw new Error("CF-053 live orphan child failed the authenticated recovery challenge; no process was killed.");process.kill(child.pid,"SIGTERM");const deadline=Date.now()+1000;while(isProcessAlive(child.pid)&&Date.now()<deadline){}if(isProcessAlive(child.pid)){if(!challengeRecoveryChild(candidate.entry.candidateDigest,child))throw new Error("CF-053 orphan identity changed before forced termination.");process.kill(child.pid,"SIGKILL");}}}
    db.exec("BEGIN IMMEDIATE;");
    const changed = row.status==="pending" ? db.prepare("DELETE FROM cf053_generations WHERE reservation_id=? AND status='pending'").run(row.reservationId) : db.prepare("UPDATE cf053_generations SET status='retired',action_endpoint=NULL,action_recovery_token=NULL,observer_endpoint=NULL,observer_recovery_token=NULL WHERE reservation_id=? AND status='active' AND receipt_digest=?").run(row.reservationId,row.receiptDigest);
    if(changed.changes!==1)throw new Error("CF-053 abandoned generation recovery lost its exact lifecycle CAS.");
    db.exec("COMMIT;"); return true;
  } catch (error) { try { db.exec("ROLLBACK;"); } catch {} throw error; } finally { db.close(); }
}

/** Compatibility helper whose name and query are deliberately pending-only. */
export function recoverCf053AbandonedPendingGeneration(input: { candidate: Cf053CandidateHandle; worldRoot: string; reservationId?: string }): boolean {
  const target: Cf053AbandonedGenerationRecoveryTarget = input.reservationId === undefined ? { lifecycle: "pending" } : { lifecycle: "pending", reservationId: input.reservationId };
  return recoverCf053AbandonedGeneration({ candidate: input.candidate, worldRoot: input.worldRoot, target });
}

async function launchCf053ProcessesInternal(input: { candidate: Cf053CandidateHandle; authoritySigner: Cf053AuthoritySigner; worldRoot: string; now?: string; boundary: "derived" | "development"; parentPlan?: Cf053ValidatedParentPlanHandle }): Promise<Cf053ProcessHandle> {
  const candidate = candidateHandles.get(input.candidate as object);
  const authoritySigner = authoritySigners.get(input.authoritySigner as object);
  if (!candidate || candidate.boundary !== input.boundary || !authoritySigner || candidate.entry.candidateDigest !== input.candidate.candidateDigest || readRegistry(candidate.registryPath).entries.filter((entry) => entry.candidateDigest === input.candidate.candidateDigest).length !== 1) throw new Error("CF-053 candidate/authority handle is forged, cloned, stale or belongs to the wrong production/development boundary.");
  const now = input.boundary === "derived" ? new Date().toISOString() : input.now;
  if (!now || !Number.isFinite(Date.parse(now))) throw new Error("CF-053 process launch time is invalid.");
  const boundPlan = input.parentPlan ? parentPlanHandles.get(input.parentPlan as object) : undefined;
  if (input.boundary === "derived" && (!boundPlan || boundPlan.boundary !== "derived" || boundPlan.candidateDigest !== candidate.entry.candidateDigest)) throw new Error("CF-053 production launch requires the exact candidate-bound production parent plan.");
  const parentPlanDigest = input.boundary === "derived" ? input.parentPlan!.parentPlanDigest : cf053Digest({ developmentWorld: candidate.entry.candidateDigest });
  const expectedStableIdsDigest = input.boundary === "derived" ? input.parentPlan!.expectedStableIdsDigest : cf053Digest({ developmentWorld: candidate.entry.candidateDigest, expectedStableIds: "authority-bound-at-execution" });
  const worldRoot = resolve(input.worldRoot);
  mkdirSync(worldRoot, { recursive: true, mode: 0o700 });
  cleanupCf053OwnedCrashArtifacts(worldRoot, "world-next");
  const statePath = join(worldRoot, "state.json"), worldIdentityDigest = cf053Digest({ statePath: resolve(statePath) });
  if (!existsSync(statePath)) {
    const descriptor = openSync(statePath, "wx", 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify(initialWorld(candidate.entry.candidateDigest, candidate.entry.contract.contractDigest, worldIdentityDigest, parentPlanDigest, expectedStableIdsDigest))}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    fsyncDirectory(worldRoot);
  }
  else {
    assertRegularBoundedFile(statePath, 1_048_576, "durable world");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { body: Record<string, unknown>; stateDigest: string };
    if (state.stateDigest !== cf053Digest(state.body) || state.body.schemaVersion !== "1.0" || state.body.candidateDigest !== candidate.entry.candidateDigest || state.body.contractDigest !== candidate.entry.contract.contractDigest || state.body.worldIdentityDigest !== worldIdentityDigest || state.body.parentPlanDigest !== parentPlanDigest || state.body.expectedStableIdsDigest !== expectedStableIdsDigest || !Number.isInteger(state.body.sequence) || !Number.isInteger(state.body.writes) || state.body.records === null || typeof state.body.records !== "object" || Array.isArray(state.body.records) || Object.keys(state.body.records).length > 100) throw new Error("CF-053 durable world integrity or pinned parent/candidate identity failed before launch.");
  }
  const actionToken = randomBytes(32).toString("hex"), observerToken = randomBytes(32).toString("hex");
  const actionNonce = randomBytes(24).toString("hex"), observerNonce = randomBytes(24).toString("hex");
  const actionScript = join(candidate.candidateDirectory, `${candidate.entry.actionSourceDigest}.mjs`), observerScript = join(candidate.candidateDirectory, `${candidate.entry.observerSourceDigest}.mjs`);
  assertRegularBoundedFile(actionScript, 131_072, "action process source"); assertRegularBoundedFile(observerScript, 131_072, "observer process source");
  if (bytesDigest(readFileSync(actionScript)) !== candidate.entry.actionSourceDigest || bytesDigest(readFileSync(observerScript)) !== candidate.entry.observerSourceDigest) throw new Error("CF-053 exact registered candidate process bytes changed before launch.");
  const executionBinding = candidate.entry.contract.executionBinding;
  if (!executionBinding) throw new Error("CF-053 candidate lacks an executable reviewed semantic binding.");
  const generationDbPath = generationDatabasePath(worldRoot);
  bootstrapGenerationDatabase(generationDbPath);
  const reservation = reserveGeneration(generationDbPath, candidate.entry.candidateDigest, worldIdentityDigest, now);
  let action: Awaited<ReturnType<typeof launchProcess>> | undefined, observer: Awaited<ReturnType<typeof launchProcess>> | undefined;
  try {
    action = await launchProcess({ script: actionScript, statePath, nonce: actionNonce, token: actionToken, candidateDigest: candidate.entry.candidateDigest, plane: "action", authoritySignerKeyId: input.authoritySigner.signerKeyId, authorityPublicKeyDigest: input.authoritySigner.publicKeyDigest, inputSchema: candidate.entry.contract.inputSchema, executionBinding, generationDbPath, generationReservationId: reservation.reservationId, boundary: input.boundary, contractDigest: candidate.entry.contract.contractDigest, worldIdentityDigest, parentPlanDigest, expectedStableIdsDigest });
    observer = await launchProcess({ script: observerScript, statePath, nonce: observerNonce, token: observerToken, candidateDigest: candidate.entry.candidateDigest, plane: "observer", authoritySignerKeyId: input.authoritySigner.signerKeyId, authorityPublicKeyDigest: input.authoritySigner.publicKeyDigest, inputSchema: candidate.entry.contract.inputSchema, executionBinding, generationDbPath, generationReservationId: reservation.reservationId, boundary: input.boundary, contractDigest: candidate.entry.contract.contractDigest, worldIdentityDigest, parentPlanDigest, expectedStableIdsDigest });
  } catch (error) {
    await Promise.all([action?.child, observer?.child].filter((child): child is Cf053ChildProcess => Boolean(child)).map(waitForExit));
    cancelGeneration(generationDbPath, reservation.reservationId);
    throw error;
  }
  if (action.identity.pid === observer.identity.pid || action.identity.endpoint === observer.identity.endpoint || action.identity.launchNonce === observer.identity.launchNonce || action.identity.processKeyDigest === observer.identity.processKeyDigest || action.identity.sourceDigest === observer.identity.sourceDigest) {
    await Promise.all([waitForExit(action.child), waitForExit(observer.child)]); cancelGeneration(generationDbPath, reservation.reservationId); throw new Error("CF-053 action and observer processes are conflated.");
  }
  if (action.identity.sourceDigest !== candidate.entry.actionSourceDigest || observer.identity.sourceDigest !== candidate.entry.observerSourceDigest) { await Promise.all([waitForExit(action.child), waitForExit(observer.child)]); cancelGeneration(generationDbPath, reservation.reservationId); throw new Error("CF-053 launched process identity is not bound to the registered candidate bytes."); }
  const keys = generateKeyPairSync("ed25519"), publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const body = { schemaVersion: "1.0" as const, generation: reservation.generation, predecessorReceiptDigest: reservation.predecessorReceiptDigest, launcherPublicKeyDigest: bytesDigest(keys.publicKey.export({ type: "spki", format: "der" })), action: action.identity, observer: observer.identity, issuedAt: now };
  const signature = sign(null, Buffer.from(canonical(body)), keys.privateKey).toString("base64");
  const receipt = { ...body, signature, receiptDigest: cf053Digest({ ...body, signature }) };
  const handle = Object.freeze({ launchReceiptDigest: receipt.receiptDigest });
  processHandles.set(handle, { candidate, action: action.child, observer: observer.child, actionToken, observerToken, receipt, publicKeyPem, statePath, generationDbPath, generationReservationId: reservation.reservationId, worldIdentityDigest, parentPlanDigest, expectedStableIdsDigest, closed: false });
  return handle;
}

export const launchCf053DevelopmentProcesses = (input: { candidate: Cf053CandidateHandle; authoritySigner: Cf053AuthoritySigner; worldRoot: string; now: string }) => launchCf053ProcessesInternal({ ...input, boundary: "development" });

async function waitForExit(child: Cf053ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => { child.once("exit", () => resolvePromise()); child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1000); });
}

export async function closeCf053ProviderProcesses(handle: Cf053ProcessHandle): Promise<void> {
  const current = processHandles.get(handle as object);
  if (!current || current.closed) throw new Error("CF-053 process handle is forged, cloned, stale or already closed.");
  await Promise.all([waitForExit(current.action), waitForExit(current.observer)]);
  const database = new DatabaseSync(current.generationDbPath); database.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");
  try {
    const row = database.prepare("SELECT status, receipt_digest AS receiptDigest FROM cf053_generations WHERE reservation_id=?").get(current.generationReservationId) as { status: string; receiptDigest: string | null } | undefined;
    if (row?.status === "pending") {
      const changed = database.prepare("DELETE FROM cf053_generations WHERE reservation_id=? AND status='pending'").run(current.generationReservationId);
      if (changed.changes !== 1) throw new Error("CF-053 pending close lost its exact reservation CAS.");
    } else if (row?.status === "active") {
      if (row.receiptDigest !== current.receipt.receiptDigest) throw new Error("CF-053 active close receipt identity was substituted.");
      const changed = database.prepare("UPDATE cf053_generations SET status='retired',action_endpoint=NULL,action_recovery_token=NULL,observer_endpoint=NULL,observer_recovery_token=NULL WHERE reservation_id=? AND status='active' AND receipt_digest=?").run(current.generationReservationId, current.receipt.receiptDigest);
      if (changed.changes !== 1) throw new Error("CF-053 active close lost its exact receipt CAS.");
      database.prepare("DELETE FROM cf053_generations WHERE reservation_id IN (SELECT reservation_id FROM cf053_generations WHERE candidate_digest=? AND world_identity_digest=? AND status='retired' ORDER BY generation DESC LIMIT -1 OFFSET 64)").run(current.candidate.entry.candidateDigest, current.worldIdentityDigest);
    } else if (row) throw new Error("CF-053 close found an invalid generation lifecycle state.");
    database.exec("COMMIT;");
  } catch (error) { try { database.exec("ROLLBACK;"); } catch {} throw error; } finally { database.close(); }
  current.closed = true;
  processHandles.delete(handle as object);
}

/** Development-only crash seam: terminates children but deliberately leaves the pending reservation for a fresh launcher to recover. */
export async function simulateCf053DevelopmentLauncherCrash(handle: Cf053ProcessHandle): Promise<void> {
  const current = processHandles.get(handle as object);
  if (!current || current.closed || current.candidate.boundary !== "development") throw new Error("CF-053 launcher-crash simulation is development-only and requires the exact live handle.");
  await Promise.all([waitForExit(current.action), waitForExit(current.observer)]);
  current.closed = true; processHandles.delete(handle as object);
}

export function adoptCf053ProcessGeneration(handle: Cf053ProcessHandle): Cf053LaunchReceipt {
  const current = requireProcesses(handle);
  const database = new DatabaseSync(current.generationDbPath); database.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");
  try {
    const pending = database.prepare("SELECT generation, predecessor_receipt_digest AS predecessorReceiptDigest, status FROM cf053_generations WHERE reservation_id=?").get(current.generationReservationId) as {generation:number;predecessorReceiptDigest:string|null;status:string}|undefined;
    const active = database.prepare("SELECT generation, receipt_digest AS receiptDigest FROM cf053_generations WHERE candidate_digest=? AND world_identity_digest=? AND status='active'").get(current.candidate.entry.candidateDigest,current.worldIdentityDigest) as {generation:number;receiptDigest:string}|undefined;
    const predecessor = database.prepare("SELECT generation, receipt_digest AS receiptDigest FROM cf053_generations WHERE candidate_digest=? AND world_identity_digest=? AND status='retired' ORDER BY generation DESC LIMIT 1").get(current.candidate.entry.candidateDigest,current.worldIdentityDigest) as {generation:number;receiptDigest:string}|undefined;
    if (active) throw new Error("CF-053 refuses to adopt a replacement while its predecessor is still active; close and retire it first.");
    if (!pending || pending.status !== "pending" || pending.generation !== current.receipt.generation || pending.predecessorReceiptDigest !== current.receipt.predecessorReceiptDigest || (predecessor ? (pending.generation !== predecessor.generation + 1 || pending.predecessorReceiptDigest !== predecessor.receiptDigest) : (pending.generation !== 1 || pending.predecessorReceiptDigest !== null))) throw new Error("CF-053 pending process generation lost its exact retired-predecessor CAS.");
    const changed = database.prepare("UPDATE cf053_generations SET status='active', receipt_digest=? WHERE reservation_id=? AND status='pending'").run(current.receipt.receiptDigest,current.generationReservationId);
    if (changed.changes !== 1) throw new Error("CF-053 process generation adoption CAS failed.");
    database.exec("COMMIT;");
  } catch (error) { try { database.exec("ROLLBACK;"); } catch {} current.action.kill("SIGTERM"); current.observer.kill("SIGTERM"); cancelGeneration(current.generationDbPath,current.generationReservationId); throw error; }
  finally { database.close(); }
  return structuredClone(current.receipt);
}

function requireProcesses(handle: Cf053ProcessHandle): ProcessPrivate {
  const current = processHandles.get(handle as object);
  if (!current || current.closed || current.action.exitCode !== null || current.observer.exitCode !== null) throw new Error("CF-053 process handle is forged, cloned, stale, closed or no longer live.");
  const receipt = current.receipt, body = omit(receipt as unknown as Record<string, unknown>, "receiptDigest"), signedBody = omit(body, "signature");
  const key = createPublicKey(current.publicKeyPem);
  if (receipt.receiptDigest !== cf053Digest(body) || bytesDigest(key.export({ type: "spki", format: "der" })) !== receipt.launcherPublicKeyDigest || !verify(null, Buffer.from(canonical(signedBody)), key, Buffer.from(receipt.signature, "base64")) || receipt.action.pid !== current.action.pid || receipt.observer.pid !== current.observer.pid || receipt.action.pid === receipt.observer.pid || receipt.action.endpoint === receipt.observer.endpoint) throw new Error("CF-053 signed launch receipt or live process identity failed.");
  return current;
}

async function processCall(current: ProcessPrivate, plane: "action" | "observer", route: string, payload: unknown): Promise<Record<string, unknown>> {
  const identity = current.receipt[plane], token = plane === "action" ? current.actionToken : current.observerToken;
  const encodedRequest = JSON.stringify(payload);
  if (Buffer.byteLength(encodedRequest) > 65_536) throw new Error("CF-053 process request exceeded its 64 KiB bound.");
  const response = await fetch(new URL(route, identity.endpoint), { method: "POST", redirect: "error", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(encodedRequest)), "x-cf053-process-token": token }, body: encodedRequest, signal: AbortSignal.timeout(2500) });
  return readCf053BoundedResponse(response, plane, route);
}

async function readCf053BoundedResponse(response: Response, plane = "test", route = "/test"): Promise<Record<string, unknown>> {
  const declaredRaw = response.headers.get("content-length");
  if (!declaredRaw || !/^\d{1,6}$/.test(declaredRaw)) throw new Error("CF-053 process response omitted or malformed its bounded content length.");
  const declared = Number(declaredRaw);
  if (declared > 65_536) throw new Error("CF-053 process response exceeded its 64 KiB bound.");
  const chunks: Uint8Array[] = []; let actual = 0;
  if (!response.body) throw new Error("CF-053 process response body is absent.");
  const reader = response.body.getReader();
  while (true) { const next = await reader.read(); if (next.done) break; actual += next.value.byteLength; if (actual > 65_536) { await reader.cancel(); throw new Error("CF-053 streamed process response exceeded its 64 KiB bound."); } chunks.push(next.value); }
  if (actual !== declared) throw new Error("CF-053 process response content length did not match streamed bytes.");
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), text = bytes.toString("utf8");
  if (!response.ok) throw new Error(`CF-053 ${plane} process rejected ${route}: ${text}`);
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { throw new Error("CF-053 process response was not bounded valid JSON."); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || utilTypes.isProxy(parsed)) throw new Error("CF-053 process response must be one plain object.");
  return parsed as Record<string, unknown>;
}

/** Development-only response framing negative-control seam. */
export const readCf053BoundedResponseForDevelopment = (response: Response) => readCf053BoundedResponse(response);

/** Development-only transport negative-control seam. */
export function attemptCf053DevelopmentRawRequest(input: { processes: Cf053ProcessHandle; plane: "action" | "observer"; declaredContentLength?: number; chunks: Buffer[] }): Promise<{ status: number; body: string }> {
  const current = requireProcesses(input.processes);
  if (current.candidate.boundary !== "development") throw new Error("CF-053 raw transport control is development-only.");
  return new Promise((resolvePromise, rejectPromise) => {
    const identity = current.receipt[input.plane], token = input.plane === "action" ? current.actionToken : current.observerToken;
    const headers: Record<string, string> = { "content-type": "application/json", "x-cf053-process-token": token };
    if (input.declaredContentLength !== undefined) headers["content-length"] = String(input.declaredContentLength);
    const request = nodeHttpRequest(new URL("/identity", identity.endpoint), { method: "POST", headers }, (response) => { let body = ""; response.on("data", (chunk) => { body += String(chunk); if (Buffer.byteLength(body) > 65_536) { request.destroy(new Error("CF-053 raw response exceeded bound.")); } }); response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body })); });
    request.setTimeout(2500, () => request.destroy(new Error("CF-053 raw transport control timed out.")));
    request.on("error", rejectPromise); for (const chunk of input.chunks) request.write(chunk); request.end();
  });
}

function rolePayload(binding: NonNullable<Cf053ProviderNeutralContract["executionBinding"]>, roleName: "action" | "no-write-probe" | "reconciliation-readback" | "independent-observer", input: Readonly<Record<string, Primitive>>) {
  const role = binding.roles.find((candidate) => candidate.role === roleName);
  if (!role) throw new Error(`CF-053 reviewed ${roleName} binding is absent.`);
  return { bindingDigest: binding.bindingDigest, bindingRole: roleName, methodDigest: role.methodDigest, input, parameters: Object.fromEntries(role.parameters.map((parameter) => [parameter.parameter, input[parameter.inputKey]])) };
}

function readPath(value: unknown, path: string[]): unknown { let current = value; for (const key of path) { if (current === null || typeof current !== "object" || Array.isArray(current) || !(key in current)) return undefined; current = (current as Record<string, unknown>)[key]; } return current; }
function predicatePass(predicate: NonNullable<Cf053ProviderNeutralContract["executionBinding"]>["predicates"][number], observation: unknown, exactInput: Readonly<Record<string, Primitive>>): boolean { const actual = readPath(observation, predicate.path); if (predicate.operator === "exists") return actual !== undefined; if (predicate.operator === "equals-input") return actual === exactInput[predicate.inputKey!]; if (predicate.operator === "equals-confirmed") return actual === predicate.expected; return Array.isArray(actual) && actual.length === predicate.expected; }

async function freshAggregateObservation(processes: Cf053ProcessHandle, expected: Array<{ stableId: string; exactInputDigest: string }>): Promise<{ passed: true; evidenceDigest: string; totalBusinessWrites: number }> {
  const current = requireProcesses(processes), expectedStableIds = expected.map((item) => item.stableId).sort(), binding = current.candidate.entry.contract.executionBinding!;
  const results = [];
  for (const item of expected) {
    const state = JSON.parse(readFileSync(current.statePath, "utf8")) as { body: { records: Record<string, { input: Record<string, Primitive> }> } }, exactInput = state.body.records[item.stableId]?.input;
    if (!exactInput) throw new Error("CF-053 fresh aggregate observer cannot find the exact durable record input.");
    results.push(await processCall(current, "observer", "/observe", { stableId: item.stableId, exactInputDigest: item.exactInputDigest, expectedStableIds, ...rolePayload(binding, "independent-observer", exactInput) }));
  }
  const passed = results.length === expected.length && results.every((result, index) => result.classification === "completed" && result.stableId === expected[index]!.stableId && result.exactInputDigest === expected[index]!.exactInputDigest && Number(result.matchCount) === 1 && result.collateralClean === true && Number(result.writeCount) === 0 && Number(result.totalBusinessWrites) === expected.length);
  if (!passed) throw new Error(`CF-053 fresh aggregate observer rejected parent completion: ${canonical(results)}`);
  return { passed: true, evidenceDigest: cf053Digest({ expected, results }), totalBusinessWrites: expected.length };
}

export interface Cf053AuthorityReceipt {
  schemaVersion: "1.0";
  candidateDigest: string;
  exactInputDigest: string;
  stableId: string;
  expectedStableIdsDigest: string;
  processGenerationDigest: string;
  parentPlanDigest: string;
  workItemId: string;
  authorityPolicyDigest: string;
  tenantId: string;
  targetAlias: string;
  actionScope: string;
  policyVersion: string;
  issuedAt: string;
  expiresAt: string;
  signerKeyId: string;
  publicKeyPem: string;
  signature: string;
}

export interface Cf053AuthoritySigner {
  readonly signerKeyId: string;
  readonly publicKeyDigest: string;
}

export interface Cf053ValidatedParentPlanHandle {
  readonly parentPlanDigest: string;
  readonly expectedStableIdsDigest: string;
}

interface Cf053ParentPlanPrivate {
  candidateDigest: string;
  boundary: "derived" | "development";
  parentPlanDigest: string;
  expectedStableIds: string[];
  workItems: Map<string, { exactInput: Readonly<Record<string, Primitive>>; exactInputDigest: string; stableId: string }>;
}

const parentPlanHandles = new WeakMap<object, Cf053ParentPlanPrivate>();

function bindParentPlan(input: {
  candidate: Cf053CandidateHandle;
  parentPlanDigest: string;
  workItems: Array<{ workItemId: string; exactInput: unknown }>;
  boundary: "derived" | "development";
}): Cf053ValidatedParentPlanHandle {
  const candidate = candidateHandles.get(input.candidate as object);
  if (!candidate || candidate.boundary !== input.boundary) throw new Error("CF-053 parent plan belongs to the wrong production/development boundary.");
  if (!DIGEST.test(input.parentPlanDigest) || input.workItems.length === 0 || input.workItems.length > 100) throw new Error("CF-053 parent plan identity or bounded work-item set is invalid.");
  const workItems = new Map<string, { exactInput: Readonly<Record<string, Primitive>>; exactInputDigest: string; stableId: string }>();
  for (const item of input.workItems) {
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(item.workItemId) || workItems.has(item.workItemId)) throw new Error("CF-053 parent work-item identity is malformed or duplicated.");
    const exactInput = boundedPrimitiveSnapshot(item.exactInput, candidate.entry.contract.inputSchema);
    const exactInputDigest = cf053Digest(exactInput), stableId = stableIdFor(candidate.entry.contract, exactInput);
    workItems.set(item.workItemId, { exactInput, exactInputDigest, stableId });
  }
  const expectedStableIds = [...new Set([...workItems.values()].map((item) => item.stableId))].sort();
  if (expectedStableIds.length !== workItems.size) throw new Error("CF-053 parent plan contains conflicting work items with the same stable identity.");
  const estimatedRecords = Object.fromEntries([...workItems.values()].map((item, index) => [item.stableId, { stableId: item.stableId, exactInputDigest: item.exactInputDigest, input: item.exactInput, version: index + 1, updatedAt: "9999-12-31T23:59:59.999Z" }]));
  const worstCaseWorld = { schemaVersion: "1.0", candidateDigest: candidate.entry.candidateDigest, contractDigest: candidate.entry.contract.contractDigest, worldIdentityDigest: "f".repeat(64), parentPlanDigest: input.parentPlanDigest, expectedStableIdsDigest: cf053Digest(expectedStableIds), sequence: workItems.size, writes: workItems.size, serverTimestamp: "9999-12-31T23:59:59.999Z", records: estimatedRecords };
  const worstCaseEncodedBytes = Buffer.byteLength(JSON.stringify({ body: worstCaseWorld, stateDigest: cf053Digest(worstCaseWorld) })) + 4096;
  if (worstCaseEncodedBytes > 1_048_576) throw new Error("CF-053 parent plan cannot be admitted because its worst-case durable world exceeds 1 MiB.");
  const handle = Object.freeze({ parentPlanDigest: input.parentPlanDigest, expectedStableIdsDigest: cf053Digest(expectedStableIds) });
  parentPlanHandles.set(handle, { candidateDigest: candidate.entry.candidateDigest, boundary: input.boundary, parentPlanDigest: input.parentPlanDigest, expectedStableIds, workItems });
  return handle;
}

function bindCf053ValidatedParentPlan(input: { candidate: Cf053CandidateHandle; plan: ValidatedGoalPlan; exactInputsByWorkItem: Readonly<Record<string, unknown>> }): Cf053ValidatedParentPlanHandle {
  const planIds = input.plan.workItems.map((item) => item.workItemId).sort();
  const suppliedIds = Object.keys(input.exactInputsByWorkItem).sort();
  if (canonical(planIds) !== canonical(suppliedIds)) throw new Error("CF-053 production parent binding must cover the exact validated-plan work-item set.");
  return bindParentPlan({ candidate: input.candidate, parentPlanDigest: goalPlanDigest(input.plan), workItems: input.plan.workItems.map((item) => ({ workItemId: item.workItemId, exactInput: input.exactInputsByWorkItem[item.workItemId] })), boundary: "derived" });
}

/** Explicitly author-known development only; production authority and execution reject it. */
export function bindCf053DevelopmentParentPlan(input: { candidate: Cf053CandidateHandle; parentPlanDigest: string; workItems: Array<{ workItemId: string; exactInput: unknown }> }): Cf053ValidatedParentPlanHandle {
  return bindParentPlan({ ...input, boundary: "development" });
}

/** Development-only admission seam for verifying worst-case durable-world bounds without execution. */
export function checkCf053DevelopmentPlanAdmission(input: { candidate: Cf053CandidateHandle; workItems: Array<{ workItemId: string; exactInput: unknown }> }): true {
  bindCf053DevelopmentParentPlan({ candidate: input.candidate, parentPlanDigest: cf053Digest({ admission: true, count: input.workItems.length }), workItems: input.workItems });
  return true;
}

const authoritySigners = new WeakMap<object, { privateKey: KeyObject; publicKeyPem: string }>();

export function createCf053AuthoritySigner(signerKeyId: string): Cf053AuthoritySigner {
  if (!IDENTIFIER.test(signerKeyId)) throw new Error("CF-053 signer key ID is invalid.");
  const keys = generateKeyPairSync("ed25519"), publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signer = Object.freeze({ signerKeyId, publicKeyDigest: bytesDigest(keys.publicKey.export({ type: "spki", format: "der" })) });
  authoritySigners.set(signer, { privateKey: keys.privateKey, publicKeyPem });
  return signer;
}

export function deriveCf053StableIdentity(contract: Cf053ProviderNeutralContract, exactInput: unknown): { stableId: string; typedComponents: Array<{ key: string; type: PrimitiveType; valueDigest: string }>; typedIdentityDigest: string } {
  assertCf053Contract(contract);
  const input = boundedPrimitiveSnapshot(exactInput, contract.inputSchema);
  const typedComponents = contract.stableIdentityKeys.map((key) => ({ key, type: contract.inputSchema.find((field) => field.key === key)!.type, valueDigest: cf053Digest({ type: typeof input[key], value: input[key] }) }));
  const typedIdentityDigest = cf053Digest(typedComponents);
  return { stableId: cf053Digest({ contractDigest: contract.contractDigest, typedIdentityDigest }), typedComponents, typedIdentityDigest };
}

function stableIdFor(contract: Cf053ProviderNeutralContract, input: Readonly<Record<string, Primitive>>): string {
  return deriveCf053StableIdentity(contract, input).stableId;
}

const developmentAuthorityContexts = new WeakMap<object, { parentPlan: Cf053ValidatedParentPlanHandle; workItemId: string; exactInput: unknown; expectedStableIds: string[] }>();

function issueCf053AuthorityForBoundPlan(input: { signer: Cf053AuthoritySigner; candidate: Cf053CandidateHandle; parentPlan: Cf053ValidatedParentPlanHandle; workItemId: string; issuedAt: string; expiresAt: string; processGenerationDigest: string; authorityPolicyDigest: string }): Cf053AuthorityReceipt {
  const signer = authoritySigners.get(input.signer as object), candidate = candidateHandles.get(input.candidate as object);
  if (!signer || !candidate) throw new Error("CF-053 authority signer or candidate handle is forged/cloned.");
  const plan = parentPlanHandles.get(input.parentPlan as object), item = plan?.workItems.get(input.workItemId);
  if (!plan || !item || plan.candidateDigest !== candidate.entry.candidateDigest || plan.boundary !== candidate.boundary || input.parentPlan.parentPlanDigest !== plan.parentPlanDigest || input.parentPlan.expectedStableIdsDigest !== cf053Digest(plan.expectedStableIds)) throw new Error("CF-053 authority requires the exact opaque candidate-bound parent-plan work item.");
  if (!DIGEST.test(input.processGenerationDigest) || !DIGEST.test(input.authorityPolicyDigest)) throw new Error("CF-053 authority requires exact process-generation and policy digests.");
  if (Date.parse(input.issuedAt) <= 0 || Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)) throw new Error("CF-053 authority validity window is invalid.");
  const body = {
    schemaVersion: "1.0" as const,
    candidateDigest: candidate.entry.candidateDigest,
    exactInputDigest: item.exactInputDigest,
    stableId: item.stableId,
    expectedStableIdsDigest: input.parentPlan.expectedStableIdsDigest,
    processGenerationDigest: input.processGenerationDigest,
    parentPlanDigest: plan.parentPlanDigest,
    workItemId: input.workItemId,
    authorityPolicyDigest: input.authorityPolicyDigest,
    tenantId: candidate.entry.contract.tenantId,
    targetAlias: candidate.entry.contract.targetAlias,
    actionScope: candidate.entry.contract.actionScope,
    policyVersion: candidate.entry.contract.policyVersion,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    signerKeyId: input.signer.signerKeyId,
    publicKeyPem: signer.publicKeyPem,
  };
  return Object.freeze({ ...body, signature: sign(null, Buffer.from(canonical(body)), signer.privateKey).toString("base64") });
}

/** Explicitly author-known development only. Production uses the opaque production broker. */
export function issueCf053DevelopmentAuthority(input: { signer: Cf053AuthoritySigner; candidate: Cf053CandidateHandle; exactInput: unknown; expectedStableIds: string[]; issuedAt: string; expiresAt: string }): Cf053AuthorityReceipt {
  const candidate = candidateHandles.get(input.candidate as object);
  if (!candidate || candidate.boundary !== "development") throw new Error("CF-053 development authority requires a development candidate.");
  const exact = boundedPrimitiveSnapshot(input.exactInput, candidate.entry.contract.inputSchema), stableId = stableIdFor(candidate.entry.contract, exact), expectedStableIds = [...new Set(input.expectedStableIds)].sort();
  if (!expectedStableIds.includes(stableId) || expectedStableIds.some((id) => !DIGEST.test(id))) throw new Error("CF-053 development authority expected stable-ID set is incomplete or malformed.");
  const syntheticInputs = expectedStableIds.map((id, index) => id === stableId ? exact : boundedPrimitiveSnapshot({ ...exact, [candidate.entry.contract.stableIdentityKeys[0]!]: `development-placeholder-${index}` }, candidate.entry.contract.inputSchema));
  const actualIds = syntheticInputs.map((item) => stableIdFor(candidate.entry.contract, item));
  if (canonical(actualIds.sort()) !== canonical(expectedStableIds)) {
    if (expectedStableIds.length !== 1) throw new Error("CF-053 development multi-item authority must use an explicit bound parent plan.");
  }
  const workItemId = "development_item", parentPlan = bindCf053DevelopmentParentPlan({ candidate: input.candidate, parentPlanDigest: cf053Digest({ development: true, expectedStableIds }), workItems: [{ workItemId, exactInput: exact }] });
  const receipt = issueCf053AuthorityForBoundPlan({ signer: input.signer, candidate: input.candidate, parentPlan, workItemId, issuedAt: input.issuedAt, expiresAt: input.expiresAt, processGenerationDigest: cf053Digest({ development: true }), authorityPolicyDigest: cf053Digest({ developmentPolicy: true }) });
  developmentAuthorityContexts.set(receipt, { parentPlan, workItemId, exactInput: exact, expectedStableIds });
  return receipt;
}

interface TrustedWorkspaceStorePrivate { databasePath: string; candidateDigest: string; privateKey: KeyObject; publicKeyPem: string; publicKeyDigest: string }
const trustedWorkspaceStores = new WeakMap<object, TrustedWorkspaceStorePrivate>();
const trustedWorkspaceConstructionToken = Object.freeze({ cf053: true });
const CF053_WORKSPACE_TRUST_ROOT_FILE = "cf053-workspace-trust-root.json";

function provisionCf053WorkspaceIssuer(input: { rootDirectory: string; authorityContextDigest: string }): { publicKeyDigest: string } {
  if (!DIGEST.test(input.authorityContextDigest)) throw new Error("CF-053 workspace issuer requires an exact trusted planning authority context.");
  const rootDirectory = resolve(input.rootDirectory); mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  const rootPath = join(rootDirectory, CF053_WORKSPACE_TRUST_ROOT_FILE);
  if (existsSync(rootPath)) {
    assertRegularBoundedFile(rootPath, 32_768, "pre-runtime workspace trust root");
    const root = JSON.parse(readFileSync(rootPath, "utf8")) as { schemaVersion: string; authorityContextDigest: string; privateKeyPem: string; publicKeyPem: string; publicKeyDigest: string; rootDigest: string }, { rootDigest, ...body } = root;
    const publicKeyDigest = bytesDigest(createPublicKey(root.publicKeyPem).export({ type: "spki", format: "der" }));
    if (root.schemaVersion !== "1.0" || root.authorityContextDigest !== input.authorityContextDigest || rootDigest !== cf053Digest(body) || root.publicKeyDigest !== publicKeyDigest) throw new Error("CF-053 pre-existing workspace issuer does not match the exact trusted planning context.");
    return { publicKeyDigest };
  }
  const keys = generateKeyPairSync("ed25519"), publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString(), publicKeyDigest = bytesDigest(keys.publicKey.export({ type: "spki", format: "der" }));
  const body = { schemaVersion: "1.0", authorityContextDigest: input.authorityContextDigest, privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem, publicKeyDigest };
  const descriptor = openSync(rootPath, "wx", 0o600); try { writeFileSync(descriptor, `${JSON.stringify({ ...body, rootDigest: cf053Digest(body) })}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); } fsyncDirectory(rootDirectory);
  return { publicKeyDigest };
}

export class Cf053TrustedWorkspaceInputStore {
  constructor(databasePath: string, candidateDigest: string, token: object) {
    if (token !== trustedWorkspaceConstructionToken || !DIGEST.test(candidateDigest)) throw new Error("CF-053 trusted workspace stores can only be opened through the candidate-bound workspace issuer.");
    const path = resolve(databasePath); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) assertRegularBoundedFile(path, 32 * 1024 * 1024, "trusted workspace input database");
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS cf053_trusted_plan_inputs (plan_digest TEXT NOT NULL, work_item_id TEXT NOT NULL, input_json TEXT NOT NULL, input_digest TEXT NOT NULL, public_key_pem TEXT, signature TEXT, PRIMARY KEY(plan_digest,work_item_id));");
    const columns = database.prepare("PRAGMA table_info(cf053_trusted_plan_inputs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "public_key_pem")) database.exec("ALTER TABLE cf053_trusted_plan_inputs ADD COLUMN public_key_pem TEXT;");
    if (!columns.some((column) => column.name === "signature")) database.exec("ALTER TABLE cf053_trusted_plan_inputs ADD COLUMN signature TEXT;");
    database.close();
    const rootPath = join(dirname(path), CF053_WORKSPACE_TRUST_ROOT_FILE);
    if (!existsSync(rootPath)) throw new Error("CF-053 runtime cannot mint trust; the exact workspace issuer must pre-exist from trusted planning.");
    assertRegularBoundedFile(rootPath, 32_768, "pre-existing workspace trust root");
    const root = JSON.parse(readFileSync(rootPath, "utf8")) as { schemaVersion: string; authorityContextDigest: string; privateKeyPem: string; publicKeyPem: string; publicKeyDigest: string; rootDigest: string }, { rootDigest, ...body } = root;
    if (root.schemaVersion !== "1.0" || !DIGEST.test(root.authorityContextDigest) || rootDigest !== cf053Digest(body)) throw new Error("CF-053 durable trusted workspace root identity failed.");
    const privateKey = createPrivateKey(root.privateKeyPem), publicKeyPem = root.publicKeyPem, publicKeyDigest = bytesDigest(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }));
    if (publicKeyDigest !== root.publicKeyDigest) throw new Error("CF-053 durable trusted workspace public key was substituted.");
    trustedWorkspaceStores.set(this, { databasePath: path, candidateDigest, privateKey, publicKeyPem, publicKeyDigest }); Object.freeze(this);
  }
  save(plan: ValidatedGoalPlan, exactInputsByWorkItem: Readonly<Record<string, unknown>>): void {
    const state = trustedWorkspaceStores.get(this); if (!state) throw new Error("CF-053 trusted workspace store is forged.");
    const ids = plan.workItems.map((item) => item.workItemId).sort(); if (ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length || canonical(ids) !== canonical(Object.keys(exactInputsByWorkItem).sort())) throw new Error("CF-053 trusted workspace inputs must cover one to one hundred distinct exact validated-plan work items.");
    const database = new DatabaseSync(state.databasePath); database.exec("BEGIN IMMEDIATE;");
    try { for (const id of ids) { const json = canonical(exactInputsByWorkItem[id]); if (Buffer.byteLength(json) > 16_384) throw new Error("CF-053 trusted workspace input exceeds its bound."); const planDigest = goalPlanDigest(plan), inputDigest = cf053Digest(JSON.parse(json)), signedBody = { planDigest, workItemId: id, inputDigest, inputJsonDigest: bytesDigest(json), publicKeyDigest: state.publicKeyDigest }, signature = sign(null, Buffer.from(canonical(signedBody)), state.privateKey).toString("base64"); database.prepare("INSERT INTO cf053_trusted_plan_inputs(plan_digest,work_item_id,input_json,input_digest,public_key_pem,signature) VALUES(?,?,?,?,?,?)").run(planDigest,id,json,inputDigest,state.publicKeyPem,signature); } database.exec("COMMIT;"); } catch(error){try{database.exec("ROLLBACK;")}catch{}throw error} finally{database.close()}
  }
}

export function openCf053TrustedWorkspaceInputStore(input: { candidate: Cf053CandidateHandle; rootDirectory: string }): Cf053TrustedWorkspaceInputStore {
  const candidate = candidateHandles.get(input.candidate as object);
  if (!candidate || candidate.boundary !== "derived") throw new Error("CF-053 trusted workspace issuance requires the exact opaque production-derived candidate.");
  const store = new Cf053TrustedWorkspaceInputStore(join(resolve(input.rootDirectory), "trusted-inputs.sqlite"), candidate.entry.candidateDigest, trustedWorkspaceConstructionToken);
  const state = trustedWorkspaceStores.get(store)!;
  if (state.publicKeyDigest !== candidate.entry.contract.workspaceIssuerPublicKeyDigest) throw new Error("CF-053 runtime workspace issuer is not the immutable issuer anchored by trusted derivation.");
  const pinPath = join(candidate.candidateDirectory, "workspace-trust-pin.json");
  if (existsSync(pinPath)) {
    assertRegularBoundedFile(pinPath, 4_096, "workspace trust pin");
    const pin = JSON.parse(readFileSync(pinPath, "utf8")) as { schemaVersion: string; candidateDigest: string; publicKeyDigest: string; pinDigest: string }, { pinDigest, ...body } = pin;
    if (pin.schemaVersion !== "1.0" || pin.candidateDigest !== candidate.entry.candidateDigest || !DIGEST.test(pin.publicKeyDigest) || pinDigest !== cf053Digest(body) || pin.publicKeyDigest !== state.publicKeyDigest) throw new Error("CF-053 candidate is durably pinned to a different trusted workspace issuer.");
  } else {
    const body = { schemaVersion: "1.0", candidateDigest: candidate.entry.candidateDigest, publicKeyDigest: state.publicKeyDigest }, descriptor = openSync(pinPath, "wx", 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify({ ...body, pinDigest: cf053Digest(body) })}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); } fsyncDirectory(candidate.candidateDirectory);
  }
  if (candidate.trustedWorkspacePublicKeyDigest && candidate.trustedWorkspacePublicKeyDigest !== state.publicKeyDigest) throw new Error("CF-053 candidate is already pinned to a different trusted workspace issuer.");
  candidate.trustedWorkspacePublicKeyDigest = state.publicKeyDigest;
  return store;
}

function readTrustedWorkspaceInputs(store: Cf053TrustedWorkspaceInputStore, plan: ValidatedGoalPlan): Record<string, unknown> {
  const state = trustedWorkspaceStores.get(store); if (!state) throw new Error("CF-053 production broker requires the exact module-owned trusted workspace store.");
  const planDigest = goalPlanDigest(plan), database = new DatabaseSync(state.databasePath,{readOnly:true}), rows = database.prepare("SELECT work_item_id AS workItemId,input_json AS inputJson,input_digest AS inputDigest,public_key_pem AS publicKeyPem,signature FROM cf053_trusted_plan_inputs WHERE plan_digest=? ORDER BY work_item_id").all(planDigest) as Array<{workItemId:string;inputJson:string;inputDigest:string;publicKeyPem:string|null;signature:string|null}>; database.close();
  if (rows.length !== plan.workItems.length) throw new Error("CF-053 trusted workspace source is incomplete for the exact plan.");
  const result: Record<string,unknown> = {}; for(const row of rows){if(Buffer.byteLength(row.inputJson)>16_384)throw new Error("CF-053 trusted workspace input exceeds its bound.");const value=JSON.parse(row.inputJson), key = row.publicKeyPem ? createPublicKey(row.publicKeyPem) : null, keyDigest = key ? bytesDigest(key.export({type:"spki",format:"der"})) : "", signedBody = { planDigest, workItemId: row.workItemId, inputDigest: row.inputDigest, inputJsonDigest: bytesDigest(row.inputJson), publicKeyDigest: keyDigest };if(row.inputDigest!==cf053Digest(value)||result[row.workItemId]!==undefined||row.publicKeyPem!==state.publicKeyPem||keyDigest!==state.publicKeyDigest||!row.signature||!key||!verify(null,Buffer.from(canonical(signedBody)),key,Buffer.from(row.signature,"base64")))throw new Error("CF-053 trusted workspace input identity or module signature failed.");result[row.workItemId]=value} return result;
}

export interface Cf053ProductionAuthorityPolicy {
  policyVersion: string;
  allowedTargetAliases: string[];
  allowedActions: string[];
  allowedMethods: string[];
  maximumItems: number;
  maximumWritesPerItem: 1;
  maximumNumericValues?: Readonly<Record<string, number>>;
  grantTtlSeconds: number;
}

export interface Cf053ProductionAuthorityGrantHandle {
  readonly grantDigest: string;
}

interface ProductionBrokerPrivate {
  candidate: Cf053CandidateHandle;
  signer: Cf053AuthoritySigner;
  parentPlan: Cf053ValidatedParentPlanHandle;
  plan: ValidatedGoalPlan;
  policy: Cf053ProductionAuthorityPolicy;
  completedWorkItems: Map<string, string>;
}

interface ProductionGrantPrivate {
  broker: Cf053ProductionAuthorityBroker;
  candidate: Cf053CandidateHandle;
  signer: Cf053AuthoritySigner;
  parentPlan: Cf053ValidatedParentPlanHandle;
  workItemId: string;
  authority: Cf053AuthorityReceipt;
  now: string;
  processGenerationDigest: string;
  authorityPolicyDigest: string;
}

const productionBrokers = new WeakMap<object, ProductionBrokerPrivate>();
const productionGrants = new WeakMap<object, ProductionGrantPrivate>();

export class Cf053ProductionAuthorityBroker {
  constructor(input: {
    candidate: Cf053CandidateHandle;
    proposal: GoalPlanProposal;
    scope: TrustedGoalScope;
    savedValidatedPlan: ValidatedGoalPlan;
    trustedWorkspaceInputs: Cf053TrustedWorkspaceInputStore;
    policy: Cf053ProductionAuthorityPolicy;
  }) {
    const candidate = candidateHandles.get(input.candidate as object);
    if (!candidate || candidate.boundary !== "derived") throw new Error("CF-053 production authority broker requires an exact derived candidate.");
    const trustedState = trustedWorkspaceStores.get(input.trustedWorkspaceInputs as object);
    if (!trustedState || trustedState.candidateDigest !== candidate.entry.candidateDigest || candidate.trustedWorkspacePublicKeyDigest !== trustedState.publicKeyDigest) throw new Error("CF-053 production authority broker requires the exact candidate-pinned trusted workspace issuer.");
    const rerun = validateGoalPlan(structuredClone(input.proposal), structuredClone(input.scope));
    if (rerun.status !== "validated" || canonical(rerun.plan) !== canonical(input.savedValidatedPlan)) throw new Error("CF-053 production broker rejected a stale, substituted or non-reproducible validated plan.");
    if (rerun.plan.tenantId !== candidate.entry.contract.tenantId) throw new Error("CF-053 production plan tenant does not match the derived candidate tenant.");
    const policy = structuredClone(input.policy);
    if (policy.policyVersion !== candidate.entry.contract.policyVersion || canonical([...policy.allowedTargetAliases].sort()) !== canonical([candidate.entry.contract.targetAlias]) || policy.maximumWritesPerItem !== 1 || !Number.isInteger(policy.maximumItems) || policy.maximumItems < 1 || policy.maximumItems > 100 || rerun.plan.workItems.length > policy.maximumItems || !Number.isInteger(policy.grantTtlSeconds) || policy.grantTtlSeconds < 1 || policy.grantTtlSeconds > 300) throw new Error("CF-053 production authority policy is malformed or wider/narrower than the exact candidate and bounded plan.");
    const allowedActions = new Set(policy.allowedActions), allowedMethods = new Set(policy.allowedMethods), allowedTargets = new Set(policy.allowedTargetAliases);
    const requiredActions = [...new Set(rerun.plan.workItems.flatMap((item) => item.requiredActions))].sort(), requiredMethods = [...new Set(rerun.plan.workItems.flatMap((item) => item.authority.methods))].sort(), requiredTargets = [...new Set(rerun.plan.workItems.flatMap((item) => item.targetAliases))].sort();
    if (allowedActions.size !== policy.allowedActions.length || allowedMethods.size !== policy.allowedMethods.length || allowedTargets.size !== policy.allowedTargetAliases.length || canonical([...allowedActions].sort()) !== canonical(requiredActions) || canonical([...allowedMethods].sort()) !== canonical(requiredMethods) || canonical([...allowedTargets].sort()) !== canonical(requiredTargets)) throw new Error("CF-053 production authority policy must exactly match the validated plan target/action/method sets without extra authority.");
    const reviewedBinding = candidate.entry.contract.executionBinding!, reviewedAction = reviewedBinding.roles.find((role) => role.role === "action")!, reviewedObserver = reviewedBinding.roles.find((role) => role.role === "independent-observer")!, exactInputsByWorkItem = readTrustedWorkspaceInputs(input.trustedWorkspaceInputs, rerun.plan);
    const actionMethod = candidate.entry.contract.actionScope.split(/\s+/, 1)[0]!, observerMethod = candidate.entry.contract.observerScope.split(/\s+/, 1)[0]!;
    if (!/^[A-Z]+$/.test(actionMethod) || !/^[A-Z]+$/.test(observerMethod) || actionMethod === observerMethod || reviewedAction.methodName === reviewedObserver.methodName) throw new Error("CF-053 reviewed action and observer scopes or method identities are not independently distinguishable.");
    for (const workItem of rerun.plan.workItems) {
      if (!workItem.authority.currentlyAuthorized || workItem.authority.missing.length > 0 || workItem.targetAliases.some((target) => !allowedTargets.has(target)) || workItem.requiredActions.some((action) => !allowedActions.has(action)) || workItem.authority.methods.some((method) => !allowedMethods.has(method)) || canonical(workItem.requiredActions.slice().sort()) !== canonical([reviewedAction.methodName, reviewedObserver.methodName].sort()) || workItem.completionCriteria.length !== 1 || workItem.completionCriteria[0]!.verifierKey !== reviewedObserver.methodName || canonical(workItem.authority.methods.slice().sort()) !== canonical([actionMethod, observerMethod].sort())) throw new Error("CF-053 production work item does not exactly bind the reviewed action, observer, completion and single-write semantics.");
      const exact = boundedPrimitiveSnapshot(exactInputsByWorkItem[workItem.workItemId], candidate.entry.contract.inputSchema);
      for (const [key, ceiling] of Object.entries(policy.maximumNumericValues ?? {})) {
        if (!Number.isFinite(ceiling) || ceiling < 0 || typeof exact[key] !== "number" || (exact[key] as number) > ceiling) throw new Error("CF-053 production numeric authority limit is malformed or exceeded.");
      }
      exactInputsByWorkItem[workItem.workItemId] = exact;
    }
    const parentPlan = bindCf053ValidatedParentPlan({ candidate: input.candidate, plan: rerun.plan, exactInputsByWorkItem });
    const signer = createCf053AuthoritySigner(`cf053_production_${randomUUID().replace(/-/g, "")}`);
    productionBrokers.set(this, { candidate: input.candidate, signer, parentPlan, plan: structuredClone(rerun.plan), policy, completedWorkItems: new Map() });
    Object.freeze(this);
  }

  issueGrant(processes: Cf053ProcessHandle, workItemId: string): Cf053ProductionAuthorityGrantHandle {
    const broker = productionBrokers.get(this), current = processHandles.get(processes as object);
    if (!broker || !current || current.closed || current.candidate.boundary !== "derived" || current.candidate.entry.candidateDigest !== broker.candidate.candidateDigest) throw new Error("CF-053 production broker/process binding is forged, stale or cross-candidate.");
    const workItem = broker.plan.workItems.find((item) => item.workItemId === workItemId);
    if (!workItem) throw new Error("CF-053 production grant work item is outside the exact validated plan.");
    if (workItem.dependencyWorkItemIds.some((dependencyId) => !broker.completedWorkItems.has(dependencyId))) throw new Error("CF-053 production authority refuses a dependent work item until every exact prerequisite has accepted completion evidence.");
    const adopted = readActiveGeneration(current.generationDbPath, current.candidate.entry.candidateDigest, current.worldIdentityDigest);
    if (!adopted || adopted.receiptDigest !== current.receipt.receiptDigest || adopted.generation !== current.receipt.generation) throw new Error("CF-053 production grant requires the exact active adopted process generation.");
    const now = new Date().toISOString(), expiresAt = new Date(Date.parse(now) + broker.policy.grantTtlSeconds * 1000).toISOString();
    if (!Number.isFinite(Date.parse(now))) throw new Error("CF-053 production authority clock returned an invalid timestamp.");
    const authorityPolicyDigest = cf053Digest(broker.policy);
    const authority = issueCf053AuthorityForBoundPlan({ signer: broker.signer, candidate: broker.candidate, parentPlan: broker.parentPlan, workItemId, issuedAt: now, expiresAt, processGenerationDigest: current.receipt.receiptDigest, authorityPolicyDigest });
    const handle = Object.freeze({ grantDigest: cf053Digest({ authority, workItemId, processGenerationDigest: current.receipt.receiptDigest }) });
    productionGrants.set(handle, { broker: this, candidate: broker.candidate, signer: broker.signer, parentPlan: broker.parentPlan, workItemId, authority, now, processGenerationDigest: current.receipt.receiptDigest, authorityPolicyDigest });
    return handle;
  }
}

export async function launchCf053ProviderProcesses(input: { candidate: Cf053CandidateHandle; authorityBroker: Cf053ProductionAuthorityBroker; worldRoot: string }): Promise<Cf053ProcessHandle> {
  const broker = productionBrokers.get(input.authorityBroker), candidate = candidateHandles.get(input.candidate as object);
  if (!broker || !candidate || candidate.boundary !== "derived" || broker.candidate.candidateDigest !== input.candidate.candidateDigest) throw new Error("CF-053 production launch requires the exact candidate-bound opaque authority broker.");
  return launchCf053ProcessesInternal({ candidate: input.candidate, authoritySigner: broker.signer, parentPlan: broker.parentPlan, worldRoot: input.worldRoot, boundary: "derived" });
}

function assertAuthority(receipt: Cf053AuthorityReceipt, expected: { candidate: CandidatePrivate; inputDigest: string; stableId: string; expectedStableIdsDigest: string; processGenerationDigest: string; parentPlanDigest: string; workItemId: string; authorityPolicyDigest: string; now: string; signer: Cf053AuthoritySigner }): void {
  const signer = authoritySigners.get(expected.signer as object);
  if (!signer || receipt.signerKeyId !== expected.signer.signerKeyId || receipt.publicKeyPem !== signer.publicKeyPem || bytesDigest(createPublicKey(receipt.publicKeyPem).export({ type: "spki", format: "der" })) !== expected.signer.publicKeyDigest) throw new Error("CF-053 authority signer identity was substituted.");
  const { signature, ...body } = receipt, contract = expected.candidate.entry.contract;
  if (body.schemaVersion !== "1.0" || body.candidateDigest !== expected.candidate.entry.candidateDigest || body.exactInputDigest !== expected.inputDigest || body.stableId !== expected.stableId || body.expectedStableIdsDigest !== expected.expectedStableIdsDigest || body.processGenerationDigest !== expected.processGenerationDigest || body.parentPlanDigest !== expected.parentPlanDigest || body.workItemId !== expected.workItemId || body.authorityPolicyDigest !== expected.authorityPolicyDigest || body.tenantId !== contract.tenantId || body.targetAlias !== contract.targetAlias || body.actionScope !== contract.actionScope || body.policyVersion !== contract.policyVersion || Date.parse(body.issuedAt) > Date.parse(expected.now) || Date.parse(body.expiresAt) <= Date.parse(expected.now) || !verify(null, Buffer.from(canonical(body)), createPublicKey(receipt.publicKeyPem), Buffer.from(signature, "base64"))) throw new Error("CF-053 authority is expired, cross-input, cross-contract, cross-generation, cross-plan, cross-policy or invalidly signed.");
}

export interface Cf053ExecutionReceipt {
  candidateSource: "built" | "retained";
  candidateDigest: string;
  launchReceiptDigest: string;
  generation: number;
  stableId: string;
  exactInputDigest: string;
  reconciliationBeforeAction: "completed" | "not-started";
  actionStatus: "committed" | "already-exists";
  intendedWrites: 0 | 1;
  totalBusinessWrites: number;
  outcome: "completed";
  fresh: true;
  collateralClean: true;
  observerWrites: 0;
  evidenceDigest: string;
}

async function executeCf053TransferInternal(input: { processes: Cf053ProcessHandle; candidate: Cf053CandidateHandle; authoritySigner: Cf053AuthoritySigner; authority: Cf053AuthorityReceipt; parentPlan: Cf053ValidatedParentPlanHandle; workItemId: string; authorityPolicyDigest: string; now: string; boundary: "derived" | "development" }): Promise<Cf053ExecutionReceipt> {
  const current = requireProcesses(input.processes), candidate = candidateHandles.get(input.candidate as object);
  if (!candidate || candidate.boundary !== input.boundary || candidate.entry.candidateDigest !== current.candidate.entry.candidateDigest || input.candidate.candidateDigest !== current.candidate.entry.candidateDigest) throw new Error("CF-053 execution candidate/process binding is stale, substituted or belongs to the wrong production/development boundary.");
  const adopted = readActiveGeneration(current.generationDbPath, current.candidate.entry.candidateDigest, current.worldIdentityDigest);
  if (!adopted || adopted.receiptDigest !== current.receipt.receiptDigest || adopted.generation !== current.receipt.generation) throw new Error("CF-053 process generation must be explicitly adopted before use.");
  const plan = parentPlanHandles.get(input.parentPlan as object), item = plan?.workItems.get(input.workItemId);
  if (!plan || !item || plan.boundary !== input.boundary || plan.candidateDigest !== candidate.entry.candidateDigest || input.parentPlan.parentPlanDigest !== plan.parentPlanDigest || input.parentPlan.expectedStableIdsDigest !== cf053Digest(plan.expectedStableIds)) throw new Error("CF-053 execution requires the exact opaque candidate-bound parent-plan work item.");
  const snapshot = item.exactInput, exactInputDigest = item.exactInputDigest, stableId = item.stableId;
  const expectedStableIds = plan.expectedStableIds, expectedStableIdsDigest = input.parentPlan.expectedStableIdsDigest;
  const processGenerationDigest = input.boundary === "derived" ? current.receipt.receiptDigest : cf053Digest({ development: true });
  assertAuthority(input.authority, { candidate, inputDigest: exactInputDigest, stableId, expectedStableIdsDigest, processGenerationDigest, parentPlanDigest: plan.parentPlanDigest, workItemId: input.workItemId, authorityPolicyDigest: input.authorityPolicyDigest, now: input.now, signer: input.authoritySigner });
  const operationStartedAt = new Date().toISOString();
  const binding = candidate.entry.contract.executionBinding!;
  const probe = await processCall(current, "action", "/probe", { stableId, ...rolePayload(binding, "no-write-probe", snapshot) });
  if (probe.reachable !== true || Number(probe.writeCount) !== 0) throw new Error("CF-053 reviewed no-write probe failed or wrote state.");
  const reconciliation = await processCall(current, "action", "/reconcile", { stableId, ...rolePayload(binding, "reconciliation-readback", snapshot) });
  if (!['completed','not-started'].includes(String(reconciliation.classification)) || Number(reconciliation.writeCount) !== 0 || (reconciliation.classification === "completed" && reconciliation.exactInputDigest !== exactInputDigest)) throw new Error("CF-053 reconciliation was duplicate, conflicting or unknown; action is blocked.");
  const action = await processCall(current, "action", "/action", { stableId, exactInputDigest, authority: input.authority, expected: { candidateDigest: candidate.entry.candidateDigest, exactInputDigest, stableId, expectedStableIdsDigest, processGenerationDigest, parentPlanDigest: plan.parentPlanDigest, workItemId: input.workItemId, authorityPolicyDigest: input.authorityPolicyDigest, tenantId: candidate.entry.contract.tenantId, targetAlias: candidate.entry.contract.targetAlias, actionScope: candidate.entry.contract.actionScope, policyVersion: candidate.entry.contract.policyVersion }, ...rolePayload(binding, "action", snapshot) });
  const postActionReconciliation = await processCall(current, "action", "/reconcile", { stableId, ...rolePayload(binding, "reconciliation-readback", snapshot) });
  const observation = await processCall(current, "observer", "/observe", { stableId, exactInputDigest, expectedStableIds, ...rolePayload(binding, "independent-observer", snapshot) });
  const observedAt = Date.parse(String(observation.observedAt)), observationClock = Date.parse(String(observation.observationClock)), startedAt = Date.parse(operationStartedAt);
  const fresh = Number.isFinite(observedAt) && Number.isFinite(observationClock) && observedAt <= observationClock && observationClock - observedAt <= candidate.entry.contract.maximumAgeSeconds * 1000 && (reconciliation.classification === "completed" || observedAt >= startedAt);
  const exactOutcome = binding.predicates.every((predicate) => predicatePass(predicate, observation, snapshot));
  const duplicateClean = Array.isArray(readPath(observation, binding.duplicatePath)) && (readPath(observation, binding.duplicatePath) as unknown[]).length === 1;
  const collateralClean = binding.collateralPredicates.every((predicate) => predicatePass(predicate, observation, snapshot));
  const freshnessValue = readPath(observation, binding.freshnessPath);
  if (freshnessValue !== observation.observedAt || !['committed','already-exists'].includes(String(action.status)) || postActionReconciliation.classification !== "completed" || postActionReconciliation.exactInputDigest !== exactInputDigest || observation.classification !== "completed" || observation.exactInputDigest !== exactInputDigest || observation.stableId !== stableId || Number(observation.matchCount) !== 1 || Number(observation.writeCount) !== 0 || !exactOutcome || !duplicateClean || !collateralClean || !fresh || action.committedVersion !== postActionReconciliation.observedVersion || action.committedVersion !== observation.observedVersion || action.committedAt !== postActionReconciliation.observedAt || action.committedAt !== observation.observedAt) {
    throw new Error(`CF-053 independent outcome, freshness, reconciliation or collateral verification failed: ${canonical({ action, postActionReconciliation, observation, exactOutcome, fresh })}`);
  }
  const body = {
    candidateSource: input.candidate.source,
    candidateDigest: candidate.entry.candidateDigest,
    launchReceiptDigest: current.receipt.receiptDigest,
    generation: current.receipt.generation,
    stableId,
    exactInputDigest,
    reconciliationBeforeAction: reconciliation.classification as "completed" | "not-started",
    actionStatus: action.status as "committed" | "already-exists",
    intendedWrites: (action.status === "committed" ? 1 : 0) as 0 | 1,
    totalBusinessWrites: Number(action.totalBusinessWrites),
    outcome: "completed" as const,
    fresh: true as const,
    collateralClean: true as const,
    observerWrites: 0 as const,
  };
  return Object.freeze({ ...body, evidenceDigest: cf053Digest(body) });
}

export async function executeCf053Transfer(input: { processes: Cf053ProcessHandle; candidate: Cf053CandidateHandle; authorityGrant: Cf053ProductionAuthorityGrantHandle; workItemId: string }): Promise<Cf053ExecutionReceipt> {
  const grant = productionGrants.get(input.authorityGrant as object), current = processHandles.get(input.processes as object);
  if (!grant || !current || grant.candidate.candidateDigest !== input.candidate.candidateDigest || grant.workItemId !== input.workItemId || grant.processGenerationDigest !== current.receipt.receiptDigest || input.authorityGrant.grantDigest !== cf053Digest({ authority: grant.authority, workItemId: grant.workItemId, processGenerationDigest: grant.processGenerationDigest })) throw new Error("CF-053 production execution requires the exact opaque generation-bound authority grant.");
  const receipt = await executeCf053TransferInternal({ processes: input.processes, candidate: input.candidate, authoritySigner: grant.signer, authority: grant.authority, parentPlan: grant.parentPlan, workItemId: grant.workItemId, authorityPolicyDigest: grant.authorityPolicyDigest, now: grant.now, boundary: "derived" });
  const broker = productionBrokers.get(grant.broker);
  if (!broker) throw new Error("CF-053 production broker disappeared before completion evidence acceptance.");
  const prior = broker.completedWorkItems.get(grant.workItemId);
  if (prior && prior !== receipt.evidenceDigest) throw new Error("CF-053 production work item completion evidence conflicts with its prior accepted receipt.");
  broker.completedWorkItems.set(grant.workItemId, receipt.evidenceDigest);
  return receipt;
}

export interface Cf053ProductionParentCompletionReceipt {
  parentPlanDigest: string;
  requiredItems: number;
  completedItems: number;
  totalBusinessWrites: number;
  freshAggregateEvidenceDigest: string;
  resumedExactlyOnce: true;
  receiptDigest: string;
}

export async function completeCf053ProductionParent(input: { authorityBroker: Cf053ProductionAuthorityBroker; processes: Cf053ProcessHandle; executions: Cf053ExecutionReceipt[]; resumeOriginalGoal: () => Promise<{ completed: true }> }): Promise<Cf053ProductionParentCompletionReceipt> {
  const broker = productionBrokers.get(input.authorityBroker), current = requireProcesses(input.processes);
  if (!broker || current.candidate.entry.candidateDigest !== broker.candidate.candidateDigest || current.candidate.boundary !== "derived") throw new Error("CF-053 production parent completion requires the exact broker-bound live process generation.");
  const plan = parentPlanHandles.get(broker.parentPlan as object);
  if (!plan || input.executions.length !== plan.workItems.size || input.executions.length < 1 || input.executions.length > 100) throw new Error("CF-053 production parent completion requires one exact execution receipt per validated work item.");
  const expected = [...plan.workItems.values()].map((item) => ({ stableId: item.stableId, exactInputDigest: item.exactInputDigest })).sort((left, right) => left.stableId.localeCompare(right.stableId));
  const actual = input.executions.map((receipt) => ({ stableId: receipt.stableId, exactInputDigest: receipt.exactInputDigest })).sort((left, right) => left.stableId.localeCompare(right.stableId));
  if (canonical(expected) !== canonical(actual) || input.executions.some((receipt) => receipt.candidateDigest !== current.candidate.entry.candidateDigest || receipt.outcome !== "completed" || !receipt.fresh || !receipt.collateralClean || receipt.observerWrites !== 0)) throw new Error("CF-053 production parent completion rejected incomplete, duplicated, stale or foreign item evidence.");
  const aggregate = await freshAggregateObservation(input.processes, expected);
  if (aggregate.totalBusinessWrites !== expected.length) throw new Error("CF-053 production parent aggregate write count does not match the exact bounded plan.");
  let resumeCount = 0; const resumed = await input.resumeOriginalGoal(); resumeCount += 1;
  if (!resumed.completed || resumeCount !== 1) throw new Error("CF-053 production original goal did not resume exactly once after fresh aggregate proof.");
  const body = { parentPlanDigest: plan.parentPlanDigest, requiredItems: expected.length, completedItems: expected.length, totalBusinessWrites: aggregate.totalBusinessWrites, freshAggregateEvidenceDigest: aggregate.evidenceDigest, resumedExactlyOnce: true as const };
  return Object.freeze({ ...body, receiptDigest: cf053Digest(body) });
}

/** Explicitly author-known development only. */
export async function executeCf053DevelopmentTransfer(input: { processes: Cf053ProcessHandle; candidate: Cf053CandidateHandle; authoritySigner: Cf053AuthoritySigner; authority: Cf053AuthorityReceipt; exactInput: unknown; expectedStableIds: string[]; now: string }): Promise<Cf053ExecutionReceipt> {
  const context = developmentAuthorityContexts.get(input.authority as object), candidate = candidateHandles.get(input.candidate as object);
  if (!context || !candidate || candidate.boundary !== "development" || canonical(boundedPrimitiveSnapshot(input.exactInput, candidate.entry.contract.inputSchema)) !== canonical(context.exactInput) || canonical([...new Set(input.expectedStableIds)].sort()) !== canonical(context.expectedStableIds)) throw new Error("CF-053 development authority/input/parent-set binding failed.");
  return executeCf053TransferInternal({ processes: input.processes, candidate: input.candidate, authoritySigner: input.authoritySigner, authority: input.authority, parentPlan: context.parentPlan, workItemId: context.workItemId, authorityPolicyDigest: cf053Digest({ developmentPolicy: true }), now: input.now, boundary: "development" });
}

/** Development-only negative-control seam: the action child must recompute body identity. */
export async function attemptCf053DevelopmentMismatchedBody(input: { processes: Cf053ProcessHandle; candidate: Cf053CandidateHandle; authority: Cf053AuthorityReceipt; signedInput: unknown; substitutedBody: unknown }): Promise<never> {
  const current = requireProcesses(input.processes), candidate = candidateHandles.get(input.candidate as object);
  if (!candidate || candidate.boundary !== "development") throw new Error("CF-053 mismatched-body control is development-only.");
  const signed = boundedPrimitiveSnapshot(input.signedInput, candidate.entry.contract.inputSchema), substituted = boundedPrimitiveSnapshot(input.substitutedBody, candidate.entry.contract.inputSchema), exactInputDigest = cf053Digest(signed), stableId = stableIdFor(candidate.entry.contract, signed);
  await processCall(current, "action", "/action", { stableId, exactInputDigest, authority: input.authority, expected: { candidateDigest: candidate.entry.candidateDigest, exactInputDigest, stableId, expectedStableIdsDigest: input.authority.expectedStableIdsDigest, processGenerationDigest: input.authority.processGenerationDigest, parentPlanDigest: input.authority.parentPlanDigest, workItemId: input.authority.workItemId, authorityPolicyDigest: input.authority.authorityPolicyDigest, tenantId: candidate.entry.contract.tenantId, targetAlias: candidate.entry.contract.targetAlias, actionScope: candidate.entry.contract.actionScope, policyVersion: candidate.entry.contract.policyVersion }, ...rolePayload(candidate.entry.contract.executionBinding!, "action", substituted) });
  throw new Error("CF-053 action child incorrectly accepted a substituted request body.");
}

export interface Cf053TwoItemGoalResult {
  state: GoalCoordinationState;
  executions: Cf053ExecutionReceipt[];
  launchReceipts: Cf053LaunchReceipt[];
  events: GoalCoordinationEvent[];
  registryBuilds: 1;
  retainedReuses: 1;
  totalBusinessWrites: 2;
  parentResumeCount: 1;
  retainedRecoveryReceipt: ComposedRecoveryReceipt;
  retainedReuseReceipt: RetainedCapabilityReuseReceipt;
  claimBoundary: "local-fictional-author-known-development-fixture-only";
}

function validatedTwoItemPlan(contract: Cf053ProviderNeutralContract): ValidatedGoalPlan {
  const scope: TrustedGoalScope = {
    tenantId: contract.tenantId,
    parentGoalId: "cf053_parent_goal",
    requestId: "cf053_request",
    ordinaryGoal: "Complete both exact bounded fictional work items and resume the original parent goal.",
    deadline: { key: "bounded_window", description: "The frozen local development window." },
    entities: [{ alias: "item_one", kind: "bounded-item", systemAliases: [contract.targetAlias] }, { alias: "item_two", kind: "bounded-item", systemAliases: [contract.targetAlias] }],
    systems: [{ targetAlias: contract.targetAlias, credentialAliases: ["cred.writer"], operations: [{ name: "commit_exact_item", method: "POST", requiredCompanionActions: ["read_exact_item"] }, { name: "read_exact_item", method: "GET" }] }],
    completionCriteria: [{ key: "exact_item", summary: "The independent observer sees the exact intended item once.", verifierKey: "cf053_independent_observer" }],
    requiredCoverage: [
      { key: "first_item", entityAliases: ["item_one"], workflowKey: "cf053_transfer", requiredActions: ["commit_exact_item", "read_exact_item"], targetAliases: [contract.targetAlias], completionCriterionKeys: ["exact_item"] },
      { key: "second_item", entityAliases: ["item_two"], workflowKey: "cf053_transfer", requiredActions: ["commit_exact_item", "read_exact_item"], targetAliases: [contract.targetAlias], completionCriterionKeys: ["exact_item"], dependsOnCoverageKeys: ["first_item"] },
    ],
    authority: { allowedTargetAliases: [contract.targetAlias], allowedSecretAliases: ["cred.writer"], allowedMethods: ["GET", "POST"], writeAuthority: "preauthorized", approvedWriteActions: [] },
  };
  const proposal: GoalPlanProposal = {
    schemaVersion: "1.0", deadlineKey: "bounded_window", summary: "Two exact dependent items.",
    workItems: [
      { key: "first", groupKey: "transfer", groupLabel: "Transfer", summary: "Complete the first item.", coverageKeys: ["first_item"], entityAliases: ["item_one"], workflowKey: "cf053_transfer", requiredActions: ["commit_exact_item", "read_exact_item"], targetAliases: [contract.targetAlias], completionCriterionKeys: ["exact_item"], dependsOnKeys: [] },
      { key: "second", groupKey: "transfer", groupLabel: "Transfer", summary: "Complete the dependent second item.", coverageKeys: ["second_item"], entityAliases: ["item_two"], workflowKey: "cf053_transfer", requiredActions: ["commit_exact_item", "read_exact_item"], targetAliases: [contract.targetAlias], completionCriterionKeys: ["exact_item"], dependsOnKeys: ["first"] },
    ],
  };
  const validated = validateGoalPlan(proposal, scope);
  if (validated.status !== "validated") throw new Error(`CF-053 author-known parent goal did not pass trusted plan validation: ${canonical(validated.checks)}`);
  return validated.plan;
}

export async function runCf053AuthorKnownTwoItemGoal(input: { rootDirectory: string; contract: Cf053ProviderNeutralContract; firstInput: unknown; secondInput: unknown; now: string; afterFirstItemCommitted?: (durableWorldPath: string) => void }): Promise<Cf053TwoItemGoalResult> {
  assertCf053Contract(input.contract);
  const root = resolve(input.rootDirectory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")), signer = createCf053AuthoritySigner("cf053_local_authority"), plan = validatedTwoItemPlan(input.contract);
  const recoveryPath = join(root, "retained-recovery.sqlite");
  let recovery = new ComposedRuntimeRecoveryCoordinator(recoveryPath, () => input.now);
  const exactInputs = [boundedPrimitiveSnapshot(input.firstInput, input.contract.inputSchema), boundedPrimitiveSnapshot(input.secondInput, input.contract.inputSchema)];
  const stableIds = exactInputs.map((item) => stableIdFor(input.contract, item));
  if (new Set(stableIds).size !== 2) throw new Error("CF-053 two-item parent goal requires two distinct stable identities.");
  const executions: Cf053ExecutionReceipt[] = [], launchReceipts: Cf053LaunchReceipt[] = [], events: GoalCoordinationEvent[] = [];
  let freshAggregateEvidence: Awaited<ReturnType<typeof freshAggregateObservation>> | undefined;
  let activeProcesses: Cf053ProcessHandle | null = null, parentResumeCount = 0;
  let retainedRecoveryReceipt: ComposedRecoveryReceipt | undefined, retainedReuseReceipt: RetainedCapabilityReuseReceipt | undefined;
  const evidence = new Map<string, Cf053ExecutionReceipt>();
  let boundParentPlan: Cf053ValidatedParentPlanHandle | undefined;
  const executor = {
    execute: async ({ item }: { item: ValidatedGoalPlan["workItems"][number] }): Promise<GoalWorkItemExecutionResult> => {
      const index = item.key === "first" ? 0 : 1;
      const candidate = registry.acquireDevelopment(input.contract, input.now);
      if (!boundParentPlan) boundParentPlan = bindCf053DevelopmentParentPlan({ candidate, parentPlanDigest: goalPlanDigest(plan), workItems: plan.workItems.map((workItem, workIndex) => ({ workItemId: workItem.workItemId, exactInput: exactInputs[workIndex]! })) });
      if (index === 0 && candidate.source !== "built") throw new Error("CF-053 first item did not build exactly one content-addressed candidate.");
      if (index === 1 && candidate.source !== "retained") throw new Error("CF-053 second item did not use the retained candidate.");
      if (index === 1) {
        if (!retainedRecoveryReceipt) throw new Error("CF-053 exact retained recovery evidence is absent.");
        retainedReuseReceipt = recovery.reuse({ tenantId: input.contract.tenantId, runtimeFamily: "constrained_http", capabilityKey: input.contract.contractId, capabilityVersion: "v1", capabilityQualificationDigest: candidate.candidateDigest, consumerPlanDigest: goalPlanDigest(plan), consumerWorkItemId: item.workItemId });
        if (!activeProcesses) throw new Error("CF-053 replacement requires the first adopted process generation.");
        await closeCf053ProviderProcesses(activeProcesses);
        activeProcesses = null;
      }
      activeProcesses = await launchCf053DevelopmentProcesses({ candidate, authoritySigner: signer, worldRoot: join(root, "world"), now: input.now });
      const launch = adoptCf053ProcessGeneration(activeProcesses); launchReceipts.push(launch);
      const exact = exactInputs[index]!, issuedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 60_000).toISOString();
      const authorityPolicyDigest = cf053Digest({ developmentPolicy: true }), authority = issueCf053AuthorityForBoundPlan({ signer, candidate, parentPlan: boundParentPlan, workItemId: item.workItemId, issuedAt, expiresAt, processGenerationDigest: cf053Digest({ development: true }), authorityPolicyDigest });
      const receipt = await executeCf053TransferInternal({ processes: activeProcesses, candidate, authoritySigner: signer, authority, parentPlan: boundParentPlan, workItemId: item.workItemId, authorityPolicyDigest, now: issuedAt, boundary: "development" });
      executions.push(receipt); evidence.set(item.workItemId, receipt);
      if (index === 0) {
        const context: ComposedRecoveryContext = { schemaVersion: "1.0", tenantId: input.contract.tenantId, parentGoalId: plan.parentGoalId, planId: "cf053_plan", planDigest: goalPlanDigest(plan), workItemId: item.workItemId, stateVersion: 1, runtimeFamily: "constrained_http", capabilityKey: input.contract.contractId, capabilityVersion: "v1", capabilityQualificationDigest: candidate.candidateDigest, capabilityMaterialDigest: candidate.candidateDigest, idempotencyKey: cf053Digest({ stableId: receipt.stableId, exactInputDigest: receipt.exactInputDigest }) };
        const evidenceBody = { schemaVersion: "1.0" as const, observerKey: "cf053_observer", classification: "completed" as const, observationDigest: receipt.evidenceDigest, incorrectSideEffects: 0, tenantId: context.tenantId, parentGoalId: context.parentGoalId, planId: context.planId, planDigest: context.planDigest, workItemId: context.workItemId, stateVersion: context.stateVersion, runtimeFamily: context.runtimeFamily, capabilityKey: context.capabilityKey, capabilityVersion: context.capabilityVersion, capabilityQualificationDigest: context.capabilityQualificationDigest, capabilityMaterialDigest: context.capabilityMaterialDigest, observedAt: input.now };
        retainedRecoveryReceipt = recovery.recover({ context, responseDisposition: "available", independentEvidence: evidenceBody });
        recovery.retain(retainedRecoveryReceipt);
        recovery.close();
        recovery = new ComposedRuntimeRecoveryCoordinator(recoveryPath, () => input.now);
        if (input.afterFirstItemCommitted) {
          const active = requireProcesses(activeProcesses);
          input.afterFirstItemCommitted(active.statePath);
        }
      }
      return { status: "executed", path: candidate.source === "built" ? "built-capability" : "retained-capability", childRunId: `cf053-${launch.generation}-${item.workItemId}`, operationKey: item.operationKey, writesAttempted: receipt.intendedWrites, summary: `${candidate.source} candidate independently verified.` };
    },
  };
  const scheduler = new GoalScheduler(
    new FileGoalCoordinationStore(join(root, "goal-state")),
    executor,
    { verify: async (_plan, item): Promise<OutcomeReceipt> => { const receipt = evidence.get(item.workItemId); if (!receipt) throw new Error("CF-053 item verifier lacks exact independent evidence."); return { verifierVersion: "cf053-independent-item-v1", passed: receipt.outcome === "completed" && receipt.fresh && receipt.collateralClean, intendedWrites: receipt.intendedWrites, incorrectSideEffects: 0, stateDigest: receipt.evidenceDigest, checks: [{ id: "separate-observer", passed: true, detail: "A distinct read-only process observed the exact fresh outcome." }, { id: "no-collateral", passed: receipt.collateralClean, detail: "No unexpected stable identity was observed." }], verifiedAt: new Date().toISOString() }; } },
    { verify: async (_plan, state): Promise<GoalAggregateOutcomeReceipt> => { const values = Object.values(state.items), completedItems = values.filter((value) => value.lifecycle === "completed").length, unknownItems = values.length - completedItems; freshAggregateEvidence = activeProcesses ? await freshAggregateObservation(activeProcesses, executions.map((receipt) => ({ stableId: receipt.stableId, exactInputDigest: receipt.exactInputDigest }))) : undefined; const passed = completedItems === 2 && executions.length === 2 && freshAggregateEvidence?.passed === true && freshAggregateEvidence.totalBusinessWrites === 2; return { verifierVersion: "cf053-independent-aggregate-v1", receiptId: cf053Digest({ parent: state.parentGoalId, freshAggregateEvidence }), result: passed ? "complete" : "unknown", passed, requiredItems: 2, completedItems, blockedItems: 0, failedItems: 0, unknownItems, incorrectSideEffects: 0, stateDigest: freshAggregateEvidence?.evidenceDigest ?? cf053Digest({ missing: true }), checks: [{ id: "fresh-exact-two", passed, detail: "A separate fresh observer pass immediately before resumption saw both exact records, no collateral state, and exactly two writes." }], verifiedAt: new Date().toISOString() }; } },
    { resume: async () => { if (!freshAggregateEvidence?.passed) throw new Error("CF-053 parent cannot resume without the immediately preceding fresh aggregate observation."); parentResumeCount += 1; if (parentResumeCount !== 1) throw new Error("CF-053 original parent goal resumed more than once."); return { completed: true, summary: "The exact original two-item parent goal resumed once after a fresh aggregate observation." }; } },
    { record: (event) => events.push(structuredClone(event)) },
  );
  try {
    const state = await scheduler.run(plan);
    if (state.lifecycle !== "completed" || !state.resume?.completed || state.aggregate?.completedItems !== 2 || executions.length !== 2 || launchReceipts.length !== 2 || launchReceipts[0]!.action.pid === launchReceipts[1]!.action.pid || launchReceipts[0]!.observer.pid === launchReceipts[1]!.observer.pid || launchReceipts[1]!.generation !== 2 || launchReceipts[1]!.predecessorReceiptDigest !== launchReceipts[0]!.receiptDigest || parentResumeCount !== 1) throw new Error("CF-053 two-item parent goal did not prove build/reuse/replacement/resumption exactly.");
    if (!retainedRecoveryReceipt || !retainedReuseReceipt || !retainedRecoveryReceipt.verifiedCompletion) throw new Error("CF-053 composed recovery retention/reuse was not exactly proven.");
    return { state, executions, launchReceipts, events, registryBuilds: 1, retainedReuses: 1, totalBusinessWrites: 2, parentResumeCount: 1, retainedRecoveryReceipt, retainedReuseReceipt, claimBoundary: "local-fictional-author-known-development-fixture-only" };
  } finally {
    if (activeProcesses) await closeCf053ProviderProcesses(activeProcesses);
    recovery.close();
  }
}
