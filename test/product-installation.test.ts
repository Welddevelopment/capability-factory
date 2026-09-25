import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PilotInstallationManager } from "../src/product/installation.js";
import { SidecarGoalJobStore } from "../src/product/sidecar-jobs.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  roots.push(root);
  return root;
}

describe("controlled-pilot installation lifecycle", () => {
  it("installs, backs up, upgrades, rolls back a failed migration, deactivates, and reactivates", () => {
    const parent = temporaryRoot("cf-installation-");
    const root = path.join(parent, "pilot");
    const manager = new PilotInstallationManager(root);
    expect(manager.install({
      installationId: "pilot-one",
      productVersion: "0.1.0",
      installationMode: "customer-hosted-sidecar",
    })).toMatchObject({ schemaVersion: 2, lifecycle: "active", supportedCapabilityModes: ["constrained-http-api"] });
    fs.writeFileSync(path.join(manager.dataDirectory, "state.json"), "v1-state", { mode: 0o600 });

    const firstBackup = manager.backup("before-test-upgrade");
    expect(manager.verifyBackup(firstBackup.backupId).files.map((file) => file.path)).toContain("data/state.json");
    const upgraded = manager.upgrade("0.2.0", (data) => {
      fs.writeFileSync(path.join(data, "state.json"), "v2-state", { mode: 0o600 });
    });
    expect(upgraded.metadata).toMatchObject({ productVersion: "0.2.0", lastBackupId: upgraded.backup.backupId });
    expect(fs.readFileSync(path.join(manager.dataDirectory, "state.json"), "utf8")).toBe("v2-state");

    expect(() => manager.upgrade("0.3.0", (data) => {
      fs.writeFileSync(path.join(data, "state.json"), "corrupt-migration", { mode: 0o600 });
      throw new Error("simulated migration failure");
    })).toThrow(/rolled back/);
    expect(manager.inspect().productVersion).toBe("0.2.0");
    expect(fs.readFileSync(path.join(manager.dataDirectory, "state.json"), "utf8")).toBe("v2-state");
    expect(manager.deactivate("Customer paused the pilot.")).toMatchObject({ lifecycle: "deactivated" });
    expect(() => manager.upgrade("0.3.0")).toThrow(/active installation/);
    expect(manager.reactivate()).toMatchObject({ lifecycle: "active" });
  });

  it("migrates legacy metadata only after preserving its original state", () => {
    const parent = temporaryRoot("cf-installation-legacy-");
    const root = path.join(parent, "pilot");
    fs.mkdirSync(path.join(root, "data"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, "data", "legacy.sqlite"), "legacy-state", { mode: 0o600 });
    fs.writeFileSync(path.join(root, "installation.json"), JSON.stringify({
      schemaVersion: 1,
      installationId: "legacy-pilot",
      productVersion: "0.0.9",
      installationMode: "embedded-sdk",
      active: false,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    }), { mode: 0o600 });
    const manager = new PilotInstallationManager(root);
    const migrated = manager.migrateLegacy();
    expect(migrated.metadata).toMatchObject({ schemaVersion: 2, lifecycle: "deactivated", lastBackupId: migrated.backup.backupId });
    expect(manager.verifyBackup(migrated.backup.backupId).files.map((file) => file.path)).toEqual([
      "data/legacy.sqlite",
      "installation.json",
    ]);
  });

  it("exports and verifies evidence before uninstalling runtime state", () => {
    const parent = temporaryRoot("cf-installation-uninstall-");
    const root = path.join(parent, "pilot");
    const archive = path.join(parent, "pilot-final-archive");
    const manager = new PilotInstallationManager(root);
    manager.install({ installationId: "pilot-uninstall", productVersion: "0.2.0", installationMode: "customer-hosted-sidecar" });
    fs.writeFileSync(path.join(manager.dataDirectory, "audit.jsonl"), "preserved-audit\n", { mode: 0o600 });
    const result = manager.uninstall(archive);
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.readFileSync(path.join(archive, "payload", "data", "audit.jsonl"), "utf8")).toBe("preserved-audit\n");
    expect(result.manifest.files.map((file) => file.path)).toContain("installation.json");
    expect(JSON.parse(fs.readFileSync(path.join(archive, "payload", "installation.json"), "utf8"))).toMatchObject({ lifecycle: "uninstalled" });
  });

  it("migrates an existing sidecar job database to schema version 2 without losing jobs", () => {
    const parent = temporaryRoot("cf-sidecar-schema-");
    const databasePath = path.join(parent, "jobs.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE sidecar_goal_jobs (
        job_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_goal_id TEXT NOT NULL,
        request_id TEXT NOT NULL, request_digest TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, request_json TEXT NOT NULL, result_json TEXT,
        error_text TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, parent_goal_id)
      );
    `);
    legacy.close();
    const store = new SidecarGoalJobStore(databasePath);
    store.close();
    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    expect((inspected.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    expect((inspected.prepare("PRAGMA table_info(sidecar_goal_jobs)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("continuation_json");
    inspected.close();
  });

  it("fails closed on altered, extra, traversing, or mismatched backup contents", () => {
    const parent = temporaryRoot("cf-installation-corruption-");
    const root = path.join(parent, "pilot");
    const manager = new PilotInstallationManager(root);
    manager.install({ installationId: "pilot-corruption", productVersion: "0.2.0", installationMode: "customer-hosted-sidecar" });
    fs.writeFileSync(path.join(manager.dataDirectory, "state.json"), "trusted-state", { mode: 0o600 });

    const altered = manager.backup("altered-payload");
    fs.writeFileSync(path.join(manager.backupsDirectory, altered.backupId, "payload", "data", "state.json"), "altered", { mode: 0o600 });
    expect(() => manager.verifyBackup(altered.backupId)).toThrow(/integrity check failed/);

    const extra = manager.backup("extra-payload");
    fs.writeFileSync(path.join(manager.backupsDirectory, extra.backupId, "payload", "data", "unlisted.json"), "unlisted", { mode: 0o600 });
    expect(() => manager.verifyBackup(extra.backupId)).toThrow(/exactly match/);

    const traversing = manager.backup("traversing-manifest");
    const traversingManifestPath = path.join(manager.backupsDirectory, traversing.backupId, "manifest.json");
    const traversingManifest = JSON.parse(fs.readFileSync(traversingManifestPath, "utf8")) as { files: Array<{ path: string }> };
    traversingManifest.files[0]!.path = "../outside";
    fs.writeFileSync(traversingManifestPath, JSON.stringify(traversingManifest), { mode: 0o600 });
    expect(() => manager.verifyBackup(traversing.backupId)).toThrow(/normalized relative POSIX paths/);

    const mismatched = manager.backup("mismatched-identity");
    const mismatchedManifestPath = path.join(manager.backupsDirectory, mismatched.backupId, "manifest.json");
    const mismatchedManifest = JSON.parse(fs.readFileSync(mismatchedManifestPath, "utf8")) as { backupId: string };
    mismatchedManifest.backupId = "backup-other";
    fs.writeFileSync(mismatchedManifestPath, JSON.stringify(mismatchedManifest), { mode: 0o600 });
    expect(() => manager.verifyBackup(mismatched.backupId)).toThrow(/identity/);
  });
});
