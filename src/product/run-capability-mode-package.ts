import path from "node:path";
import { CapabilityModePackageManager } from "./capability-mode-package.js";

type Command =
  | "doctor"
  | "backup"
  | "verify-backup"
  | "restore"
  | "deactivate"
  | "evidence"
  | "support";

function usage(): never {
  throw new Error([
    "Usage:",
    "  mode-package doctor <package-root>",
    "  mode-package backup <package-root> <reason>",
    "  mode-package verify-backup <package-root> <backup-id>",
    "  mode-package restore <package-root> <backup-id>",
    "  mode-package deactivate <package-root> <reason>",
    "  mode-package evidence <package-root> <private-report.json> <output.json>",
    "  mode-package support <package-root> <output.json>",
  ].join("\n"));
}

const [rawCommand, rawRoot, ...args] = process.argv.slice(2);
if (!rawCommand || !rawRoot) usage();
const command = rawCommand as Command;
if (!["doctor", "backup", "verify-backup", "restore", "deactivate", "evidence", "support"].includes(command)) {
  usage();
}
const manager = new CapabilityModePackageManager(path.resolve(rawRoot));

let result: unknown;
switch (command) {
  case "doctor": {
    if (args.length !== 0) usage();
    result = await manager.readiness();
    if (!(result as { ready: boolean }).ready) process.exitCode = 1;
    break;
  }
  case "backup": {
    if (args.length !== 1) usage();
    result = manager.backup(args[0]!);
    break;
  }
  case "verify-backup": {
    if (args.length !== 1) usage();
    result = manager.verifyBackup(args[0]!);
    break;
  }
  case "restore": {
    if (args.length !== 1) usage();
    result = manager.restore(args[0]!);
    break;
  }
  case "deactivate": {
    if (args.length !== 1) usage();
    result = manager.deactivate(args[0]!);
    break;
  }
  case "evidence": {
    if (args.length !== 2) usage();
    result = await manager.exportEvidence({
      reportPath: path.resolve(args[0]!),
      outputPath: path.resolve(args[1]!),
    });
    break;
  }
  case "support": {
    if (args.length !== 1) usage();
    result = await manager.exportSupportBundle(path.resolve(args[0]!));
    break;
  }
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
