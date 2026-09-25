import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IndependentShipmentOutcomeVerifier,
  LocalSignedShipmentDelegate,
} from "../src/customer-world/signed-agent-delegate-world.js";
import {
  AgentDelegationRegistry,
  ExperimentalAgentDelegationCapabilitySdk,
  type AgentDelegateAdapter,
  type AgentDelegateOutcomeVerifier,
} from "../src/experimental/agent-delegation-capability-sdk.js";
import { CapabilityModeRouter, createAgentDelegationModeRunner } from "../src/product/capability-mode-router.js";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function request(delegate: LocalSignedShipmentDelegate, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-one",
    requestId: "request-one",
    parentGoalId: "goal-one",
    ordinaryGoal: "Create the approved fictional shipment draft and prove the external result.",
    needKey: "create-shipment-draft",
    contractHash: delegate.contract.contractHash,
    operationKey: "shipment-order-one",
    delegateId: delegate.contract.delegateId,
    delegateVersion: delegate.contract.version,
    taskKey: "create-shipment-draft",
    input: { orderId: "order-one", carrier: "carrier-one" },
    approvals: ["delegate-shipment-draft"],
    ...overrides,
  };
}

function sdk(
  registry: AgentDelegationRegistry,
  delegate: AgentDelegateAdapter,
  verifier: AgentDelegateOutcomeVerifier,
) {
  return new ExperimentalAgentDelegationCapabilitySdk(
    registry,
    new Map([[`${delegate.contract.delegateId}@${delegate.contract.version}`, delegate]]),
    new Map([[verifier.key, verifier]]),
  );
}

