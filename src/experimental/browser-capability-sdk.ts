import type { LocalSecretProvider } from "../product/secrets.js";
import {
  ExperimentalBrowserDriver,
  ExperimentalBrowserOperationalBlockedError,
  type BrowserOperationalControl,
  type ExperimentalBrowserCapability,
  type ExperimentalBrowserOutcomeVerifier,
  type ExperimentalBrowserRunResult,
} from "./browser-driver.js";
import type { BrowserCapabilityRegistry, VerifiedBrowserCapabilityRecord } from "./browser-registry.js";
import type { BrowserCapabilityBuilder } from "./browser-ui-contract.js";

export interface TrustedBrowserCapabilitySource {
  readonly sourceId: string;
  find(needKey: string, uiContractHash: string): Promise<ExperimentalBrowserCapability | null>;
}

export interface BrowserCapabilityGoalRequest {
  tenantId: string;
  requestId: string;
  parentGoalId: string;
  ordinaryGoal: string;
  needKey: string;
  uiContractHash: string;
  operationKey: string;
  input: Record<string, string>;
  approvals: string[];
}

export type BrowserCapabilityAcquisitionPath = "retained-capability" | "trusted-capability" | "built-capability";

export type BrowserCapabilityGoalResult =
  | {
      status: "completed";
      tenantId: string;
      requestId: string;
      parentGoalId: string;
      ordinaryGoal: string;
      path: BrowserCapabilityAcquisitionPath;
      capabilityId: string;
      execution: Extract<ExperimentalBrowserRunResult, { status: "completed" }>;
      parent: {
        resumed: true;
        completed: true;
        summary: string;
        verifiedAt: string;
      };
    }
  | {
      status: "blocked" | "unknown";
      tenantId: string;
      requestId: string;
      parentGoalId: string;
      ordinaryGoal: string;
      path?: BrowserCapabilityAcquisitionPath;
      capabilityId?: string;
      execution?: Extract<ExperimentalBrowserRunResult, { writesAttempted: 0 | 1 }>;
      parent: {
        resumed: false;
        completed: false;
        summary: string;
      };
      handoff: {
        reason: "capability-unavailable" | "authority-or-credential-missing" | "browser-outcome-unsafe";
        summary: string;
        writesAttempted: number;
      };
    };

export interface BrowserCapabilitySdkDependencies {
  driver: ExperimentalBrowserDriver;
  registry: BrowserCapabilityRegistry;
  trustedSource: TrustedBrowserCapabilitySource;
  builder?: BrowserCapabilityBuilder;
  outcomeVerifier(request: BrowserCapabilityGoalRequest): ExperimentalBrowserOutcomeVerifier;
  secretProvider?: LocalSecretProvider;
  operationalControl?: BrowserOperationalControl;
}

/**
 * Narrow second-mode reference. It searches retained capabilities, then one
 * trusted source, verifies before use, executes through the browser driver,
 * verifies external state, and resumes the original goal only on proof.
 */
export class ExperimentalBrowserCapabilitySdk {
  constructor(private readonly dependencies: BrowserCapabilitySdkDependencies) {}

