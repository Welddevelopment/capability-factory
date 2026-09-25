import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zodTextFormat } from "openai/helpers/zod";
import { redactEncryptedModelContent } from "../src/model-gateway.js";
import type { CapabilityManifest } from "../src/manifest.js";
import { CapabilityRuntime } from "../src/runtime.js";
import {
  createErpNextReferenceCapability,
  startErpNextDevelopmentWorld,
  type ErpNextDevelopmentWorldHandle,
} from "../src/customer-world/erpnext-world.js";
import { createRealErpNextReferenceCapability } from "../src/customer-world/real-erpnext-world.js";
import type {
  ActionReceipt,
  CapabilityEvent,
  CapabilityRequest,
  OutcomeReceipt,
} from "../src/product/contracts.js";
import {
  CapabilityCoordinator,
  manifestDigest,
  type CapabilityBuilder,
  type CapabilityEventSink,
  type CapabilityVerifier,
  type RuntimeResolver,
  type TrustedCapabilitySource,
} from "../src/product/coordinator.js";
import { CapabilityFactorySdk, type CapabilityWorkflow } from "../src/product/sdk.js";
import { createCapabilitySidecar } from "../src/product/sidecar.js";
import { CustomerDataPlaneWorker, InMemoryControlPlaneQueue } from "../src/product/split-plane.js";
import { FileTenantCapabilityStore } from "../src/product/store.js";
import { FileCapabilityEventJournal } from "../src/product/audit.js";
import { ConfiguredTrustedCatalog } from "../src/product/catalog.js";
import { CapabilityFactorySidecarClient } from "../src/product/client.js";
import {
  StructuredManifestBuilder,
  manifestToDraftOutput,
  productCapabilityDraftSchema,
} from "../src/product/builder.js";

const SIDECAR_TOKEN = "local-sidecar-test-token-0001";

const worlds: ErpNextDevelopmentWorldHandle[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.close()));
});

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "capability-factory-product-"));
}

async function startWorld(): Promise<ErpNextDevelopmentWorldHandle> {
  const world = await startErpNextDevelopmentWorld(temporaryDirectory());
  worlds.push(world);
  return world;
}

function requestFor(
  world: ErpNextDevelopmentWorldHandle,
  caseId: string,
  tenantId = "tenant-a",
  requestId = `request-${caseId}`,
): CapabilityRequest {
  const secretAlias = world.secretAlias(caseId);
  return {
    context: {
      tenantId,
      requestId,
      workflowKey: "dispatch-preparation",
      ordinaryGoal: world.cases.find((candidate) => candidate.id === caseId)!.ordinaryGoal,
      blockedAt: "2026-07-26T10:00:00.000Z",
      blockedReason: "The configured tools cannot prepare the required dispatch record.",
      visibility: "exceptions-only",
    },
    need: {
      key: "prepare-dispatch-record",
      summary: "Prepare one authorized dispatch record and update its source order.",
      requiredActions: ["read_sales_order", "create_delivery_note", "update_sales_order"],
      targetAliases: ["customer_system"],
      secretAliases: [secretAlias],
      documentationHash: world.documentation.sha256,
    },
    authority: {
      allowedTargetAliases: ["customer_system"],
      allowedSecretAliases: [secretAlias],
      allowedMethods: ["GET", "POST", "PUT"],
      writeAuthority: "preauthorized",
      approvedWriteActions: [],
    },
    runtimeProfile: caseId,
  };
}

class WorldRuntimeResolver implements RuntimeResolver {
  constructor(private readonly world: ErpNextDevelopmentWorldHandle) {}
  resolve(request: CapabilityRequest): CapabilityRuntime {
    return new CapabilityRuntime(this.world.runtimeConfiguration(request.runtimeProfile));
  }
}

class ReferenceBuilder implements CapabilityBuilder {
  calls = 0;
  constructor(private readonly world: ErpNextDevelopmentWorldHandle) {}
  async build(request: CapabilityRequest): Promise<CapabilityManifest> {
    this.calls += 1;
    return createErpNextReferenceCapability(this.world.documentation, request.need.secretAliases[0]!);
  }
}

