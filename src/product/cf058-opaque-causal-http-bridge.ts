import { createHash } from "node:crypto";
import { sdkWorkPackDigest, type SdkImplementationWorkPack } from "./customer-local-sdk-work-pack.js";
import { assertHttpBindingFactoryResultIntegrity, type HttpBindingFactoryResult } from "./http-binding-factory.js";
import { compileAuthorityEnforcedReviewedHttpBindings, type CompileAuthorityEnforcedHttpBindingsInput, type CompiledHttpBindingPair } from "./http-binding-compiler.js";
import { inspectCf053ProductionCandidateCausalLineage, type Cf053CandidateHandle } from "./local-declarative-exact-record-core.js";

export const CF058_OPAQUE_CAUSAL_HTTP_BRIDGE_VERSION = "1.0" as const;
const digestPattern = /^[a-f0-9]{64}$/;
const roles = ["action", "independent-observer", "no-write-probe", "reconciliation-readback"] as const;

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function cf058CausalBridgeDigest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

export interface Cf058CausalBridgeReceipt {
  schemaVersion: typeof CF058_OPAQUE_CAUSAL_HTTP_BRIDGE_VERSION;
  state: "causal-lineage-joined-nonactivating";
  candidateDigest: string;
  cf053ContractDigest: string;
  cf036WorkPackDigest: string;
  cf041ReviewedContractDigest: string;
  factoryResultDigest: string;
  targetAlias: string;
  actionScope: string;
  observerScope: string;
  inputSchemaDigest: string;
  stableIdentityDigest: string;
  exactOutcomePredicateDigest: string;
  credentialSeparationDigest: string;
  reviewedMethodIdentities: Array<{ role: typeof roles[number]; module: string; className: string; methodName: string; overloadId: string; methodDigest: string }>;
  executionAuthorityEffect: "none";
  activationEffect: "none";
  bridgeDigest: string;
}

export interface Cf058CausalBridgeHandle { readonly bridgeDigest: string }
interface BridgePrivate { receipt: Cf058CausalBridgeReceipt; factoryResultDigest: string; candidateDigest: string }
const bridgeHandles = new WeakMap<object, BridgePrivate>();

function verifiedMethodIdentities(workPack: SdkImplementationWorkPack, executionRoles: ReturnType<typeof inspectCf053ProductionCandidateCausalLineage>["executionBinding"]["roles"]): Cf058CausalBridgeReceipt["reviewedMethodIdentities"] {
  if (workPack.roles.length !== 4 || workPack.explicitReviews !== 4 || new Set(workPack.roles.map((item) => item.review.role)).size !== 4 || !same(workPack.roles.map((item) => item.review.role).sort(), [...roles].sort())) throw new Error("CF-058 requires exactly four one-to-one reviewed SDK role identities.");
  return roles.map((role) => {
    const reviewed = workPack.roles.find((item) => item.review.role === role), bound = executionRoles.find((item) => item.role === role);
    if (!reviewed || !bound || !reviewed.review.exactOneToOne || reviewed.methodDigest !== sdkWorkPackDigest(reviewed.method) || reviewed.provenance.sdkSourceDigest !== workPack.sdkSourceDigest || reviewed.method.module !== reviewed.review.module || reviewed.method.className !== reviewed.review.className || reviewed.method.methodName !== reviewed.review.methodName || reviewed.method.overloadId !== reviewed.review.overloadId || reviewed.method.sourcePointer !== reviewed.review.expectedSourcePointer || bound.module !== reviewed.method.module || bound.className !== reviewed.method.className || bound.methodName !== reviewed.method.methodName || bound.methodDigest !== reviewed.methodDigest) throw new Error(`CF-058 reviewed ${role} SDK method identity or CF-053 binding lineage failed.`);
    return { role, module: reviewed.method.module, className: reviewed.method.className!, methodName: reviewed.method.methodName, overloadId: reviewed.method.overloadId, methodDigest: reviewed.methodDigest };
  });
}