describe("experimental signed agent/service delegation", () => {
  it("probes, requires exact approval, verifies the signed receipt, independently checks external state, resumes and durably reuses", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-delegation-"));
    const databasePath = join(directory, "delegate-world.sqlite");
    const registryPath = join(directory, "registry.sqlite");
    const pair = keys();
    const delegate = new LocalSignedShipmentDelegate(databasePath, pair.privateKeyPem, pair.publicKeyPem, () => "2026-08-05T00:00:00.000Z");
    const verifier = new IndependentShipmentOutcomeVerifier(databasePath, delegate.protectedStateDigest());
    try {
      const firstRegistry = new AgentDelegationRegistry(registryPath);
      expect(await sdk(firstRegistry, delegate, verifier).completeGoal(request(delegate))).toMatchObject({
        status: "completed",
        path: "trusted-delegate",
        parent: { resumed: true, completed: true },
      });
      firstRegistry.close();

      const recoveredRegistry = new AgentDelegationRegistry(registryPath);
      expect(await sdk(recoveredRegistry, delegate, verifier).completeGoal(request(delegate, {
        requestId: "request-two",
        operationKey: "shipment-order-two",
        input: { orderId: "order-two", carrier: "carrier-two" },
      }))).toMatchObject({ status: "completed", path: "retained-reuse" });
      expect(delegate.countDrafts()).toBe(2);
      recoveredRegistry.close();
    } finally {
      delegate.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconciles a lost response after delegated commit without duplicating the action", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-delegation-lost-"));
    const databasePath = join(directory, "delegate-world.sqlite");
    const pair = keys();
    const delegate = new LocalSignedShipmentDelegate(databasePath, pair.privateKeyPem, pair.publicKeyPem, () => "2026-08-05T00:00:00.000Z");
    const registry = new AgentDelegationRegistry();
    try {
      const result = await sdk(registry, delegate, new IndependentShipmentOutcomeVerifier(databasePath, delegate.protectedStateDigest()))
        .completeGoal(request(delegate, { simulateLostResponseAfterCommit: true }));
      expect(result).toMatchObject({ status: "completed", parent: { completed: true } });
      expect(delegate.countDrafts()).toBe(1);
    } finally {
      registry.close();
      delegate.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stops before delegation for missing approval, changed contract, unsupported task or unknown prior state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-delegation-stop-"));
    const databasePath = join(directory, "delegate-world.sqlite");
    const pair = keys();
    const delegate = new LocalSignedShipmentDelegate(databasePath, pair.privateKeyPem, pair.publicKeyPem);
    const verifier = new IndependentShipmentOutcomeVerifier(databasePath, delegate.protectedStateDigest());
    try {
      for (const variant of [
        request(delegate, { approvals: [] }),
        request(delegate, { contractHash: "f".repeat(64) }),
        request(delegate, { taskKey: "unreviewed-task" }),
      ]) {
        const registry = new AgentDelegationRegistry();
        expect(await sdk(registry, delegate, verifier).completeGoal(variant)).toMatchObject({ status: "handoff" });
        registry.close();
      }
      expect(delegate.countDrafts()).toBe(0);

      const unknownDelegate: AgentDelegateAdapter = {
        contract: delegate.contract,
        probe: (taskKey) => delegate.probe(taskKey),
        async reconcile() { return { status: "unknown" }; },
        execute: (input) => delegate.execute(input),
      };
      const registry = new AgentDelegationRegistry();
      expect(await sdk(registry, unknownDelegate, verifier).completeGoal(request(delegate))).toMatchObject({ status: "unknown" });
      expect(delegate.countDrafts()).toBe(0);
      registry.close();
    } finally {
      delegate.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a forged completion receipt and a delegate-only success without independent outcome proof", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-delegation-forge-"));
    const databasePath = join(directory, "delegate-world.sqlite");
    const pair = keys();
    const delegate = new LocalSignedShipmentDelegate(databasePath, pair.privateKeyPem, pair.publicKeyPem, () => "2026-08-05T00:00:00.000Z");
    try {
      const forged: AgentDelegateAdapter = {
        contract: delegate.contract,
        probe: (taskKey) => delegate.probe(taskKey),
        reconcile: (operationKey) => delegate.reconcile(operationKey),
        async execute(input) {
          const receipt = await delegate.execute(input);
          return { ...receipt, signatureBase64: Buffer.from("forged-receipt").toString("base64").repeat(8) };
        },
      };
      const independent = new IndependentShipmentOutcomeVerifier(databasePath, delegate.protectedStateDigest());
      const forgedRegistry = new AgentDelegationRegistry();
      expect(await sdk(forgedRegistry, forged, independent).completeGoal(request(delegate))).toMatchObject({ status: "handoff" });
      forgedRegistry.close();

      const noProof: AgentDelegateOutcomeVerifier = {
        key: independent.key,
        async verifyOutcome() {
          return { passed: false, incorrectSideEffects: 0, stateDigest: "a".repeat(64), detail: "No independent proof." };
        },
      };
      const noProofRegistry = new AgentDelegationRegistry();
      expect(await sdk(noProofRegistry, delegate, noProof).completeGoal(request(delegate, {
        requestId: "request-two",
        operationKey: "shipment-order-two",
        input: { orderId: "order-two", carrier: "carrier-two" },
      }))).toMatchObject({ status: "handoff" });
      noProofRegistry.close();
    } finally {
      delegate.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs through the shared strict mode router", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-delegation-router-"));
    const databasePath = join(directory, "delegate-world.sqlite");
    const pair = keys();
    const delegate = new LocalSignedShipmentDelegate(databasePath, pair.privateKeyPem, pair.publicKeyPem);
    const registry = new AgentDelegationRegistry();
    try {
      const router = new CapabilityModeRouter([
        createAgentDelegationModeRunner(sdk(registry, delegate, new IndependentShipmentOutcomeVerifier(databasePath, delegate.protectedStateDigest()))),
      ]);
      const result = await router.execute({
        schemaVersion: "1.0",
        capabilityMode: "experimental-agent-delegation-actions",
        request: request(delegate),
      });
      expect(result).toMatchObject({
        capabilityMode: "experimental-agent-delegation-actions",
        status: "completed",
        parentResumed: true,
        parentCompleted: true,
        acquisitionPath: "trusted-delegate",
      });
    } finally {
      registry.close();
      delegate.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

