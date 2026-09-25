import type { BroadGoalRuntimeResolver, BroadGoalScopeResolver, ValidatedGoalPlanStore } from "./broad-goal-sdk.js";
import { BroadGoalCoordinatorSdk } from "./broad-goal-sdk.js";
import type { GoalPlanner } from "./goal-coordination.js";
import { CURRENT_CAPABILITY_MODE, type SupportedCapabilityMode } from "./pilot-readiness.js";

export const PILOT_ADAPTER_SCHEMA_VERSION = "1.0" as const;

export const REQUIRED_PILOT_ADAPTER_CASES = [
  "read-only-happy-path",
  "approved-write",
  "fresh-process-reuse",
  "missing-credential",
  "missing-permission",
  "lost-response-reconciliation",
  "wrong-or-partial-outcome",
  "sidecar-restart",
  "duplicate-submission",
  "conflicting-parent-reuse",
] as const;

export type PilotAdapterAcceptanceCase = (typeof REQUIRED_PILOT_ADAPTER_CASES)[number];

export interface PilotAdapterOperationDescriptor {
  name: string;
  targetAlias: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  consequence: "read" | "write";
  retrySafety: "not-applicable" | "reconcile-before-retry";
  outcomeVerifierKey: string;
}

export interface PilotAdapterDescriptor {
  schemaVersion: typeof PILOT_ADAPTER_SCHEMA_VERSION;
  adapterId: string;
  adapterVersion: string;
  capabilityMode: SupportedCapabilityMode;
  environmentId: string;
  scopeKeys: string[];
  workflowKeys: string[];
  targetAliases: string[];
  credentialAliases: string[];
  documentation: Array<{ targetAlias: string; sha256: string }>;
  operations: PilotAdapterOperationDescriptor[];
  acceptanceCases: PilotAdapterAcceptanceCase[];
  dataBoundary: {
    execution: "customer-local";
    credentials: "customer-local-alias-only";
    externalVerification: "customer-local-independent";
  };
}

export interface PilotAdapterCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface PilotAdapterAcceptanceResult {
  caseId: PilotAdapterAcceptanceCase;
  passed: boolean;
  intendedWrites: number;
  incorrectSideEffects: number;
  checks: PilotAdapterCheck[];
  artifactReferences: string[];
  completedAt: string;
}

export interface PilotAdapterAcceptanceHarness {
  caseIds: PilotAdapterAcceptanceCase[];
  run(caseId: PilotAdapterAcceptanceCase): Promise<PilotAdapterAcceptanceResult>;
}

export interface PilotAdapterAcceptanceSummary {
  passed: boolean;
  abortedForSafety: boolean;
  requiredCases: number;
  completedCases: number;
  failedCases: PilotAdapterAcceptanceCase[];
  notRunCases: PilotAdapterAcceptanceCase[];
  incorrectSideEffects: number;
  results: PilotAdapterAcceptanceResult[];
}

export interface ControlledPilotAdapter {
  descriptor: PilotAdapterDescriptor;
  scopes: BroadGoalScopeResolver;
  runtimes: BroadGoalRuntimeResolver;
  /** Deterministic, read-only setup checks. It must not make a consequential write. */
  preflight(): Promise<PilotAdapterCheck[]>;
  /** Optional until a customer-specific acceptance implementation is supplied. */
  acceptance?: PilotAdapterAcceptanceHarness;
}

const identifier = /^[a-z][a-z0-9_-]{2,159}$/;
const aliasIdentifier = /^[a-zA-Z][a-zA-Z0-9_-]{2,159}$/;
const semver = /^\d+\.\d+\.\d+$/;
const sha256 = /^[a-f0-9]{64}$/;
const obviousSecret = /(bearer\s+[a-z0-9._~-]{8,}|token\s+[a-z0-9_-]{4,}:[a-z0-9_-]{4,}|sk-[a-z0-9_-]{12,})/i;

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function check(id: string, passed: boolean, detail: string): PilotAdapterCheck {
  return { id, passed, detail };
}

