import type { JourneyArtifact, OnboardingJourneyStage } from "./customer-local-onboarding-journey.js";
import { onboardingJourneyDigest } from "./customer-local-onboarding-journey.js";
import {
  providerWorkBoardDigest,
  getBuiltInProviderWorkTypedValidator,
  assertCoordinatedProviderWorkBoundary,
  completeProviderWorkWithAtomicEvidence,
  readProgressiveProviderWorkSource,
  type DurableCustomerLocalProviderWorkBoard,
  type ProviderWorkArtifactMaterial,
  type ProviderWorkBoardSnapshot,
  type ProviderWorkAtomicCrashPhase,
  type ProviderWorkEvidenceCoordinator,
  type ProviderWorkEvidenceInput,
  type ProviderWorkEvidenceReader,
  type ProviderWorkJourneyReader,
  type ProviderWorkProofMaterial,
  type ProviderWorkTaskId,
  type ProviderWorkTypedValidationEnvelope,
  type ProviderWorkTypedValidator,
} from "./customer-local-provider-work-board.js";
import { sdkWorkPackDigest, type SdkImplementationWorkPack } from "./customer-local-sdk-work-pack.js";

export const CUSTOMER_LOCAL_PROVIDER_EVIDENCE_REUSE_VERSION = "1.0" as const;

const exactReviewedRoles = ["action", "no-write-probe", "reconciliation-readback", "independent-observer"] as const;
const executableResiduals: ProviderWorkTaskId[] = ["action-runtime", "no-write-probe", "stable-identity", "idempotency-reconciliation", "independent-observer", "freshness-outcome"];
const independentResiduals: ProviderWorkTaskId[] = ["negative-controls", "plugin-conformance", "binding-qualification", "mandatory-acceptance", "host-doctor"];
const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{1,179}$/;

function omit(value: Record<string, unknown>, key: string) { const copy = { ...value }; delete copy[key]; return copy; }
function assertArtifactIntegrity(artifact: JourneyArtifact, stage: OnboardingJourneyStage) {
  if (artifact.stage !== stage || artifact.payloadDigest !== onboardingJourneyDigest(artifact.payload) || artifact.artifactDigest !== onboardingJourneyDigest(omit(artifact as unknown as Record<string, unknown>, "artifactDigest"))) throw new Error(`Evidence reuse rejected stage/digest relabeling at ${stage}.`);
}
export type ProviderEvidenceReuseTypedValidation = ProviderWorkTypedValidationEnvelope & { validatorId: "cf051-cf036-reviewed-source"; validatorVersion: "1"; taskId: "sdk-source-review"; sourceStage: "cf041-semantic-review" };
function validateExactReviewedSource(artifact: JourneyArtifact, workPack: SdkImplementationWorkPack, providerId: string): void {
  assertArtifactIntegrity(artifact, "cf036-sdk-work-pack");
  const { workPackDigest, ...body } = workPack;
  const roles = workPack.roles.map(item => item.review.role).sort();
  if (workPack.state !== "engineer-implementation-required" || workPack.providerId !== providerId || workPackDigest !== sdkWorkPackDigest(body) || artifact.lineage.workPackDigest !== workPackDigest || workPack.explicitReviews !== 4 || new Set(roles).size !== 4 || JSON.stringify(roles) !== JSON.stringify([...exactReviewedRoles].sort()) || workPack.roles.some(item => !item.review.exactOneToOne || item.methodDigest !== sdkWorkPackDigest(item.method) || item.provenance.sdkSourceDigest !== workPack.sdkSourceDigest) || workPack.conformanceControls.length === 0 || workPack.conformanceControls.some(control => control.state !== "not-run")) throw new Error("CF-036 does not contain the exact reviewed, still-non-executable SDK source mapping required for safe reuse.");
}

