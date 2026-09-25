import path from "node:path";
import { pathToFileURL } from "node:url";
import { preflightControlledPilotAdapter, type ControlledPilotAdapter } from "./pilot-adapter.js";

async function main(): Promise<void> {
  const modulePath = process.argv[2];
  if (!modulePath) throw new Error("Usage: pnpm product:adapter:check -- <adapter-module.ts>");
  const imported = await import(pathToFileURL(path.resolve(modulePath)).href) as {
    default?: ControlledPilotAdapter;
    pilotAdapter?: ControlledPilotAdapter;
  };
  const adapter = imported.pilotAdapter ?? imported.default;
  if (!adapter) throw new Error("The module must export `pilotAdapter` or a default ControlledPilotAdapter.");
  const checks = await preflightControlledPilotAdapter(adapter);
  const passed = checks.every((item) => item.passed);
  console.log(JSON.stringify({
    adapterId: adapter.descriptor.adapterId,
    adapterVersion: adapter.descriptor.adapterVersion,
    capabilityMode: adapter.descriptor.capabilityMode,
    passed,
    checks,
  }, null, 2));
  if (!passed) process.exitCode = 1;
}

await main();
