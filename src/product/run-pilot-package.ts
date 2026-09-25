import path from "node:path";
import { pathToFileURL } from "node:url";
import { PilotPackageManager, startPilotPackageSidecar, type PackagedPilotRuntimeFactory } from "./pilot-package.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  pnpm pilot:package init --root <dir> --installation <id> --tenant <id> --version <semver> --adapter <runtime.mjs> [--port 4317]",
    "  pnpm pilot:package ready --root <dir>",
    "  pnpm pilot:package doctor --root <dir>",
    "  pnpm pilot:package serve --root <dir> [--container-internal]",
    "  pnpm pilot:package evidence --root <dir> --report <report.json> --output <export.json>",
    "  pnpm pilot:package support --root <dir> --output <support.json>",
    "--container-internal is only for a container whose host port is published on 127.0.0.1.",
  ].join("\n"));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command) usage();
  const manager = new PilotPackageManager(path.resolve(required("--root")));
  if (command === "init") {
    const portRaw = option("--port");
    const config = manager.initialize({
      installationId: required("--installation"), tenantId: required("--tenant"),
      productVersion: required("--version"), adapterRuntimePath: path.resolve(required("--adapter")),
      ...(portRaw ? { port: Number(portRaw) } : {}),
    });
    process.stdout.write(`${JSON.stringify({ status: "initialized", root: manager.rootDirectory, bind: config.bind,
      accessTokenFile: manager.resolve(config.files.accessToken), continuationSecretFile: manager.resolve(config.files.continuationSecret),
      next: `pnpm pilot:package ready --root ${manager.rootDirectory}` }, null, 2)}\n`);
    return;
  }
  if (command === "ready") {
    const readiness = await manager.readiness();
    process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`);
    if (!readiness.ready) process.exitCode = 1;
    return;
  }
  if (command === "doctor") {
    const readiness = await manager.readiness();
    const nextActions: Record<string, string> = {
      "installation-active": "Reactivate only after the customer confirms the pilot may run, or restore a verified backup.",
      "installation-mode": "Reinitialize this package as a customer-hosted sidecar installation.",
      "installation-metadata": "Restore verified installation metadata; do not invent or hand-edit lifecycle state.",
      "package-config": "Restore the private package config from a verified backup or initialize a new installation.",
      "adapter-runtime": "Restore the reviewed adapter bytes matching the pinned hash; do not update the hash to bless unknown bytes.",
      "access-token": "Rotate or recreate the customer-local token as a private mode-0600 file, then rerun doctor.",
      "continuation-secret": "Rotate or restore the customer-local continuation secret, revoke outstanding grants, then rerun doctor.",
      "plans-directory": "Restore the validated-plan directory with owner-only permissions.",
      "continuation-revocations": "Restore the revocation directory with owner-only permissions before accepting continuations.",
      "bind-address": "Keep the sidecar on 127.0.0.1; do not expose it directly to a network.",
      "port-available": "Stop the conflicting local process or create a new reviewed installation on another localhost port.",
    };
    for (const check of readiness.checks) {
      process.stdout.write(`${check.passed ? "PASS" : "FAIL"} ${check.id}: ${check.detail}\n`);
      if (!check.passed) process.stdout.write(`  Next: ${nextActions[check.id] ?? "Stop activation, preserve state, and investigate before changing files."}\n`);
    }
    process.stdout.write(`Pilot package doctor: ${readiness.checks.filter((check) => check.passed).length}/${readiness.checks.length} checks passed.\n`);
    if (!readiness.ready) process.exitCode = 1;
    return;
  }
  if (command === "serve") {
    const config = manager.readConfig();
    const runtimeUrl = pathToFileURL(manager.resolve(config.adapterRuntime.path));
    runtimeUrl.searchParams.set("sha256", config.adapterRuntime.sha256);
    const module = await import(runtimeUrl.href) as { createPilotRuntime?: PackagedPilotRuntimeFactory };
    if (typeof module.createPilotRuntime !== "function") throw new Error("Adapter runtime must export createPilotRuntime(context).");
    const containerInternal = process.argv.includes("--container-internal");
    if (containerInternal && process.env.CF_CONTAINER_LOCALHOST_PUBLISH !== "acknowledged") {
      throw new Error("Container-internal binding requires CF_CONTAINER_LOCALHOST_PUBLISH=acknowledged and a host publish restricted to 127.0.0.1.");
    }
    const running = await startPilotPackageSidecar(manager, module.createPilotRuntime, containerInternal ? { listenHost: "0.0.0.0" } : {});
    process.stdout.write(`${JSON.stringify({ status: "running", url: running.url, tenantId: config.tenantId }, null, 2)}\n`);
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    });
    await running.close();
    return;
  }
  if (command === "evidence") {
    const output = path.resolve(required("--output"));
    const exported = await manager.exportEvidence({ reportPath: path.resolve(required("--report")), outputPath: output });
    process.stdout.write(`${JSON.stringify({ status: "exported", installationId: exported.installation.installationId,
      ready: exported.readiness.ready, output, reportSha256: exported.suppliedReportSha256 }, null, 2)}\n`);
    return;
  }
  if (command === "support") {
    const output = path.resolve(required("--output"));
    const exported = await manager.exportSupportBundle(output);
    process.stdout.write(`${JSON.stringify({ status: "exported", output, ready: exported.readiness.ready,
      installationId: exported.installation.installationId, secretValuesIncluded: false, customerPayloadsIncluded: false }, null, 2)}\n`);
    return;
  }
  usage();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
