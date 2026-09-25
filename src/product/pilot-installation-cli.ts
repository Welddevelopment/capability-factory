import path from "node:path";
import { PilotInstallationManager } from "./installation.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredFlag(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`Missing required --${name} value.`);
  return value;
}

const command = process.argv[2];
const root = path.resolve(process.env.CF_PILOT_INSTALL_ROOT ?? flag("root") ?? ".capability-factory-pilot");
const manager = new PilotInstallationManager(root);
let result: unknown;

if (command === "install") {
  const mode = requiredFlag("mode");
  if (mode !== "embedded-sdk" && mode !== "customer-hosted-sidecar") throw new Error("--mode must be embedded-sdk or customer-hosted-sidecar.");
  result = manager.install({
    installationId: requiredFlag("id"),
    productVersion: requiredFlag("version"),
    installationMode: mode,
  });
} else if (command === "inspect") {
  result = manager.inspect();
} else if (command === "backup") {
  result = manager.backup(requiredFlag("reason"));
} else if (command === "verify") {
  result = manager.verifyBackup(requiredFlag("backup"));
} else if (command === "restore") {
  result = manager.restore(requiredFlag("backup"));
} else if (command === "upgrade") {
  result = manager.upgrade(requiredFlag("version"));
} else if (command === "deactivate") {
  result = manager.deactivate(requiredFlag("reason"));
} else if (command === "reactivate") {
  result = manager.reactivate();
} else if (command === "uninstall") {
  result = manager.uninstall(path.resolve(requiredFlag("archive")));
} else {
  throw new Error("Usage: pilot:lifecycle <install|inspect|backup|verify|restore|upgrade|deactivate|reactivate|uninstall> [flags]");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
