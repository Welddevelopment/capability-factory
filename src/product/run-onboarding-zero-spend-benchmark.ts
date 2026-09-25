import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runZeroSpendOnboardingBenchmark } from "./onboarding-zero-spend-benchmark.js";

const root = join(process.cwd(), "test/fixtures/onboarding-zero-spend");
const load = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));

const report = runZeroSpendOnboardingBenchmark({
  unfamiliarOpenApi: load("yardpass-openapi.json"),
  adversarialOpenApi: load("adversarial-openapi-fragment.json"),
  adversarialAuthorityEvidenceOpenApi: load("adversarial-authority-evidence-injection.json"),
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
