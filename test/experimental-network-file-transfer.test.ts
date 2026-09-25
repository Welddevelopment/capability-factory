import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FICTIONAL_EDIFACT_APPROVAL,
  FICTIONAL_EDIFACT_SECRET_DESCRIPTOR,
  FictionalEdifactNetworkFileWorld,
  fictionalEdifactContractHash,
  fictionalEdifactPurchaseOrder,
} from "../src/customer-world/edifact-network-file-world.js";
import {
  buildCapabilityModePackageSidecar,
  CapabilityModePackageManager,
} from "../src/product/capability-mode-package.js";
import { CAPABILITY_MODE_SCHEMA_VERSION } from "../src/product/capability-mode-contract.js";
import { createFileTransferModeRunner } from "../src/product/capability-mode-router.js";
import { RotatingMemorySecretProvider } from "../src/product/secrets.js";

const enabled = process.env.CF_REAL_NETWORK_FILE === "1";
const testIfEnabled = enabled ? it : it.skip;
const worlds: FictionalEdifactNetworkFileWorld[] = [];

afterEach(async () => {
  while (worlds.length > 0) await worlds.pop()!.close();
});

describe("authenticated network EDIFACT capability", () => {
  it("uses a genuinely different bounded partner-order format", () => {
    const source = fictionalEdifactPurchaseOrder({
      fileAlias: "format-check.unb",
      purchaseOrderNumber: "NORTH-1001",
      lines: [
        { itemCode: "BOLT-10", quantity: 2 },
        { itemCode: "GLOVE-7", quantity: 4 },
      ],
    });
    expect(source).toContain("UNH+1+ORDERS:D:96A:UN'");
    expect(source).toContain("LIN+1++BOLT-10:SA'");
    expect(source).not.toContain("ISA*");
    expect(fictionalEdifactContractHash()).toMatch(/^[a-f0-9]{64}$/);
  });

  testIfEnabled("builds, verifies, writes, reconciles, resumes, and retains through an authenticated network gateway", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-network-edifact-"));
    const world = new FictionalEdifactNetworkFileWorld(root);
    worlds.push(world);
    await world.start();
    const firstInput = world.writeInput({
      fileAlias: "north-1001.unb",
      purchaseOrderNumber: "NORTH-1001",
      lines: [{ itemCode: "BOLT-10", quantity: 2 }],
    });
    const first = await world.sdk().completeGoal(world.request({
      requestId: "network-edifact-first",
      operationKey: "north-network-order-1001",
      inputFileAlias: "north-1001.unb",
      expectedInputSha256: firstInput.sha256,
    }));
    expect(first.status, JSON.stringify(first, null, 2)).toBe("completed");
    expect(first).toMatchObject({
      status: "completed",
      path: "built-capability",
      execution: { writesAttempted: 1 },
      parent: { resumed: true, completed: true },
    });
    expect(world.outputAliases()).toHaveLength(1);

    const secondInput = world.writeInput({
      fileAlias: "north-1002.unb",
      purchaseOrderNumber: "NORTH-1002",
      lines: [{ itemCode: "FILTER-42", quantity: 3 }],
    });
    const second = await world.sdk().completeGoal(world.request({
      requestId: "network-edifact-second",
      operationKey: "north-network-order-1002",
      inputFileAlias: "north-1002.unb",
      expectedInputSha256: secondInput.sha256,
      simulateLostResponseAfterCommit: true,
    }));
    expect(second).toMatchObject({
      status: "completed",
      path: "retained-capability",
      execution: { writesAttempted: 1, reconciled: true },
      parent: { resumed: true, completed: true },
    });
    expect(world.outputAliases()).toHaveLength(2);

    const replay = await world.sdk().completeGoal({
      ...world.request({
        requestId: "network-edifact-replay",
        operationKey: "north-network-order-1002",
        inputFileAlias: "north-1002.unb",
        expectedInputSha256: secondInput.sha256,
      }),
    });
    expect(replay).toMatchObject({
      status: "completed",
      execution: { writesAttempted: 0, reconciled: true },
    });
    expect(world.outputAliases()).toHaveLength(2);
  }, 60_000);

  testIfEnabled("runs the authenticated EDIFACT workflow through the packaged durable sidecar", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-network-edifact-package-"));
    const world = new FictionalEdifactNetworkFileWorld(path.join(root, "world"));
    worlds.push(world);
    await world.start();
    const contractPath = path.join(root, "north-sea-edifact-contract.json");
    fs.writeFileSync(contractPath, `${JSON.stringify({
      schemaVersion: "1",
      contractHash: fictionalEdifactContractHash(),
      inputFormat: "edifact-orders-d96a",
      transportKind: "authenticated-network",
    }, null, 2)}\n`, { mode: 0o600 });
    const manager = new CapabilityModePackageManager(path.join(root, "package"), {
      portProbe: async () => true,
    });
    manager.initialize({
      installationId: "network-edifact-package",
      productVersion: "0.1.0",
      tenantId: "fictional-north-sea-distributor",
      modes: [{
        capabilityMode: "experimental-file-transfer-actions",
        driverVersion: "file-transfer-driver-v0.1",
        contractFiles: [{ sourcePath: contractPath, packagedName: "north-sea-edifact-contract.json" }],
        requiredSecrets: [FICTIONAL_EDIFACT_SECRET_DESCRIPTOR],
      }],
    });
    manager.writeSecret(FICTIONAL_EDIFACT_SECRET_DESCRIPTOR.alias, world.credentialValue());
    const built = await buildCapabilityModePackageSidecar(manager, async (context) => [
      createFileTransferModeRunner(world.sdk(context.secrets)),
    ]);
    const token = manager.readAccessTokenForLocalClient();
    try {
      const input = world.writeInput({
        fileAlias: "packaged-1001.unb",
        purchaseOrderNumber: "PACKAGED-1001",
        lines: [{ itemCode: "GLOVE-7", quantity: 8 }],
      });
      const request = world.request({
        requestId: "packaged-network-edifact",
        operationKey: "packaged-network-edifact-operation",
        inputFileAlias: "packaged-1001.unb",
        expectedInputSha256: input.sha256,
        approvals: [FICTIONAL_EDIFACT_APPROVAL],
      });
      const submitted = await built.app.inject({
        method: "POST",
        url: "/v1/capability-mode-jobs",
        headers: { "x-capability-sidecar-token": token },
        payload: {
          schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
          capabilityMode: "experimental-file-transfer-actions",
          request,
        },
      });
      expect(submitted.statusCode).toBe(202);
      const jobId = submitted.json().jobId as string;
      let terminal: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await built.app.inject({
          method: "GET",
          url: `/v1/capability-mode-jobs/${jobId}?tenantId=${request.tenantId}`,
          headers: { "x-capability-sidecar-token": token },
        });
        const job = response.json() as Record<string, unknown>;
        if (job.status !== "queued" && job.status !== "running") {
          terminal = job;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(terminal).toMatchObject({
        capabilityMode: "experimental-file-transfer-actions",
        status: "completed",
        result: {
          parentResumed: true,
          parentCompleted: true,
          acquisitionPath: "built-capability",
        },
      });
      expect(world.outputAliases()).toHaveLength(1);
      expect(fs.readFileSync(manager.configFilename, "utf8")).not.toContain(world.credentialValue());
    } finally {
      await built.close();
    }
  }, 60_000);

  testIfEnabled("fails before any network write when gateway credentials or exact approval are missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-network-edifact-authority-"));
    const world = new FictionalEdifactNetworkFileWorld(root);
    worlds.push(world);
    await world.start();
    const input = world.writeInput({
      fileAlias: "authority-1001.unb",
      purchaseOrderNumber: "AUTHORITY-1001",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });

    const wrongSecrets = new RotatingMemorySecretProvider();
    wrongSecrets.set(FICTIONAL_EDIFACT_SECRET_DESCRIPTOR, "wrong-local-gateway-token");
    const wrongCredential = await world.sdk(wrongSecrets).completeGoal(world.request({
      requestId: "network-wrong-credential",
      operationKey: "network-wrong-credential-operation",
      inputFileAlias: "authority-1001.unb",
      expectedInputSha256: input.sha256,
    }));
    expect(wrongCredential).toMatchObject({
      status: "blocked",
      handoff: { writesAttempted: 0 },
      parent: { resumed: false, completed: false },
    });
    expect(world.outputAliases()).toEqual([]);

    const missingApproval = await world.sdk().completeGoal(world.request({
      requestId: "network-missing-approval",
      operationKey: "network-missing-approval-operation",
      inputFileAlias: "authority-1001.unb",
      expectedInputSha256: input.sha256,
      approvals: [],
    }));
    expect(missingApproval).toMatchObject({
      status: "blocked",
      handoff: { reason: "authority-missing", writesAttempted: 0 },
      parent: { resumed: false, completed: false },
    });
    expect(world.outputAliases()).toEqual([]);
  }, 60_000);
});
