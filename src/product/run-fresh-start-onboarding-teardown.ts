import path from "node:path";
import { runFreshStartOnboardingTeardown } from "./fresh-start-onboarding-teardown.js";

const projectDirectory = process.cwd();
const packageDirectory = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(projectDirectory, "validation/fresh-start-onboarding-teardown-v1/package");
const outputDirectory = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(projectDirectory, "reports/fresh-start-onboarding-teardown-artifacts-2026-08-14");

try {
  const report = await runFreshStartOnboardingTeardown({ packageDirectory, outputDirectory, projectDirectory });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
