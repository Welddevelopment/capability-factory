import path from "node:path";
import { runSimulatedControlledPilot } from "./run-simulated-pilot.js";

const root = process.env.CF_SIMULATED_PILOT_ROOT;
if (!root) throw new Error("Set CF_SIMULATED_PILOT_ROOT to a new disposable installation path.");
const report = await runSimulatedControlledPilot(path.resolve(root));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
