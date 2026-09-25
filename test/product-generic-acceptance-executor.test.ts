import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryGenericAcceptanceCampaignStore,
  JsonFileGenericAcceptanceCampaignStore,
  prepareGenericAcceptanceCampaign,
  runGenericAcceptanceCampaign,
  type GenericAcceptanceBinding,
} from "../src/product/generic-acceptance-executor.js";
import {
  REQUIRED_PILOT_ADAPTER_CASES,
  type PilotAdapterAcceptanceCase,
  type PilotAdapterAcceptanceResult,
} from "../src/product/pilot-adapter.js";

const temporaryDirectories: string[] = [];
const declarationDigest = createHash("sha256").update("reviewed-acceptance-declaration-v1").digest("hex");
const bindingDigest = createHash("sha256").update("reviewed-customer-binding-v1").digest("hex");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function result(
  caseId: PilotAdapterAcceptanceCase,
  options: { passed?: boolean; incorrectSideEffects?: number; suffix?: string } = {},
): PilotAdapterAcceptanceResult {
  const passed = options.passed ?? true;
  return {
    caseId,
    passed,
    intendedWrites: caseId === "approved-write" ? 1 : 0,
    incorrectSideEffects: options.incorrectSideEffects ?? 0,
    checks: [{ id: `outcome-${caseId}`, passed, detail: passed ? "Independent state matched." : "Independent state did not match." }],
    artifactReferences: [`evidence://${caseId}/${options.suffix ?? "first"}`],
    completedAt: "2026-08-14T00:00:00.000Z",
  };
}

function binding(overrides: Partial<GenericAcceptanceBinding> = {}): GenericAcceptanceBinding {
  return {
    bindingId: "generic-customer-world",
    bindingVersion: "1.0.0",
    bindingDigest,
    caseIds: [...REQUIRED_PILOT_ADAPTER_CASES],
    execute: async (caseId) => result(caseId),
    ...overrides,
  };
}

