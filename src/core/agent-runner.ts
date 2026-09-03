import type {
  AgentEventHandler,
  AgentRunResult,
  ApprovalPolicy,
  ConversationMessage,
  ModelAdapter,
  ModelInputItem,
  ModelResponse,
  ModelToolCall,
  ReasoningSummaryMode,
  ToolCallOutput,
} from "./types.js";
import type { AgentTool, ToolContext, ToolRegistry } from "../tools/types.js";

export const DEFAULT_MAX_STEPS = 100;

const MIN_TOOL_OUTPUT_CHARS = 128;
const TRUNCATION_MARKER = "…[truncated]…";
const MIN_STRUCTURED_STRING_CHARS = 64;
const TRUNCATION_SEARCH_STEPS = 1_000;

type ToolOutputValue =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface JsonLimits {
  maxStringChars: number;
  maxArrayItems: number;
}

interface JsonTruncationCounts {
  truncatedStrings: number;
  omittedStringChars: number;
  truncatedArrays: number;
  omittedArrayItems: number;
}

interface PreparedToolCall {
  index: number;
  call: ModelToolCall;
  tool: AgentTool<any>;
  arguments: unknown;
}

type ToolExecutionOutcome =
  | { prepared: PreparedToolCall; output: ToolCallOutput; ok: true; result: unknown }
  | { prepared: PreparedToolCall; output: ToolCallOutput; ok: false; error: string };

function previewHeadAndTail(value: string, retainedChars: number): string {
  const headChars = Math.ceil(retainedChars / 2);
  const tailChars = Math.floor(retainedChars / 2);
  const head = value.slice(0, headChars);
  const tail = tailChars > 0 ? value.slice(value.length - tailChars) : "";
  return `${head}${TRUNCATION_MARKER}${tail}`;
}

function serializeTruncatedToolOutput(
  value: ToolOutputValue,
  originalOutputChars: number,
  maxChars: number,
): string {
  const payload = value.ok
    ? (JSON.stringify(value.result) ?? "null")
    : value.error;
  let lowerBound = 0;
  let upperBound = Math.min(payload.length, maxChars);
  let bestOutput: string | undefined;

  while (lowerBound <= upperBound) {
    const retainedChars = Math.floor((lowerBound + upperBound) / 2);
    const preview = previewHeadAndTail(payload, retainedChars);
    const omittedPayloadChars = payload.length - retainedChars;
    const truncatedValue = value.ok
      ? {
          ok: true,
          result: preview,
          truncated: true,
          originalOutputChars,
          omittedResultChars: omittedPayloadChars,
        }
      : {
          ok: false,
          error: preview,
          truncated: true,
          originalOutputChars,
          omittedErrorChars: omittedPayloadChars,
        };
    const output = JSON.stringify(truncatedValue);
    if (output.length <= maxChars) {
      bestOutput = output;
      lowerBound = retainedChars + 1;
    } else {
      upperBound = retainedChars - 1;
    }
  }

  if (bestOutput) return bestOutput;
  throw new Error("maxToolOutputChars is too small for truncation metadata.");
}

function measureJson(value: JsonValue, limits: JsonLimits): void {
  if (typeof value === "string") {
    limits.maxStringChars = Math.max(limits.maxStringChars, value.length);
    return;
  }
  if (Array.isArray(value)) {
    limits.maxArrayItems = Math.max(limits.maxArrayItems, value.length);
    for (const item of value) measureJson(item, limits);
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) measureJson(child, limits);
  }
}

function previewWithinLimit(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, maxChars);
  }
  return previewHeadAndTail(value, maxChars - TRUNCATION_MARKER.length);
}

function truncateJson(
  value: JsonValue,
  stringLimit: number,
  arrayLimit: number,
  counts: JsonTruncationCounts,
): JsonValue {
  if (typeof value === "string") {
    if (value.length <= stringLimit) return value;
    counts.truncatedStrings += 1;
    counts.omittedStringChars += value.length - stringLimit;
    return previewWithinLimit(value, stringLimit);
  }
  if (Array.isArray(value)) {
    const retainedItems = Math.min(value.length, arrayLimit);
    if (retainedItems < value.length) {
      counts.truncatedArrays += 1;
      counts.omittedArrayItems += value.length - retainedItems;
    }
    return value.slice(0, retainedItems).map((item) => (
      truncateJson(item, stringLimit, arrayLimit, counts)
    ));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      truncateJson(child, stringLimit, arrayLimit, counts),
    ]));
  }
  return value;
}

