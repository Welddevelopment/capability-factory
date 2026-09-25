import type {
  PilotAdapterAcceptanceCase,
  PilotAdapterAcceptanceHarness,
  PilotAdapterAcceptanceSummary,
  PilotAdapterCheck,
} from "../product/pilot-adapter.js";
import {
  REQUIRED_PILOT_ADAPTER_CASES,
  runPilotAdapterAcceptanceHarness,
} from "../product/pilot-adapter.js";
import {
  EXPERIMENTAL_BROWSER_CAPABILITY_MODE,
  EXPERIMENTAL_BROWSER_DRIVER_VERSION,
  experimentalBrowserLocatorSchema,
  type ExperimentalBrowserLocator,
} from "./browser-driver.js";

export const EXPERIMENTAL_BROWSER_ADAPTER_SCHEMA_VERSION = "0.1" as const;

export interface ExperimentalBrowserRequestPolicyDescriptor {
  path: string;
  query?: string;
  method: "GET" | "POST";
  purpose: "read" | "session-auth" | "business-write";
  maxPerSession: number;
}

export interface ExperimentalBrowserAdapterDescriptor {
  schemaVersion: typeof EXPERIMENTAL_BROWSER_ADAPTER_SCHEMA_VERSION;
  adapterId: string;
  adapterVersion: string;
  capabilityMode: typeof EXPERIMENTAL_BROWSER_CAPABILITY_MODE;
  driverVersion: typeof EXPERIMENTAL_BROWSER_DRIVER_VERSION;
  environmentId: string;
  scopeKeys: string[];
  workflowKeys: string[];
  targetAliases: string[];
  credentialAliases: string[];
  uiContracts: Array<{
    targetAlias: string;
    contractHash: string;
    allowedNavigationPaths: string[];
    allowedRequests: ExperimentalBrowserRequestPolicyDescriptor[];
    allowedLocators: ExperimentalBrowserLocator[];
  }>;
  operations: Array<{
    name: string;
    targetAlias: string;
    consequence: "read" | "write";
    retrySafety: "not-applicable" | "reconcile-before-retry";
    outcomeVerifierKey: string;
    approvalKey?: string;
  }>;
  acceptanceCases: PilotAdapterAcceptanceCase[];
  dataBoundary: {
    execution: "customer-local";
    credentials: "customer-local-alias-only";
    browserSession: "ephemeral-customer-local";
    externalVerification: "customer-local-independent";
  };
}

export interface ExperimentalBrowserPilotAdapter {
  descriptor: ExperimentalBrowserAdapterDescriptor;
  preflight(): Promise<PilotAdapterCheck[]>;
  acceptance: PilotAdapterAcceptanceHarness;
}

const identifier = /^[a-z][a-z0-9_-]{2,159}$/;
const alias = /^[a-zA-Z][a-zA-Z0-9_-]{2,159}$/;
const semver = /^\d+\.\d+\.\d+$/;
const sha256 = /^[a-f0-9]{64}$/;
const obviousSecret = /(bearer\s+[a-z0-9._~-]{8,}|token\s+[a-z0-9_-]{4,}:[a-z0-9_-]{4,}|sk-[a-z0-9_-]{12,})/i;

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function check(id: string, passed: boolean, detail: string): PilotAdapterCheck {
  return { id, passed, detail };
}

/**
 * Experimental equivalent of the HTTP adapter descriptor. It deliberately
 * cannot be passed to createControlledPilotSdk or satisfy HTTP readiness.
 */