export function createCf051ReviewedSourceValidator(): ProviderWorkTypedValidator {
  const validator = getBuiltInProviderWorkTypedValidator("sdk-source-review");
  if (!validator) throw new Error("CF-051 built-in reviewed-source validator is unavailable.");
  return validator;
}

export interface ProviderEvidenceReuseReceipt {
  schemaVersion: "1.0";
  state: "one-safe-reuse-thirteen-explicit-residuals";
  boardId: string;
  tenantId: string;
  providerId: string;
  journeyId: string;
  sourceIdentityDigest: string;
  sourceEventCount: number;
  sourceEventHeadDigest: string;
  sourceEventStateDigest: string;
  journeyDigest: string;
  cumulativeLineageDigest: string;
  releaseManifestDigest: string;
  readinessReceiptDigest: string;
  reused: Array<{ taskId: "sdk-source-review"; upstreamStage: "cf036-sdk-work-pack"; upstreamArtifactDigest: string; upstreamPayloadDigest: string; workPackDigest: string; proofClass: "reviewed-source-mapping"; typedValidation: ProviderEvidenceReuseTypedValidation }>;
  residual: { taskIds: ProviderWorkTaskId[]; total: 13; engineer: 7; customer: 1; independentProof: 5; executableImplementationTasks: 6; customerConfirmations: 1; independentProofTasks: 5 };
  deliberatelyNotReused: Array<{ upstreamStage: OnboardingJourneyStage; refusedTaskId: ProviderWorkTaskId; reason: string }>;
  duplicateBoardReviewsEliminated: 1;
  underlyingExplicitRoleReviewsReused: 4;
  executionAuthorityEffect: "none";
  activationEffect: "none";
  receiptDigest: string;
}
export interface ProviderEvidenceReusePlan { receipt: ProviderEvidenceReuseReceipt; artifacts: ProviderWorkArtifactMaterial[]; proofs: ProviderWorkProofMaterial[]; inputs: ProviderWorkEvidenceInput[] }

