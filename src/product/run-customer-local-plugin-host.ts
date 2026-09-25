import { resolve } from "node:path";
import { CustomerLocalPluginHost, createReferencePluginHostManifest } from "./customer-local-plugin-host.js";

async function main(): Promise<void> {
  const statePath = process.argv[2];
  if (!statePath) throw new Error("Usage: node --import tsx src/product/run-customer-local-plugin-host.ts <customer-local-state.sqlite>");
  const tenantId = process.argv[3] ?? "local-reference-tenant";
  const configured = createReferencePluginHostManifest(tenantId);
  const host = new CustomerLocalPluginHost(configured.manifest, { statePath: resolve(statePath), loaders: configured.loaders });
  try {
    const reports = [];
    for (const entry of configured.manifest.entries) reports.push(await host.load(entry.bundleId));
    process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", reports, evidence: host.evidenceExport(), evidenceBoundary: "Local host/doctor machinery only; no authority or activation." }, null, 2)}\n`);
  } finally { host.close(); }
}
void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "Plugin host failed."}\n`); process.exitCode = 1; });
