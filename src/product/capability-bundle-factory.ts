import type { CapabilityMode, CapabilityModeEnvelope } from "./capability-mode-contract.js";
import { capabilityModeIdentity } from "./capability-mode-contract.js";
import {
  capabilityBundleSchema,
  type CapabilityBundle,
  type CapabilityBundleSource,
  type ExecutionRisk,
  type RuntimeFamily,
} from "./universal-capability-contract.js";
import type { PreparedCapabilityRoute } from "./universal-capability-coordinator.js";

const MODE_FAMILY: Record<CapabilityMode, RuntimeFamily> = {
  "constrained-http-api": "service-api",
  "experimental-browser-actions": "browser-web",
  "experimental-file-transfer-actions": "file-object-edi",
  "experimental-inbox-message-actions": "message-event",
  "experimental-document-actions": "document-media",
  "experimental-database-actions": "database-query",
  "experimental-trusted-tool-actions": "trusted-tool-code",
  "experimental-agent-delegation-actions": "agent-service-delegation",
};

export interface CapabilityBundleBuildInput {
  envelope: CapabilityModeEnvelope;
  needKey: string;
  summary: string;
  capabilityId: string;
  source: CapabilityBundleSource;
  driverId: string;
  driverVersion: string;
  executionBoundary: "customer-local" | "isolated-sandbox" | "delegated";
  manifest: { mediaType: string; digest: string; reference: string; generated: boolean };
  authority: {
    targetAliases: string[];
    secretAliases: string[];
    approvalKeys: string[];
    risk: ExecutionRisk;
    expiresAt?: string;
  };
  verification: {
    preUseVerifierKey: string;
    outcomeVerifierKey: string;
    observationSource: string;
    contractHash: string;
  };
  recovery: {
    operationKey: string;
    idempotency: "required" | "not-applicable" | "unavailable";
    quarantineOn: Array<"verification-failure" | "policy-escape" | "partial-outcome" | "incorrect-outcome" | "unknown-outcome" | "drift">;
  };
  provenance: {
    trustedSourceIds: string[];
    sourceHashes: string[];
    builderVersion: string;
    builtAt: string;
  };
  retention: { version: number; reusable: boolean; scopeDigest: string; expiresAt?: string };
}

/** Builds the complete cross-mode object while preserving each driver's family identity. */
export function buildCapabilityBundle(input: CapabilityBundleBuildInput): CapabilityBundle {
  const identity = capabilityModeIdentity(input.envelope);
  return capabilityBundleSchema.parse({
    schemaVersion: "1.0",
    capabilityId: input.capabilityId,
    tenantId: identity.tenantId,
    needKey: input.needKey,
    summary: input.summary,
    source: input.source,
    runtime: {
      family: MODE_FAMILY[input.envelope.capabilityMode],
      driverId: input.driverId,
      driverVersion: input.driverVersion,
      executionBoundary: input.executionBoundary,
    },
    manifest: input.manifest,
    authority: input.authority,
    verification: {
      ...input.verification,
      independentFromExecution: true,
    },
    recovery: {
      ...input.recovery,
      reconcileBeforeRetry: true,
      blindRetryAllowed: false,
    },
    provenance: input.provenance,
    retention: input.retention,
  });
}

export interface PreparedRouteBuildInput extends CapabilityBundleBuildInput {
  routeId: string;
  supportedActions: string[];
  observationKeys: string[];
  priority: number;
}

/**
 * Shared adapter used by current and future drivers. It prevents a driver from
 * declaring a family different from the mode encoded in its strict envelope.
 */
export function prepareCapabilityRoute(input: PreparedRouteBuildInput): PreparedCapabilityRoute {
  const bundle = buildCapabilityBundle(input);
  return {
    routeId: input.routeId,
    family: bundle.runtime.family,
    envelope: input.envelope,
    bundle,
    supportedActions: [...input.supportedActions],
    targetAliases: [...input.authority.targetAliases],
    observationKeys: [...input.observationKeys],
    requiredSecretAliases: [...input.authority.secretAliases],
    requiredApprovalKeys: [...input.authority.approvalKeys],
    priority: input.priority,
  };
}
