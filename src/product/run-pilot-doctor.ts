import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { preflightControlledPilotAdapter, validatePilotAdapterAcceptanceHarness } from "./pilot-adapter.js";
import { createRealErpNextBroadGoalPilotAdapter } from "../customer-world/real-erpnext-broad-goal-pilot-adapter.js";
import { startRealErpNextProcurementWorld } from "../customer-world/real-erpnext-procurement-world.js";

interface DoctorCheck { id: string; passed: boolean; detail: string }

async function main(): Promise<void> {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ id: "node-version", passed: major >= 24, detail: `Node ${process.versions.node}; version 24 or newer is required.` });
  checks.push({ id: "package-lock", passed: fs.existsSync(path.resolve("pnpm-lock.yaml")), detail: "The pinned pnpm lockfile is present." });
  const composeDirectory = path.resolve(process.env.CF_ERPNEXT_COMPOSE_DIR ?? "fixtures/erpnext");
  const composeFile = path.join(composeDirectory, "compose.yml");
  checks.push({ id: "erpnext-compose", passed: fs.existsSync(composeFile), detail: `The pinned disposable ERPNext compose fixture is present: ${composeFile}` });
  const token = process.env.CF_SIDECAR_TOKEN?.trim();
  checks.push({ id: "sidecar-token", passed: Boolean(token && token.length >= 16), detail: "CF_SIDECAR_TOKEN must contain at least 16 characters; its value is never printed." });
  const dataRoot = path.resolve(process.env.CF_SIDECAR_DATA ?? "artifacts/real-erpnext-pilot-sidecar");
  try {
    fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    fs.accessSync(dataRoot, fs.constants.R_OK | fs.constants.W_OK);
    checks.push({ id: "data-directory", passed: true, detail: `The private sidecar data directory is readable and writable: ${dataRoot}` });
  } catch (error) {
    checks.push({ id: "data-directory", passed: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    const world = await startRealErpNextProcurementWorld({ repositoryRoot: process.cwd() });
    const adapter = createRealErpNextBroadGoalPilotAdapter({ world, dataDirectory: dataRoot });
    checks.push(...await preflightControlledPilotAdapter(adapter));
    checks.push(...validatePilotAdapterAcceptanceHarness(adapter.acceptance));
    await world.close();
  } catch (error) {
    checks.push({ id: "erpnext-connection", passed: false, detail: error instanceof Error ? error.message : String(error) });
  }
  for (const item of checks) console.log(`${item.passed ? "PASS" : "FAIL"} ${item.id}: ${item.detail}`);
  const failures = checks.filter((item) => !item.passed);
  console.log(`Pilot doctor: ${checks.length - failures.length}/${checks.length} checks passed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
