import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCompanyServer, type CompanyServerHandle } from "../src/company-server.js";
import { openCompanyDatabase, readPurchaseOrders, seedCompanyDatabase } from "../src/database.js";
import { createManualProcurementManifest } from "../src/manual-manifest.js";
import { CustomerLocalOperationalControl } from "../src/product/operations.js";
import { CapabilityRuntime } from "../src/runtime.js";
import { developmentScenario } from "../src/scenario.js";

const servers: CompanyServerHandle[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("customer-local operational controls", () => {
  it("enforces write budgets, drain/halt modes, and capability quarantine before external action", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-operations-"));
    directories.push(directory);
    const scenario = developmentScenario();
    const database = openCompanyDatabase(path.join(directory, "company.sqlite"));
    seedCompanyDatabase(database, scenario);
    const server = await startCompanyServer(database, scenario);
    servers.push(server);
    const manifest = createManualProcurementManifest(scenario, server.documentation);
    const controls = new CustomerLocalOperationalControl(path.join(directory, "operations.sqlite"), "tenant-a", {
      maxWriteAttemptsPerRun: 1,
      maxWriteAttemptsPerHour: 3,
      maxModelSpendUsdPerDay: 0.5,
    });
    const runtime = new CapabilityRuntime({
      targets: { procurement: { baseUrl: server.aliases.procurement!, allowedPaths: server.allowedPaths.procurement! } },
      secrets: { [scenario.credential.secretAlias]: scenario.credential.secretValue },
      operationGuard: controls,
    });
    const writeInput = {
      productSku: "SENSOR-COLD-16",
      quantity: 1,
      warehouseId: "WH-NORTH",
      deliverBy: scenario.shipments[0]!.arrivalAt,
    };
    await runtime.execute(manifest, "create_purchase_order", writeInput, { runId: "run-one" });
    await expect(runtime.execute(manifest, "create_purchase_order", writeInput, { runId: "run-one" }))
      .rejects.toThrow(/Per-run write-attempt limit/);
    expect(readPurchaseOrders(database)).toHaveLength(1);

    controls.setMode("draining", "Finish reads but stop new writes.");
    await runtime.execute(manifest, "search_equipment", {
      requiredMinTempC: -20,
      requiredMaxTempC: 8,
      deliverBy: scenario.shipments[0]!.arrivalAt,
    }, { runId: "drain-read" });
    await expect(runtime.execute(manifest, "create_purchase_order", writeInput, { runId: "drain-write" }))
      .rejects.toThrow(/draining/);
    controls.setMode("halted", "Emergency customer stop.");
    await expect(runtime.execute(manifest, "search_equipment", {
      requiredMinTempC: -20,
      requiredMaxTempC: 8,
      deliverBy: scenario.shipments[0]!.arrivalAt,
    }, { runId: "halt-read" })).rejects.toThrow(/kill switch/);

    controls.setMode("running", "Customer explicitly resumed the pilot.");
    controls.setCapabilityStatus(manifest.id, "quarantined", "Unknown outcome requires review.");
    await expect(runtime.execute(manifest, "search_equipment", {
      requiredMinTempC: -20,
      requiredMaxTempC: 8,
      deliverBy: scenario.shipments[0]!.arrivalAt,
    }, { runId: "quarantined-read" })).rejects.toThrow(/quarantined/);
    controls.setCapabilityStatus(manifest.id, "active", "Independent review cleared the capability.");

    controls.authorizeModelSpend("model-one", 0.3);
    expect(() => controls.authorizeModelSpend("model-two", 0.21)).toThrow(/spend limit/);
    controls.raiseIncident("high", { summary: "Credential check failed.", apiToken: "private-secret-value" });
    controls.recordBackupCheck("backup-good", true, "All hashes matched.");
    controls.recordBackupCheck("backup-bad", false, "One payload hash differed.");
    expect(JSON.stringify(controls.incidents())).not.toContain("private-secret-value");
    expect(controls.incidents().length).toBeGreaterThanOrEqual(2);
    expect(controls.verifyAuditChain()).toMatchObject({ passed: true });
    expect(controls.exportAudit().map((entry) => entry.payload.type)).toContain("operations.backup-check");
    controls.close();
    database.close();
  });
});