export function joinCf058OpaqueCausalHttpBridge(input: { candidate: Cf053CandidateHandle; workPack: SdkImplementationWorkPack; factoryResult: HttpBindingFactoryResult }): { handle: Cf058CausalBridgeHandle; receipt: Readonly<Cf058CausalBridgeReceipt> } {
  const lineage = inspectCf053ProductionCandidateCausalLineage(input.candidate);
  assertHttpBindingFactoryResultIntegrity(input.factoryResult);
  const { workPackDigest, ...workPackBody } = input.workPack;
  if (input.workPack.schemaVersion !== "1.0" || input.workPack.state !== "engineer-implementation-required" || input.workPack.executionAuthorityEffect !== "none" || input.workPack.activationEffect !== "none" || workPackDigest !== sdkWorkPackDigest(workPackBody)) throw new Error("CF-058 CF-036 work pack failed exact integrity or non-authority validation.");
  if (lineage.sourceChain.cf036WorkPackDigest !== workPackDigest || input.workPack.factoryResultDigest !== input.factoryResult.resultDigest || input.factoryResult.status !== "review-required" || !input.factoryResult.actionBinding || !input.factoryResult.observerBinding) throw new Error("CF-058 CF-036, factory-result or reviewed-declaration lineage is substituted or blocked.");
  const action = input.factoryResult.actionBinding, observer = input.factoryResult.observerBinding;
  if (action.targetAlias !== lineage.targetAlias || observer.targetAlias !== lineage.targetAlias || lineage.actionScope !== `${action.operation.method} ${action.operation.pathTemplate}` || lineage.observerScope !== `${observer.operation.method} ${observer.operation.pathTemplate}`) throw new Error("CF-058 reviewed target or action/observer scope does not match the CF-053 contract.");
  if (action.operation.operationId !== input.workPack.roles.find((item) => item.review.role === "action")?.method.methodName || observer.operation.operationId !== input.workPack.roles.find((item) => item.review.role === "independent-observer")?.method.methodName) throw new Error("CF-058 HTTP operations do not match the reviewed action and observer SDK methods.");
  const inputKeys = lineage.inputSchema.map((field) => field.key).sort(), actionInputKeys = action.requestMappings.flatMap((mapping) => mapping.source.kind === "workflow-input" ? [mapping.source.inputKey] : []).sort();
  if (new Set(actionInputKeys).size !== actionInputKeys.length || !same(actionInputKeys, inputKeys) || action.reconciliationKeySource.kind !== "workflow-input" || !lineage.stableIdentityKeys.includes(action.reconciliationKeySource.inputKey)) throw new Error("CF-058 action serialization or stable reconciliation identity is not the exact CF-053 input contract.");
  const observerStableKeys = observer.parameterBindings.flatMap((item) => item.purpose === "stable-identifier" && item.source.kind === "workflow-input" ? [item.source.inputKey] : []).sort();
  const outcomeKeys = observer.predicates.filter((predicate) => predicate.operator === "equals-input").map((predicate) => predicate.inputKey!).sort();
  if (!same(observerStableKeys, [...lineage.stableIdentityKeys].sort()) || !same(outcomeKeys, [...lineage.exactOutcomeKeys].sort()) || observer.actionResponseEligibleAsProof !== false) throw new Error("CF-058 observer stable identity, exact input predicates or proof independence diverged from CF-053.");
  const actionAlias = action.credentialAlias, observerAlias = observer.credentialAlias;
  const actionRoles = input.workPack.roles.filter((item) => item.review.role === "action" || item.review.role === "no-write-probe"), observerRoles = input.workPack.roles.filter((item) => item.review.role === "reconciliation-readback" || item.review.role === "independent-observer");
  if (actionAlias === observerAlias || actionRoles.some((item) => !item.method.authAliasRequirements.includes(actionAlias) || item.method.authAliasRequirements.includes(observerAlias)) || observerRoles.some((item) => !item.method.authAliasRequirements.includes(observerAlias) || item.method.authAliasRequirements.includes(actionAlias))) throw new Error("CF-058 action and independent-observer credential boundaries are conflated or unreviewed.");
  const reviewedMethodIdentities = verifiedMethodIdentities(input.workPack, lineage.executionBinding.roles);
  const body: Omit<Cf058CausalBridgeReceipt, "bridgeDigest"> = { schemaVersion: CF058_OPAQUE_CAUSAL_HTTP_BRIDGE_VERSION, state: "causal-lineage-joined-nonactivating", candidateDigest: lineage.candidateDigest, cf053ContractDigest: lineage.contractDigest, cf036WorkPackDigest: workPackDigest, cf041ReviewedContractDigest: lineage.sourceChain.cf041ReviewedContractDigest, factoryResultDigest: input.factoryResult.resultDigest, targetAlias: lineage.targetAlias, actionScope: lineage.actionScope, observerScope: lineage.observerScope, inputSchemaDigest: cf058CausalBridgeDigest(lineage.inputSchema), stableIdentityDigest: cf058CausalBridgeDigest(lineage.stableIdentityKeys), exactOutcomePredicateDigest: cf058CausalBridgeDigest({ keys: lineage.exactOutcomeKeys, predicates: observer.predicates }), credentialSeparationDigest: cf058CausalBridgeDigest({ actionAlias, observerAlias, observerSourceId: observer.sourceId }), reviewedMethodIdentities, executionAuthorityEffect: "none", activationEffect: "none" };
  const receipt = Object.freeze({ ...body, bridgeDigest: cf058CausalBridgeDigest(body) }), handle = Object.freeze({ bridgeDigest: receipt.bridgeDigest });
  bridgeHandles.set(handle, { receipt, factoryResultDigest: input.factoryResult.resultDigest, candidateDigest: lineage.candidateDigest });
  return { handle, receipt };
}

export interface Cf058CausallyBoundCompiledHttpPair {
  schemaVersion: "1.0";
  state: "compiled-acceptance-only-causally-bound";
  causalBridgeDigest: string;
  compiledPair: CompiledHttpBindingPair;
  boundPairDigest: string;
}

export function compileCf058AuthorityEnforcedReviewedHttpBindings(input: CompileAuthorityEnforcedHttpBindingsInput & { causalBridge: Cf058CausalBridgeHandle }): Cf058CausallyBoundCompiledHttpPair {
  const joined = bridgeHandles.get(input.causalBridge as object);
  if (!joined || joined.receipt.bridgeDigest !== input.causalBridge.bridgeDigest || joined.factoryResultDigest !== input.factoryResult.resultDigest) throw new Error("CF-058 compilation requires the exact opaque causal bridge for this factory result.");
  const { causalBridge: _causalBridge, ...compilerInput } = input;
  const compiledPair = compileAuthorityEnforcedReviewedHttpBindings(compilerInput);
  const body = { schemaVersion: "1.0" as const, state: "compiled-acceptance-only-causally-bound" as const, causalBridgeDigest: joined.receipt.bridgeDigest, compiledPair };
  return Object.freeze({ ...body, boundPairDigest: cf058CausalBridgeDigest({ causalBridgeDigest: joined.receipt.bridgeDigest, compiledPairDigest: compiledPair.pairDigest }) });
}