describe("generic fixed ten-case acceptance executor", () => {
  it("keeps a prepared declaration distinct from executed evidence", async () => {
    const store = new InMemoryGenericAcceptanceCampaignStore();
    const prepared = await prepareGenericAcceptanceCampaign({
      campaignId: "prepared-campaign",
      declarationDigest,
      binding: binding(),
      store,
    });

    expect(prepared).toMatchObject({
      status: "prepared",
      passed: false,
      declaredCases: 10,
      executedCases: 0,
      passedCases: 0,
    });
    expect(prepared.state.cases.every((item) => item.status === "declared-not-run")).toBe(true);
    expect(prepared.state.receipts).toEqual([]);
  });

  it("owns fixed ordering and emits hash-chained evidence receipts", async () => {
    const order: PilotAdapterAcceptanceCase[] = [];
    const summary = await runGenericAcceptanceCampaign({
      campaignId: "complete-campaign",
      declarationDigest,
      binding: binding({
        execute: async (caseId) => {
          order.push(caseId);
          return result(caseId);
        },
      }),
      store: new InMemoryGenericAcceptanceCampaignStore(),
    });

    expect(order).toEqual(REQUIRED_PILOT_ADAPTER_CASES);
    expect(summary).toMatchObject({
      status: "completed",
      passed: true,
      declaredCases: 10,
      executedCases: 10,
      reconciledCases: 0,
      passedCases: 10,
      failedCases: [],
      notRunCases: [],
      incorrectSideEffects: 0,
    });
    expect(summary.state.receipts).toHaveLength(10);
    expect(summary.state.receipts[0]?.previousReceiptHash).toBeUndefined();
    for (let index = 1; index < summary.state.receipts.length; index += 1) {
      expect(summary.state.receipts[index]?.previousReceiptHash).toBe(summary.state.receipts[index - 1]?.receiptHash);
    }
  });

  it("stops immediately when an incorrect side effect survives", async () => {
    const executed: PilotAdapterAcceptanceCase[] = [];
    const summary = await runGenericAcceptanceCampaign({
      campaignId: "unsafe-campaign",
      declarationDigest,
      binding: binding({
        execute: async (caseId) => {
          executed.push(caseId);
          return caseId === "approved-write"
            ? result(caseId, { passed: false, incorrectSideEffects: 1 })
            : result(caseId);
        },
      }),
      store: new InMemoryGenericAcceptanceCampaignStore(),
    });

    expect(executed).toEqual(["read-only-happy-path", "approved-write"]);
    expect(summary).toMatchObject({
      status: "safety-aborted",
      passed: false,
      abortedForSafety: true,
      executedCases: 2,
      incorrectSideEffects: 1,
    });
    expect(summary.notRunCases).toEqual(REQUIRED_PILOT_ADAPTER_CASES.slice(2));
  });

  it("reconciles an interrupted case after restart without executing it twice", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cf-generic-acceptance-"));
    temporaryDirectories.push(directory);
    let approvedExecutions = 0;
    const firstBinding = binding({
      execute: async (caseId) => {
        if (caseId === "approved-write") {
          approvedExecutions += 1;
          throw new Error("simulated process loss after the external action began");
        }
        return result(caseId);
      },
    });
    const first = await runGenericAcceptanceCampaign({
      campaignId: "restart-campaign",
      declarationDigest,
      binding: firstBinding,
      store: new JsonFileGenericAcceptanceCampaignStore(directory),
    });

    expect(first).toMatchObject({ status: "awaiting-reconciliation", awaitingReconciliation: true, executedCases: 1 });
    expect(first.state.cases.find((item) => item.caseId === "approved-write")).toMatchObject({
      status: "reconciliation-required",
      attemptCount: 1,
    });

    const reconciledCases: PilotAdapterAcceptanceCase[] = [];
    const second = await runGenericAcceptanceCampaign({
      campaignId: "restart-campaign",
      declarationDigest,
      binding: binding({
        execute: async (caseId) => {
          if (caseId === "approved-write") approvedExecutions += 1;
          return result(caseId, { suffix: "after-restart" });
        },
        reconcileInterrupted: async (caseId) => {
          reconciledCases.push(caseId);
          return result(caseId, { suffix: "independent-reconciliation" });
        },
      }),
      store: new JsonFileGenericAcceptanceCampaignStore(directory),
    });

    expect(approvedExecutions).toBe(1);
    expect(reconciledCases).toEqual(["approved-write"]);
    expect(second).toMatchObject({ status: "completed", passed: true, executedCases: 10, reconciledCases: 1 });
    expect(second.state.receipts.find((item) => item.caseId === "approved-write")).toMatchObject({
      source: "interrupted-reconciliation",
      attemptNumber: 1,
    });
  });

  it("fails closed when interrupted execution has no reconciliation binding", async () => {
    const store = new InMemoryGenericAcceptanceCampaignStore();
    const first = await runGenericAcceptanceCampaign({
      campaignId: "unreconciled-campaign",
      declarationDigest,
      binding: binding({ execute: async () => { throw new Error("unknown external state"); } }),
      store,
    });
    expect(first.status).toBe("awaiting-reconciliation");

    const second = await runGenericAcceptanceCampaign({
      campaignId: "unreconciled-campaign",
      declarationDigest,
      binding: binding(),
      store,
    });
    expect(second).toMatchObject({ status: "awaiting-reconciliation", passed: false, executedCases: 0 });
    expect(second.state.cases[0]).toMatchObject({ status: "reconciliation-required", attemptCount: 1 });
  });

  it("rejects changed bindings and detects durable state tampering", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cf-generic-acceptance-"));
    temporaryDirectories.push(directory);
    const store = new JsonFileGenericAcceptanceCampaignStore(directory);
    await prepareGenericAcceptanceCampaign({ campaignId: "bound-campaign", declarationDigest, binding: binding(), store });

    await expect(prepareGenericAcceptanceCampaign({
      campaignId: "bound-campaign",
      declarationDigest,
      binding: binding({ bindingDigest: "f".repeat(64) }),
      store,
    })).rejects.toThrow(/binding identity changed/i);

    const statePath = path.join(directory, "bound-campaign.generic-acceptance.json");
    const envelope = JSON.parse(await readFile(statePath, "utf8")) as { state: { status: string } };
    envelope.state.status = "completed";
    await writeFile(statePath, JSON.stringify(envelope), "utf8");
    await expect(store.load("bound-campaign")).rejects.toThrow(/integrity check/i);
  });

  it("treats malformed success evidence as unknown external state", async () => {
    const summary = await runGenericAcceptanceCampaign({
      campaignId: "malformed-evidence-campaign",
      declarationDigest,
      binding: binding({
        execute: async (caseId) => ({ ...result(caseId), artifactReferences: [] }),
      }),
      store: new InMemoryGenericAcceptanceCampaignStore(),
    });
    expect(summary).toMatchObject({ status: "awaiting-reconciliation", passed: false, executedCases: 0 });
    expect(summary.state.cases[0]?.lastError).toMatch(/evidence references/i);
  });
});
