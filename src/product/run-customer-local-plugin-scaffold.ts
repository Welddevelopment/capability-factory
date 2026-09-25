import { readFileSync } from "node:fs";
import { buildCustomerLocalPlugin, createPluginReleaseManifest, scaffoldCustomerLocalPlugin, type PluginScaffoldMetadata } from "./customer-local-plugin-scaffold.js";

function json(path: string): Record<string, unknown> { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
async function main(): Promise<void> {
  const [command, first, second] = process.argv.slice(2);
  if (command === "scaffold" && first && second) {
    const result = scaffoldCustomerLocalPlugin(second, json(first) as unknown as PluginScaffoldMetadata);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return;
  }
  if (command === "build" && first) { process.stdout.write(`${JSON.stringify(buildCustomerLocalPlugin(first), null, 2)}\n`); return; }
  if (command === "release" && first && second) {
    const input = json(second) as unknown as Parameters<typeof createPluginReleaseManifest>[0];
    process.stdout.write(`${JSON.stringify(createPluginReleaseManifest({ ...input, projectPath: first }), null, 2)}\n`); return;
  }
  throw new Error("Usage: ... scaffold <metadata.json> <output-root> | build <project> | release <project> <release-input.json>");
}
void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "Plugin scaffold command failed."}\n`); process.exitCode = 1; });
