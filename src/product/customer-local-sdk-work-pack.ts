import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { HttpBindingFactoryResult } from "./http-binding-factory.js";
import type { PluginScaffoldMetadata } from "./customer-local-plugin-scaffold.js";

export const CUSTOMER_LOCAL_SDK_WORK_PACK_VERSION = "1.0" as const;
const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{1,119}$/;
const safeType = /^(?:string|number|boolean|unknown|void|Record<string, unknown>|Array<string>|Promise<(?:string|number|boolean|unknown|void|Record<string, unknown>|Array<string>)>)$/;
const forbidden = /\b(?:eval|Function|child_process|exec|spawn|require|import\s*\(|postinstall|preinstall|prepare)\b|(?:bearer|password|secret|token|api[_ -]?key)\s*[:=]\s*[^\s,;}]+/i;
const canonical = (value: unknown): string => { if (value === undefined) return "undefined"; if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); };
export const sdkWorkPackDigest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");

export interface ApprovedSdkMethodParameter { name: string; type: string; required: boolean; sourcePointer: string }
export interface ApprovedSdkMethod {
  module: string; className?: string; methodName: string; overloadId: string; parameters: ApprovedSdkMethodParameter[]; returnType: string;
  errorTypes: string[]; authAliasRequirements: string[]; pagination: "none" | "cursor" | "offset" | "unknown";
  retryCandidate: "never" | "read-only" | "idempotency-key" | "unknown"; idempotencyCandidate: string | null;
  sourcePointer: string;
}
export interface ApprovedLocalSdkIndex {
  schemaVersion: "1.0"; providerId: string; sourceKind: "typescript-declarations" | "reference-json" | "mcp-descriptor" | "minimal-sdk-index";
  localReference: string; sourceDigest: string; approved: true; allowedImports: string[]; methods: ApprovedSdkMethod[];
}
export interface SdkRoleReview {
  role: "action" | "no-write-probe" | "reconciliation-readback" | "independent-observer"; module: string; className?: string;
  methodName: string; overloadId: string; expectedSourcePointer: string; reviewerAlias: string; reviewedAt: string; exactOneToOne: true;
}
export interface SdkImplementationWorkPack {
  schemaVersion: "1.0"; state: "engineer-implementation-required"; providerId: string; pluginId: string; sdkSourceDigest: string; factoryResultDigest: string;
  roles: Array<{ review: SdkRoleReview; method: ApprovedSdkMethod; methodDigest: string; provenance: { sourceKind: ApprovedLocalSdkIndex["sourceKind"]; localReference: string; sourcePointer: string; sdkSourceDigest: string } }>;
  normalized: { modules: string[]; classes: string[]; methodCount: number; parameterCount: number; returnShapeCount: number; errorShapeCount: number; authAliasRequirements: string[]; paginationCandidates: string[]; retryCandidates: string[]; idempotencyCandidates: string[] };
  blockedUnknowns: Array<{ blockerId: string; detail: string; engineerOwned: true }>;
  conformanceControls: Array<{ controlId: string; state: "not-run" }>;
  generatedFiles: string[]; generatedLines: number; mappedMethods: number; mappedFields: number; explicitReviews: number;
  executionAuthorityEffect: "none"; activationEffect: "none"; workPackDigest: string;
}

