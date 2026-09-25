import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CapabilityRuntime } from "../src/runtime.js";
import {
  createGiteaReferenceCapability,
  executeReconciledGiteaIssue,
  startRealGiteaWorld,
  type RealGiteaWorld,
} from "../src/customer-world/real-gitea-world.js";

const enabled = process.env.CF_REAL_GITEA === "1";

describe.skipIf(!enabled)("genuine local Gitea transfer boundary", () => {
  let root: string;
  let world: RealGiteaWorld;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "cf-real-gitea-"));
    world = await startRealGiteaWorld({ repositoryRoot: process.cwd(), artifactDirectory: root });
  }, 30_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses a pinned genuine Gitea API and a hashed bounded documentation contract", () => {
    expect(world.adapterKind).toContain("Gitea 1.27.0");
    expect(world.documentation.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(world.baseUrl).toBe("http://127.0.0.1:3100");
  });

  it("creates one exact issue and verifies it through an independent credential", async () => {
    const state = await world.reset("approved-write");
    const manifest = createGiteaReferenceCapability(world.documentation, world.secretAlias("full"));
    const runtime = new CapabilityRuntime(world.runtimeConfiguration("full"));
    const receipts = await executeReconciledGiteaIssue(manifest, runtime, state, "gitea-approved-write");
    expect(receipts.map((receipt) => receipt.action)).toEqual(["list_issues", "create_issue"]);
    await expect(world.verify("approved-write")).resolves.toMatchObject({ passed: true, intendedWrites: 1, incorrectSideEffects: 0 });
  });

  it("binds workflow values through manifest semantics rather than fixed input names", async () => {
    const state = await world.reset("approved-write");
    const manifest = structuredClone(createGiteaReferenceCapability(world.documentation, world.secretAlias("full")));
    const create = manifest.actions.find((item) => item.name === "create_issue")!;
    create.inputSchema.properties.label = create.inputSchema.properties.labelId!;
    delete create.inputSchema.properties.labelId;
    create.inputSchema.required = create.inputSchema.required.map((name) => name === "labelId" ? "label" : name);
    const body = create.request.bodyTemplate as Record<string, unknown>;
    body.labels = ["{{input.label}}"];

    await executeReconciledGiteaIssue(
      manifest,
      new CapabilityRuntime(world.runtimeConfiguration("full")),
      state,
      "gitea-semantic-binding",
    );
    await expect(world.verify("approved-write")).resolves.toMatchObject({ passed: true, intendedWrites: 1, incorrectSideEffects: 0 });
  });

  it("reuses external state instead of repeating the write", async () => {
    const state = await world.reset("fresh-process-reuse");
    const manifest = createGiteaReferenceCapability(world.documentation, world.secretAlias("full"));
    await executeReconciledGiteaIssue(
      manifest,
      new CapabilityRuntime(world.runtimeConfiguration("full")),
      state,
      "gitea-reuse-first",
    );
    const freshRuntime = new CapabilityRuntime(world.runtimeConfiguration("full"));
    const second = await executeReconciledGiteaIssue(manifest, freshRuntime, state, "gitea-reuse-second");
    expect(second.map((receipt) => receipt.action)).toEqual(["list_issues"]);
    await expect(world.verify("fresh-process-reuse")).resolves.toMatchObject({ passed: true, intendedWrites: 1, incorrectSideEffects: 0 });
  });

  it("denies a write through the genuine read-only token with zero issue creation", async () => {
    const state = await world.reset("missing-permission");
    const manifest = createGiteaReferenceCapability(world.documentation, world.secretAlias("read-only"));
    await expect(executeReconciledGiteaIssue(
      manifest,
      new CapabilityRuntime(world.runtimeConfiguration("read-only")),
      state,
      "gitea-read-only",
    )).rejects.toMatchObject({ category: "permission", status: 403 });
    await expect(world.verify("missing-permission")).resolves.toMatchObject({ passed: true, intendedWrites: 0, incorrectSideEffects: 0 });
  });

  it("refuses execution when the credential alias has no value", async () => {
    const state = await world.reset("missing-credential");
    const manifest = createGiteaReferenceCapability(world.documentation, world.secretAlias("missing"));
    await expect(executeReconciledGiteaIssue(
      manifest,
      new CapabilityRuntime(world.runtimeConfiguration("missing")),
      state,
      "gitea-missing-credential",
    )).rejects.toThrow(/Unknown secret alias/);
    await expect(world.verify("missing-credential")).resolves.toMatchObject({ passed: true, intendedWrites: 0, incorrectSideEffects: 0 });
  });

  it("reconciles a committed issue after its response is discarded", async () => {
    const state = await world.reset("lost-response-reconciliation");
    const manifest = createGiteaReferenceCapability(world.documentation, world.secretAlias("full"));
    const runtime = new CapabilityRuntime(world.runtimeConfiguration("full"));
    const create = manifest.actions.find((item) => item.name === "create_issue")!;
    await runtime.execute(manifest, create.name, {
      owner: world.owner,
      repo: world.repository,
      title: state.title,
      body: state.body,
      labelId: state.labelId,
    }, { runId: "gitea-lost-response-prelude" });
    const recovered = await executeReconciledGiteaIssue(manifest, runtime, state, "gitea-lost-response-recovery");
    expect(recovered.map((receipt) => receipt.action)).toEqual(["list_issues"]);
    await expect(world.verify("lost-response-reconciliation")).resolves.toMatchObject({ passed: true, intendedWrites: 1, incorrectSideEffects: 0 });
  });

  it("detects a wrong partial issue and refuses to create over it", async () => {
    const state = await world.reset("wrong-or-partial-outcome");
    const manifest = createGiteaReferenceCapability(world.documentation, world.secretAlias("full"));
    await expect(executeReconciledGiteaIssue(
      manifest,
      new CapabilityRuntime(world.runtimeConfiguration("full")),
      state,
      "gitea-wrong-partial",
    )).rejects.toThrow(/incorrect partial issue/);
    const direct = await world.verify("wrong-or-partial-outcome");
    expect(direct.passed).toBe(false);
    expect(direct.incorrectSideEffects).toBeGreaterThan(0);
  });
});