export function validatePilotAdapterDescriptor(descriptor: PilotAdapterDescriptor): PilotAdapterCheck[] {
  const serialized = JSON.stringify(descriptor);
  const declaredCases = new Set(descriptor.acceptanceCases);
  const writeOperations = descriptor.operations.filter((operation) => operation.consequence === "write");
  return [
    check("schema-version", descriptor.schemaVersion === PILOT_ADAPTER_SCHEMA_VERSION, "The adapter uses the supported descriptor schema."),
    check("capability-mode", descriptor.capabilityMode === CURRENT_CAPABILITY_MODE, "The current pilot accepts only the constrained HTTP API driver."),
    check("adapter-identity", identifier.test(descriptor.adapterId) && semver.test(descriptor.adapterVersion), "The adapter has a stable ID and semantic version."),
    check("environment-identity", identifier.test(descriptor.environmentId), "The customer-controlled environment has a stable alias."),
    check("scope-keys", descriptor.scopeKeys.length > 0 && unique(descriptor.scopeKeys) && descriptor.scopeKeys.every((value) => identifier.test(value)), "At least one unique trusted scope key is declared."),
    check("workflow-keys", descriptor.workflowKeys.length > 0 && unique(descriptor.workflowKeys) && descriptor.workflowKeys.every((value) => identifier.test(value)), "At least one unique workflow key is declared."),
    check("target-aliases", descriptor.targetAliases.length > 0 && unique(descriptor.targetAliases) && descriptor.targetAliases.every((value) => aliasIdentifier.test(value)), "Targets are represented by unique aliases."),
    check("credential-aliases", descriptor.credentialAliases.length > 0 && unique(descriptor.credentialAliases) && descriptor.credentialAliases.every((value) => aliasIdentifier.test(value)), "Credentials are represented by unique aliases."),
    check("no-obvious-secret-values", !obviousSecret.test(serialized), "The adapter descriptor contains aliases and hashes, not obvious credential values."),
    check("documentation", descriptor.documentation.length > 0 && descriptor.documentation.every((item) => descriptor.targetAliases.includes(item.targetAlias) && sha256.test(item.sha256)), "Every documentation record belongs to a declared target and has a SHA-256 digest."),
    check("operations", descriptor.operations.length > 0 && unique(descriptor.operations.map((item) => item.name)) && descriptor.operations.every((item) => aliasIdentifier.test(item.name) && descriptor.targetAliases.includes(item.targetAlias) && aliasIdentifier.test(item.outcomeVerifierKey)), "Every operation is unique, bounded to a target and linked to an independent verifier."),
    check("write-reconciliation", writeOperations.every((operation) => operation.retrySafety === "reconcile-before-retry"), "Every declared write requires inspection before retry."),
    check("data-boundary", descriptor.dataBoundary.execution === "customer-local" && descriptor.dataBoundary.credentials === "customer-local-alias-only" && descriptor.dataBoundary.externalVerification === "customer-local-independent", "Execution, secrets and direct verification remain inside the customer-controlled boundary."),
    check("acceptance-coverage", REQUIRED_PILOT_ADAPTER_CASES.every((caseId) => declaredCases.has(caseId)) && unique(descriptor.acceptanceCases), "The adapter declares every mandatory controlled-pilot acceptance case exactly once."),
  ];
}

export async function preflightControlledPilotAdapter(adapter: ControlledPilotAdapter): Promise<PilotAdapterCheck[]> {
  const descriptorChecks = validatePilotAdapterDescriptor(adapter.descriptor);
  let adapterChecks: PilotAdapterCheck[];
  try {
    adapterChecks = await adapter.preflight();
  } catch (error) {
    adapterChecks = [{
      id: "adapter-preflight",
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    }];
  }
  if (adapterChecks.length === 0) {
    adapterChecks = [{ id: "adapter-preflight", passed: false, detail: "The adapter returned no preflight checks." }];
  }
  return [...descriptorChecks, ...adapterChecks];
}