export function prepareProviderEvidenceReuse(input: { reader: ProviderWorkJourneyReader; board: ProviderWorkBoardSnapshot; now: string }): ProviderEvidenceReusePlan {
  const anchor = readProgressiveProviderWorkSource(input.reader, input.board.journeyId, input.board.tenantId, input.board.providerId, input.now);
  const cf041Artifact=anchor.snapshot.artifacts["cf041-semantic-review"],sourceEvents=input.reader.events(input.board.journeyId,input.board.tenantId),cf041Event=sourceEvents[input.board.sourceEventCount-1];
  if(input.board.originMode!=="cf041-progressive"||input.board.importedStage!=="cf041-semantic-review"||!cf041Artifact||!cf041Event||!cf041Event.detail.startsWith("cf041-semantic-review attached")||input.board.importedSourceEventHeadDigest!==cf041Event.eventDigest||input.board.sourceEventHeadDigest!==cf041Event.eventDigest||anchor.snapshot.currentStage!=="cf041-semantic-review"||anchor.sourceEventCount!==input.board.sourceEventCount||anchor.sourceEventHeadDigest!==cf041Event.eventDigest)throw new Error("CF-051 reuse requires the exact causal progressive CF-041 frontier; retrospective or later-stage imports are rejected.");
  if (input.board.sourceIdentityDigest !== anchor.sourceIdentityDigest || input.board.sourceEventCount !== anchor.sourceEventCount || input.board.sourceEventHeadDigest !== anchor.sourceEventHeadDigest || input.board.sourceEventStateDigest !== anchor.sourceEventStateDigest || input.board.journeyDigest !== anchor.journeyDigest || input.board.journeyRevision !== anchor.journeyRevision || input.board.cumulativeLineageDigest !== anchor.cumulativeLineageDigest || input.board.releaseManifestDigest !== anchor.releaseManifestDigest || input.board.readinessReceiptDigest !== anchor.readinessReceiptDigest || input.board.workPackDigest !== anchor.workPack.workPackDigest || input.board.semanticDraftDigest !== anchor.semanticDraft.snapshotDigest) throw new Error("Evidence reuse board is stale or belongs to another provider/source event state.");
  if (input.board.tasks.some(task => task.evidence)) throw new Error("Evidence reuse v1 applies only to an untouched current provider work board.");
  const upstream = anchor.snapshot.artifacts["cf036-sdk-work-pack"]!;
  validateExactReviewedSource(upstream, anchor.workPack, input.board.providerId);
  const contentDigest = providerWorkBoardDigest({ boundary: "cf051-reviewed-source-reuse", upstreamArtifactDigest: upstream.artifactDigest, workPackDigest: anchor.workPack.workPackDigest, sourceEventStateDigest: anchor.sourceEventStateDigest });
  const artifactBody = { schemaVersion: "1.0" as const, uri: `artifact://${input.board.journeyId}/reuse/cf036-sdk-source-review`, tenantId: input.board.tenantId, providerId: input.board.providerId, journeyId: input.board.journeyId, taskId: "sdk-source-review" as const, kind: "bounded-config" as const, contentDigest, implementationDigest: null, executable: false, generatedStub: false, declarationOnly: false, manualCodeFiles: 0, manualConfigObjects: 0, producedByAlias: upstream.recordedBy, producedAt: upstream.recordedAt };
  const artifact: ProviderWorkArtifactMaterial = { ...artifactBody, materialDigest: providerWorkBoardDigest(artifactBody) };
  const proofBody = { schemaVersion: "1.1" as const, uri: `artifact://${input.board.journeyId}/reuse-proof/cf036-sdk-source-review`, tenantId: input.board.tenantId, providerId: input.board.providerId, journeyId: input.board.journeyId, taskId: "sdk-source-review" as const, surface: "source-review" as const, evidenceClass: "build-execution" as const, artifactDigest: contentDigest, prerequisiteEvidenceDigests: [], sourceIdentityDigest: anchor.sourceIdentityDigest, sourceEventStateDigest: anchor.sourceEventStateDigest, cumulativeLineageDigest: anchor.cumulativeLineageDigest, releaseManifestDigest: anchor.releaseManifestDigest, readinessReceiptDigest: anchor.readinessReceiptDigest, passed: true as const, independent: false, actionResponseUsed: false as const, producedByAlias: upstream.recordedBy, producedAt: upstream.recordedAt };
  const proof: ProviderWorkProofMaterial = { ...proofBody, proofDigest: providerWorkBoardDigest(proofBody) };
  const validationBody = { schemaVersion: "1.0" as const, validatorId: "cf051-cf036-reviewed-source" as const, validatorVersion: "1" as const, taskId: "sdk-source-review" as const, sourceStage: "cf041-semantic-review" as const, sourceArtifactDigest: upstream.artifactDigest, workPackDigest: anchor.workPack.workPackDigest, semanticDraftDigest: anchor.semanticDraft.snapshotDigest, sourceEventCount: anchor.sourceEventCount, sourceEventHeadDigest: anchor.sourceEventHeadDigest, journeyPrefixDigest: providerWorkBoardDigest({ journeyId: input.board.journeyId, sourceEventCount: anchor.sourceEventCount, sourceEventHeadDigest: anchor.sourceEventHeadDigest }), outputMaterialDigest: artifact.materialDigest, outputProofDigest: proof.proofDigest, producerReferenceDigest: providerWorkBoardDigest({ recordedBy: upstream.recordedBy, recordedAt: upstream.recordedAt, sourceArtifactDigest: upstream.artifactDigest }), validationReferenceDigest: providerWorkBoardDigest({ validatorId: "cf051-cf036-reviewed-source", validatorVersion: "1", journeyPrefix: anchor.sourceEventHeadDigest, sourceArtifactDigest: upstream.artifactDigest }) };
  const typedValidation: ProviderEvidenceReuseTypedValidation = { ...validationBody, validationReceiptDigest: providerWorkBoardDigest(validationBody) };
  if (!identifier.test(upstream.recordedBy) || Date.parse(upstream.recordedAt) > Date.parse(input.now)) throw new Error("Reused reviewed source identity or chronology is invalid.");
  const evidenceInput: ProviderWorkEvidenceInput = { schemaVersion: "1.2", boardId: input.board.boardId, tenantId: input.board.tenantId, providerId: input.board.providerId, journeyId: input.board.journeyId, taskId: "sdk-source-review", expectedSnapshotDigest: input.board.snapshotDigest, expectedRevision: input.board.revision, expectedJourneyDigest: anchor.journeyDigest, expectedSourceIdentityDigest: anchor.sourceIdentityDigest, expectedSourceEventStateDigest: anchor.sourceEventStateDigest, expectedCumulativeLineageDigest: anchor.cumulativeLineageDigest, expectedReleaseManifestDigest: anchor.releaseManifestDigest, expectedReadinessReceiptDigest: anchor.readinessReceiptDigest, artifactUri: artifact.uri, proofUri: proof.uri, typedValidation, prerequisiteEvidenceDigests: [], reviewedByAlias: upstream.recordedBy, reviewedAt: upstream.recordedAt, reviewPhrase: `COMPLETE sdk-source-review ${contentDigest}` };
  const residual = input.board.tasks.filter(task => task.taskId !== "sdk-source-review").map(task => task.taskId);
  const deliberatelyNotReused: ProviderEvidenceReuseReceipt["deliberatelyNotReused"] = [
    { upstreamStage: "cf041-semantic-review", refusedTaskId: "stable-identity", reason: "Reviewed semantic intent is not an executed stable-identity implementation." },
    { upstreamStage: "cf037-acceptance-only-compile", refusedTaskId: "action-runtime", reason: "Acceptance-only compilation explicitly fails before acceptance and proves no executable runtime." },
    { upstreamStage: "cf030-plugin-conformance", refusedTaskId: "plugin-conformance", reason: "Upstream conformance predates and does not bind the CF-046 implementation/prerequisite evidence graph." },
    { upstreamStage: "cf029-binding-qualification", refusedTaskId: "credentials-authority", reason: "Qualification cannot replace explicit current customer authority confirmation." },
    { upstreamStage: "cf029-binding-qualification", refusedTaskId: "binding-qualification", reason: "Upstream qualification does not bind the residual implementation graph or a completed customer-authority task." },
    { upstreamStage: "cf035-signed-release", refusedTaskId: "signed-release", reason: "The upstream release predates executed CF-046 mandatory acceptance and cannot sign future residual work." },
    { upstreamStage: "cf034-host-doctor", refusedTaskId: "host-doctor", reason: "The upstream doctor describes the prior signed bundle, not a release produced from completed residual work." },
    { upstreamStage: "readiness-evidence", refusedTaskId: "mandatory-acceptance", reason: "Preparation readiness contains no executed mandatory-acceptance receipt and cannot masquerade as one." },
  ];
  if (residual.length !== 13 || executableResiduals.some(task => !residual.includes(task)) || independentResiduals.some(task => !residual.includes(task)) || !residual.includes("credentials-authority")) throw new Error("Evidence reuse residual accounting changed unexpectedly.");
  const receiptBody = { schemaVersion: "1.0" as const, state: "one-safe-reuse-thirteen-explicit-residuals" as const, boardId: input.board.boardId, tenantId: input.board.tenantId, providerId: input.board.providerId, journeyId: input.board.journeyId, sourceIdentityDigest: anchor.sourceIdentityDigest, sourceEventCount: anchor.sourceEventCount, sourceEventHeadDigest: anchor.sourceEventHeadDigest, sourceEventStateDigest: anchor.sourceEventStateDigest, journeyDigest: anchor.journeyDigest, cumulativeLineageDigest: anchor.cumulativeLineageDigest, releaseManifestDigest: anchor.releaseManifestDigest, readinessReceiptDigest: anchor.readinessReceiptDigest, reused: [{ taskId: "sdk-source-review" as const, upstreamStage: "cf036-sdk-work-pack" as const, upstreamArtifactDigest: upstream.artifactDigest, upstreamPayloadDigest: upstream.payloadDigest, workPackDigest: anchor.workPack.workPackDigest, proofClass: "reviewed-source-mapping" as const, typedValidation }], residual: { taskIds: residual, total: 13 as const, engineer: 7 as const, customer: 1 as const, independentProof: 5 as const, executableImplementationTasks: 6 as const, customerConfirmations: 1 as const, independentProofTasks: 5 as const }, deliberatelyNotReused, duplicateBoardReviewsEliminated: 1 as const, underlyingExplicitRoleReviewsReused: 4 as const, executionAuthorityEffect: "none" as const, activationEffect: "none" as const };
  return { receipt: { ...receiptBody, receiptDigest: providerWorkBoardDigest(receiptBody) }, artifacts: [artifact], proofs: [proof], inputs: [evidenceInput] };
}

