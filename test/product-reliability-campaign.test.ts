import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RELIABILITY_CASE_IDS,
  ReliabilityCampaignController,
  ReliabilityCampaignExecutor,
  type ReliabilityCaseAdapter,
  type ReliabilityCampaignConfiguration,
  type ReliabilityCaseResult,
} from "../src/product/reliability-campaign.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-factory-campaign-"));
  fs.writeFileSync(path.join(root, "candidate.ts"), "export const candidate = 1;\n");
  const configuration: ReliabilityCampaignConfiguration = {
    protocolVersion: "reliability-test-v1",
    repositoryRoot: root,
    artifactRoot: path.join(root, "artifacts"),
    model: "test-model",
    reasoning: "test",
    priorPreservedSpendUsd: 4.4619215,
    additionalSpendCeilingUsd: 5,
    sourceFiles: ["candidate.ts"],
    cases: RELIABILITY_CASE_IDS.map((id) => ({
      id,
      name: `Case ${id}`,
      expectedResult: "A deterministic test result.",
      safetyCritical: true,
    })),
    now: () => "2026-07-27T00:00:00.000Z",
  };
  return { root, controller: new ReliabilityCampaignController(configuration) };
}

function result(id: (typeof RELIABILITY_CASE_IDS)[number], overrides: Partial<ReliabilityCaseResult> = {}): ReliabilityCaseResult {
  return {
    id,
    passed: true,
    safetyFailure: false,
    incorrectSideEffects: 0,
    modelCalls: 1,
    spentUsd: 0.1,
    detail: { authorization: "Bearer must-not-survive" },
    completedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("reliability campaign controller", () => {
  it("requires passing deterministic preflight before freezing", () => {
    const { controller } = setup();
    expect(() => controller.freeze()).toThrow(/preflight/i);
    expect(() => controller.recordPreflight([{ id: "fixture", passed: false, detail: "Bad fixture" }])).toThrow(/failed/i);
  });

  it("freezes source hashes, redacts results, and writes sidecar digests", () => {
    const { controller } = setup();
    controller.recordPreflight([{ id: "fixture", passed: true, detail: "Stable" }]);
    const freeze = controller.freeze();
    expect(freeze.cases).toHaveLength(8);
    controller.recordCase(result("R1"));
    const written = fs.readFileSync(path.join(controller.directory, "case-R1", "result.json"), "utf8");
    expect(written).not.toContain("must-not-survive");
    expect(written).toContain("[REDACTED]");
    expect(fs.existsSync(path.join(controller.directory, "case-R1", "result.json.sha256"))).toBe(true);
  });

  it("detects any source change after freeze", () => {
    const { root, controller } = setup();
    controller.recordPreflight([{ id: "fixture", passed: true, detail: "Stable" }]);
    controller.freeze();
    fs.writeFileSync(path.join(root, "candidate.ts"), "export const candidate = 2;\n");
    expect(() => controller.recordCase(result("R1"))).toThrow(/source changed/i);
  });

  it("blocks projected and recorded spend beyond the frozen ceiling", () => {
    const { controller } = setup();
    controller.recordPreflight([{ id: "fixture", passed: true, detail: "Stable" }]);
    controller.freeze();
    expect(() => controller.assertCanStartPaidCall(0.2, 4.9)).toThrow(/spend ceiling/i);
    expect(() => controller.recordCase(result("R1", { spentUsd: 5.01 }))).toThrow(/ceiling/i);
  });

  it("cannot hide incorrect side effects and cannot overwrite a result", () => {
    const { controller } = setup();
    controller.recordPreflight([{ id: "fixture", passed: true, detail: "Stable" }]);
    controller.freeze();
    expect(() => controller.recordCase(result("R1", { incorrectSideEffects: 1 }))).toThrow(/hide/i);
    controller.recordCase(result("R1"));
    expect(() => controller.recordCase(result("R1"))).toThrow(/immutable/i);
  });

  it("finalizes as passing only with all eight safe passing cases", () => {
    const { controller } = setup();
    controller.recordPreflight([{ id: "fixture", passed: true, detail: "Stable" }]);
    controller.freeze();
    for (const id of RELIABILITY_CASE_IDS) controller.recordCase(result(id));
    expect(controller.finalize()).toMatchObject({
      passed: true,
      safetyFailure: false,
      passedCount: 8,
      expectedCount: 8,
      missingCases: [],
    });
  });
});

function adapters(overrides: Partial<Record<(typeof RELIABILITY_CASE_IDS)[number], Partial<ReliabilityCaseAdapter>>> = {}) {
  return RELIABILITY_CASE_IDS.map((id): ReliabilityCaseAdapter => ({
    id,
    version: "test-adapter-v1",
    preflight: () => [{ id: "fixture", passed: true, detail: "Deterministic fixture passed." }],
    execute: async () => ({
      passed: true,
      safetyFailure: false,
      incorrectSideEffects: 0,
      detail: { id },
    }),
    ...overrides[id],
  }));
}

describe("reliability campaign executor", () => {
  it("requires one versioned adapter for each frozen case", () => {
    const { controller } = setup();
    expect(() => new ReliabilityCampaignExecutor(controller, adapters().slice(0, 7))).toThrow(/R1 through R8/i);
    expect(() => new ReliabilityCampaignExecutor(controller, adapters({ R8: { version: "" } }))).toThrow(/version/i);
  });

  it("namespaces deterministic adapter preflight and rejects empty checks", async () => {
    const { controller } = setup();
    const executor = new ReliabilityCampaignExecutor(
      controller,
      adapters({ R2: { preflight: () => [] } }),
    );
    const checks = await executor.preflight();
    expect(checks).toHaveLength(8);
    expect(checks[0]).toMatchObject({ id: "R1:fixture", passed: true });
    expect(checks[1]).toMatchObject({ id: "R2:adapter-preflight", passed: false });
  });

  it("runs in frozen order, measures model usage, and preserves a thrown case as a failure", async () => {
    const { controller } = setup();
    controller.recordPreflight([{ id: "fixture", passed: true, detail: "Stable" }]);
    controller.freeze();
    const order: string[] = [];
    const executor = new ReliabilityCampaignExecutor(
      controller,
      adapters({
        R1: {
          execute: async (context) => {
            order.push("R1");
            context.modelObserver.beforeCall({ callNumber: 1, projectedUsd: 0.2, runSpentUsd: 0 });
            context.modelObserver.usageRecorded?.({ callNumber: 1, callCostUsd: 0.1, runSpentUsd: 0.1 });
            return { passed: true, safetyFailure: false, incorrectSideEffects: 0, detail: {} };
          },
        },
        R2: {
          execute: async () => {
            order.push("R2");
            throw new Error("Preserved adapter failure");
          },
        },
      }).map((adapter) => ({
        ...adapter,
        execute: adapter.id === "R1" || adapter.id === "R2"
          ? adapter.execute
          : async () => {
              order.push(adapter.id);
              return { passed: true, safetyFailure: false, incorrectSideEffects: 0, detail: {} };
            },
      })),
      () => "2026-07-27T01:00:00.000Z",
    );
    const summary = await executor.execute();
    expect(order).toEqual(RELIABILITY_CASE_IDS);
    expect(summary).toMatchObject({ passed: false, passedCount: 7, totalModelCalls: 1, additionalSpentUsd: 0.1 });
    const failed = JSON.parse(fs.readFileSync(path.join(controller.directory, "case-R2", "result.json"), "utf8"));
    expect(failed).toMatchObject({ passed: false, detail: { adapterVersion: "test-adapter-v1" } });
    expect(failed.detail.error.message).toBe("Preserved adapter failure");
  });

  it("uses the controller ceiling before each projected call", async () => {
    const { controller } = setup();
    controller.recordPreflight([{ id: "fixture", passed: true, detail: "Stable" }]);
    controller.freeze();
    const executor = new ReliabilityCampaignExecutor(
      controller,
      adapters({
        R1: {
          execute: async (context) => {
            context.modelObserver.beforeCall({ callNumber: 1, projectedUsd: 5.01, runSpentUsd: 0 });
            return { passed: true, safetyFailure: false, incorrectSideEffects: 0, detail: {} };
          },
        },
      }),
    );
    const summary = await executor.execute();
    expect(summary).toMatchObject({ passed: false, passedCount: 7, additionalSpentUsd: 0 });
  });
});
