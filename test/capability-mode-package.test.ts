import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCapabilityModePackageSidecar,
  CapabilityModePackageManager,
} from "../src/product/capability-mode-package.js";
import {
  CAPABILITY_MODE_SCHEMA_VERSION,
  type CapabilityModeEnvelope,
} from "../src/product/capability-mode-contract.js";
import type { CapabilityModeRunner } from "../src/product/capability-mode-router.js";

const digest = "a".repeat(64);

function browserEnvelope(parentGoalId: string): CapabilityModeEnvelope {
  return {
    schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
    capabilityMode: "experimental-browser-actions",
    request: {
      tenantId: "package-tenant",
      requestId: `request-${parentGoalId}`,
      parentGoalId,
      ordinaryGoal: "Complete one bounded browser action and verify its external outcome.",
      needKey: "create-reviewed-record",
      uiContractHash: digest,
      operationKey: `operation-${parentGoalId}`,
      input: { recordId: parentGoalId },
      approvals: ["create-reviewed-record"],
    },
  };
}

function browserRunner(): CapabilityModeRunner {
  return {
    descriptor: {
      capabilityMode: "experimental-browser-actions",
      label: "Authenticated browser actions",
      driverVersion: "browser-driver-v0.1",
      maturity: "experimental-local",
      configured: true,
      claimBoundary: "Bounded package test only.",
    },
    async run(envelope) {
      if (envelope.capabilityMode !== "experimental-browser-actions") throw new Error("Wrong mode.");
      return {
        capabilityMode: envelope.capabilityMode,
        status: "completed",
        parentResumed: true,
        parentCompleted: true,
        summary: "The packaged browser action completed and its outcome was independently verified.",
        acquisitionPath: "built-capability",
        capabilityId: "reviewed-browser-capability-v1",
      };
    },
  };
}

function initialize(directory: string): {
  manager: CapabilityModePackageManager;
  contractPath: string;
} {
  const contractPath = path.join(directory, "trusted-browser-contract.json");
  fs.writeFileSync(contractPath, `${JSON.stringify({ schemaVersion: "1.0", kind: "trusted-test-contract" })}\n`, {
    mode: 0o600,
  });
  const manager = new CapabilityModePackageManager(path.join(directory, "package"), {
    portProbe: async () => true,
  });
  manager.initialize({
    installationId: "browser-package-test",
    productVersion: "0.1.0",
    tenantId: "package-tenant",
    modes: [{
      capabilityMode: "experimental-browser-actions",
      driverVersion: "browser-driver-v0.1",
      contractFiles: [{ sourcePath: contractPath, packagedName: "trusted-browser-contract.json" }],
      requiredSecrets: [{
        alias: "portal_username",
        version: "local-v1",
        scope: {
          targetAliases: ["reviewed_portal"],
          actionNames: ["browser-capability-verification", "browser-write"],
          methods: ["BROWSER"],
        },
      }],
    }],
  });
  return { manager, contractPath };
}

