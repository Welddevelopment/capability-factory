import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCustomerLocalPilotAuthorityRecoveryPoint,
  reconcileCustomerLocalPilotAuthorityRecoveryContinuity,
  restoreCustomerLocalPilotAuthorityRecoveryPoint,
} from "../src/product/customer-local-pilot-authority-recovery.js";
import { CustomerLocalHttpAuthorityTrustStore } from "../src/product/customer-local-http-authority-trust.js";
import { CustomerLocalTrustStore, type CustomerLocalTrustConfiguration } from "../src/product/customer-local-trust-backup.js";
import { signWorkspaceHttpAuthorityActivation } from "../src/product/customer-local-http-write-authority.js";
import { PilotPackageManager } from "../src/product/pilot-package.js";
import { DurableExternalMonotonicContinuityAnchor } from "../src/product/external-monotonic-continuity-anchor.js";

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    try { close(); } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "cf061-"));
  roots.push(value);
  return value;
}

function publicPem(key: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function fixture(label: string) {
  const directory = root();
  const packageRoot = join(directory, "package");
  const runtimePath = join(directory, "runtime.mjs");
  writeFileSync(runtimePath, "export const createPilotRuntime = () => undefined;\n", { mode: 0o600 });
  const manager = new PilotPackageManager(packageRoot, { portProbe: async () => true });
  manager.initialize({ installationId: `pilot-${label}`, tenantId: `tenant_${label}`, productVersion: "0.1.0", adapterRuntimePath: runtimePath, port: 44061 });

  const admin = generateKeyPairSync("ed25519");
  const now = Date.now();
  const trustConfig: CustomerLocalTrustConfiguration = {
    schemaVersion: "1.0",
    tenantId: `tenant_${label}`,
    environment: "local",
    keys: [{
      keyId: "workspace_admin_v1",
      issuer: "customer_admin",
      publicKeyPem: publicPem(admin.publicKey),
      notBefore: new Date(now - 60_000).toISOString(),
      notAfter: new Date(now + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    }],
  };
  const trustStore = new CustomerLocalTrustStore(join(packageRoot, "trust", "root-trust.sqlite"), trustConfig);
  const authorityTrustStore = new CustomerLocalHttpAuthorityTrustStore({
    statePath: join(packageRoot, "trust", "authority-live.sqlite"),
    workspaceId: `workspace_${label}`,
    initialAdminKeyId: "workspace_admin_v1",
    trustStore,
  });
  closers.push(() => authorityTrustStore.close(), () => trustStore.close());
  const authorityContractDigest = createHash("sha256").update(`authority:${label}`).digest("hex");
  const anchorKey = generateKeyPairSync("ed25519");
  const continuityAnchorPath = join(directory, "external-continuity", "anchor.sqlite");
  const continuityAnchorConfig = {
    schemaVersion: "1.0", anchorId: `anchor_${label}`, tenantId: `tenant_${label}`,
    installationId: `pilot-${label}`, workspaceId: `workspace_${label}`, authorityContractDigest,
    trustConfigurationDigest: authorityTrustStore.trustConfigurationDigest, signerKeyId: "continuity_signer_v1",
    signerPublicKeyPem: publicPem(anchorKey.publicKey),
  } as const;
  const continuityAnchor = new DurableExternalMonotonicContinuityAnchor(continuityAnchorPath, continuityAnchorConfig, { signerPrivateKey: anchorKey.privateKey });
  closers.push(() => continuityAnchor.close());
  const activation = signWorkspaceHttpAuthorityActivation({
    adminSignerKeyId: "workspace_admin_v1",
    workspaceId: `workspace_${label}`,
    authorityContractDigest,
    privateKey: admin.privateKey,
    issuedAt: new Date(Date.now() - 1).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    activationNonce: createHash("sha256").update(`activation:${label}`).digest("hex"),
  });
  authorityTrustStore.importActivation(activation);
  return { directory, packageRoot, manager, admin, trustStore, authorityTrustStore, authorityContractDigest, activation, workspaceId: `workspace_${label}`, continuityAnchor, continuityAnchorPath, continuityAnchorConfig, anchorKey };
}

describe("CF-061 package authority recovery", () => {
  it("restores package data deactivated and authority trust audit-only until a strictly fresh activation", async () => {
    const f = fixture("joined");
    writeFileSync(join(f.manager.installation.dataDirectory, "before-backup.txt"), "preserved", { mode: 0o600 });
    const recoveryPoint = createCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager,
      authorityTrustStore: f.authorityTrustStore,
      authorityContractDigest: f.authorityContractDigest,
      reason: "cf061 joined package recovery",
      signerKeyId: "workspace_admin_v1",
      signerPrivateKey: f.admin.privateKey,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      continuityAnchor: f.continuityAnchor,
    });
    writeFileSync(join(f.manager.installation.dataDirectory, "after-backup.txt"), "must disappear", { mode: 0o600 });

    const restored = restoreCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager,
      trustStore: f.trustStore,
      continuityAnchor: f.continuityAnchor,
      backupId: recoveryPoint.manifest.backupId,
      expectedWorkspaceId: f.workspaceId,
      expectedAuthorityContractDigest: f.authorityContractDigest,
    });
    closers.push(() => restored.authorityTrustStore.close());

    expect(readFileSync(join(f.manager.installation.dataDirectory, "before-backup.txt"), "utf8")).toBe("preserved");
    expect(() => readFileSync(join(f.manager.installation.dataDirectory, "after-backup.txt"), "utf8")).toThrow();
    expect(restored.installation).toMatchObject({
      lifecycle: "deactivated",
      authorityRecovery: {
        state: "audit-only-awaiting-fresh-activation",
        authorityRestoreReceiptDigest: restored.receipt.authorityRestoreReceiptDigest,
      },
    });
    expect(restored.receipt).toMatchObject({ executionAuthority: false, activationAuthority: false, packageLifecycle: "deactivated", continuityCurrentnessVerified: true, continuityRecoveryGeneration: 1 });
    expect(restored.continuityCompletionCheckpoint).toMatchObject({ generation: 2, kind: "restore-completed", recoveryManifestDigest: recoveryPoint.manifest.manifestDigest, recoveryReceiptDigest: restored.receipt.receiptDigest });
    expect(JSON.parse(readFileSync(restored.evidencePath, "utf8"))).toEqual(restored.receipt);
    await expect(f.manager.readiness()).resolves.toMatchObject({ ready: false });
    expect(() => f.manager.installation.reactivate()).toThrow(/fresh signed workspace-authority activation/i);
    expect(() => f.manager.installation.restore(recoveryPoint.manifest.backupId)).toThrow(/authority-recovery gate/i);

    restored.authorityTrustStore.importActivation(f.activation);
    expect(() => restored.authorityTrustStore.resolveCurrent(f.authorityContractDigest)).toThrow(/audit-only|fresh post-restore/i);

    while (Date.now() <= Date.parse(restored.receipt.restoredAt)) await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
    const successor = signWorkspaceHttpAuthorityActivation({
      adminSignerKeyId: "workspace_admin_v1",
      workspaceId: f.workspaceId,
      authorityContractDigest: f.authorityContractDigest,
      privateKey: f.admin.privateKey,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      activationNonce: createHash("sha256").update("successor:joined").digest("hex"),
    });
    f.authorityTrustStore.importActivation(successor);
    const wrongStoreBinding = f.authorityTrustStore.resolveCurrent(f.authorityContractDigest);
    expect(() => f.manager.installation.reactivateAfterAuthorityRecovery({
      binding: wrongStoreBinding,
      authorityRestoreReceiptDigest: restored.receipt.authorityRestoreReceiptDigest,
      packageRecoveryReceiptDigest: restored.receipt.receiptDigest,
      continuityGuard: restored.continuityGuard,
    })).toThrow(/exact contract|trust scope|post-restore/i);
    restored.authorityTrustStore.importActivation(successor);
    const binding = restored.authorityTrustStore.resolveCurrent(f.authorityContractDigest);
    expect(() => f.manager.installation.reactivateAfterAuthorityRecovery({ binding, authorityRestoreReceiptDigest: restored.receipt.authorityRestoreReceiptDigest } as never)).toThrow(/continuity guard|trusted external-anchor/i);
    const reactivated = f.manager.installation.reactivateAfterAuthorityRecovery({
      binding,
      authorityRestoreReceiptDigest: restored.receipt.authorityRestoreReceiptDigest,
      packageRecoveryReceiptDigest: restored.receipt.receiptDigest,
      continuityGuard: restored.continuityGuard,
    });
    expect(reactivated.lifecycle).toBe("active");
    expect(reactivated.authorityRecovery).toBeUndefined();
    expect(reactivated.authorityContinuity).toMatchObject({ identityDigest: restored.continuityGuard.identityDigest, completionCheckpointDigest: restored.continuityCompletionCheckpoint.checkpointDigest });
    const finalReadiness = await f.manager.readiness();
    expect(finalReadiness, JSON.stringify(finalReadiness, null, 2)).toMatchObject({ ready: true });
  });

  it("rejects package/authority substitution before publishing recovered state", () => {
    const f = fixture("tamper");
    const recoveryPoint = createCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager,
      authorityTrustStore: f.authorityTrustStore,
      authorityContractDigest: f.authorityContractDigest,
      reason: "cf061 substitution control",
      signerKeyId: "workspace_admin_v1",
      signerPrivateKey: f.admin.privateKey,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      continuityAnchor: f.continuityAnchor,
    });
    const filename = join(f.manager.installation.backupsDirectory, recoveryPoint.manifest.backupId, "authority-recovery.json");
    const changed = { ...JSON.parse(readFileSync(filename, "utf8")), tenantId: "tenant_attacker" };
    writeFileSync(filename, JSON.stringify(changed), { mode: 0o600 });
    expect(() => restoreCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager,
      trustStore: f.trustStore,
      continuityAnchor: f.continuityAnchor,
      backupId: recoveryPoint.manifest.backupId,
      expectedWorkspaceId: f.workspaceId,
      expectedAuthorityContractDigest: f.authorityContractDigest,
    })).toThrow(/substituted|cross-scope|signature/i);
    expect(f.manager.installation.inspect()).toMatchObject({ lifecycle: "active" });
  });

  it("rejects package-config drift and torn recovery sets without changing lifecycle", () => {
    const f = fixture("drift");
    const recoveryPoint = createCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager,
      authorityTrustStore: f.authorityTrustStore,
      authorityContractDigest: f.authorityContractDigest,
      reason: "cf061 drift control",
      signerKeyId: "workspace_admin_v1",
      signerPrivateKey: f.admin.privateKey,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      continuityAnchor: f.continuityAnchor,
    });
    const config = JSON.parse(readFileSync(f.manager.configFilename, "utf8"));
    writeFileSync(f.manager.configFilename, `${JSON.stringify({ ...config, bind: { ...config.bind, port: 44062 } }, null, 2)}\n`, { mode: 0o600 });
    expect(() => restoreCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager,
      trustStore: f.trustStore,
      continuityAnchor: f.continuityAnchor,
      backupId: recoveryPoint.manifest.backupId,
      expectedWorkspaceId: f.workspaceId,
      expectedAuthorityContractDigest: f.authorityContractDigest,
    })).toThrow(/substituted|cross-scope|recovery point/i);
    expect(f.manager.installation.inspect()).toMatchObject({ lifecycle: "active" });
  });

  it("rejects an older valid recovery point after a newer point is externally pinned", () => {
    const f = fixture("superseded");
    const older = createCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager, authorityTrustStore: f.authorityTrustStore, authorityContractDigest: f.authorityContractDigest,
      reason: "older recovery", signerKeyId: "workspace_admin_v1", signerPrivateKey: f.admin.privateKey,
      expiresAt: new Date(Date.now() + 30_000).toISOString(), continuityAnchor: f.continuityAnchor,
    });
    const newer = createCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager, authorityTrustStore: f.authorityTrustStore, authorityContractDigest: f.authorityContractDigest,
      reason: "newer recovery", signerKeyId: "workspace_admin_v1", signerPrivateKey: f.admin.privateKey,
      expiresAt: new Date(Date.now() + 30_000).toISOString(), continuityAnchor: f.continuityAnchor,
    });
    expect(older.continuityCheckpoint.generation).toBe(1); expect(newer.continuityCheckpoint.generation).toBe(2);
    expect(() => restoreCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager, trustStore: f.trustStore, continuityAnchor: f.continuityAnchor,
      backupId: older.manifest.backupId, expectedWorkspaceId: f.workspaceId, expectedAuthorityContractDigest: f.authorityContractDigest,
    })).toThrow(/not the current.*continuity head/i);
    expect(f.manager.installation.inspect()).toMatchObject({ lifecycle: "active" });
    const restored = restoreCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager, trustStore: f.trustStore, continuityAnchor: f.continuityAnchor,
      backupId: newer.manifest.backupId, expectedWorkspaceId: f.workspaceId, expectedAuthorityContractDigest: f.authorityContractDigest,
    });
    closers.push(() => restored.authorityTrustStore.close());
    expect(restored.receipt.continuityRecoveryCheckpointDigest).toBe(newer.continuityCheckpoint.checkpointDigest);
  });

  it("survives anchor restart and rejects an anchor stored inside the package backup boundary", () => {
    const f = fixture("restart");
    const recovery = createCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager, authorityTrustStore: f.authorityTrustStore, authorityContractDigest: f.authorityContractDigest,
      reason: "restart anchor", signerKeyId: "workspace_admin_v1", signerPrivateKey: f.admin.privateKey,
      expiresAt: new Date(Date.now() + 30_000).toISOString(), continuityAnchor: f.continuityAnchor,
    });
    f.continuityAnchor.close();
    const reopened = new DurableExternalMonotonicContinuityAnchor(f.continuityAnchorPath, f.continuityAnchorConfig, { signerPrivateKey: f.anchorKey.privateKey });
    closers.push(() => reopened.close());
    const restored = restoreCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager, trustStore: f.trustStore, continuityAnchor: reopened,
      backupId: recovery.manifest.backupId, expectedWorkspaceId: f.workspaceId, expectedAuthorityContractDigest: f.authorityContractDigest,
    });
    closers.push(() => restored.authorityTrustStore.close());
    expect(reopened.current()).toMatchObject({ kind: "restore-completed", generation: 2 });

    const other = fixture("inside");
    const inside = new DurableExternalMonotonicContinuityAnchor(join(other.packageRoot, "trust", "bad-anchor.sqlite"), other.continuityAnchorConfig, { signerPrivateKey: other.anchorKey.privateKey });
    closers.push(() => inside.close());
    expect(() => createCustomerLocalPilotAuthorityRecoveryPoint({
      manager: other.manager, authorityTrustStore: other.authorityTrustStore, authorityContractDigest: other.authorityContractDigest,
      reason: "inside anchor", signerKeyId: "workspace_admin_v1", signerPrivateKey: other.admin.privateKey,
      expiresAt: new Date(Date.now() + 30_000).toISOString(), continuityAnchor: inside,
    })).toThrow(/outside.*package root/i);
  });

  it("reconciles a process loss after deactivated restore evidence without granting authority", () => {
    const f = fixture("reconcile");
    const recovery = createCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager, authorityTrustStore: f.authorityTrustStore, authorityContractDigest: f.authorityContractDigest,
      reason: "reconcile completion", signerKeyId: "workspace_admin_v1", signerPrivateKey: f.admin.privateKey,
      expiresAt: new Date(Date.now() + 30_000).toISOString(), continuityAnchor: f.continuityAnchor,
    });
    expect(() => restoreCustomerLocalPilotAuthorityRecoveryPoint({
      manager: f.manager, trustStore: f.trustStore, continuityAnchor: f.continuityAnchor,
      backupId: recovery.manifest.backupId, expectedWorkspaceId: f.workspaceId, expectedAuthorityContractDigest: f.authorityContractDigest,
      _testOnlyAfterRecoveryEvidence: () => { throw new Error("simulated process loss before continuity completion"); },
    })).toThrow(/simulated process loss/i);
    expect(f.manager.installation.inspect()).toMatchObject({ lifecycle: "deactivated", authorityRecovery: { state: "audit-only-awaiting-fresh-activation" } });
    expect(f.continuityAnchor.current()).toMatchObject({ kind: "recovery-pinned", generation: 1 });
    const evidenceDirectory = join(f.packageRoot, "recovery-evidence"), evidenceFiles = readdirSync(evidenceDirectory);
    expect(evidenceFiles).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(join(evidenceDirectory, evidenceFiles[0]!), "utf8"));
    const completion = reconcileCustomerLocalPilotAuthorityRecoveryContinuity({
      manager: f.manager, trustStore: f.trustStore, continuityAnchor: f.continuityAnchor,
      backupId: recovery.manifest.backupId, expectedWorkspaceId: f.workspaceId,
      expectedAuthorityContractDigest: f.authorityContractDigest, receipt,
    });
    expect(completion).toMatchObject({ kind: "restore-completed", generation: 2, recoveryReceiptDigest: receipt.receiptDigest });
    expect(f.manager.installation.inspect()).toMatchObject({ lifecycle: "deactivated" });
  });
});
