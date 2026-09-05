import { MIN_TRUNCATED_TOOL_OUTPUT_CHARS, serializeToolOutput, type ToolOutputValue } from "./tool-output.js";
import type {
  AgentEvent,
  AgentEventHandler,
  AgentRunResult,
  ApprovalPolicy,
  CompactionResult,
  CompactionSettings,
  ContextUsage,
  ModelAdapter,
  ModelInputItem,
  ModelResponse,
  ModelToolCall,
  ReasoningEffort,
  ToolCallOutput,
} from "./types.js";
import type { ToolContext, ToolRegistry } from "../tools/types.js";
import {
  compactContext, contextInput, contextTokens, resolveCompactionSettings,
  retainedHistoryStart, responseContextUsage, responseInputItems,
} from "./context-compaction.js";

export const DEFAULT_MAX_STEPS = 300;

const MIN_TOOL_OUTPUT_CHARS = 128;
export interface AgentRunnerOptions {
  model: ModelAdapter;
  modelName: string;
  instructions: string;
  tools: ToolRegistry;
  toolContext: ToolContext;
  approvalPolicy: ApprovalPolicy;
  maxSteps?: number;
  maxToolOutputChars?: number;
  maxToolOutputCharsPerStep?: number;
  reasoningEffort?: ReasoningEffort;
  stream?: boolean;
  onEvent?: AgentEventHandler;
  contextWindow?: (model: string) => number | undefined;
}

export interface AgentRunOptions {
  reasoningEffort?: ReasoningEffort;
  previousResponseId?: string;
  /** Input that failed immediately after previousResponseId and can be retried once. */
  pendingInput?: string | ModelInputItem[];
  model?: string;
  /** Local mirror of active history. With a live response ID, only the new input is sent. */
  history?: ModelInputItem[];
  summary?: string;
  contextUsage?: ContextUsage;
}

export interface AgentContinuation {
  previousResponseId: string;
  pendingInput: string | ModelInputItem[];
}

/** A failed model request carrying one provider-independent retry checkpoint. */
export class AgentResponseError extends Error {
  readonly continuation: AgentContinuation;

  constructor(error: unknown, continuation: AgentContinuation) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "AgentResponseError";
    this.continuation = continuation;
  }
}

export class AgentLimitError extends Error {
  constructor(maxSteps: number) {
    super(`Agent stopped after reaching the ${maxSteps}-step limit.`);
    this.name = "AgentLimitError";
  }
}

export class AgentRunner {
  readonly #options: AgentRunnerOptions & Required<Pick<
    AgentRunnerOptions,
    "maxSteps" | "maxToolOutputChars" | "maxToolOutputCharsPerStep" | "stream"
  >>;

