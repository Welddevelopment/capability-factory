import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROAD_GOAL_ORDINARY_GOAL } from "../../../src/customer-world/broad-goal-reference-world.js";
import { createConsoleApp } from "./app.js";

const port = Number(process.env.CF_DEMO_CONSOLE_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CF_DEMO_CONSOLE_PORT must be a valid TCP port.");
}

const sessionDirectory = mkdtempSync(join(tmpdir(), "cf-broad-goal-recording-"));
const { app } = createConsoleApp({
  databasePath: join(sessionDirectory, "console.sqlite"),
  goalDataDirectory: join(sessionDirectory, "goal-worlds"),
  recordingProfile: {
    suggestedGoal: BROAD_GOAL_ORDINARY_GOAL,
    defaultMode: "goal-plan-complete",
    // Shown persistently on screen so a recording can never imply model-backed
    // construction: this route uses a deterministic reference builder.
    routeBadge: "Deterministic fictional route \u00b7 no model calls \u00b7 reference-built manifest",
  },
});

await app.listen({ host: "127.0.0.1", port });

console.log(`Capability Factory recording console: http://127.0.0.1:${port}/playground`);
console.log("First run: fresh capability registry (East Industrial will show New Capability).");
console.log("Second run: fresh business world with the same registry (East Industrial will show Retained Reuse).");
console.log(`Evidence preserved for this recording session at: ${sessionDirectory}`);
console.log("For a clean retake, stop this process and launch the command again. Prior session evidence is not deleted.");

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
