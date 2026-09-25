import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { runPilotAdapterAcceptanceHarness } from "../product/pilot-adapter.js";
import { startRealGiteaWorld } from "./real-gitea-world.js";
import { createRealGiteaPilotAcceptanceHarness } from "./real-gitea-pilot-acceptance.js";

const baseRoot = path.resolve(process.env.CF_GITEA_ACCEPTANCE_DATA ?? "artifacts/gitea-pilot-acceptance");
const campaignId = `gitea-acceptance-v1-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const root = path.join(baseRoot, campaignId);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const world = await startRealGiteaWorld({ repositoryRoot: process.cwd(), artifactDirectory: root });
const harness = createRealGiteaPilotAcceptanceHarness({ world, dataDirectory: root });
const acceptance = await runPilotAdapterAcceptanceHarness(harness);
const summaryPath = path.join(root, "acceptance-summary.json");
fs.writeFileSync(summaryPath, `${JSON.stringify({
  schemaVersion: "1.0",
  environment: "genuine disposable local Gitea 1.27.0 with fictional data",
  capabilityMode: "constrained-http-api",
  acceptance,
  evidenceBoundary: "Private local controlled-pilot transfer evidence; not a customer result or production-reliability claim.",
  completedAt: new Date().toISOString(),
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`Gitea adapter acceptance: ${acceptance.completedCases}/${acceptance.requiredCases} cases completed`);
console.log(`Incorrect side effects surviving cleanup: ${acceptance.incorrectSideEffects}`);
console.log(`Result: ${acceptance.passed ? "PASS" : "NOT READY"}`);
console.log(`Evidence: ${summaryPath}`);
if (!acceptance.passed) process.exitCode = 1;