function assertSdk(index: ApprovedLocalSdkIndex): void {
  if (index.schemaVersion !== "1.0" || !identifier.test(index.providerId) || !/^(?:fixture:\/\/[a-zA-Z0-9_.\/-]+|file:\/\/[a-zA-Z0-9_.\/-]+|[a-zA-Z0-9_.\/-]+)$/.test(index.localReference) || index.localReference.includes("..") || !/^[a-f0-9]{64}$/.test(index.sourceDigest) || forbidden.test(canonical(index))) throw new Error("Approved local SDK index failed schema, path, digest or injection checks.");
  if (index.allowedImports.length === 0 || index.allowedImports.some((item) => !/^[a-zA-Z][a-zA-Z0-9_./-]{1,159}$/.test(item) || item.includes(".."))) throw new Error("SDK import allowlist is missing or unsafe.");
  const identities = new Set<string>();
  for (const method of index.methods) {
    for (const value of [method.module, method.className, method.methodName, method.overloadId].filter(Boolean) as string[]) if (!identifier.test(value)) throw new Error("SDK method identity is invalid.");
    const identity = canonical({ module: method.module, className: method.className, methodName: method.methodName, overloadId: method.overloadId }); if (identities.has(identity)) throw new Error("SDK method overload identity is ambiguous."); identities.add(identity);
    if (!safeType.test(method.returnType) || method.parameters.some((parameter) => !identifier.test(parameter.name) || !safeType.test(parameter.type))) throw new Error("SDK method contains an unsupported or mismatched type.");
    if (!index.allowedImports.includes(method.module)) throw new Error("SDK method module is not in the static import allowlist.");
  }
}
function selected(index: ApprovedLocalSdkIndex, review: SdkRoleReview): ApprovedSdkMethod {
  const matches = index.methods.filter((method) => method.module === review.module && method.className === review.className && method.methodName === review.methodName && method.overloadId === review.overloadId);
  if (matches.length !== 1 || matches[0]!.sourcePointer !== review.expectedSourcePointer) throw new Error(`Reviewed ${review.role} method is missing, ambiguous or source-mismatched.`);
  return matches[0]!;
}
function safeOutput(root: string, pluginId: string, file: string): string { const base = resolve(root, pluginId), target = resolve(base, file); if (!target.startsWith(`${base}${sep}`)) throw new Error("SDK work-pack output escaped the explicit root."); return target; }