async function waitForTerminal(
  app: Awaited<ReturnType<typeof buildCapabilityModePackageSidecar>>["app"],
  token: string,
  tenantId: string,
  jobId: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/capability-mode-jobs/${jobId}?tenantId=${tenantId}`,
      headers: { "x-capability-sidecar-token": token },
    });
    const job = response.json();
    if (job.status !== "queued" && job.status !== "running") return job;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Packaged capability-mode job did not finish.");
}

describe("customer-local experimental capability-mode package", () => {
  it("pins contracts, requires private credential files, and durably serves the exact registered mode", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-mode-package-"));
    try {
      const { manager } = initialize(directory);
      expect(await manager.readiness()).toMatchObject({
        ready: false,
        checks: expect.arrayContaining([
          expect.objectContaining({ id: "secret:experimental-browser-actions:portal_username", passed: false }),
        ]),
      });
      await expect(buildCapabilityModePackageSidecar(manager, async () => [browserRunner()]))
        .rejects.toThrow(/secret:experimental-browser-actions:portal_username/);

      manager.writeSecret("portal_username", "fictional-customer-local-username");
      expect(await manager.readiness()).toMatchObject({ ready: true });
      const built = await buildCapabilityModePackageSidecar(manager, async (context) => {
        expect(context.secrets.has("portal_username")).toBe(true);
        expect(context.registrations).toHaveLength(1);
        return [browserRunner()];
      });
      try {
        const token = manager.readAccessTokenForLocalClient();
        const modes = await built.app.inject({
          method: "GET",
          url: "/v1/capability-modes",
          headers: { "x-capability-sidecar-token": token },
        });
        expect(modes.statusCode).toBe(200);
        expect(modes.json().modes).toEqual([
          expect.objectContaining({
            capabilityMode: "experimental-browser-actions",
            maturity: "experimental-local",
          }),
        ]);

        const submitted = await built.app.inject({
          method: "POST",
          url: "/v1/capability-mode-jobs",
          headers: { "x-capability-sidecar-token": token },
          payload: browserEnvelope("packaged-parent"),
        });
        expect(submitted.statusCode).toBe(202);
        const terminal = await waitForTerminal(
          built.app,
          token,
          "package-tenant",
          submitted.json().jobId,
        );
        expect(terminal).toMatchObject({
          capabilityMode: "experimental-browser-actions",
          status: "completed",
          result: {
            capabilityMode: "experimental-browser-actions",
            parentResumed: true,
            parentCompleted: true,
          },
        });
      } finally {
        await built.close();
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses altered contracts, unsafe secrets, undeclared secret aliases, and runner substitution", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-mode-package-fail-closed-"));
    try {
      const { manager } = initialize(directory);
      expect(() => manager.writeSecret("undeclared_secret", "value")).toThrow(/not declared/);
      manager.writeSecret("portal_username", "fictional-customer-local-username");
      const config = manager.readConfig();
      const secretPath = path.join(manager.resolve(config.files.secretsDirectory), "portal_username");
      fs.chmodSync(secretPath, 0o644);
      expect(await manager.readiness()).toMatchObject({ ready: false });
      fs.chmodSync(secretPath, 0o600);

      const contractPath = manager.resolve(config.modes[0]!.contractFiles[0]!.path);
      fs.appendFileSync(contractPath, "altered", "utf8");
      expect(await manager.readiness()).toMatchObject({
        ready: false,
        checks: expect.arrayContaining([
          expect.objectContaining({ id: expect.stringMatching(/^contract:/), passed: false }),
        ]),
      });

      fs.writeFileSync(
        contractPath,
        `${JSON.stringify({ schemaVersion: "1.0", kind: "trusted-test-contract" })}\n`,
        { mode: 0o600 },
      );
      await expect(buildCapabilityModePackageSidecar(manager, async () => [{
        ...browserRunner(),
        descriptor: { ...browserRunner().descriptor, driverVersion: "substituted-driver-v9" },
      }])).rejects.toThrow(/does not match its pinned package registration/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backs up and exactly restores customer-local state while exporting only sanitized immutable support evidence", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-mode-package-lifecycle-"));
    try {
      const { manager } = initialize(directory);
      const credential = "fictional-private-package-credential";
      manager.writeSecret("portal_username", credential);
      const built = await buildCapabilityModePackageSidecar(manager, async () => [browserRunner()]);
      const token = manager.readAccessTokenForLocalClient();
      const submitted = await built.app.inject({
        method: "POST",
        url: "/v1/capability-mode-jobs",
        headers: { "x-capability-sidecar-token": token },
        payload: browserEnvelope("backup-parent"),
      });
      await waitForTerminal(built.app, token, "package-tenant", submitted.json().jobId);
      await built.close();

      const stateMarker = path.join(
        manager.stateDirectory("experimental-browser-actions"),
        "operator-marker.json",
      );
      fs.writeFileSync(stateMarker, `${JSON.stringify({ state: "verified-before-backup" })}\n`, { mode: 0o600 });
      const backup = manager.backup("Pre-upgrade reversible checkpoint.");
      expect(manager.verifyBackup(backup.backupId)).toMatchObject({
        installationId: "browser-package-test",
        files: expect.arrayContaining([
          expect.objectContaining({ path: "capability-mode-package.json" }),
          expect.objectContaining({ path: expect.stringMatching(/capability-mode-jobs\.sqlite$/) }),
        ]),
      });

      fs.writeFileSync(stateMarker, `${JSON.stringify({ state: "unwanted-mutation" })}\n`, { mode: 0o600 });
      manager.deactivate("Local operator requested a reversible stop.");
      expect(await manager.readiness()).toMatchObject({
        ready: false,
        checks: expect.arrayContaining([
          expect.objectContaining({ id: "installation-active", passed: false }),
        ]),
      });
      await expect(buildCapabilityModePackageSidecar(manager, async () => [browserRunner()]))
        .rejects.toThrow(/installation-active/);

      const restored = manager.restore(backup.backupId);
      expect(restored.installation.lifecycle).toBe("active");
      expect(JSON.parse(fs.readFileSync(stateMarker, "utf8"))).toEqual({ state: "verified-before-backup" });
      expect(manager.secretProvider().resolve({
        alias: "portal_username",
        targetAlias: "reviewed_portal",
        actionName: "browser-write",
        method: "BROWSER",
        runId: "restored-secret-check",
        testMode: true,
      }).value).toBe(credential);
      expect(await manager.readiness()).toMatchObject({ ready: true });

      const reportPath = path.join(directory, "private-report.json");
      const evidencePath = path.join(directory, "sanitized-evidence.json");
      const supportPath = path.join(directory, "sanitized-support.json");
      fs.writeFileSync(reportPath, `${JSON.stringify({
        status: "completed",
        authorization: `Bearer ${credential}`,
        password: credential,
        detail: "Synthetic evidence only.",
      })}\n`, { mode: 0o600 });
      const evidence = await manager.exportEvidence({ reportPath, outputPath: evidencePath });
      const support = await manager.exportSupportBundle(supportPath);
      expect(JSON.stringify(evidence)).not.toContain(credential);
      expect(JSON.stringify(support)).not.toContain(credential);
      expect(evidence).toMatchObject({
        guarantees: {
          secretValuesIncluded: false,
          customerPayloadsIncludedByPackage: false,
          immutableOutput: true,
        },
      });
      expect(support).toMatchObject({
        guarantees: {
          secretValuesIncluded: false,
          customerPayloadsIncluded: false,
          immutableOutput: true,
        },
      });
      expect(() => fs.writeFileSync(evidencePath, "overwrite", { flag: "wx" })).toThrow();
      await expect(manager.exportEvidence({ reportPath, outputPath: evidencePath }))
        .rejects.toThrow(/immutable/);

      const backupConfig = path.join(
        manager.resolve(manager.readConfig().files.backupsDirectory),
        backup.backupId,
        "payload",
        "capability-mode-package.json",
      );
      fs.appendFileSync(backupConfig, "\n");
      expect(() => manager.verifyBackup(backup.backupId)).toThrow(/integrity check failed/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
