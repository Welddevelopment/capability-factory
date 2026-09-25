import type {
  BrowserCapabilityGoalRequest,
  BrowserCapabilityGoalResult,
  ExperimentalBrowserCapabilitySdk,
} from "./browser-capability-sdk.js";
import {
  DiscoveredBrowserCapabilityBuilder,
  browserDiscoveryBoundarySchema,
  type BrowserDiscoveryBoundary,
  type BrowserDiscoveryPlanner,
  type BrowserDiscoverySnapshot,
  type BrowserUiDiscoverer,
} from "./browser-discovery.js";
import type { ExperimentalBrowserTarget } from "./browser-driver.js";
import type { BrowserCapabilityRegistry, VerifiedBrowserCapabilityRecord } from "./browser-registry.js";
import {
  BrowserDiscoveryAuthenticationError,
  targetWithDiscoveredLocators,
} from "./playwright-browser-discovery.js";

export interface BrowserDiscoveryGoalRequest extends Omit<BrowserCapabilityGoalRequest, "uiContractHash"> {}

export interface BrowserDriftQuarantineReceipt {
  capabilityId: string;
  previousSnapshotHash: string;
  currentSnapshotHash: string;
  reason: string;
}

export type BrowserDiscoveryGoalResult =
  | {
      status: "completed" | "blocked" | "unknown";
      snapshot: BrowserDiscoverySnapshot;
      drift: BrowserDriftQuarantineReceipt[];
      capability: BrowserCapabilityGoalResult;
    }
  | {
      status: "blocked";
      snapshot?: BrowserDiscoverySnapshot;
      drift: BrowserDriftQuarantineReceipt[];
      handoff: {
        reason: "human-authentication-required";
        summary: string;
        writesAttempted: 0;
      };
    };

export interface BrowserDiscoverySdkFactoryInput {
  target: ExperimentalBrowserTarget;
  builder: DiscoveredBrowserCapabilityBuilder;
  snapshot: BrowserDiscoverySnapshot;
  supersedesCapabilityId?: string;
}

function quarantineDriftedRecords(options: {
  registry: BrowserCapabilityRegistry;
  tenantId: string;
  needKey: string;
  currentSnapshotHash: string;
}): BrowserDriftQuarantineReceipt[] {
  const receipts: BrowserDriftQuarantineReceipt[] = [];
  for (const record of options.registry.list(options.tenantId)) {
    if (
      record.needKey !== options.needKey
      || record.status !== "active"
      || record.manifest.uiContractHash === options.currentSnapshotHash
    ) continue;
    const reason = `Trusted browser UI snapshot changed from ${record.manifest.uiContractHash.slice(0, 12)} to ${options.currentSnapshotHash.slice(0, 12)}; the old capability requires replacement verification.`;
    options.registry.setStatus(options.tenantId, record.manifest.id, "quarantined", reason);
    receipts.push({
      capabilityId: record.manifest.id,
      previousSnapshotHash: record.manifest.uiContractHash,
      currentSnapshotHash: options.currentSnapshotHash,
      reason,
    });
  }
  return receipts;
}

function newest(receipts: BrowserDriftQuarantineReceipt[]): BrowserDriftQuarantineReceipt | undefined {
  return receipts.at(-1);
}

/**
 * Runs trusted discovery before the existing browser SDK. The model/planner sees
 * only the sanitized snapshot; execution remains in the previously confirmed driver.
 */
export class BrowserDiscoveryGoalRunner {
  constructor(
    private readonly target: ExperimentalBrowserTarget,
    private readonly boundary: BrowserDiscoveryBoundary,
    private readonly discoverer: BrowserUiDiscoverer,
    private readonly planner: BrowserDiscoveryPlanner,
    private readonly registry: BrowserCapabilityRegistry,
    private readonly sdkFactory: (input: BrowserDiscoverySdkFactoryInput) => ExperimentalBrowserCapabilitySdk,
  ) {
    browserDiscoveryBoundarySchema.parse(boundary);
    if (boundary.targetAlias.length === 0) throw new Error("Browser discovery requires a target alias.");
  }

  async completeGoal(request: BrowserDiscoveryGoalRequest): Promise<BrowserDiscoveryGoalResult> {
    if (request.needKey !== this.boundary.needKey) throw new Error("Browser discovery goal does not match the trusted boundary need.");
    let snapshot: BrowserDiscoverySnapshot;
    try {
      snapshot = await this.discoverer.discover(this.target, this.boundary);
    } catch (error) {
      if (!(error instanceof BrowserDiscoveryAuthenticationError)) throw error;
      return {
        status: "blocked",
        drift: [],
        handoff: {
          reason: "human-authentication-required",
          summary: `${error.message} No business action was attempted; refresh the customer-local session or complete the required authentication before resuming.`,
          writesAttempted: 0,
        },
      };
    }
    const drift = quarantineDriftedRecords({
      registry: this.registry,
      tenantId: request.tenantId,
      needKey: request.needKey,
      currentSnapshotHash: snapshot.snapshotHash,
    });
    if (snapshot.humanGates.length > 0) {
      return {
        status: "blocked",
        snapshot,
        drift,
        handoff: {
          reason: "human-authentication-required",
          summary: `Browser discovery stopped before action because it observed: ${snapshot.humanGates.map((gate) => `${gate.signal} on ${gate.pagePath}`).join(", ")}.`,
          writesAttempted: 0,
        },
      };
    }
    const effectiveTarget = targetWithDiscoveredLocators(this.target, snapshot, this.boundary);
    const builder = new DiscoveredBrowserCapabilityBuilder(
      effectiveTarget,
      this.boundary,
      snapshot,
      this.planner,
      2,
    );
    const superseded = newest(drift);
    const sdk = this.sdkFactory({
      target: effectiveTarget,
      builder,
      snapshot,
      ...(superseded ? { supersedesCapabilityId: superseded.capabilityId } : {}),
    });
    const capability = await sdk.completeGoal({
      ...request,
      uiContractHash: snapshot.snapshotHash,
    });
    const active = this.registry.findActive(request.tenantId, request.needKey, snapshot.snapshotHash);
    if (active) {
      this.registry.register(discoveryRecordMetadata(active, snapshot, superseded?.capabilityId));
    }
    return { status: capability.status, snapshot, drift, capability };
  }
}

export function discoveryRecordMetadata(
  record: VerifiedBrowserCapabilityRecord,
  snapshot: BrowserDiscoverySnapshot,
  supersedesCapabilityId?: string,
): VerifiedBrowserCapabilityRecord {
  return {
    ...record,
    discoverySnapshotHash: snapshot.snapshotHash,
    ...(supersedesCapabilityId ? { supersedesCapabilityId } : {}),
  };
}
