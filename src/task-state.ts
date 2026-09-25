import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const taskStatusSchema = z.enum([
  "running",
  "completed",
  "handed_off",
  "failed",
  "timed_out",
]);

export const taskStateSchema = z
  .object({
    runId: z.string(),
    originalGoal: z.string(),
    observations: z.array(z.string()),
    completedSteps: z.array(z.string()),
    remainingWork: z.array(z.string()),
    blockedAction: z.string().nullable(),
    requiredCapability: z.string().nullable(),
    capabilitySearchResult: z.enum(["not_run", "no_match", "match"]),
    installedCapabilities: z.array(z.string()),
    handoffReason: z.string().nullable(),
    finalAnswer: z.string().nullable(),
    status: taskStatusSchema,
  })
  .strict();

export type TaskState = z.infer<typeof taskStateSchema>;

export function createTaskState(runId: string, goal: string): TaskState {
  return {
    runId,
    originalGoal: goal,
    observations: [],
    completedSteps: [],
    remainingWork: [goal],
    blockedAction: null,
    requiredCapability: null,
    capabilitySearchResult: "not_run",
    installedCapabilities: [],
    handoffReason: null,
    finalAnswer: null,
    status: "running",
  };
}

export class TaskStateStore {
  constructor(readonly filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }

  save(state: TaskState): void {
    const parsed = taskStateSchema.parse(state);
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.filename);
  }

  load(): TaskState {
    if (!fs.existsSync(this.filename)) throw new Error(`Task state not found: ${this.filename}`);
    return taskStateSchema.parse(JSON.parse(fs.readFileSync(this.filename, "utf8")));
  }
}
