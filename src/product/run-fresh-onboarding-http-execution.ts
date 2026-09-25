import path from "node:path";
import { runFreshOnboardingHttpExecution } from "../customer-world/fresh-onboarding-http-world.js";

const root = process.cwd();
const outputDirectory = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "reports", "fresh-onboarding-http-execution-2026-08-12");

const report = await runFreshOnboardingHttpExecution({
  fixtureDirectory: path.join(root, "test", "fixtures", "onboarding-fresh-execution"),
  outputDirectory,
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