class ReferenceVerifier implements CapabilityVerifier {
  async verify(request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime) {
    runtime.validateManifest(manifest);
    const read = manifest.actions.find((action) => action.name === "read_sales_order");
    return {
      verifierVersion: "product-reference-1",
      manifestDigest: manifestDigest(manifest),
      documentationHash: request.need.documentationHash,
      passed: Boolean(read),
      checks: [
        { id: "runtime-policy", passed: true, detail: "Manifest passed trusted runtime policy validation." },
        { id: "required-read", passed: Boolean(read), detail: "Required read action is present." },
      ],
      verifiedAt: "2026-07-26T10:00:01.000Z",
    };
  }
}

class WorldWorkflow implements CapabilityWorkflow {
  constructor(
    private readonly world: ErpNextDevelopmentWorldHandle,
    private readonly caseId: string,
    private readonly orderId: string,
  ) {}

  async execute(_request: CapabilityRequest, manifest: CapabilityManifest, runtime: CapabilityRuntime) {
    const runId = `product-${this.caseId}`;
    const input = {
      salesOrderId: this.orderId,
      trackingNumber: `PF-${this.orderId}`,
      labelReference: `LABEL-${this.orderId}`,
      injectLostResponse: false,
    };
    const read = await runtime.execute(manifest, "read_sales_order", { salesOrderId: this.orderId }, { runId });
    const created = await runtime.execute(manifest, "create_delivery_note", input, { runId });
    const updated = await runtime.execute(
      manifest,
      "update_sales_order",
      {
        salesOrderId: this.orderId,
        trackingNumber: `PF-${this.orderId}`,
        labelReference: `LABEL-${this.orderId}`,
      },
      { runId },
    );
    return [read, created, updated].map<ActionReceipt>((receipt, index) => ({
      action: ["read_sales_order", "create_delivery_note", "update_sales_order"][index]!,
      status: receipt.status,
      output: receipt.output,
    }));
  }

  async verifyOutcome(): Promise<OutcomeReceipt> {
    const result = this.world.verify(this.caseId);
    return {
      verifierVersion: "direct-database-1",
      passed: result.passed,
      intendedWrites: result.intendedWrites,
      incorrectSideEffects: result.incorrectSideEffects,
      stateDigest: result.stateHash,
      checks: result.issues.length
        ? result.issues.map((issue) => ({ id: issue.code, passed: false, detail: issue.message }))
        : [{ id: "exact-external-state", passed: true, detail: "Direct database state matched the case contract." }],
      verifiedAt: "2026-07-26T10:00:02.000Z",
    };
  }

  async resume() {
    return { completed: this.world.verify(this.caseId).passed, summary: "The original goal continued after dispatch preparation." };
  }
}

function productFor(
  world: ErpNextDevelopmentWorldHandle,
  events?: CapabilityEvent[],
  trustedSources?: TrustedCapabilitySource[],
) {
  const store = new FileTenantCapabilityStore(path.join(temporaryDirectory(), "registry"));
  const builder = new ReferenceBuilder(world);
  const runtimeResolver = new WorldRuntimeResolver(world);
  const eventSink: CapabilityEventSink | undefined = events
    ? { record: (event) => void events.push(event) }
    : undefined;
  const coordinator = new CapabilityCoordinator({
    store,
    builder,
    verifier: new ReferenceVerifier(),
    runtimeResolver,
    ...(trustedSources ? { trustedSources } : {}),
    ...(eventSink ? { events: eventSink } : {}),
  });
  const sdk = new CapabilityFactorySdk({
    coordinator,
    runtimeResolver,
    ...(eventSink ? { events: eventSink } : {}),
  });
  return { store, builder, coordinator, sdk };
}

