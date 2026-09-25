import fs from "node:fs";
import path from "node:path";
import { runPilotConversionRehearsal } from "./pilot-conversion-rehearsal.js";

function option(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function required(name: string): string { const value = option(name); if (!value) throw new Error(`Missing required option ${name}`); return value; }

void runPilotConversionRehearsal(path.resolve(required("--root"))).then((report) => {
  const output = option("--output");
  if (output) fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.checks.some((check) => !check.passed)) process.exitCode = 1;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
