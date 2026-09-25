import { createHash } from "node:crypto";
import { DurableExternalMonotonicContinuityAnchor, type ExternalMonotonicContinuityCheckpoint } from "./external-monotonic-continuity-anchor.js";

const trustedGuards = new WeakSet<object>();
const digestPattern = /^[a-f0-9]{64}$/;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

export interface CustomerLocalAuthorityContinuityIdentity {
  schemaVersion: "1.0";
  anchorConfigurationDigest: string;
  tenantId: string;
  installationId: string;
  workspaceId: string;
  authorityContractDigest: string;
  trustConfigurationDigest: string;
  recoveryManifestDigest: string;
  recoveryReceiptDigest: string;
  recoveryCheckpointDigest: string;
  completionCheckpointDigest: string;
  completionGeneration: number;
  identityDigest: string;
}

export interface CustomerLocalAuthorityContinuityGuard extends CustomerLocalAuthorityContinuityIdentity {
  assertCurrent(): void;
  withCurrentConsumption<T>(consume: () => T): T;
}

export function createCustomerLocalAuthorityContinuityGuard(input: {
  anchor: DurableExternalMonotonicContinuityAnchor;
  recoveryManifestDigest: string;
  recoveryReceiptDigest: string;
  recoveryCheckpointDigest: string;
  completionCheckpoint: ExternalMonotonicContinuityCheckpoint;
}): CustomerLocalAuthorityContinuityGuard {
  for (const value of [input.recoveryManifestDigest, input.recoveryReceiptDigest, input.recoveryCheckpointDigest, input.completionCheckpoint.checkpointDigest]) if (!digestPattern.test(value)) throw new Error("Authority continuity guard contains an invalid digest.");
  const descriptor = input.anchor.descriptor(), completion = input.anchor.assertCurrentRestoreCompletion({ recoveryManifestDigest: input.recoveryManifestDigest, recoveryReceiptDigest: input.recoveryReceiptDigest, completionCheckpointDigest: input.completionCheckpoint.checkpointDigest });
  if (completion.checkpointDigest !== input.completionCheckpoint.checkpointDigest || completion.generation !== input.completionCheckpoint.generation || completion.kind !== "restore-completed") throw new Error("Authority continuity completion checkpoint was substituted.");
  const body = {
    schemaVersion: "1.0" as const, anchorConfigurationDigest: descriptor.configurationDigest,
    tenantId: descriptor.tenantId, installationId: descriptor.installationId, workspaceId: descriptor.workspaceId,
    authorityContractDigest: descriptor.authorityContractDigest, trustConfigurationDigest: descriptor.trustConfigurationDigest,
    recoveryManifestDigest: input.recoveryManifestDigest, recoveryReceiptDigest: input.recoveryReceiptDigest,
    recoveryCheckpointDigest: input.recoveryCheckpointDigest, completionCheckpointDigest: completion.checkpointDigest,
    completionGeneration: completion.generation,
  };
  const check = () => { input.anchor.assertCurrentRestoreCompletion({ recoveryManifestDigest: body.recoveryManifestDigest, recoveryReceiptDigest: body.recoveryReceiptDigest, completionCheckpointDigest: body.completionCheckpointDigest }); };
  const guard: CustomerLocalAuthorityContinuityGuard = Object.freeze({
    ...body, identityDigest: digest(body), assertCurrent: check,
    withCurrentConsumption<T>(consume: () => T): T { return input.anchor.withCurrentRestoreCompletion({ recoveryManifestDigest: body.recoveryManifestDigest, recoveryReceiptDigest: body.recoveryReceiptDigest, completionCheckpointDigest: body.completionCheckpointDigest }, consume); },
  });
  trustedGuards.add(guard);
  return guard;
}

export function assertTrustedCustomerLocalAuthorityContinuityGuard(guard: CustomerLocalAuthorityContinuityGuard): void {
  if (!trustedGuards.has(guard)) throw new Error("Authority continuity guard is not an instance of the trusted external-anchor implementation.");
  guard.assertCurrent();
}