function serializeStructuredTruncatedSuccess(
  result: unknown,
  originalOutputChars: number,
  maxChars: number,
): string | undefined {
  const serializedResult = JSON.stringify(result) ?? "null";
  const jsonResult = JSON.parse(serializedResult) as JsonValue;
  const limits: JsonLimits = { maxStringChars: 0, maxArrayItems: 0 };
  measureJson(jsonResult, limits);
  let lowerBound = 0;
  let upperBound = TRUNCATION_SEARCH_STEPS;
  let bestOutput: string | undefined;

  while (lowerBound <= upperBound) {
    const step = Math.floor((lowerBound + upperBound) / 2);
    const ratio = step / TRUNCATION_SEARCH_STEPS;
    const minimumStringLimit = Math.min(
      MIN_STRUCTURED_STRING_CHARS,
      limits.maxStringChars,
    );
    const stringLimit = minimumStringLimit + Math.floor(
      (limits.maxStringChars - minimumStringLimit) * ratio,
    );
    const arrayLimit = Math.floor(limits.maxArrayItems * ratio);
    const counts: JsonTruncationCounts = {
      truncatedStrings: 0,
      omittedStringChars: 0,
      truncatedArrays: 0,
      omittedArrayItems: 0,
    };
    const truncatedResult = truncateJson(jsonResult, stringLimit, arrayLimit, counts);
    const output = JSON.stringify({
      ok: true,
      result: truncatedResult,
      truncated: true,
      originalOutputChars,
      truncation: {
        strategy: "structured",
        ...counts,
      },
    });
    if (output.length <= maxChars) {
      bestOutput = output;
      lowerBound = step + 1;
    } else {
      upperBound = step - 1;
    }
  }

  return bestOutput;
}

function serializeToolOutput(value: ToolOutputValue, maxChars: number): string {
  const output = JSON.stringify(value);
  if (output.length <= maxChars) return output;
  if (value.ok) {
    const structured = serializeStructuredTruncatedSuccess(
      value.result,
      output.length,
      maxChars,
    );
    if (structured) return structured;
  }
  return serializeTruncatedToolOutput(value, output.length, maxChars);
}

export interface AgentRunnerOptions {
  model: ModelAdapter;
  modelName: string;
  instructions: string;
  tools: ToolRegistry;
  toolContext: ToolContext;
  approvalPolicy: ApprovalPolicy;
  maxSteps?: number;
  maxToolOutputChars?: number;
  maxParallelToolCalls?: number;
  reasoningSummary?: ReasoningSummaryMode;
  stream?: boolean;
  onEvent?: AgentEventHandler;
}

export interface AgentRunOptions {
  previousResponseId?: string;
  model?: string;
  history?: ConversationMessage[];
}

export class AgentLimitError extends Error {
  constructor(maxSteps: number) {
    super(`Agent stopped after reaching the ${maxSteps}-step limit.`);
    this.name = "AgentLimitError";
  }
}

export class AgentRunner {
  readonly #options: Required<Pick<
    AgentRunnerOptions,
    "maxSteps" | "maxToolOutputChars" | "maxParallelToolCalls" | "stream"
  >> & Omit<
    AgentRunnerOptions,
    "maxSteps" | "maxToolOutputChars" | "maxParallelToolCalls" | "stream"
  >;

