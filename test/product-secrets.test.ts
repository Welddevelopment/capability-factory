import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCompanyServer, type CompanyServerHandle } from "../src/company-server.js";
import { openCompanyDatabase, readPurchaseOrders, seedCompanyDatabase } from "../src/database.js";
import { createManualProcurementManifest } from "../src/manual-manifest.js";
import {
  DirectorySecretProvider,
  EnvironmentSecretProvider,
  RotatingMemorySecretProvider,
  type ScopedSecretDescriptor,
} from "../src/product/secrets.js";
import { CapabilityRuntime } from "../src/runtime.js";
import { developmentScenario } from "../src/scenario.js";
import { TraceWriter } from "../src/trace.js";

const servers: CompanyServerHandle[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function descriptor(alias: string, version = "v1"): ScopedSecretDescriptor {
  return {
    alias,
    version,
    scope: {
      targetAliases: ["procurement"],
      actionNames: ["search_equipment", "create_purchase_order"],
      methods: ["GET", "POST"],
    },
  };
}

describe("customer-local credential boundary", () => {
  it("resolves an alias only at execution, scopes its use, supports rotation, and redacts the value", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-secret-boundary-"));
    directories.push(directory);
    const scenario = developmentScenario();
    const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
    seedCompanyDatabase(database, scenario);
    const server = await startCompanyServer(database, scenario);
    servers.push(server);
    const manifest = createManualProcurementManifest(scenario, server.documentation);
    const provider = new RotatingMemorySecretProvider();
    provider.set(descriptor(scenario.credential.secretAlias), scenario.credential.secretValue);
    const trace = new TraceWriter("customer-local-secret", path.join(directory, "trace"));
    const runtime = new CapabilityRuntime({
      targets: {
        procurement: {
          baseUrl: server.aliases.procurement!,
          allowedPaths: server.allowedPaths.procurement!,
        },
      },
      secrets: {},
      secretProvider: provider,
    }, trace);

    runtime.validateManifest(manifest);
    expect(JSON.stringify(manifest)).not.toContain(scenario.credential.secretValue);
    await runtime.execute(manifest, "create_purchase_order", {
      productSku: "SENSOR-COLD-16",
      quantity: 1,
      warehouseId: "WH-NORTH",
      deliverBy: scenario.shipments[0]!.arrivalAt,
    }, { runId: "customer-local-secret" });
    expect(readPurchaseOrders(database)).toHaveLength(1);
    const traceText = fs.readFileSync(trace.filename, "utf8");
    expect(traceText).not.toContain(scenario.credential.secretValue);
    expect(traceText).toContain("[REDACTED]");

    provider.set(descriptor(scenario.credential.secretAlias, "v2"), scenario.credential.secretValue);
    expect(provider.resolve({
      alias: scenario.credential.secretAlias,
      targetAlias: "procurement",
      actionName: "search_equipment",
      method: "GET",
      runId: "rotation-check",
      testMode: false,
    }).version).toBe("v2");
    expect(() => provider.resolve({
      alias: scenario.credential.secretAlias,
      targetAlias: "different-system",
      actionName: "search_equipment",
      method: "GET",
      runId: "scope-denial",
      testMode: false,
    })).toThrow(/not authorized/);
    database.close();
  });

  it("supports environment and locked-file providers without loading values during alias checks", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-secret-files-"));
    directories.push(directory);
    const alias = "supplier_key";
    const file = path.join(directory, alias);
    fs.writeFileSync(file, "file-only-secret\n", { mode: 0o600 });
    const files = new DirectorySecretProvider(directory, [descriptor(alias)]);
    expect(files.has(alias)).toBe(true);
    expect(files.resolve({
      alias,
      targetAlias: "procurement",
      actionName: "search_equipment",
      method: "GET",
      runId: "file-secret",
      testMode: false,
    })).toEqual({ value: "file-only-secret", version: "v1" });
    fs.chmodSync(file, 0o644);
    expect(files.has(alias)).toBe(false);
    expect(() => files.resolve({
      alias,
      targetAlias: "procurement",
      actionName: "search_equipment",
      method: "GET",
      runId: "file-secret",
      testMode: false,
    })).toThrow(/must not be readable/);

    const environment = new EnvironmentSecretProvider(
      [{ ...descriptor(alias, "env-v3"), environmentVariable: "CF_TEST_SUPPLIER_KEY" }],
      { CF_TEST_SUPPLIER_KEY: "environment-only-secret" },
    );
    expect(environment.has(alias)).toBe(true);
    expect(environment.resolve({
      alias,
      targetAlias: "procurement",
      actionName: "create_purchase_order",
      method: "POST",
      runId: "environment-secret",
      testMode: false,
    })).toEqual({ value: "environment-only-secret", version: "env-v3" });
  });
});