  constructor(options: AgentRunnerOptions) {
    const maxToolOutputChars = options.maxToolOutputChars ?? 20_000;
    const maxToolOutputCharsPerStep = options.maxToolOutputCharsPerStep
      ?? maxToolOutputChars;
    if (!Number.isInteger(maxToolOutputChars) || maxToolOutputChars < MIN_TOOL_OUTPUT_CHARS) {
      throw new RangeError(
        `maxToolOutputChars must be an integer of at least ${MIN_TOOL_OUTPUT_CHARS}.`,
      );
    }
    if (
      !Number.isInteger(maxToolOutputCharsPerStep)
      || maxToolOutputCharsPerStep < MIN_TOOL_OUTPUT_CHARS
    ) {
      throw new RangeError(
        `maxToolOutputCharsPerStep must be an integer of at least ${MIN_TOOL_OUTPUT_CHARS}.`,
      );
    }
    this.#options = {
      ...options,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
      maxToolOutputChars,
      maxToolOutputCharsPerStep,
      stream: options.stream ?? true,
    };
  }

  async run(task: string, runOptions: AgentRunOptions = {}): Promise<AgentRunResult> {
    const taskText = task.trim();
    if (!taskText) {
      throw new Error("Task cannot be empty.");
    }
    if (runOptions.pendingInput !== undefined && !runOptions.previousResponseId) {
      throw new Error("pendingInput requires previousResponseId.");
    }
    await this.#emit({ type: "run_started", task: taskText });
    let history: ModelInputItem[] = [...runOptions.history ?? [], { role: "user", content: taskText }];
    let summary = runOptions.summary;
    let usage = runOptions.contextUsage;
    const pendingInput = runOptions.pendingInput;
    const isContinuationAttempt = pendingInput !== undefined;
    let input: string | ModelInputItem[];
    if (runOptions.previousResponseId && pendingInput !== undefined) {
      const pendingItems = typeof pendingInput === "string"
        ? [{ role: "user" as const, content: pendingInput }]
        : pendingInput;
      input = [...pendingItems, { role: "user", content: taskText }];
    } else if (!runOptions.previousResponseId && (runOptions.history?.length || summary)) {
      input = contextInput(history, summary);
    } else {
      input = taskText;
    }
    let previousResponseId = runOptions.previousResponseId;
    const modelName = runOptions.model?.trim() || this.#options.modelName;
    const settings = this.#settings(modelName);
    const reasoningEffort = runOptions.reasoningEffort ?? this.#options.reasoningEffort;
    if (settings && previousResponseId && !runOptions.history) {
      throw new Error("Automatic compaction requires local history alongside a live response ID.");
    }

    for (let step = 1; step <= this.#options.maxSteps; step += 1) {
      if (settings && this.#contextTokens(history, summary, usage) >= settings.triggerTokens) {
        const result = await this.#compact(modelName, history, summary, usage, settings, step, "threshold", reasoningEffort);
        if (!result) throw new Error("Context exceeds the token budget, but no older complete message group can be summarized.");
        history = result.replacementHistory;
        summary = result.summary;
        usage = undefined;
        previousResponseId = undefined;
        input = contextInput(history, summary);
      }
      await this.#emit({ type: "model_requested", step, model: modelName });
      let response: ModelResponse;
      try {
        response = await this.#options.model.respond({
          model: modelName,
          instructions: this.#options.instructions,
          input,
          previousResponseId,
          reasoningSummary: "auto",
          reasoningEffort,
          stream: this.#options.stream,
          onStreamEvent: this.#options.stream
            ? async (event) => {
                await this.#emit(event.type === "output_text_delta"
                  ? { type: "model_output_delta", step, delta: event.delta }
                  : { type: "model_reasoning_delta", step, delta: event.delta });
              }
            : undefined,
          tools: this.#options.tools.definitions(),
        });
      } catch (error) {
        await this.#emit({ type: "model_response_failed", step });
        const continuation = previousResponseId && !(isContinuationAttempt && step === 1)
          ? {
              previousResponseId,
              pendingInput: typeof input === "string" ? input : [...input],
            }
          : undefined;
        if (continuation) throw new AgentResponseError(error, continuation);
        throw error;
      }
      previousResponseId = response.id;
      history.push(...responseInputItems(response));
      usage = responseContextUsage(response, history.length) ?? usage;
      await this.#emit({
        type: "model_response", step, response,
        context: {
          tokens: this.#contextTokens(history, summary, usage),
          ...(settings ? { contextWindow: settings.contextWindow, triggerTokens: settings.triggerTokens } : {}),
        },
      });

      if (response.status !== undefined && response.status !== "completed") {
        throw new Error(`Model response was not completed (status=${response.status}, reason=${response.incompleteDetails?.reason ?? "unknown"}). Partial output was preserved.`);
      }

      if (response.toolCalls.length === 0) {
        const output = response.outputText.trim();
        await this.#emit({ type: "run_completed", steps: step, output });
        return { output, steps: step, responseId: response.id };
      }

      input = await this.#executeTools(response.toolCalls, step);
      history.push(...input);
    }

    throw new AgentLimitError(this.#options.maxSteps);
  }

  async compact(options: AgentRunOptions, customInstructions?: string): Promise<CompactionResult | undefined> {
    const model = options.model?.trim() || this.#options.modelName;
    const settings = this.#settings(model);
    if (!settings) throw new Error("Set this model's contextWindow in .config/config.json before compacting.");
    return this.#compact(model, options.history ?? [], options.summary, options.contextUsage, settings, 0, "manual", options.reasoningEffort ?? this.#options.reasoningEffort, customInstructions);
  }

  #settings(model: string): CompactionSettings | undefined {
    const contextWindow = this.#options.contextWindow?.(model);
    return contextWindow === undefined ? undefined : resolveCompactionSettings(contextWindow);
  }

  #contextTokens(history: ModelInputItem[], summary?: string, usage?: ContextUsage): number {
    return contextTokens(history, summary, this.#options.instructions, this.#options.tools.definitions(), usage);
  }

  async #compact(
    model: string, history: ModelInputItem[], summary: string | undefined, usage: ContextUsage | undefined,
    settings: CompactionSettings, step: number, reason: "manual" | "threshold", reasoningEffort?: ReasoningEffort, customInstructions?: string,
  ): Promise<CompactionResult | undefined> {
    if (retainedHistoryStart(history, settings.keepRecentTokens) === 0) return undefined;
    const tokensBefore = this.#contextTokens(history, summary, usage);
    await this.#emit({ type: "compaction_started", step, reason, tokensBefore });
    try {
      const result = await compactContext({
        model: this.#options.model, modelName: model, history, summary, settings,
        instructions: this.#options.instructions, tools: this.#options.tools.definitions(),
        reasoningEffort,
        customInstructions, tokensBefore,
      });
      if (result) await this.#emit({ type: "compaction_completed", step, result });
      return result;
    } catch (error) {
      await this.#emit({ type: "compaction_failed", step, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async #executeTools(calls: ModelToolCall[], step: number): Promise<ToolCallOutput[]> {
    const outputs: ToolCallOutput[] = [];
    // A function_call_output is required for every call. If the configured
    // budget cannot fit those minimal envelopes, preserve protocol pairing
    // and omit optional result details instead of failing the whole step.
    let remainingOutputChars = Math.max(
      this.#options.maxToolOutputCharsPerStep,
      calls.length * MIN_TRUNCATED_TOOL_OUTPUT_CHARS,
    );
    for (const [index, call] of calls.entries()) {
      const remainingCalls = calls.length - index;
      const outputBudget = Math.min(
        this.#options.maxToolOutputChars,
        Math.floor(remainingOutputChars / remainingCalls),
      );
      const tool = this.#options.tools.get(call.name);
      await this.#emit({ type: "tool_requested", step, call, risk: tool?.risk });
      if (!tool) {
        const output = this.#toolOutput(call.callId, {
          ok: false,
          error: `Unknown tool: ${call.name}`,
        }, outputBudget);
        await this.#recordToolOutput(outputs, step, output);
        remainingOutputChars -= output.output.length;
        continue;
      }

      let value: ToolOutputValue;
      let completionEvent: AgentEvent | undefined;
      try {
        const rawArguments = JSON.parse(call.arguments) as unknown;
        const parsed = tool.parse(rawArguments);
        const parsedArguments = tool.prepare
          ? await tool.prepare(parsed, this.#options.toolContext)
          : parsed;
        const approvalRequest = { toolName: call.name, risk: tool.risk, arguments: parsedArguments } as const;
        await this.#emit({ type: "approval_requested", step, request: approvalRequest });
        const approved = await this.#options.approvalPolicy.approve(approvalRequest);
        if (!approved) {
          value = { ok: false, error: "User denied this tool call." };
        } else {
          const result = await tool.execute(parsedArguments, this.#options.toolContext);
          value = { ok: true, result };
          completionEvent = { type: "tool_completed", step, callId: call.callId, toolName: call.name, result };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        value = { ok: false, error: message };
        completionEvent = { type: "tool_failed", step, callId: call.callId, toolName: call.name, error: message };
      }
      // Serialization, persistence, and reporting errors stop the run without changing the action's outcome.
      const output = this.#toolOutput(call.callId, value, outputBudget);
      await this.#recordToolOutput(outputs, step, output);
      if (completionEvent) await this.#emit(completionEvent);
      remainingOutputChars -= output.output.length;
    }
    return outputs;
  }

  async #recordToolOutput(outputs: ToolCallOutput[], step: number, output: ToolCallOutput): Promise<void> {
    await this.#emit({ type: "tool_output", step, output });
    outputs.push(output);
  }

  #toolOutput(callId: string, value: ToolOutputValue, maxChars: number): ToolCallOutput {
    return {
      type: "function_call_output",
      call_id: callId,
      output: serializeToolOutput(value, maxChars),
    };
  }

  async #emit(event: AgentEvent): Promise<void> {
    await this.#options.onEvent?.(event);
  }
}
