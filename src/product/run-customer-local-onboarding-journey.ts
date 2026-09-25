import process from "node:process";
import { runCustomerLocalOnboardingJourneyCli } from "./customer-local-onboarding-journey-cli.js";

process.exitCode=await runCustomerLocalOnboardingJourneyCli(process.argv.slice(2));