export function applyProviderEvidenceReuse(input: { board: DurableCustomerLocalProviderWorkBoard; reader: ProviderWorkJourneyReader; coordinator: ProviderWorkEvidenceCoordinator; plan: ProviderEvidenceReusePlan; now: string; crashAt?:ProviderWorkAtomicCrashPhase }): ProviderWorkBoardSnapshot {
  assertCoordinatedProviderWorkBoundary(input.board,input.coordinator);
  const { receiptDigest, ...receiptBody } = input.plan.receipt;
  if (receiptDigest !== providerWorkBoardDigest(receiptBody) || input.plan.artifacts.length !== 1 || input.plan.proofs.length !== 1 || input.plan.inputs.length !== 1) throw new Error("Evidence reuse plan is malformed or mutated.");
  const before = input.board.read(input.plan.receipt.boardId, input.plan.receipt.tenantId);
  if(before.originMode!=="cf041-progressive"||before.importedStage!=="cf041-semantic-review"||before.importedSourceEventHeadDigest!==before.sourceEventHeadDigest)throw new Error("CF-051 apply requires the exact progressive CF-041 board origin.");
  if (before.snapshotDigest !== input.plan.inputs[0]!.expectedSnapshotDigest || before.sourceEventStateDigest !== input.plan.receipt.sourceEventStateDigest) throw new Error("Evidence reuse plan is stale before application.");
  const expected = prepareProviderEvidenceReuse({ reader: input.reader, board: before, now: input.now });
  if (providerWorkBoardDigest(input.plan) !== providerWorkBoardDigest(expected)) throw new Error("Evidence reuse plan no longer matches the exact current source mapping and residual boundary.");
  const artifact=input.plan.artifacts[0]!,proof=input.plan.proofs[0]!,typedValidation=input.plan.inputs[0]!.typedValidation;
  if(!typedValidation)throw new Error("Evidence reuse plan omitted the typed validation envelope.");
  const after=completeProviderWorkWithAtomicEvidence({board:input.board,coordinator:input.coordinator,bundle:{artifact,proof,typedValidation,planDigest:providerWorkBoardDigest(input.plan)},boardId:before.boardId,tenantId:before.tenantId,evidence:structuredClone(input.plan.inputs[0]!),...(input.crashAt?{crashAt:input.crashAt}:{})});
  if (after.tasks.find(task => task.taskId === "sdk-source-review")?.status !== "completed" || after.metrics.completedTasks !== 1 || after.metrics.engineerTasksRemaining !== 7 || after.metrics.customerTasksRemaining !== 1 || after.metrics.independentProofTasksRemaining !== 5 || after.executionAuthorityEffect !== "none" || after.activationEffect !== "none") throw new Error("Evidence reuse did not preserve the exact one-task/remainder/authority boundary.");
  return after;
}
