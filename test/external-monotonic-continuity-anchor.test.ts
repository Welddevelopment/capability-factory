import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DurableExternalMonotonicContinuityAnchor, type ExternalMonotonicContinuityAnchorConfiguration } from "../src/product/external-monotonic-continuity-anchor.js";
import { assertTrustedCustomerLocalAuthorityContinuityGuard, createCustomerLocalAuthorityContinuityGuard } from "../src/product/customer-local-authority-continuity-guard.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture(times = ["2026-08-14T10:00:00.000Z", "2026-08-14T10:01:00.000Z", "2026-08-14T10:02:00.000Z"]) {
  const root = mkdtempSync(join(tmpdir(), "cf066-anchor-")); roots.push(root);
  const key = generateKeyPairSync("ed25519"); let index = 0;
  const config: ExternalMonotonicContinuityAnchorConfiguration = {
    schemaVersion: "1.0", anchorId: "anchor_test", tenantId: "tenant_test", installationId: "installation_test",
    workspaceId: "workspace_test", authorityContractDigest: sha("authority"), trustConfigurationDigest: sha("trust"),
    signerKeyId: "anchor_signer_v1", signerPublicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const path = join(root, "anchor.sqlite");
  const anchor = new DurableExternalMonotonicContinuityAnchor(path, config, { signerPrivateKey: key.privateKey, now: () => times[Math.min(index++, times.length - 1)]! });
  return { root, path, key, config, anchor };
}

describe("CF-066 external monotonic continuity anchor", () => {
  it("pins and consumes exactly the current recovery head across restart", () => {
    const f = fixture(), manifest = sha("manifest");
    const pinned = f.anchor.pinRecoveryManifest(manifest); expect(pinned).toMatchObject({ generation: 1, kind: "recovery-pinned", previousCheckpointDigest: null });
    f.anchor.close();
    const reopened = new DurableExternalMonotonicContinuityAnchor(f.path, f.config, { signerPrivateKey: f.key.privateKey, now: () => "2026-08-14T10:03:00.000Z" });
    const result = reopened.withCurrentRecovery(manifest, () => ({ value: "restored", recoveryReceiptDigest: sha("receipt") }));
    expect(result).toMatchObject({ value: "restored", recoveryCheckpoint: { checkpointDigest: pinned.checkpointDigest }, completionCheckpoint: { generation: 2, kind: "restore-completed", recoveryReceiptDigest: sha("receipt") } });
    expect(() => reopened.withCurrentRecovery(manifest, () => ({ value: "replayed", recoveryReceiptDigest: sha("other") }))).toThrow(/not the current/i);
    expect(() => reopened.pinRecoveryManifest(manifest)).toThrow(/already pinned|reintroduced/i);
    reopened.close();
  });

  it("rejects raw checkpoint mutation and configuration substitution", () => {
    const f = fixture(); f.anchor.pinRecoveryManifest(sha("manifest")); f.anchor.close();
    const database = new DatabaseSync(f.path); const row = database.prepare("SELECT checkpoint_json FROM continuity_checkpoints WHERE generation=1").get() as { checkpoint_json: string };
    const changed = { ...JSON.parse(row.checkpoint_json), recoveryManifestDigest: sha("attacker") };
    database.prepare("UPDATE continuity_checkpoints SET checkpoint_json=? WHERE generation=1").run(JSON.stringify(changed)); database.close();
    expect(() => new DurableExternalMonotonicContinuityAnchor(f.path, f.config, { signerPrivateKey: f.key.privateKey })).toThrow(/tampered|substituted|history/i);
    const alternatePath = join(f.root, "alternate.sqlite"), changedConfig = { ...f.config, workspaceId: "workspace_other" };
    const alternate = new DurableExternalMonotonicContinuityAnchor(alternatePath, f.config, { signerPrivateKey: f.key.privateKey }); alternate.close();
    expect(() => new DurableExternalMonotonicContinuityAnchor(alternatePath, changedConfig, { signerPrivateKey: f.key.privateKey })).toThrow(/configuration.*substituted|widened/i);
  });

  it("keeps read-only anchors and backward clocks fail-closed", () => {
    const f = fixture(["2026-08-14T10:01:00.000Z", "2026-08-14T10:00:00.000Z"]); f.anchor.pinRecoveryManifest(sha("first"));
    expect(() => f.anchor.pinRecoveryManifest(sha("second"))).toThrow(/clock moved backwards/i); f.anchor.close();
    const readOnly = new DurableExternalMonotonicContinuityAnchor(f.path, f.config);
    expect(readOnly.current()).toMatchObject({ generation: 1, recoveryManifestDigest: sha("first") });
    expect(() => readOnly.pinRecoveryManifest(sha("third"))).toThrow(/read-only/i); readOnly.close();
  });

  it("creates an unforgeable guard that serializes only the exact current completed recovery", () => {
    const f = fixture(), manifest = sha("guard-manifest"), receipt = sha("guard-receipt"), recovery = f.anchor.pinRecoveryManifest(manifest);
    const completion = f.anchor.withCurrentRecovery(manifest, () => ({ value: null, recoveryReceiptDigest: receipt })).completionCheckpoint;
    const guard = createCustomerLocalAuthorityContinuityGuard({ anchor: f.anchor, recoveryManifestDigest: manifest, recoveryReceiptDigest: receipt, recoveryCheckpointDigest: recovery.checkpointDigest, completionCheckpoint: completion });
    expect(() => assertTrustedCustomerLocalAuthorityContinuityGuard({ ...guard } as never)).toThrow(/not an instance/i);
    expect(guard.withCurrentConsumption(() => "allowed")).toBe("allowed");
    f.anchor.pinRecoveryManifest(sha("later-manifest"));
    expect(() => guard.assertCurrent()).toThrow(/stale|superseded|mismatched|missing/i);
    expect(() => guard.withCurrentConsumption(() => "forbidden")).toThrow(/stale|superseded|mismatched|missing/i);
    f.anchor.close();
  });
});