describe("shared product core", () => {
  it("builds, verifies, executes, independently checks, resumes, then reuses", async () => {
    const world = await startWorld();
    const events: CapabilityEvent[] = [];
    const product = productFor(world, events);

    world.reset("first-build");
    const first = await product.sdk.completeBlockedGoal(
      requestFor(world, "first-build"),
      new WorldWorkflow(world, "first-build", "SO-DEV-0002"),
    );
    expect(first).toMatchObject({ status: "completed", capabilitySource: "built" });
    expect(world.verify("first-build")).toMatchObject({ passed: true, incorrectSideEffects: 0 });

    world.reset("fresh-session-reuse");
    const second = await product.sdk.completeBlockedGoal(
      requestFor(world, "fresh-session-reuse"),
      new WorldWorkflow(world, "fresh-session-reuse", "SO-DEV-0003"),
    );
    expect(second).toMatchObject({ status: "completed", capabilitySource: "reused" });
    expect(product.builder.calls).toBe(1);
    expect(events.map((event) => event.type)).toContain("goal.resumed");
  });

  it("denies missing write authority before building or touching external state", async () => {
    const world = await startWorld();
    const resetHash = world.reset("first-build");
    const product = productFor(world);
    const request = requestFor(world, "first-build");
    request.authority.writeAuthority = "denied";
    const result = await product.sdk.completeBlockedGoal(
      request,
      new WorldWorkflow(world, "first-build", "SO-DEV-0002"),
    );
    expect(result).toMatchObject({ status: "handoff", handoff: { reason: "policy-denied" } });
    expect(product.builder.calls).toBe(1);
    expect(world.stateHash()).toBe(resetHash);
  });

  it("requires every consequential action when authority is per-action", async () => {
    const world = await startWorld();
    const product = productFor(world);
    const partiallyApproved = requestFor(world, "first-build", "tenant-a", "partial");
    partiallyApproved.authority.writeAuthority = "per-action-approval";
    partiallyApproved.authority.approvedWriteActions = ["create_delivery_note"];
    expect(await product.coordinator.acquire(partiallyApproved)).toMatchObject({
      status: "handoff",
      handoff: { reason: "policy-denied" },
    });

    const fullyApproved = requestFor(world, "first-build", "tenant-b", "full");
    fullyApproved.authority.writeAuthority = "per-action-approval";
    fullyApproved.authority.approvedWriteActions = ["create_delivery_note", "update_sales_order"];
    expect(await product.coordinator.acquire(fullyApproved)).toMatchObject({
      status: "acquired",
      acquired: { source: "built" },
    });
  });

  it("rejects an unresolved OpenAPI path placeholder before any network request", async () => {
    const world = await startWorld();
    const runtime = new CapabilityRuntime(world.runtimeConfiguration("first-build"));
    const manifest = createErpNextReferenceCapability(world.documentation, world.secretAlias("first-build"));
    manifest.actions.find((action) => action.name === "read_sales_order")!.request.pathTemplate =
      "/api/resource/Sales%20Order/{name}";
    expect(() => runtime.validateManifest(manifest)).toThrow(/unresolved placeholder/);
  });

  it("feeds independent verification failure into one bounded structured redraft", async () => {
    const world = await startWorld();
    const reference = createErpNextReferenceCapability(world.documentation, world.secretAlias("first-build"));
    const invalid = structuredClone(reference);
    invalid.actions.find((action) => action.name === "read_sales_order")!.request.pathTemplate =
      "/api/resource/Sales%20Order/{name}";
    let calls = 0;
    const builder = new StructuredManifestBuilder({
      documentation: { resolve: async () => world.documentation },
      gateway: {
        modelLabel: "deterministic-repair-gateway",
        draft: async (input) => {
          calls += 1;
          if (calls === 2) expect(input.previousError).toMatch(/unresolved placeholder/);
          return manifestToDraftOutput(calls === 1 ? invalid : reference);
        },
      },
      maxAttempts: 1,
    });
    const runtimeResolver = new WorldRuntimeResolver(world);
    const coordinator = new CapabilityCoordinator({
      store: new FileTenantCapabilityStore(path.join(temporaryDirectory(), "registry")),
      builder,
      verifier: new ReferenceVerifier(),
      runtimeResolver,
      maxVerificationRepairs: 1,
    });
    expect(await coordinator.acquire(requestFor(world, "first-build"))).toMatchObject({
      status: "acquired",
      acquired: { source: "built" },
    });
    expect(calls).toBe(2);
  });

  it("keeps capability records isolated by tenant", async () => {
    const world = await startWorld();
    const product = productFor(world);
    await product.coordinator.acquire(requestFor(world, "first-build", "tenant-a", "a"));
    expect(product.store.list("tenant-a")).toHaveLength(1);
    expect(product.store.list("tenant-b")).toHaveLength(0);
    await product.coordinator.acquire(requestFor(world, "first-build", "tenant-b", "b"));
    expect(product.builder.calls).toBe(2);
    expect(product.store.list("tenant-b")).toHaveLength(1);
  });

  it("coalesces concurrent requests for the same missing capability", async () => {
    const world = await startWorld();
    const product = productFor(world);
    const request = requestFor(world, "first-build");
    const [left, right] = await Promise.all([
      product.coordinator.acquire(request),
      product.coordinator.acquire(structuredClone(request)),
    ]);
    expect(left).toEqual(right);
    expect(product.builder.calls).toBe(1);
  });

  it("searches, verifies, and installs a trusted existing tool before allowing a build", async () => {
    const world = await startWorld();
    const trustedManifest = createErpNextReferenceCapability(world.documentation, world.secretAlias("first-build"));
    const source: TrustedCapabilitySource = {
      id: "local-trusted-catalog",
      search: async () => [{ referenceId: "catalog-item-1", manifest: trustedManifest }],
    };
    const product = productFor(world, undefined, [source]);
    const result = await product.coordinator.acquire(requestFor(world, "first-build"));
    expect(result).toMatchObject({ status: "acquired", acquired: { source: "trusted-tool" } });
    expect(product.builder.calls).toBe(0);
    expect(product.store.list("tenant-a")[0]).toMatchObject({ origin: "trusted:local-trusted-catalog" });
  });

  it("rejects a stale trusted catalog candidate and builds against current documentation", async () => {
    const world = await startWorld();
    const staleManifest = createErpNextReferenceCapability(world.documentation, world.secretAlias("first-build"));
    staleManifest.provenance.documentationHash = "a".repeat(64);
    const source: TrustedCapabilitySource = {
      id: "stale-catalog",
      search: async () => [{ manifest: staleManifest }],
    };
    const product = productFor(world, undefined, [source]);
    const result = await product.coordinator.acquire(requestFor(world, "first-build"));
    expect(result).toMatchObject({ status: "acquired", acquired: { source: "built" } });
    expect(product.builder.calls).toBe(1);
  });

  it("filters disabled and untrusted catalog entries before coordinator verification", async () => {
    const world = await startWorld();
    const manifest = createErpNextReferenceCapability(world.documentation, world.secretAlias("first-build"));
    const catalog = new ConfiguredTrustedCatalog("customer-catalog", [
      { referenceId: "disabled", needKey: "prepare-dispatch-record", manifest, trust: "customer-approved", enabled: false },
      { referenceId: "untrusted", needKey: "prepare-dispatch-record", manifest, trust: "untrusted", enabled: true },
      { referenceId: "approved", needKey: "prepare-dispatch-record", manifest, trust: "customer-approved", enabled: true },
      { referenceId: "wrong-need", needKey: "different-need", manifest, trust: "vendor-reviewed", enabled: true },
    ]);
    const candidates = await catalog.search(requestFor(world, "first-build"));
    expect(candidates.map((candidate) => candidate.referenceId)).toEqual(["approved"]);
  });

  it("builds the unsupported residual from current documentation without sending the ordinary goal", async () => {
    const world = await startWorld();
    const request = requestFor(world, "first-build");
    const reference = createErpNextReferenceCapability(world.documentation, world.secretAlias("first-build"));
    const seen: unknown[] = [];
    let calls = 0;
    const builder = new StructuredManifestBuilder({
      documentation: { resolve: async () => world.documentation },
      gateway: {
        modelLabel: "deterministic-local-draft-gateway",
        draft: async (input) => {
          calls += 1;
          seen.push(input);
          return calls === 1 ? { malformed: true } : manifestToDraftOutput(reference);
        },
      },
      maxAttempts: 2,
      now: () => "2026-07-26T10:00:00.000Z",
    });
    const manifest = await builder.build(request);
    expect(calls).toBe(2);
    expect(manifest.provenance).toMatchObject({
      documentationHash: world.documentation.sha256,
      model: "deterministic-local-draft-gateway",
    });
    expect(JSON.stringify(seen)).not.toContain(request.context.ordinaryGoal);
    const secretValue = Object.values(world.runtimeConfiguration("first-build").secrets)[0]!;
    expect(JSON.stringify(seen)).not.toContain(secretValue);
  });

  it("round-trips nested real-application request bodies through the product draft transport", async () => {
    const world = await startWorld();
    const request = requestFor(world, "first-build");
    const nestedReference = createRealErpNextReferenceCapability(
      world.documentation,
      world.secretAlias("first-build"),
    );
    const builder = new StructuredManifestBuilder({
      documentation: { resolve: async () => world.documentation },
      gateway: {
        modelLabel: "deterministic-nested-draft",
        draft: async () => manifestToDraftOutput(nestedReference),
      },
      now: () => "2026-07-26T10:00:00.000Z",
    });
    const built = await builder.build(request);
    const originalBody = nestedReference.actions.find((action) => action.name === "create_delivery_note")!.request.bodyTemplate;
    const builtBody = built.actions.find((action) => action.name === "create_delivery_note")!.request.bodyTemplate;
    expect(builtBody).toEqual(originalBody);
    expect((builtBody as Record<string, unknown>).items).toBeInstanceOf(Array);
  });

  it("converts the nested draft transport to a strict model-output schema without dynamic map keywords", () => {
    const format = zodTextFormat(productCapabilityDraftSchema, "product_capability_draft");
    const serialized = JSON.stringify(format);
    expect(serialized).not.toContain("propertyNames");
    expect(serialized).toContain("product_capability_draft");
    expect(serialized).toContain("$ref");
  });

  it("does not reuse a quarantined capability", async () => {
    const world = await startWorld();
    const product = productFor(world);
    const first = await product.coordinator.acquire(requestFor(world, "first-build", "tenant-a", "first"));
    expect(first.status).toBe("acquired");
    const capabilityId = product.store.list("tenant-a")[0]!.manifest.id;
    product.store.setStatus("tenant-a", capabilityId, "quarantined");
    const second = await product.coordinator.acquire(requestFor(world, "first-build", "tenant-a", "second"));
    expect(second).toMatchObject({ status: "acquired", acquired: { source: "built" } });
    expect(product.builder.calls).toBe(2);
  });

  it("writes a redacted tenant-separated local audit journal", async () => {
    const directory = temporaryDirectory();
    const journal = new FileCapabilityEventJournal(directory);
    journal.record({
      tenantId: "tenant-a",
      requestId: "request-a",
      type: "handoff.created",
      detail: { message: "Authorization: Bearer private-value", apiKey: "private-key" },
      occurredAt: "2026-07-26T10:00:00.000Z",
    });
    expect(JSON.stringify(journal.read("tenant-a"))).not.toMatch(/private-value|private-key/);
    expect(journal.read("tenant-b")).toEqual([]);
  });

  it("removes opaque encrypted model content before trace persistence", () => {
    const sanitized = redactEncryptedModelContent({
      type: "reasoning",
      encrypted_content: "sk-ciphertext-like-value",
      summary: [{ text: "safe summary" }],
    });
    expect(JSON.stringify(sanitized)).not.toContain("ciphertext-like-value");
    expect(sanitized).toMatchObject({ encrypted_content: "[REDACTED ENCRYPTED MODEL CONTENT]" });
  });

  it("redacts credential-shaped text from failed handoffs", async () => {
    const world = await startWorld();
    const store = new FileTenantCapabilityStore(path.join(temporaryDirectory(), "registry"));
    const coordinator = new CapabilityCoordinator({
      store,
      builder: { build: async () => { throw new Error("Bearer exposed-token"); } },
      verifier: new ReferenceVerifier(),
      runtimeResolver: new WorldRuntimeResolver(world),
    });
    const result = await coordinator.acquire(requestFor(world, "first-build"));
    expect(JSON.stringify(result)).not.toContain("exposed-token");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("hands off on a wrong external outcome and never resumes the original goal", async () => {
    const world = await startWorld();
    world.reset("first-build");
    const events: CapabilityEvent[] = [];
    const product = productFor(world, events);
    const base = new WorldWorkflow(world, "first-build", "SO-DEV-0002");
    let resumeCalls = 0;
    const workflow: CapabilityWorkflow = {
      execute: async (request, manifest, runtime) => {
        const actions = await base.execute(request, manifest, runtime);
        world.database
          .prepare("UPDATE tabDeliveryNote SET carrier = ? WHERE sales_order = ?")
          .run("WrongCarrier", "SO-DEV-0002");
        return actions;
      },
      verifyOutcome: async () => base.verifyOutcome(),
      resume: async () => {
        resumeCalls += 1;
        return { completed: true, summary: "Should not run" };
      },
    };
    expect(await product.sdk.completeBlockedGoal(requestFor(world, "first-build"), workflow)).toMatchObject({
      status: "handoff",
      handoff: { reason: "outcome-failed" },
    });
    expect(resumeCalls).toBe(0);
    expect(product.store.list("tenant-a")).toEqual([
      expect.objectContaining({ status: "quarantined" }),
    ]);
    expect(events.map((event) => event.type)).toContain("capability.quarantined");

    const replacement = await product.coordinator.acquire(
      requestFor(world, "first-build", "tenant-a", "replacement-after-quarantine"),
    );
    expect(replacement).toMatchObject({ status: "acquired", acquired: { source: "built" } });
    expect(product.builder.calls).toBe(2);
  });

  it("quarantines when the independent outcome cannot be established", async () => {
    const world = await startWorld();
    world.reset("first-build");
    const product = productFor(world);
    const base = new WorldWorkflow(world, "first-build", "SO-DEV-0002");
    const workflow: CapabilityWorkflow = {
      execute: async (request, manifest, runtime) => base.execute(request, manifest, runtime),
      verifyOutcome: async () => { throw new Error("independent read channel unavailable"); },
      resume: async () => ({ completed: true, summary: "Must not resume" }),
    };

    const result = await product.sdk.completeBlockedGoal(requestFor(world, "first-build"), workflow);
    expect(result).toMatchObject({
      status: "handoff",
      handoff: {
        reason: "outcome-failed",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({ id: "outcome-verifier", passed: false }),
        ]),
      },
    });
    expect(product.store.list("tenant-a")).toEqual([
      expect.objectContaining({ status: "quarantined" }),
    ]);
  });

  it("does not call a successful capability action a success when the original goal fails to resume", async () => {
    const world = await startWorld();
    world.reset("first-build");
    const product = productFor(world);
    const base = new WorldWorkflow(world, "first-build", "SO-DEV-0002");
    const workflow: CapabilityWorkflow = {
      execute: async (request, manifest, runtime) => base.execute(request, manifest, runtime),
      verifyOutcome: async () => base.verifyOutcome(),
      resume: async () => ({ completed: false, summary: "The original agent remained stopped." }),
    };
    expect(await product.sdk.completeBlockedGoal(requestFor(world, "first-build"), workflow)).toMatchObject({
      status: "handoff",
      handoff: { reason: "resume-failed" },
    });
    expect(world.verify("first-build")).toMatchObject({ passed: true, incorrectSideEffects: 0 });
  });
});

