import { createHash } from "node:crypto";
import type { CapabilityManifest } from "../manifest.js";
import { CapabilityRuntime } from "../runtime.js";
import type {
  AcquisitionResult,
  CapabilityEvent,
  CapabilityRequest,
  HandoffEnvelope,
  HandoffReason,
  VerificationCheck,
  VerificationReceipt,
} from "./contracts.js";
import { redactValue } from "./redaction.js";
import type { TenantCapabilityStore } from "./store.js";

export interface CapabilityBuilder {
  build(request: CapabilityRequest): Promise<CapabilityManifest>;
}

export interface RepairableCapabilityBuilder extends CapabilityBuilder {
  repair(
    request: CapabilityRequest,
    previousManifest: CapabilityManifest,
    verification: VerificationReceipt,
  ): Promise<CapabilityManifest>;
}

export interface TrustedCapabilityCandidate {
  manifest: CapabilityManifest;
  referenceId?: string;
}

/** Adapter for a trusted tool catalog or integration provider. Search results are still verified locally. */
export interface TrustedCapabilitySource {
  id: string;
  search(request: CapabilityRequest): Promise<TrustedCapabilityCandidate[]>;
}

export interface CapabilityVerifier {
  verify(
    request: CapabilityRequest,
    manifest: CapabilityManifest,
    runtime: CapabilityRuntime,
  ): Promise<VerificationReceipt>;
}

export interface RuntimeResolver {
  resolve(request: CapabilityRequest): CapabilityRuntime;
}

export interface CapabilityEventSink {
  record(event: CapabilityEvent): void | Promise<void>;
}

export interface CoordinatorDependencies {
  store: TenantCapabilityStore;
  builder: CapabilityBuilder;
  verifier: CapabilityVerifier;
  runtimeResolver: RuntimeResolver;
  trustedSources?: TrustedCapabilitySource[];
  events?: CapabilityEventSink;
  now?: () => string;
  maxVerificationRepairs?: number;
}

