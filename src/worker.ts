import type { ResponseFunctionToolCall, ResponseInput } from "openai/resources/responses/responses";
import { EXPERIMENT_LIMITS } from "./config.js";
import type { OpenAIModelGateway } from "./model-gateway.js";
import { WORKER_SYSTEM_PROMPT } from "./prompts.js";
import type { TaskState, TaskStateStore } from "./task-state.js";
import type { TraceWriter } from "./trace.js";
import type { FunctionTool } from "openai/resources/responses/responses";

export interface WorkerToolHost {
  definitions(): FunctionTool[];
  execute(name: string, input: Record<string, unknown>): Promise<unknown>;
}

function functionCalls(output: unknown[]): ResponseFunctionToolCall[] {
  return output.filter(
    (item): item is ResponseFunctionToolCall =>
      Boolean(item) && typeof item === "object" && (item as { type?: string }).type === "function_call",
  );
}

export class AutonomousWorker {
  constructor(
    private readonly gateway: OpenAIModelGateway,
    private readonly host: WorkerToolHost,
    private readonly state: TaskState,
    private readonly trace: TraceWriter,
    private readonly systemPrompt = WORKER_SYSTEM_PROMPT,
    private readonly stateStore?: TaskStateStore,
  ) {}

  async run(): Promise<TaskState> {
    const startedAt = Date.now();
    this.stateStore?.save(this.state);
    let previousResponseId: string | undefined;
    let input: string | ResponseInput = this.state.originalGoal;
    for (let turn = 1; turn <= EXPERIMENT_LIMITS.maxTurns; turn += 1) {
      if (Date.now() - startedAt > EXPERIMENT_LIMITS.runTimeoutMs) {
        this.state.status = "timed_out";
        break;
      }
      const response = await this.gateway.create({
        model: EXPERIMENT_LIMITS.model,
        reasoning: { effort: EXPERIMENT_LIMITS.reasoningEffort },
        instructions: `${this.systemPrompt}\n\nCurrent task state:\n${JSON.stringify(this.state)}`,
        input,
        tools: this.host.definitions(),
        parallel_tool_calls: false,
        max_output_tokens: EXPERIMENT_LIMITS.maxOutputTokens,
        store: true,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      });
      previousResponseId = response.id;
      const calls = functionCalls(response.output);
      if (calls.length === 0) {
        if (this.state.status === "running") {
          this.state.status = "completed";
          this.state.finalAnswer = response.output_text;
          this.state.remainingWork = [];
        }
        this.trace.record("task.finished", { turn, state: this.state });
        this.stateStore?.save(this.state);
        return this.state;
      }
      const outputs: ResponseInput = [];
      for (const call of calls) {
        let argumentsValue: Record<string, unknown>;
        try {
          argumentsValue = JSON.parse(call.arguments) as Record<string, unknown>;
        } catch {
          argumentsValue = {};
        }
        const result = await this.host.execute(call.name, argumentsValue);
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
        if (this.state.status === "handed_off") {
          this.state.finalAnswer = this.state.handoffReason;
          this.trace.record("task.handed_off", { turn, state: this.state });
          this.stateStore?.save(this.state);
          return this.state;
        }
      }
      input = outputs;
    }
    if (this.state.status === "running") this.state.status = "failed";
    this.trace.record("task.failed", { state: this.state });
    this.stateStore?.save(this.state);
    return this.state;
  }
}