export function validatePilotAdapterAcceptanceHarness(
  harness: PilotAdapterAcceptanceHarness | undefined,
): PilotAdapterCheck[] {
  if (!harness) {
    return [{ id: "acceptance-harness", passed: false, detail: "No executable customer-adapter acceptance harness is configured." }];
  }
  return [{
    id: "acceptance-harness-coverage",
    passed: unique(harness.caseIds)
      && harness.caseIds.length === REQUIRED_PILOT_ADAPTER_CASES.length
      && REQUIRED_PILOT_ADAPTER_CASES.every((caseId) => harness.caseIds.includes(caseId)),
    detail: "The executable harness covers every required controlled-pilot case exactly once.",
  }];
}

/**
 * Runs acceptance cases in the precommitted order. Any surviving incorrect
 * side effect stops the campaign immediately; later cases cannot compensate.
 */
export async function runPilotAdapterAcceptance(
  adapter: ControlledPilotAdapter,
): Promise<PilotAdapterAcceptanceSummary> {
  const harnessChecks = validatePilotAdapterAcceptanceHarness(adapter.acceptance);
  if (harnessChecks.some((item) => !item.passed) || !adapter.acceptance) {
    throw new Error(harnessChecks.filter((item) => !item.passed).map((item) => item.detail).join(" "));
  }
  return runPilotAdapterAcceptanceHarness(adapter.acceptance);
}

/** Runs a standalone executable adapter harness before it is connected to a full customer adapter. */
export async function runPilotAdapterAcceptanceHarness(
  harness: PilotAdapterAcceptanceHarness,
): Promise<PilotAdapterAcceptanceSummary> {
  const harnessChecks = validatePilotAdapterAcceptanceHarness(harness);
  if (harnessChecks.some((item) => !item.passed)) {
    throw new Error(harnessChecks.filter((item) => !item.passed).map((item) => item.detail).join(" "));
  }
  const results: PilotAdapterAcceptanceResult[] = [];
  let abortedForSafety = false;
  for (const caseId of REQUIRED_PILOT_ADAPTER_CASES) {
    const result = await harness.run(caseId);
    if (result.caseId !== caseId) throw new Error(`Acceptance harness returned ${result.caseId} while running ${caseId}.`);
    if (result.checks.length === 0) throw new Error(`Acceptance case ${caseId} returned no checks.`);
    if (result.passed && (result.checks.some((item) => !item.passed) || result.artifactReferences.length === 0)) {
      throw new Error(`Acceptance case ${caseId} claimed success without complete checks and saved evidence.`);
    }
    results.push(structuredClone(result));
    if (result.incorrectSideEffects > 0) {
      abortedForSafety = true;
      break;
    }
  }
  const completed = new Set(results.map((result) => result.caseId));
  const notRunCases = REQUIRED_PILOT_ADAPTER_CASES.filter((caseId) => !completed.has(caseId));
  const failedCases = results.filter((result) => !result.passed).map((result) => result.caseId);
  const incorrectSideEffects = results.reduce((total, result) => total + result.incorrectSideEffects, 0);
  return {
    passed: results.length === REQUIRED_PILOT_ADAPTER_CASES.length
      && failedCases.length === 0
      && incorrectSideEffects === 0,
    abortedForSafety,
    requiredCases: REQUIRED_PILOT_ADAPTER_CASES.length,
    completedCases: results.length,
    failedCases,
    notRunCases: [...notRunCases],
    incorrectSideEffects,
    results,
  };
}

export interface ControlledPilotSdkOptions {
  planner: GoalPlanner;
  plans: ValidatedGoalPlanStore;
  maxPlanningAttempts?: number;
}

/** Standard connection from a validated customer adapter into the shared broad-goal product core. */
export async function createControlledPilotSdk(
  adapter: ControlledPilotAdapter,
  options: ControlledPilotSdkOptions,
): Promise<BroadGoalCoordinatorSdk> {
  const checks = await preflightControlledPilotAdapter(adapter);
  const failures = checks.filter((item) => !item.passed);
  if (failures.length > 0) {
    throw new Error(`Pilot adapter preflight failed: ${failures.map((item) => item.id).join(", ")}`);
  }
  return new BroadGoalCoordinatorSdk({
    planner: options.planner,
    plans: options.plans,
    scopes: adapter.scopes,
    runtimes: adapter.runtimes,
    ...(options.maxPlanningAttempts === undefined ? {} : { maxPlanningAttempts: options.maxPlanningAttempts }),
  });
}