export function manifestDigest(manifest: CapabilityManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function authorityChecks(request: CapabilityRequest, manifest?: CapabilityManifest): VerificationCheck[] {
  const { authority, need } = request;
  const checks: VerificationCheck[] = [
    {
      id: "need-target-authority",
      passed: need.targetAliases.every((alias) => authority.allowedTargetAliases.includes(alias)),
      detail: "Every target requested by the diagnosed need must have customer-granted authority.",
    },
    {
      id: "need-secret-authority",
      passed: need.secretAliases.every((alias) => authority.allowedSecretAliases.includes(alias)),
      detail: "Every credential alias requested by the diagnosed need must have customer-granted authority.",
    },
  ];
  if (!manifest) return checks;

  const writeActions = manifest.actions.filter((action) => action.request.method !== "GET");
  const approvedWrites =
    authority.writeAuthority === "preauthorized" ||
    (authority.writeAuthority === "per-action-approval" &&
      writeActions.every((action) => authority.approvedWriteActions.includes(action.name)));
  checks.push(
    {
      id: "manifest-documentation-match",
      passed: manifest.provenance.documentationHash === need.documentationHash,
      detail: "The capability must have been derived from or verified against the current documentation version.",
    },
    {
      id: "manifest-target-authority",
      passed: authority.allowedTargetAliases.includes(manifest.baseUrlAlias),
      detail: "The built or reused capability must target an explicitly approved runtime alias.",
    },
    {
      id: "manifest-secret-authority",
      passed:
        manifest.auth.kind === "none" || authority.allowedSecretAliases.includes(manifest.auth.secretAlias),
      detail: "The capability may reference only customer-approved credential aliases.",
    },
    {
      id: "manifest-method-authority",
      passed: manifest.actions.every((action) => authority.allowedMethods.includes(action.request.method)),
      detail: "Every HTTP method must be within the customer policy envelope.",
    },
    {
      id: "manifest-write-authority",
      passed: writeActions.length === 0 || approvedWrites,
      detail: "Consequential writes require prior or action-specific customer authority.",
    },
  );
  return checks;
}

export class CapabilityCoordinator {
  private readonly inFlight = new Map<string, Promise<AcquisitionResult>>();
  private readonly now: () => string;
  private readonly maxVerificationRepairs: number;

  constructor(private readonly dependencies: CoordinatorDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.maxVerificationRepairs = dependencies.maxVerificationRepairs ?? 2;
  }

  acquire(request: CapabilityRequest): Promise<AcquisitionResult> {
    const lockKey = `${request.context.tenantId}:${request.need.key}:${request.need.documentationHash}`;
    const running = this.inFlight.get(lockKey);
    if (running) return running;
    const operation = this.acquireUnlocked(request).finally(() => this.inFlight.delete(lockKey));
    this.inFlight.set(lockKey, operation);
    return operation;
  }

  /**
   * Containment boundary for a capability whose real external outcome could
   * not be established or did not satisfy the task contract. Quarantine is
   * tenant-scoped and preserves the record for investigation while excluding
   * it from all automatic reuse.
   */
  async quarantine(
    request: CapabilityRequest,
    capabilityId: string,
    reason: "outcome-unverified" | "outcome-mismatch" | "incorrect-side-effect",
  ): Promise<VerificationCheck> {
    try {
      this.dependencies.store.setStatus(request.context.tenantId, capabilityId, "quarantined");
      await this.event(request, "capability.quarantined", { capabilityId, reason });
      return {
        id: "capability-quarantine",
        passed: true,
        detail: "The capability was quarantined and cannot be reused automatically for this tenant.",
      };
    } catch (error) {
      return {
        id: "capability-quarantine",
        passed: false,
        detail: `Automatic quarantine failed: ${String(redactValue(error instanceof Error ? error.message : error))}`,
      };
    }
  }

  private async acquireUnlocked(request: CapabilityRequest): Promise<AcquisitionResult> {
    await this.event(request, "acquisition.requested", { needKey: request.need.key });
    const initialChecks = authorityChecks(request);
    if (initialChecks.some((check) => !check.passed)) {
      return this.handoff(request, "authority-missing", "Required target or credential authority is unavailable.", initialChecks);
    }

    const retained = this.dependencies.store.findActive(
      request.context.tenantId,
      request.need.key,
      request.need.documentationHash,
    );
    if (retained) {
      const checks = authorityChecks(request, retained.manifest);
      if (checks.every((check) => check.passed)) {
        this.dependencies.store.markUsed(request.context.tenantId, retained.manifest.id);
        await this.event(request, "capability.reused", { capabilityId: retained.manifest.id });
        return {
          status: "acquired",
          acquired: { source: "reused", manifest: retained.manifest, verification: retained.verification },
        };
      }
      return this.handoff(
        request,
        "policy-denied",
        "The retained capability exceeds the authority granted for this task.",
        checks,
        retained.manifest.id,
      );
    }

    for (const source of this.dependencies.trustedSources ?? []) {
      let candidates: TrustedCapabilityCandidate[];
      try {
        candidates = await source.search(request);
      } catch {
        continue;
      }
      for (const candidate of candidates) {
        const policyChecks = authorityChecks(request, candidate.manifest);
        if (policyChecks.some((check) => !check.passed)) continue;
        const verification = await this.verify(request, candidate.manifest);
        if (!verification.passed || verification.checks.some((check) => !check.passed)) continue;
        this.dependencies.store.register({
          tenantId: request.context.tenantId,
          needKey: request.need.key,
          manifest: candidate.manifest,
          verification,
          origin: `trusted:${source.id}`,
          status: "active",
          registeredAt: this.now(),
          reuseCount: 0,
        });
        await this.event(request, "capability.discovered", {
          capabilityId: candidate.manifest.id,
          sourceId: source.id,
          ...(candidate.referenceId ? { referenceId: candidate.referenceId } : {}),
        });
        await this.event(request, "capability.verified", {
          capabilityId: candidate.manifest.id,
          manifestDigest: verification.manifestDigest,
        });
        return {
          status: "acquired",
          acquired: { source: "trusted-tool", manifest: candidate.manifest, verification },
        };
      }
    }

    let manifest: CapabilityManifest;
    try {
      manifest = await this.dependencies.builder.build(request);
      await this.event(request, "capability.built", { capabilityId: manifest.id });
    } catch (error) {
      return this.handoff(request, "build-failed", "No capability could be built safely.", [
        { id: "builder", passed: false, detail: error instanceof Error ? error.message : String(error) },
      ]);
    }

    const policyChecks = authorityChecks(request, manifest);
    if (policyChecks.some((check) => !check.passed)) {
      await this.event(request, "capability.rejected", { capabilityId: manifest.id, stage: "policy" });
      return this.handoff(
        request,
        "policy-denied",
        "The proposed capability exceeds the customer policy envelope.",
        policyChecks,
        manifest.id,
      );
    }

    let verification = await this.verify(request, manifest);
    let repairCount = 0;
    while (
      (!verification.passed || verification.checks.some((check) => !check.passed)) &&
      repairCount < this.maxVerificationRepairs &&
      "repair" in this.dependencies.builder &&
      typeof this.dependencies.builder.repair === "function"
    ) {
      repairCount += 1;
      try {
        manifest = await (this.dependencies.builder as RepairableCapabilityBuilder).repair(
          request,
          manifest,
          verification,
        );
      } catch (error) {
        verification = {
          ...verification,
          passed: false,
          checks: [
            ...verification.checks,
            {
              id: `repair-${repairCount}`,
              passed: false,
              detail: error instanceof Error ? error.message : String(error),
            },
          ],
        };
        break;
      }
      await this.event(request, "capability.repaired", { capabilityId: manifest.id, repairCount });
      const repairedPolicyChecks = authorityChecks(request, manifest);
      if (repairedPolicyChecks.some((check) => !check.passed)) {
        return this.handoff(
          request,
          "policy-denied",
          "The repaired capability exceeds the customer policy envelope.",
          repairedPolicyChecks,
          manifest.id,
        );
      }
      verification = await this.verify(request, manifest);
    }
    if (!verification.passed || verification.checks.some((check) => !check.passed)) {
      await this.event(request, "capability.rejected", { capabilityId: manifest.id, stage: "verification" });
      return this.handoff(
        request,
        "verification-failed",
        "Independent capability verification did not pass.",
        verification.checks,
        manifest.id,
      );
    }

    this.dependencies.store.register({
      tenantId: request.context.tenantId,
      needKey: request.need.key,
      manifest,
      verification,
      origin: "built",
      status: "active",
      registeredAt: this.now(),
      reuseCount: 0,
    });
    await this.event(request, "capability.verified", {
      capabilityId: manifest.id,
      manifestDigest: verification.manifestDigest,
    });
    return { status: "acquired", acquired: { source: "built", manifest, verification } };
  }

  private async verify(request: CapabilityRequest, manifest: CapabilityManifest): Promise<VerificationReceipt> {
    try {
      return await this.dependencies.verifier.verify(
        request,
        manifest,
        this.dependencies.runtimeResolver.resolve(request),
      );
    } catch (error) {
      return {
        verifierVersion: "unavailable",
        manifestDigest: manifestDigest(manifest),
        documentationHash: request.need.documentationHash,
        passed: false,
        checks: [{ id: "verifier", passed: false, detail: error instanceof Error ? error.message : String(error) }],
        verifiedAt: this.now(),
      };
    }
  }

  private async handoff(
    request: CapabilityRequest,
    reason: HandoffReason,
    summary: string,
    checks: VerificationCheck[],
    capabilityId?: string,
  ): Promise<AcquisitionResult> {
    const handoff: HandoffEnvelope = {
      requestId: request.context.requestId,
      tenantId: request.context.tenantId,
      reason,
      summary,
      failedChecks: checks
        .filter((check) => !check.passed)
        .map((check) => ({ ...check, detail: String(redactValue(check.detail)) })),
      createdAt: this.now(),
      ...(capabilityId ? { attemptedCapabilityId: capabilityId } : {}),
    };
    await this.event(request, "handoff.created", { reason, summary });
    return { status: "handoff", handoff };
  }

  private async event(request: CapabilityRequest, type: CapabilityEvent["type"], detail: Record<string, unknown>) {
    await this.dependencies.events?.record({
      tenantId: request.context.tenantId,
      requestId: request.context.requestId,
      ...(request.context.correlation ? { correlation: structuredClone(request.context.correlation) } : {}),
      type,
      detail: redactValue(detail) as Record<string, unknown>,
      occurredAt: this.now(),
    });
  }
}
