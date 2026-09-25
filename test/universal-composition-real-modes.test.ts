import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ReviewedInventoryDatabaseAdapter } from "../src/customer-world/reviewed-database-world.js";
import { DatabaseCapabilityRegistry, ExperimentalDatabaseCapabilitySdk } from "../src/experimental/database-capability-sdk.js";
import {
  ExperimentalTrustedToolCapabilitySdk,
  TrustedToolCapabilityRegistry,
  TrustedToolSandbox,
  type TrustedToolArtifact,
} from "../src/experimental/trusted-tool-sandbox.js";
import { prepareCapabilityRoute } from "../src/product/capability-bundle-factory.js";
import { CapabilityModeRouter, createDatabaseModeRunner, createTrustedToolModeRunner } from "../src/product/capability-mode-router.js";
import type { UniversalGoal } from "../src/product/universal-capability-contract.js";
import { UniversalCapabilityCoordinator } from "../src/product/universal-capability-coordinator.js";
import { UniversalCompositionCoordinator, type UniversalCompositionPlan } from "../src/product/universal-composition.js";

const ADD_WASM = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

describe("genuine local cross-mode composition", () => {
  it("uses isolated compute then a reviewed database action and completes only after a separate aggregate database check", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-composition-real-"));
    const databasePath = join(directory, "inventory.sqlite");
    const adapter = new ReviewedInventoryDatabaseAdapter(databasePath);
    const databaseRegistry = new DatabaseCapabilityRegistry(join(directory, "database-capabilities.sqlite"));
    const toolRegistry = new TrustedToolCapabilityRegistry(join(directory, "tool-capabilities.sqlite"));
    try {
      const artifactHash = createHash("sha256").update(ADD_WASM).digest("hex");
      const tool: TrustedToolArtifact = {
        descriptor: {
          schemaVersion: "1.0",
          toolId: "restock-quantity",
          version: "1.0.0",
          artifactSha256: artifactHash,
          exportName: "add",
          maximumArtifactBytes: 1_024,
          maximumInputs: 2,
          timeoutMs: 1_000,
          workerMemoryMb: 16,
          probeInputs: [2, 3],
          expectedProbeOutput: 5,
          approvalKey: "calculate-restock",
          resultVerifierKey: "restock-calculation-verifier",
        },
        wasmBytes: ADD_WASM,
      };
      const verifiedOutputs = new Map<string, number>();
      const toolSdk = new ExperimentalTrustedToolCapabilitySdk(
        new TrustedToolSandbox(),
        toolRegistry,
        new Map([["restock-quantity@1.0.0", tool]]),
        new Map([["restock-calculation-verifier", {
          key: "restock-calculation-verifier",
          async verify(input, output) {
            const passed = output === input[0]! + input[1]!;
            if (passed) verifiedOutputs.set("widget-one", output);
            return { passed, stateDigest: hash({ input, output }), detail: "A separate deterministic calculation verified the tool output." };
          },
        }]]),
      );
      const databaseSdk = new ExperimentalDatabaseCapabilitySdk(databaseRegistry, adapter);
      const router = new CapabilityModeRouter([
        createTrustedToolModeRunner(toolSdk),
        createDatabaseModeRunner(databaseSdk),
      ]);
      const leafCoordinator = new UniversalCapabilityCoordinator(router, { now: () => "2026-08-05T00:00:00.000Z" });
      const composition = new UniversalCompositionCoordinator(leafCoordinator, () => "2026-08-05T00:00:01.000Z");
      const ordinaryGoal = "Calculate the exact fictional shortfall, create one approved restock draft, and prove the combined result.";

      const toolGoal: UniversalGoal = {
        schemaVersion: "1.0",
        tenantId: "tenant-one",
        requestId: "request-calculate",
        parentGoalId: "parent-restock",
        ordinaryGoal,
        gap: {
          key: "calculate-widget-shortfall",
          summary: "Calculate the exact approved restock quantity.",
          requiredActions: ["calculate-restock"],
          targetAliases: ["trusted-tool-catalog"],
          requiredObservationKeys: ["verified-compute-output"],
          maximumRisk: "read-only",
        },
        authority: {
          allowedTargetAliases: ["trusted-tool-catalog"],
          allowedSecretAliases: [],
          allowedActions: ["calculate-restock"],
          grantedApprovals: ["calculate-restock"],
          maximumRisk: "read-only",
        },
      };
      const databaseGoal: UniversalGoal = {
        schemaVersion: "1.0",
        tenantId: "tenant-one",
        requestId: "request-write",
        parentGoalId: "parent-restock",
        ordinaryGoal,
        gap: {
          key: "create-widget-restock-draft",
          summary: "Create exactly one reviewed restock draft.",
          requiredActions: ["create-restock-draft"],
          targetAliases: ["inventory-database"],
          requiredObservationKeys: ["restock-database-state"],
          maximumRisk: "consequential-write",
        },
        authority: {
          allowedTargetAliases: ["inventory-database"],
          allowedSecretAliases: [],
          allowedActions: ["create-restock-draft"],
          grantedApprovals: ["create-approved-draft"],
          maximumRisk: "consequential-write",
        },
      };

      const toolEnvelope = {
        schemaVersion: "1.0" as const,
        capabilityMode: "experimental-trusted-tool-actions" as const,
        request: {
          tenantId: "tenant-one",
          requestId: "request-calculate",
          parentGoalId: "parent-restock",
          ordinaryGoal,
          needKey: "calculate-widget-shortfall",
          contractHash: artifactHash,
          operationKey: "calculate-widget-one",
          toolId: "restock-quantity",
          toolVersion: "1.0.0",
          values: [1, 2],
          approvals: ["calculate-restock"],
        },
      };
      const databaseEnvelope = {
        schemaVersion: "1.0" as const,
        capabilityMode: "experimental-database-actions" as const,
        request: {
          tenantId: "tenant-one",
          requestId: "request-write",
          parentGoalId: "parent-restock",
          ordinaryGoal,
          needKey: "create-widget-restock-draft",
          contractHash: adapter.contract.schemaHash,
          operationKey: "restock-widget-one",
          input: { sku: "widget-one", quantity: "3" },
          approvals: ["create-approved-draft"],
        },
      };
      const toolRoute = prepareCapabilityRoute({
        envelope: toolEnvelope,
        needKey: "calculate-widget-shortfall",
        summary: "Pinned isolated shortfall calculation.",
        capabilityId: "capability-calculate-widget",
        source: "trusted-existing",
        driverId: "trusted-tool-wasm",
        driverVersion: "0.1.0",
        executionBoundary: "isolated-sandbox",
        manifest: { mediaType: "application/wasm", digest: artifactHash, reference: "restock-quantity-wasm", generated: false },
        authority: { targetAliases: ["trusted-tool-catalog"], secretAliases: [], approvalKeys: ["calculate-restock"], risk: "read-only" },
        verification: { preUseVerifierKey: "wasm-probe", outcomeVerifierKey: "restock-calculation-verifier", observationSource: "verified-compute-output", contractHash: artifactHash },
        recovery: { operationKey: "calculate-widget-one", idempotency: "not-applicable", quarantineOn: ["verification-failure", "incorrect-outcome", "unknown-outcome"] },
        provenance: { trustedSourceIds: ["local-pinned-catalog"], sourceHashes: [artifactHash], builderVersion: "trusted-tool-builder", builtAt: "2026-08-05T00:00:00.000Z" },
        retention: { version: 1, reusable: true, scopeDigest: hash("tool-scope") },
        routeId: "route-calculate-widget",
        supportedActions: ["calculate-restock"],
        observationKeys: ["verified-compute-output"],
        priority: 1,
      });
      const databaseRoute = prepareCapabilityRoute({
        envelope: databaseEnvelope,
        needKey: "create-widget-restock-draft",
        summary: "Reviewed restock draft procedure.",
        capabilityId: "capability-create-widget-draft",
        source: "built-manifest",
        driverId: "reviewed-database",
        driverVersion: "0.1.0",
        executionBoundary: "customer-local",
        manifest: { mediaType: "application/json", digest: adapter.contract.schemaHash, reference: "reviewed-restock-procedure", generated: true },
        authority: { targetAliases: ["inventory-database"], secretAliases: [], approvalKeys: ["create-approved-draft"], risk: "consequential-write" },
        verification: { preUseVerifierKey: "reviewed-procedure-probe", outcomeVerifierKey: "independent-sqlite-read", observationSource: "restock-database-state", contractHash: adapter.contract.schemaHash },
        recovery: { operationKey: "restock-widget-one", idempotency: "required", quarantineOn: ["verification-failure", "partial-outcome", "incorrect-outcome", "unknown-outcome"] },
        provenance: { trustedSourceIds: ["reviewed-local-schema"], sourceHashes: [adapter.contract.schemaHash], builderVersion: "database-manifest-builder", builtAt: "2026-08-05T00:00:00.000Z" },
        retention: { version: 1, reusable: true, scopeDigest: hash("database-scope") },
        routeId: "route-write-widget",
        supportedActions: ["create-restock-draft"],
        observationKeys: ["restock-database-state"],
        priority: 1,
      });
      const plan: UniversalCompositionPlan = {
        schemaVersion: "1.0",
        tenantId: "tenant-one",
        requestId: "composition-restock-one",
        parentGoalId: "parent-restock",
        ordinaryGoal,
        failurePolicy: "stop-all",
        workItems: [
          { workItemId: "calculate", dependencies: [], goal: toolGoal, routes: [toolRoute] },
          { workItemId: "write", dependencies: ["calculate"], goal: databaseGoal, routes: [databaseRoute] },
        ],
      };

      const result = await composition.resolve(plan, {
        key: "aggregate-restock-verifier",
        sourceId: "independent-read-only-inventory-observer",
        kind: "independent-external-state",
        async verify() {
          const observer = new DatabaseSync(databasePath, { readOnly: true });
          try {
            const drafts = observer.prepare("SELECT operation_key, sku, quantity, status FROM restock_drafts ORDER BY operation_key").all();
            const passed = verifiedOutputs.get("widget-one") === 3
              && drafts.length === 1
              && (drafts[0] as { operation_key: string }).operation_key === "restock-widget-one"
              && (drafts[0] as { sku: string }).sku === "widget-one"
              && (drafts[0] as { quantity: number }).quantity === 3
              && (drafts[0] as { status: string }).status === "draft";
            return {
              passed,
              incorrectSideEffects: passed ? 0 : 1,
              stateDigest: hash({ verifiedOutput: verifiedOutputs.get("widget-one"), drafts }),
              detail: "A separate read-only connection joined the verified compute result to the exact persisted draft.",
            };
          } finally {
            observer.close();
          }
        },
      });

      expect(result).toMatchObject({
        status: "autonomous-completion",
        parentResumed: true,
        parentCompleted: true,
        aggregateOutcome: { passed: true, incorrectSideEffects: 0 },
      });
      expect(result.leafReceipts.map((item) => item.resolution?.selectedFamily)).toEqual(["trusted-tool-code", "database-query"]);
      expect(adapter.countDrafts()).toBe(1);
    } finally {
      toolRegistry.close();
      databaseRegistry.close();
      adapter.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