export function generateCustomerLocalSdkWorkPack(input: { outputRoot: string; factoryResult: HttpBindingFactoryResult; scaffold: PluginScaffoldMetadata; sdk: ApprovedLocalSdkIndex; reviews: SdkRoleReview[] }): SdkImplementationWorkPack {
  assertSdk(input.sdk);
  if (input.factoryResult.status !== "review-required" || !input.factoryResult.actionBinding || !input.factoryResult.observerBinding) throw new Error("SDK work pack requires exact reviewed HTTP declarations.");
  if (input.reviews.length !== 4 || new Set(input.reviews.map((item) => item.role)).size !== 4 || input.reviews.some((item) => !item.exactOneToOne || !identifier.test(item.reviewerAlias))) throw new Error("Exactly one explicit review is required for each SDK role.");
  const roles = input.reviews.map((review) => { const method = selected(input.sdk, review); return { review: structuredClone(review), method: structuredClone(method), methodDigest: sdkWorkPackDigest(method), provenance: { sourceKind: input.sdk.sourceKind, localReference: input.sdk.localReference, sourcePointer: method.sourcePointer, sdkSourceDigest: input.sdk.sourceDigest } }; });
  const action = roles.find((item) => item.review.role === "action")!, probe = roles.find((item) => item.review.role === "no-write-probe")!, reconciliation = roles.find((item) => item.review.role === "reconciliation-readback")!, observer = roles.find((item) => item.review.role === "independent-observer")!;
  if (action.method.retryCandidate === "read-only" || action.method.retryCandidate === "never" && action.method.idempotencyCandidate) throw new Error("Action retry/idempotency metadata is internally unsafe.");
  if (action.method.methodName === observer.method.methodName || action.method.module === observer.method.module && action.method.className === observer.method.className || observer.method.authAliasRequirements.some((alias) => action.method.authAliasRequirements.includes(alias))) throw new Error("Action and independent observer are conflated by method, implementation surface or authentication alias.");
  if (probe.method.retryCandidate !== "read-only" || reconciliation.method.retryCandidate !== "read-only" || observer.method.retryCandidate !== "read-only") throw new Error("Probe, reconciliation and observer selections must be read-only candidates.");
  const imports = [...new Set(roles.map((item) => item.method.module))].sort();
  const importsCode = imports.map((module, index) => `import type * as SDK${index} from ${JSON.stringify(module)};`).join("\n");
  const skeleton = `${importsCode}\nvoid [${imports.map((_item, index) => `undefined as unknown as typeof SDK${index}`).join(", ")}];\nconst engineerRequired = (boundary: string): never => { throw new Error(boundary + " requires engineer-owned semantics; generated SDK skeleton is non-conformant."); };\nexport async function actionAdapter(_input: unknown): Promise<unknown> { return engineerRequired("action parameter mapping, authority and idempotency"); }\nexport async function noWriteProbe(): Promise<unknown> { return engineerRequired("no-write reachability semantics"); }\nexport async function reconcileLostResponse(_stableId: unknown): Promise<unknown> { return engineerRequired("stable identifier and reconciliation semantics"); }\nexport async function independentObserver(_stableId: unknown): Promise<unknown> { return engineerRequired("observer independence and outcome rules"); }\n`;
  const provenance = { schemaVersion: "1.0", sdkSourceDigest: input.sdk.sourceDigest, factoryResultDigest: input.factoryResult.resultDigest, roles: roles.map((item) => ({ role: item.review.role, methodDigest: item.methodDigest, sourcePointer: item.method.sourcePointer })), state: "engineer-implementation-required", authority: false, activation: false };
  const files: Record<string,string> = { "src/sdk-adapter-skeleton.ts": skeleton, "sdk-provenance.json": `${JSON.stringify(provenance, null, 2)}\n`, "test/sdk-role-controls.json": `${JSON.stringify({ roles: roles.map((item) => item.review.role), controls: ["source-digest", "method-identity", "parameter-mapping", "auth-alias", "stable-id", "idempotency", "reconciliation", "observer-independence", "outcome-rules"].map((controlId) => ({ controlId, state: "not-run" })) }, null, 2)}\n` };
  for (const [file, content] of Object.entries(files)) { if (/CF_CANARY_[A-Z0-9_-]+|(?:bearer|password|api[_ -]?key)\s*[:=]\s*[^\s,;}]+/i.test(content)) throw new Error("Generated SDK skeleton failed secret scan."); const target = safeOutput(input.outputRoot, input.scaffold.pluginId, file); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  const methods = input.sdk.methods, blockedUnknowns = ["stable-identifier-semantics", "action-parameter-mapping", "authority-binding", "idempotency-guarantee", "lost-response-reconciliation", "observer-independence", "outcome-classification", "pagination-completeness", "error-and-rate-policy"].map((blockerId) => ({ blockerId, detail: `${blockerId} requires explicit engineer-owned implementation and review.`, engineerOwned: true as const }));
  const normalized = { modules: [...new Set(methods.map((item) => item.module))].sort(), classes: [...new Set(methods.map((item) => item.className).filter(Boolean) as string[])].sort(), methodCount: methods.length, parameterCount: methods.reduce((sum, item) => sum + item.parameters.length, 0), returnShapeCount: new Set(methods.map((item) => item.returnType)).size, errorShapeCount: new Set(methods.flatMap((item) => item.errorTypes)).size, authAliasRequirements: [...new Set(methods.flatMap((item) => item.authAliasRequirements))].sort(), paginationCandidates: [...new Set(methods.map((item) => item.pagination))].sort(), retryCandidates: [...new Set(methods.map((item) => item.retryCandidate))].sort(), idempotencyCandidates: [...new Set(methods.map((item) => item.idempotencyCandidate).filter(Boolean) as string[])].sort() };
  const withoutDigest = { schemaVersion: "1.0" as const, state: "engineer-implementation-required" as const, providerId: input.sdk.providerId, pluginId: input.scaffold.pluginId, sdkSourceDigest: input.sdk.sourceDigest, factoryResultDigest: input.factoryResult.resultDigest, roles, normalized, blockedUnknowns, conformanceControls: Array.from({length:21},(_,index)=>({controlId:`cf030-${String(index+1).padStart(2,"0")}`,state:"not-run" as const})), generatedFiles: Object.keys(files).sort(), generatedLines: Object.values(files).reduce((sum,item)=>sum+item.split("\n").length,0), mappedMethods: roles.length, mappedFields: roles.reduce((sum,item)=>sum+item.method.parameters.length+1,0), explicitReviews: input.reviews.length, executionAuthorityEffect: "none" as const, activationEffect: "none" as const };
  return { ...withoutDigest, workPackDigest: sdkWorkPackDigest(withoutDigest) };
}
