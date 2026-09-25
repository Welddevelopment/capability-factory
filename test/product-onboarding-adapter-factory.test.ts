import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetTracker, estimateGpt56SolCost, type UsageRecord } from "../src/budget.js";
import {
  adapterDiscoveryUsageEvidenceDigest,
  assertAdapterDiscoveryProposalSafe,
  DETERMINISTIC_ADAPTER_DISCOVERY_PROVIDER,
  discoverAdapterProposal,
  runAdapterDiscoveryProvider,
  type AdapterDiscoveryInput,
} from "../src/product/onboarding-adapter-factory.js";

const roots: string[] = [];
const budgets: BudgetTracker[] = [];
afterEach(() => {
  for (const budget of budgets.splice(0)) { try { budget.close(); } catch { /* already closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function modelOptions(attemptKey: string, maximumProviderSpendUsd = 0.01) {
  const root = mkdtempSync(join(tmpdir(), "adapter-provider-accounting-"));
  roots.push(root);
  const accounting = new BudgetTracker(join(root, "budget.json"), { warnUsd: 0.02, maxUsd: 0.05, maxRunUsd: 0.02, maxCalls: 2 });
  budgets.push(accounting);
  return { allowModelBacked: true as const, maximumProviderSpendUsd, accounting, accountingAttemptKey: attemptKey };
}

function modelResult<T>(proposal: T, providerResponseId: string) {
  const usage: UsageRecord = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 };
  return { proposal, usage, billedSpendUsd: estimateGpt56SolCost(usage), providerResponseId, usageEvidenceDigest: adapterDiscoveryUsageEvidenceDigest(providerResponseId, usage) };
}

function input(): AdapterDiscoveryInput {
  return {
    schemaVersion: "1.0",
    workflow: {
      workflowId: "approved-order-intake",
      summary: "Create one draft order for an approved request.",
      requiredOutcome: "One draft order exists and references the approved request; no other record changes.",
      approvedTargetAliases: ["customer_erp", "customer_tools", "customer_sdk"],
      requestedOperationNames: ["createDraftOrder", "lookup_order", "sdkCreateDraft"],
      customerConfirmed: true,
    },
    materials: [
      {
        kind: "openapi",
        materialId: "orders-openapi",
        localReference: "fixtures/orders-openapi.json",
        approved: true,
        targetAlias: "customer_erp",
        document: {
          openapi: "3.1.0",
          info: { title: "Orders API", version: "1.2.0" },
          security: [{ ERP_WRITER: [] }],
          paths: {
            "/orders/{id}": {
              get: {
                operationId: "getOrder",
                parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
                responses: { "200": { content: { "application/json": { schema: { type: "object", required: ["id", "status"] } } } } },
              },
            },
            "/orders": {
              post: {
                operationId: "createDraftOrder",
                summary: "Create a draft order",
                parameters: [{ in: "header", name: "Idempotency-Key", required: true, schema: { type: "string" } }],
                requestBody: { content: { "application/json": { schema: { type: "object", required: ["requestId"] } } } },
                responses: { "201": { content: { "application/json": { schema: { type: "object", required: ["id"] } } } } },
              },
            },
          },
          components: { securitySchemes: { ERP_WRITER: { type: "apiKey", in: "header", name: "X-API-Key" } } },
        },
      },
      {
        kind: "mcp",
        materialId: "orders-mcp",
        localReference: "fixtures/orders-mcp.json",
        approved: true,
        targetAlias: "customer_tools",
        serverName: "Order tools",
        tools: [
          { name: "lookup_order", description: "Read an order", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "mutate_order", description: "Potentially changes an order", inputSchema: { type: "object" } },
        ],
      },
      {
        kind: "sdk-reference",
        materialId: "orders-sdk",
        localReference: "fixtures/orders-sdk.json",
        approved: true,
        targetAlias: "customer_sdk",
        packageName: "orders-sdk",
        packageVersion: "4.0.0",
        operations: [{
          name: "sdkCreateDraft",
          effect: "write",
          requestShape: { type: "object", required: ["requestId"] },
          responseShape: { type: "object", required: ["id"] },
          idempotency: "not-documented",
          credentialAliases: ["SDK_ORDER_WRITER"],
        }],
      },
    ],
  };
}

describe("zero-spend onboarding adapter factory", () => {
  it("extracts provider-neutral operations with fact-level provenance while remaining non-executable", () => {
    const proposal = discoverAdapterProposal(input());
    expect(proposal).toMatchObject({ proposalState: "proposal-only", executable: false, writesAuthorized: false });
    expect(proposal.systems).toHaveLength(3);
    expect(proposal.targets.map((target) => target.alias.value)).toEqual(["customer_erp", "customer_tools", "customer_sdk"]);
    expect(proposal.credentialAliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ alias: expect.objectContaining({ value: "ERP_WRITER", status: "extracted" }), valuePresent: false }),
      expect.objectContaining({ alias: expect.objectContaining({ value: "SDK_ORDER_WRITER", status: "extracted" }), valuePresent: false }),
    ]));
    const create = proposal.operations.find((operation) => operation.operationId.value === "createDraftOrder");
    expect(create).toMatchObject({
      operationKey: { value: "customer_erp.createDraftOrder" },
      sourceKind: { value: "http", status: "observed" },
      transportAction: { value: "POST /orders" },
      consequence: { value: "write", status: "extracted" },
      idempotency: { value: "documented" },
      retryRequirement: { value: "reconcile-before-retry" },
      reconciliationCandidates: { value: ["getOrder"], status: "inferred-proposal" },
      requestedByWorkflow: { value: true, status: "customer-confirmed" },
      writeAuthorized: { value: false, status: "independently-verified" },
      executable: { value: false, status: "independently-verified" },
    });
    expect(create?.requestShape.value).toEqual(expect.objectContaining({ body: expect.objectContaining({ required: ["requestId"] }) }));
    expect(create?.operationId.evidence[0]).toEqual(expect.objectContaining({ materialId: "orders-openapi", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(proposal.scopeWorkflow).toMatchObject({ authorityState: { value: "unconfigured" }, verifierState: { value: "unconfigured" } });
    expect(proposal.engineeringBlockers.map((blocker) => blocker.blockerId)).toEqual(expect.arrayContaining([
      "authority-unconfigured",
      "credential-alias-unbound",
      "verifier-unconfigured",
      "acceptance-not-run",
      "reconciliation-unproven",
    ]));
    expect(() => assertAdapterDiscoveryProposalSafe(proposal)).not.toThrow();
  });

  it("keeps ambiguous MCP side effects unknown and blocks execution", () => {
    const proposal = discoverAdapterProposal(input());
    const ambiguous = proposal.operations.find((operation) => operation.operationId.value === "mutate_order");
    expect(ambiguous).toMatchObject({
      consequence: { value: "unknown", status: "unknown" },
      retryRequirement: { value: "requires-engineer-confirmation", status: "unknown" },
      writeAuthorized: { value: false },
      executable: { value: false },
    });
  });

  it("keeps reconciliation blocked even when a same-target read is a plausible candidate", () => {
    const current = input();
    current.workflow.requestedOperationNames = ["createDraftOrder"];
    const proposal = discoverAdapterProposal(current);
    const blocker = proposal.engineeringBlockers.find((item) => item.blockerId === "reconciliation-unproven");
    expect(blocker?.fact.value).toMatch(/none is yet proven/);
    expect(blocker?.fact.explanation).toMatch(/candidate read operation is not a verifier/i);
  });

  it("rejects credential-shaped material rather than copying a value into a proposal", () => {
    const current = input();
    current.materials.push({
      kind: "sdk-reference",
      materialId: "unsafe-sdk",
      localReference: "fixtures/unsafe.json",
      approved: true,
      packageName: "unsafe-sdk",
      operations: [{ name: "unsafeRead", description: "Authorization: Bearer abcdefghijklmnop", effect: "read" }],
    });
    expect(() => discoverAdapterProposal(current)).toThrow(/credential-shaped value/);
  });

  it("rejects Swagger 2 material rather than silently parsing it as OpenAPI 3", () => {
    const current = input();
    const openApi = current.materials.find((material) => material.kind === "openapi");
    if (!openApi || openApi.kind !== "openapi") throw new Error("fixture missing");
    openApi.document = { swagger: "2.0", info: { title: "Legacy API", version: "1" }, paths: {} };
    expect(() => discoverAdapterProposal(current)).toThrow(/Swagger 2\.x.*does not parse/);
  });

  it("fails closed when the workflow does not map exactly to an extracted operation", () => {
    const current = input();
    current.workflow.requestedOperationNames = ["inventedOperation"];
    const proposal = discoverAdapterProposal(current);
    expect(proposal.scopeWorkflow.operationIds).toMatchObject({ value: [], status: "unknown" });
    expect(proposal.engineeringBlockers).toContainEqual(expect.objectContaining({ blockerId: "operation-selection", blocking: true }));
    expect(proposal.operations.every((operation) => operation.executable.value === false)).toBe(true);
  });

  it("allows common operation names across targets by qualifying their identity", () => {
    const current = input();
    const sdk = current.materials.find((material) => material.kind === "sdk-reference");
    if (!sdk || sdk.kind !== "sdk-reference") throw new Error("fixture missing");
    sdk.operations[0]!.name = "createDraftOrder";
    current.workflow.requestedOperationNames = ["customer_erp.createDraftOrder", "customer_sdk.createDraftOrder"];
    const proposal = discoverAdapterProposal(current);
    expect(proposal.scopeWorkflow.operationIds.value).toEqual([
      "customer_erp.createDraftOrder",
      "customer_sdk.createDraftOrder",
    ]);
  });

  it("blocks an unqualified operation name that matches more than one target", () => {
    const current = input();
    const sdk = current.materials.find((material) => material.kind === "sdk-reference");
    if (!sdk || sdk.kind !== "sdk-reference") throw new Error("fixture missing");
    sdk.operations[0]!.name = "createDraftOrder";
    current.workflow.requestedOperationNames = ["createDraftOrder"];
    const proposal = discoverAdapterProposal(current);
    expect(proposal.scopeWorkflow.operationIds.value).toEqual([]);
    expect(proposal.engineeringBlockers).toContainEqual(expect.objectContaining({ blockerId: "operation-selection" }));
    expect(proposal.unknowns).toContainEqual(expect.objectContaining({ value: expect.stringMatching(/ambiguous across targets/) }));
  });

  it("rejects a duplicate operation key within the same target", () => {
    const current = input();
    const sdk = current.materials.find((material) => material.kind === "sdk-reference");
    if (!sdk || sdk.kind !== "sdk-reference") throw new Error("fixture missing");
    sdk.targetAlias = "customer_erp";
    sdk.operations[0]!.name = "createDraftOrder";
    expect(() => discoverAdapterProposal(current)).toThrow(/ambiguous within one target/);
  });

  it("revalidates all provider output at the provider-neutral fail-closed seam", async () => {
    const safe = await runAdapterDiscoveryProvider(DETERMINISTIC_ADAPTER_DISCOVERY_PROVIDER, input());
    expect(safe).toMatchObject({ proposalState: "proposal-only", executable: false, writesAuthorized: false });
    let called = false;
    const unsafeProvider = {
      providerId: "unsafe-model-fixture",
      providerKind: "model-backed" as const,
      propose: async () => { called = true; return modelResult({ ...safe, executable: true as never }, "unsafe-response"); },
    };
    await expect(runAdapterDiscoveryProvider(unsafeProvider, input())).rejects.toThrow(/disabled until explicitly authorized/);
    expect(called).toBe(false);
    await expect(runAdapterDiscoveryProvider(unsafeProvider, input(), { allowModelBacked: true, maximumProviderSpendUsd: 0.01 }))
      .rejects.toThrow(/durable pre-call accounting/i);
    expect(called).toBe(false);
    const accounted = modelOptions("unsafe-attempt");
    await expect(runAdapterDiscoveryProvider(unsafeProvider, input(), accounted))
      .rejects.toThrow(/proposal-only, non-executable/);
    expect(called).toBe(true);
    expect(accounted.accounting.accountingSnapshot()).toMatchObject({ statuses: { settled: 1 }, unresolvedReservationIds: [] });
  });

  it("prevents model providers from deleting trusted facts or mandatory blockers and enforces accounted spend", async () => {
    const baseline = discoverAdapterProposal(input());
    const deletingProvider = {
      providerId: "deleting-model-fixture",
      providerKind: "model-backed" as const,
      propose: async () => modelResult({ ...baseline, systems: [], engineeringBlockers: [] }, "deleting-response"),
    };
    await expect(runAdapterDiscoveryProvider(deletingProvider, input(), modelOptions("deleting-attempt")))
      .rejects.toThrow(/cannot remove or alter trusted baseline fact|mandatory baseline blocker/);

    const overspendProvider = {
      providerId: "overspend-model-fixture",
      providerKind: "model-backed" as const,
      propose: async (_input: AdapterDiscoveryInput, limits: { maximumSpendUsd: number }) => ({ proposal: baseline, billedSpendUsd: limits.maximumSpendUsd + 0.01 }),
    };
    await expect(runAdapterDiscoveryProvider(overspendProvider, input(), modelOptions("overspend-attempt")))
      .rejects.toThrow(/exceeded the caller's hard spend ceiling/);
  });

  it("preserves provider failure as ambiguous usage and blocks a second adapter proposal call", async () => {
    let providerCalls = 0;
    const failingProvider = {
      providerId: "failing-model-fixture",
      providerKind: "model-backed" as const,
      propose: async () => { providerCalls += 1; throw new Error("provider ended without usage"); },
    };
    const options = modelOptions("failing-attempt");
    await expect(runAdapterDiscoveryProvider(failingProvider, input(), options)).rejects.toThrow(/provider ended without usage/);
    expect(options.accounting.accountingSnapshot()).toMatchObject({ statuses: { ambiguous: 1 }, unresolvedReservationIds: [expect.any(String)] });
    await expect(runAdapterDiscoveryProvider(failingProvider, input(), { ...options, accountingAttemptKey: "second-attempt" })).rejects.toThrow(/unresolved model call/i);
    expect(providerCalls).toBe(1);
  });

  it("revalidates provider schema, evidence anchoring, and mandatory blockers regardless of provider label", async () => {
    const baseline = discoverAdapterProposal(input());
    const wrongSchemaProvider = {
      providerId: "wrong-schema-model-fixture",
      providerKind: "model-backed" as const,
      propose: async () => modelResult({ ...baseline, schemaVersion: "0.0" as never }, "wrong-schema-response"),
    };
    await expect(runAdapterDiscoveryProvider(wrongSchemaProvider, input(), modelOptions("wrong-schema-attempt")))
      .rejects.toThrow(/unsupported schema version/);

    const forgedEvidence = structuredClone(baseline);
    forgedEvidence.systems[0]!.systemId.evidence[0]!.sha256 = "a".repeat(64);
    const forgedEvidenceProvider = {
      providerId: "forged-evidence-model-fixture",
      providerKind: "model-backed" as const,
      propose: async () => modelResult(forgedEvidence, "forged-evidence-response"),
    };
    await expect(runAdapterDiscoveryProvider(forgedEvidenceProvider, input(), modelOptions("forged-evidence-attempt")))
      .rejects.toThrow(/evidence digest.*does not match/);

    const blockerDeletingProvider = {
      providerId: "blocker-deleting-deterministic-fixture",
      providerKind: "deterministic" as const,
      propose: async () => ({ proposal: { ...baseline, engineeringBlockers: [] }, billedSpendUsd: 0 }),
    };
    await expect(runAdapterDiscoveryProvider(blockerDeletingProvider, input()))
      .rejects.toThrow(/mandatory baseline blocker/);
  });
});
