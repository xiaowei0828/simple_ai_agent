import type {
  AgentEventHandler,
  AgentRunResult,
  ApprovalPolicy,
  ModelAdapter,
  ToolCallOutput,
} from "./types.js";
import type { ToolContext, ToolRegistry } from "../tools/types.js";

export const DEFAULT_MAX_STEPS = 50;

export interface AgentRunnerOptions {
  model: ModelAdapter;
  modelName: string;
  instructions: string;
  tools: ToolRegistry;
  toolContext: ToolContext;
  approvalPolicy: ApprovalPolicy;
  maxSteps?: number;
  maxToolOutputChars?: number;
  onEvent?: AgentEventHandler;
}

export interface AgentRunOptions {
  previousResponseId?: string;
}

export class AgentLimitError extends Error {
  constructor(maxSteps: number) {
    super(`Agent stopped after reaching the ${maxSteps}-step limit.`);
    this.name = "AgentLimitError";
  }
}

export class AgentRunner {
  readonly #options: Required<Pick<AgentRunnerOptions, "maxSteps" | "maxToolOutputChars">> &
    Omit<AgentRunnerOptions, "maxSteps" | "maxToolOutputChars">;

  constructor(options: AgentRunnerOptions) {
    this.#options = {
      ...options,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
      maxToolOutputChars: options.maxToolOutputChars ?? 20_000,
    };
  }

  async run(task: string, runOptions: AgentRunOptions = {}): Promise<AgentRunResult> {
    const taskText = task.trim();
    if (!taskText) {
      throw new Error("Task cannot be empty.");
    }

    await this.#emit({ type: "run_started", task: taskText });
    let input: string | ToolCallOutput[] = taskText;
    let previousResponseId = runOptions.previousResponseId;

    for (let step = 1; step <= this.#options.maxSteps; step += 1) {
      const response = await this.#options.model.respond({
        model: this.#options.modelName,
        instructions: this.#options.instructions,
        input,
        previousResponseId,
        tools: this.#options.tools.definitions(),
      });
      previousResponseId = response.id;
      await this.#emit({ type: "model_response", step, response });

      if (response.toolCalls.length === 0) {
        const output = response.outputText.trim();
        await this.#emit({ type: "run_completed", steps: step, output });
        return { output, steps: step, responseId: response.id };
      }

      const outputs: ToolCallOutput[] = [];
      for (const call of response.toolCalls) {
        const tool = this.#options.tools.get(call.name);
        await this.#emit({
          type: "tool_requested",
          step,
          call,
          risk: tool?.risk,
        });

        if (!tool) {
          outputs.push(this.#toolOutput(call.callId, {
            ok: false,
            error: `Unknown tool: ${call.name}`,
          }));
          continue;
        }

        try {
          const rawArguments = JSON.parse(call.arguments) as unknown;
          const parsedArguments = tool.parse(rawArguments);

          if (tool.risk !== "read") {
            const approvalRequest = {
              toolName: call.name,
              risk: tool.risk,
              arguments: parsedArguments,
            } as const;
            await this.#emit({ type: "approval_requested", step, request: approvalRequest });
            const approved = await this.#options.approvalPolicy.approve(approvalRequest);
            if (!approved) {
              outputs.push(this.#toolOutput(call.callId, {
                ok: false,
                error: "User denied this tool call.",
              }));
              continue;
            }
          }

          const result = await tool.execute(parsedArguments, this.#options.toolContext);
          await this.#emit({ type: "tool_completed", step, toolName: call.name, result });
          outputs.push(this.#toolOutput(call.callId, { ok: true, result }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.#emit({ type: "tool_failed", step, toolName: call.name, error: message });
          outputs.push(this.#toolOutput(call.callId, { ok: false, error: message }));
        }
      }

      input = outputs;
    }

    throw new AgentLimitError(this.#options.maxSteps);
  }

  #toolOutput(callId: string, value: unknown): ToolCallOutput {
    let output = JSON.stringify(value);
    if (output.length > this.#options.maxToolOutputChars) {
      output = `${output.slice(0, this.#options.maxToolOutputChars)}\n…[truncated]`;
    }
    return { type: "function_call_output", call_id: callId, output };
  }

  async #emit(event: Parameters<NonNullable<AgentRunnerOptions["onEvent"]>>[0]): Promise<void> {
    await this.#options.onEvent?.(event);
  }
}