  constructor(options: AgentRunnerOptions) {
    const maxToolOutputChars = options.maxToolOutputChars ?? 20_000;
    if (!Number.isInteger(maxToolOutputChars) || maxToolOutputChars < MIN_TOOL_OUTPUT_CHARS) {
      throw new RangeError(
        `maxToolOutputChars must be an integer of at least ${MIN_TOOL_OUTPUT_CHARS}.`,
      );
    }
    const maxParallelToolCalls = options.maxParallelToolCalls ?? 4;
    if (!Number.isInteger(maxParallelToolCalls) || maxParallelToolCalls < 1 || maxParallelToolCalls > 32) {
      throw new RangeError("maxParallelToolCalls must be an integer from 1 through 32.");
    }
    this.#options = {
      ...options,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
      maxToolOutputChars,
      maxParallelToolCalls,
      stream: options.stream ?? true,
    };
  }

  async run(task: string, runOptions: AgentRunOptions = {}): Promise<AgentRunResult> {
    const taskText = task.trim();
    if (!taskText) {
      throw new Error("Task cannot be empty.");
    }
    if (runOptions.previousResponseId && runOptions.history?.length) {
      throw new Error("previousResponseId and history cannot be used together.");
    }

    await this.#emit({ type: "run_started", task: taskText });
    let input: string | ModelInputItem[] = runOptions.history?.length
      ? [...runOptions.history, { role: "user", content: taskText }]
      : taskText;
    let previousResponseId = runOptions.previousResponseId;
    const modelName = runOptions.model?.trim() || this.#options.modelName;

    for (let step = 1; step <= this.#options.maxSteps; step += 1) {
      let response: ModelResponse;
      try {
        response = await this.#options.model.respond({
          model: modelName,
          instructions: this.#options.instructions,
          input,
          previousResponseId,
          reasoningSummary: this.#options.reasoningSummary,
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
        throw error;
      }
      previousResponseId = response.id;
      await this.#emit({ type: "model_response", step, response });

      if (response.toolCalls.length === 0) {
        const output = response.outputText.trim();
        await this.#emit({ type: "run_completed", steps: step, output });
        return { output, steps: step, responseId: response.id };
      }

      input = this.#isParallelReadBatch(response.toolCalls)
        ? await this.#executeParallelReadBatch(response.toolCalls, step)
        : await this.#executeSequentialBatch(response.toolCalls, step);
    }

    throw new AgentLimitError(this.#options.maxSteps);
  }

  #isParallelReadBatch(calls: ModelToolCall[]): boolean {
    return calls.length > 1 && calls.every((call) => {
      const tool = this.#options.tools.get(call.name);
      return tool?.risk === "read" && tool.executionMode === "parallel";
    });
  }

  async #executeSequentialBatch(calls: ModelToolCall[], step: number): Promise<ToolCallOutput[]> {
    const outputs: ToolCallOutput[] = [];
    for (const call of calls) {
      const tool = this.#options.tools.get(call.name);
      await this.#emit({ type: "tool_requested", step, call, risk: tool?.risk });
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
        const output = this.#toolOutput(call.callId, { ok: true, result });
        await this.#emit({
          type: "tool_completed",
          step,
          callId: call.callId,
          toolName: call.name,
          result,
        });
        outputs.push(output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.#emit({
          type: "tool_failed",
          step,
          callId: call.callId,
          toolName: call.name,
          error: message,
        });
        outputs.push(this.#toolOutput(call.callId, { ok: false, error: message }));
      }
    }
    return outputs;
  }

  async #executeParallelReadBatch(
    calls: ModelToolCall[],
    step: number,
  ): Promise<ToolCallOutput[]> {
    const outputs: Array<ToolCallOutput | undefined> = new Array(calls.length);
    const preparedCalls: PreparedToolCall[] = [];

    // These tools are known, read-only, and explicitly parallel-safe. Parse in
    // model order before starting any work so malformed siblings fail cleanly.
    for (const [index, call] of calls.entries()) {
      const tool = this.#options.tools.get(call.name);
      if (!tool) throw new Error(`Parallel-read preflight lost tool '${call.name}'.`);
      await this.#emit({ type: "tool_requested", step, call, risk: tool.risk });
      try {
        const rawArguments = JSON.parse(call.arguments) as unknown;
        preparedCalls.push({ index, call, tool, arguments: tool.parse(rawArguments) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.#emit({
          type: "tool_failed",
          step,
          callId: call.callId,
          toolName: call.name,
          error: message,
        });
        outputs[index] = this.#toolOutput(call.callId, { ok: false, error: message });
      }
    }

    for (let offset = 0; offset < preparedCalls.length; offset += this.#options.maxParallelToolCalls) {
      const chunk = preparedCalls.slice(offset, offset + this.#options.maxParallelToolCalls);
      const outcomes = await Promise.all(chunk.map((prepared) => this.#executeTool(prepared)));

      // Event handlers stay serialized and results remain in model order even
      // though the underlying read operations in this chunk ran concurrently.
      for (const outcome of outcomes) {
        const { prepared } = outcome;
        if (outcome.ok) {
          await this.#emit({
            type: "tool_completed",
            step,
            callId: prepared.call.callId,
            toolName: prepared.call.name,
            result: outcome.result,
          });
        } else {
          await this.#emit({
            type: "tool_failed",
            step,
            callId: prepared.call.callId,
            toolName: prepared.call.name,
            error: outcome.error,
          });
        }
        outputs[prepared.index] = outcome.output;
      }
    }

    return Array.from(outputs, (output, index) => {
      if (output) return output;
      throw new Error(`Tool call at index ${index} completed without an output.`);
    });
  }

  async #executeTool(prepared: PreparedToolCall): Promise<ToolExecutionOutcome> {
    const { call, tool, arguments: parsedArguments } = prepared;
    try {
      const result = await tool.execute(parsedArguments, this.#options.toolContext);
      return {
        prepared,
        ok: true,
        result,
        output: this.#toolOutput(call.callId, { ok: true, result }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        prepared,
        ok: false,
        error: message,
        output: this.#toolOutput(call.callId, { ok: false, error: message }),
      };
    }
  }

  #toolOutput(callId: string, value: ToolOutputValue): ToolCallOutput {
    return {
      type: "function_call_output",
      call_id: callId,
      output: serializeToolOutput(value, this.#options.maxToolOutputChars),
    };
  }

  async #emit(event: Parameters<NonNullable<AgentRunnerOptions["onEvent"]>>[0]): Promise<void> {
    await this.#options.onEvent?.(event);
  }
}