describe("deployable shapes over the shared core", () => {
  it("runs the same complete loop behind a customer-hosted HTTP sidecar", async () => {
    const world = await startWorld();
    world.reset("first-build");
    const product = productFor(world);
    const app = createCapabilitySidecar(
      product.sdk,
      {
        resolve: (key) => key === "dispatch-preparation" ? new WorldWorkflow(world, "first-build", "SO-DEV-0002") : undefined,
      },
      { accessToken: SIDECAR_TOKEN },
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/blocked-goals",
      headers: { "x-capability-sidecar-token": SIDECAR_TOKEN },
      payload: requestFor(world, "first-build"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "completed", capabilitySource: "built" });
    expect(world.verify("first-build")).toMatchObject({ passed: true, incorrectSideEffects: 0 });
    await app.close();
  });

  it("rejects malformed sidecar requests and unknown workflows without running acquisition", async () => {
    const world = await startWorld();
    const product = productFor(world);
    const app = createCapabilitySidecar(product.sdk, { resolve: () => undefined }, { accessToken: SIDECAR_TOKEN });
    expect((await app.inject({ method: "POST", url: "/v1/blocked-goals", payload: {} })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/blocked-goals",
          headers: { "x-capability-sidecar-token": SIDECAR_TOKEN },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    const unknown = requestFor(world, "first-build");
    unknown.context.workflowKey = "unknown";
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/blocked-goals",
          headers: { "x-capability-sidecar-token": SIDECAR_TOKEN },
          payload: unknown,
        })
      ).statusCode,
    ).toBe(404);
    expect(product.builder.calls).toBe(0);
    await app.close();
  });

  it("uses an authenticated thin client over the real localhost sidecar boundary", async () => {
    const world = await startWorld();
    world.reset("first-build");
    const product = productFor(world);
    const app = createCapabilitySidecar(
      product.sdk,
      {
        resolve: (key) => key === "dispatch-preparation" ? new WorldWorkflow(world, "first-build", "SO-DEV-0002") : undefined,
      },
      { accessToken: SIDECAR_TOKEN },
    );
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new CapabilityFactorySidecarClient({ baseUrl, accessToken: SIDECAR_TOKEN });
    const result = await client.completeBlockedGoal(requestFor(world, "first-build"));
    expect(result).toMatchObject({ status: "completed", capabilitySource: "built" });
    expect(world.verify("first-build")).toMatchObject({ passed: true, incorrectSideEffects: 0 });
    await app.close();
  });

  it("keeps execution in a tenant-scoped data plane while a control plane only queues sanitized work", async () => {
    const world = await startWorld();
    world.reset("first-build");
    const product = productFor(world);
    const queue = new InMemoryControlPlaneQueue();
    const request = requestFor(world, "first-build");
    request.context.ordinaryGoal += " using Bearer should-not-cross";
    queue.enqueue(request);
    expect(JSON.stringify(queue.get("tenant-a", request.context.requestId))).not.toContain("should-not-cross");
    expect(queue.get("tenant-b", request.context.requestId)).toBeUndefined();

    const worker = new CustomerDataPlaneWorker(
      "tenant-a",
      "runner-1",
      queue,
      product.sdk,
      {
        resolve: (key) => key === "dispatch-preparation" ? new WorldWorkflow(world, "first-build", "SO-DEV-0002") : undefined,
      },
      { resolve: (requestId) => requestId === request.context.requestId ? request : undefined },
    );
    expect(await worker.runOnce()).toBe(true);
    expect(queue.get("tenant-a", request.context.requestId)).toMatchObject({
      status: "completed",
      result: { status: "completed" },
    });
    expect(JSON.stringify(queue.get("tenant-a", request.context.requestId))).not.toContain("SO-DEV-0002");
    expect(JSON.stringify(queue.get("tenant-a", request.context.requestId))).not.toContain("output");
    expect(world.verify("first-build")).toMatchObject({ passed: true, incorrectSideEffects: 0 });
  });
});