export function validateExperimentalBrowserAdapterDescriptor(
  descriptor: ExperimentalBrowserAdapterDescriptor,
): PilotAdapterCheck[] {
  const declaredCases = new Set(descriptor.acceptanceCases);
  const serialized = JSON.stringify(descriptor);
  const uiTargets = new Set(descriptor.uiContracts.map((contract) => contract.targetAlias));
  const allRequestKeys = descriptor.uiContracts.flatMap((contract) =>
    contract.allowedRequests.map((request) => `${contract.targetAlias}:${request.method}:${request.path}${request.query ?? ""}`),
  );
  const allLocatorsValid = descriptor.uiContracts.every((contract) =>
    contract.allowedLocators.length > 0 &&
    unique(contract.allowedLocators.map((locator) => JSON.stringify(locator))) &&
    contract.allowedLocators.every((locator) => experimentalBrowserLocatorSchema.safeParse(locator).success),
  );
  const navigationCovered = descriptor.uiContracts.every((contract) => {
    const policies = new Set(contract.allowedRequests.map((request) => `${request.method}:${request.path}`));
    return contract.allowedNavigationPaths.length > 0 &&
      contract.allowedNavigationPaths.every((pathname) => policies.has(`GET:${pathname}`));
  });
  const requestPurposesValid = descriptor.uiContracts.every((contract) =>
    contract.allowedRequests.length > 0 && contract.allowedRequests.every((request) =>
      request.path.startsWith("/") && (request.query === undefined || (request.method === "GET" && request.query.startsWith("?"))) && Number.isInteger(request.maxPerSession) && request.maxPerSession > 0 &&
      (request.method === "GET" ? request.purpose === "read" : request.purpose !== "read"),
    ),
  );
  const writeOperations = descriptor.operations.filter((operation) => operation.consequence === "write");
  return [
    check("schema-version", descriptor.schemaVersion === EXPERIMENTAL_BROWSER_ADAPTER_SCHEMA_VERSION, "The browser adapter uses the isolated experimental descriptor schema."),
    check("experimental-mode", descriptor.capabilityMode === EXPERIMENTAL_BROWSER_CAPABILITY_MODE, "The descriptor cannot be mistaken for the supported constrained HTTP mode."),
    check("driver-version", descriptor.driverVersion === EXPERIMENTAL_BROWSER_DRIVER_VERSION, "The descriptor is pinned to the installed browser driver version."),
    check("adapter-identity", identifier.test(descriptor.adapterId) && semver.test(descriptor.adapterVersion), "The adapter has a stable ID and semantic version."),
    check("environment-identity", identifier.test(descriptor.environmentId), "The disposable browser environment has a stable alias."),
    check("scope-and-workflow", descriptor.scopeKeys.length > 0 && descriptor.workflowKeys.length > 0 && unique(descriptor.scopeKeys) && unique(descriptor.workflowKeys) && descriptor.scopeKeys.every((value) => identifier.test(value)) && descriptor.workflowKeys.every((value) => identifier.test(value)), "Trusted scopes and workflows are declared explicitly."),
    check("target-aliases", descriptor.targetAliases.length > 0 && unique(descriptor.targetAliases) && descriptor.targetAliases.every((value) => alias.test(value)), "Browser targets use unique aliases."),
    check("credential-aliases", descriptor.credentialAliases.length > 0 && unique(descriptor.credentialAliases) && descriptor.credentialAliases.every((value) => alias.test(value)), "Browser credentials are represented only by aliases."),
    check("no-obvious-secret-values", !obviousSecret.test(serialized), "The descriptor contains aliases and hashes, not obvious credential values."),
    check("ui-contracts", descriptor.uiContracts.length > 0 && descriptor.uiContracts.every((contract) => descriptor.targetAliases.includes(contract.targetAlias) && sha256.test(contract.contractHash)) && descriptor.targetAliases.every((target) => uiTargets.has(target)), "Every target is bound to a hashed trusted UI contract."),
    check("request-policies", requestPurposesValid && unique(allRequestKeys) && navigationCovered, "Every navigation, session-auth request and business write has an exact method/path/purpose/count policy."),
    check("semantic-locators", allLocatorsValid, "Every UI control uses a unique bounded semantic locator."),
    check("operations", descriptor.operations.length > 0 && unique(descriptor.operations.map((operation) => operation.name)) && descriptor.operations.every((operation) => alias.test(operation.name) && descriptor.targetAliases.includes(operation.targetAlias) && alias.test(operation.outcomeVerifierKey)), "Every operation is bounded to one target and independent verifier."),
    check("write-controls", writeOperations.length > 0 && writeOperations.every((operation) => operation.retrySafety === "reconcile-before-retry" && Boolean(operation.approvalKey)), "Every browser business write requires exact approval and reconcile-before-retry."),
    check("data-boundary", descriptor.dataBoundary.execution === "customer-local" && descriptor.dataBoundary.credentials === "customer-local-alias-only" && descriptor.dataBoundary.browserSession === "ephemeral-customer-local" && descriptor.dataBoundary.externalVerification === "customer-local-independent", "Execution, session, credentials and outcome verification remain customer-local."),
    check("acceptance-coverage", unique(descriptor.acceptanceCases) && REQUIRED_PILOT_ADAPTER_CASES.every((caseId) => declaredCases.has(caseId)), "The experimental adapter declares all ten mandatory acceptance cases."),
  ];
}

export async function preflightExperimentalBrowserPilotAdapter(
  adapter: ExperimentalBrowserPilotAdapter,
): Promise<PilotAdapterCheck[]> {
  let adapterChecks: PilotAdapterCheck[];
  try {
    adapterChecks = await adapter.preflight();
  } catch (error) {
    adapterChecks = [{ id: "browser-adapter-preflight", passed: false, detail: error instanceof Error ? error.message : String(error) }];
  }
  if (adapterChecks.length === 0) {
    adapterChecks = [{ id: "browser-adapter-preflight", passed: false, detail: "The browser adapter returned no environment preflight checks." }];
  }
  return [...validateExperimentalBrowserAdapterDescriptor(adapter.descriptor), ...adapterChecks];
}

export async function runExperimentalBrowserPilotAcceptance(
  adapter: ExperimentalBrowserPilotAdapter,
): Promise<PilotAdapterAcceptanceSummary> {
  const preflight = await preflightExperimentalBrowserPilotAdapter(adapter);
  const failures = preflight.filter((item) => !item.passed);
  if (failures.length > 0) {
    throw new Error(`Experimental browser adapter preflight failed: ${failures.map((item) => item.id).join(", ")}`);
  }
  return runPilotAdapterAcceptanceHarness(adapter.acceptance);
}
