import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { preflightControlledPilotAdapter, runPilotAdapterAcceptance } from "../product/pilot-adapter.js";
import { createRealErpNextBroadGoalPilotAdapter } from "./real-erpnext-broad-goal-pilot-adapter.js";
import { startRealErpNextProcurementWorld } from "./real-erpnext-procurement-world.js";

async function main(): Promise<void> {
  const root = path.resolve(process.env.CF_PILOT_ACCEPTANCE_DATA ?? "artifacts/controlled-pilot-acceptance");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const world = await startRealErpNextProcurementWorld({ repositoryRoot: process.cwd() });
  try {
    const adapter = createRealErpNextBroadGoalPilotAdapter({ world, dataDirectory: root });
    const preflight = await preflightControlledPilotAdapter(adapter);
    const preflightFailures = preflight.filter((item) => !item.passed);
    if (preflightFailures.length > 0) {
      throw new Error(`Adapter preflight failed: ${preflightFailures.map((item) => item.id).join(", ")}`);
    }
    const acceptance = await runPilotAdapterAcceptance(adapter);
    const summaryPath = path.join(root, "acceptance-summary.json");
    fs.writeFileSync(summaryPath, `${JSON.stringify({
      schemaVersion: "1.0",
      environment: "genuine disposable local ERPNext with fictional data",
      capabilityMode: adapter.descriptor.capabilityMode,
      preflight,
      acceptance,
      evidenceBoundary: "Private local controlled-pilot acceptance evidence; not a customer result or production-reliability claim.",
      completedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(`Controlled-pilot adapter acceptance: ${acceptance.completedCases}/${acceptance.requiredCases} cases completed`);
    console.log(`Incorrect side effects surviving case cleanup: ${acceptance.incorrectSideEffects}`);
    console.log(`Result: ${acceptance.passed ? "PASS" : "NOT READY"}`);
    console.log(`Evidence: ${summaryPath}`);
    if (!acceptance.passed) process.exitCode = 1;
  } finally {
    await world.close();
  }
}

await main();
