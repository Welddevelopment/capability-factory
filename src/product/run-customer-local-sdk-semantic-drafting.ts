import process from "node:process";
import { runSdkSemanticDraftCli } from "./customer-local-sdk-semantic-drafting-cli.js";

process.exitCode=await runSdkSemanticDraftCli(process.argv.slice(2));