  async completeGoal(request: BrowserCapabilityGoalRequest): Promise<BrowserCapabilityGoalResult> {
    this.validateRequest(request);
    let record = this.dependencies.registry.findActive(request.tenantId, request.needKey, request.uiContractHash);
    let path: BrowserCapabilityAcquisitionPath;
    if (record) {
      path = "retained-capability";
    } else {
      const contained = this.dependencies.registry.list(request.tenantId).find((candidate) =>
        candidate.needKey === request.needKey &&
        candidate.manifest.uiContractHash === request.uiContractHash &&
        candidate.status !== "active",
      );
      if (contained) {
        return this.handoff(
          request,
          "capability-unavailable",
          `The matching browser capability is ${contained.status} and cannot be reacquired automatically.`,
          0,
        );
      }
      let candidate = await this.dependencies.trustedSource.find(request.needKey, request.uiContractHash);
      let origin: VerifiedBrowserCapabilityRecord["origin"] = `trusted:${this.dependencies.trustedSource.sourceId}`;
      path = "trusted-capability";
      if (!candidate && this.dependencies.builder) {
        candidate = await this.dependencies.builder.build(request.needKey, request.uiContractHash);
        origin = `built:${this.dependencies.builder.builderId}`;
        path = "built-capability";
      }
      if (!candidate) {
        return this.handoff(request, "capability-unavailable", "No retained, trusted or constructible browser capability matched the required UI contract.", 0);
      }
      let verification: Awaited<ReturnType<ExperimentalBrowserDriver["verifyCapability"]>>;
      try {
        verification = await this.dependencies.driver.verifyCapability(candidate, {
          runId: request.requestId,
          ...(this.dependencies.operationalControl ? { operationalControl: this.dependencies.operationalControl } : {}),
          input: request.input,
          ...(this.dependencies.secretProvider ? { secretProvider: this.dependencies.secretProvider } : {}),
        });
      } catch (error) {
        return this.handoff(
          request,
          error instanceof ExperimentalBrowserOperationalBlockedError
            ? "authority-or-credential-missing"
            : "capability-unavailable",
          `Trusted browser capability could not be verified: ${error instanceof Error ? error.message : String(error)}`,
          0,
        );
      }
      if (!verification.passed) {
        return this.handoff(
          request,
          "capability-unavailable",
          `Trusted browser capability failed pre-use verification: ${verification.checks.filter((check) => !check.passed).map((check) => check.detail).join(" ")}`,
          0,
        );
      }
      const verifiedRecord: VerifiedBrowserCapabilityRecord = {
        tenantId: request.tenantId,
        needKey: request.needKey,
        manifest: candidate,
        verification,
        origin,
        status: "active",
        registeredAt: new Date().toISOString(),
        reuseCount: 0,
      };
      this.dependencies.registry.register(verifiedRecord);
      record = verifiedRecord;
    }

    if (!record) throw new Error("Browser capability resolution ended without an active record.");

    const execution = await this.dependencies.driver.execute(
      record.manifest,
      {
        operationKey: request.operationKey,
        runId: request.requestId,
        input: request.input,
        approvals: request.approvals,
        verification: record.verification,
        ...(this.dependencies.secretProvider ? { secretProvider: this.dependencies.secretProvider } : {}),
        ...(this.dependencies.operationalControl ? { operationalControl: this.dependencies.operationalControl } : {}),
      },
      this.dependencies.outcomeVerifier(request),
    );

    if (execution.status === "completed") {
      if (path === "retained-capability") {
        this.dependencies.registry.markUsed(request.tenantId, record.manifest.id);
      }
      return {
        status: "completed",
        tenantId: request.tenantId,
        requestId: request.requestId,
        parentGoalId: request.parentGoalId,
        ordinaryGoal: request.ordinaryGoal,
        path,
        capabilityId: record.manifest.id,
        execution,
        parent: {
          resumed: true,
          completed: true,
          summary: "Independent external-state verification passed; the original goal resumed and completed.",
          verifiedAt: new Date().toISOString(),
        },
      };
    }

    if (execution.quarantined) {
      this.dependencies.registry.setStatus(request.tenantId, record.manifest.id, "quarantined");
    }
    const authorityBlocked = execution.writesAttempted === 0 && !execution.quarantined;
    return {
      status: execution.status,
      tenantId: request.tenantId,
      requestId: request.requestId,
      parentGoalId: request.parentGoalId,
      ordinaryGoal: request.ordinaryGoal,
      path,
      capabilityId: record.manifest.id,
      execution,
      parent: {
        resumed: false,
        completed: false,
        summary: "The original goal remains blocked because browser completion was not independently verified.",
      },
      handoff: {
        reason: authorityBlocked ? "authority-or-credential-missing" : "browser-outcome-unsafe",
        summary: execution.reason,
        writesAttempted: execution.writesAttempted,
      },
    };
  }

  private validateRequest(request: BrowserCapabilityGoalRequest): void {
    for (const [key, value] of Object.entries({
      tenantId: request.tenantId,
      requestId: request.requestId,
      parentGoalId: request.parentGoalId,
      ordinaryGoal: request.ordinaryGoal,
      needKey: request.needKey,
      uiContractHash: request.uiContractHash,
      operationKey: request.operationKey,
    })) {
      if (!value || value.length > 2_000) throw new Error(`Browser goal request has an invalid ${key}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(request.uiContractHash)) throw new Error("Browser goal request requires a SHA-256 UI contract hash.");
  }

  private handoff(
    request: BrowserCapabilityGoalRequest,
    reason: Extract<BrowserCapabilityGoalResult, { handoff: unknown }>["handoff"]["reason"],
    summary: string,
    writesAttempted: number,
  ): Extract<BrowserCapabilityGoalResult, { handoff: unknown }> {
    return {
      status: "blocked",
      tenantId: request.tenantId,
      requestId: request.requestId,
      parentGoalId: request.parentGoalId,
      ordinaryGoal: request.ordinaryGoal,
      parent: { resumed: false, completed: false, summary: "The original goal remains blocked." },
      handoff: { reason, summary, writesAttempted },
    };
  }
}

export class StaticTrustedBrowserCapabilitySource implements TrustedBrowserCapabilitySource {
  constructor(readonly sourceId: string, private readonly manifests: ExperimentalBrowserCapability[]) {}

  async find(needKey: string, uiContractHash: string): Promise<ExperimentalBrowserCapability | null> {
    return structuredClone(this.manifests.find((manifest) =>
      manifest.needKey === needKey && manifest.uiContractHash === uiContractHash,
    ) ?? null);
  }
}

export function browserCapabilityRecord(
  record: VerifiedBrowserCapabilityRecord,
): VerifiedBrowserCapabilityRecord {
  return structuredClone(record);
}
