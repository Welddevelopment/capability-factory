import process from "node:process";
import { runOnboardingPreparationCli } from "./onboarding-preparation-cli.js";

process.exitCode = await runOnboardingPreparationCli(process.argv.slice(2));
