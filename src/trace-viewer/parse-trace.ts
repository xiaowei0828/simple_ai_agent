import type {
  TraceReport,
  TraceToolCall,
  TraceToolDefinition,
  TraceToolResult,
  TraceTurn,
  TraceUsage,
} from "./types.js";
import { projectSessionTrace, type ParsedTraceEntry } from "./session-trace.js";

type JsonObject = Record<string, unknown>;

interface ComparableConfig {
  endpoint?: string;
  model?: string;
  instructions: string;
  tools: TraceToolDefinition[];
  store?: boolean;
  parallelToolCalls?: boolean;
}

const EMPTY_USAGE: TraceUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
};

export function parseOpenAITraceJsonl(jsonl: string, sourceName = "OpenAI trace"): TraceReport {
  const warnings: string[] = [];
  const entries = projectSessionTrace(parseEntries(jsonl, warnings));
  const turnByTraceId = new Map<string, TraceTurn>();
  const turns: TraceTurn[] = [];

  let firstInstructions = "";
  let firstTools: TraceToolDefinition[] = [];
  let firstEndpoint: string | undefined;
  let previousConfigValue: ComparableConfig | undefined;
  let store: boolean | undefined;
  let parallelToolCalls: boolean | undefined;

  const instructionVariants = new Set<string>();
  const toolVariants = new Set<string>();
  const requestModels = new Set<string>();
  const responseModels = new Set<string>();

  const getTurn = (traceId: string): TraceTurn => {
    const existing = turnByTraceId.get(traceId);
    if (existing) return existing;

    const turn: TraceTurn = {
      index: turns.length + 1,
      traceId,
      userInputs: [],
      returnedToolResults: [],
      reasoningSummaries: [],
      reasoningTexts: [],
      assistantMessages: [],
      toolCalls: [],
      usage: { ...EMPTY_USAGE },
      configChanges: [],
    };
    turns.push(turn);
    turnByTraceId.set(traceId, turn);
    return turn;
  };

  for (const entry of entries) {
    const type = asString(entry.value.type);
    const traceId = asString(entry.value.traceId);
    if (!traceId) {
      warnings.push(`第 ${entry.lineNumber} 行缺少 traceId，已忽略。`);
      continue;
    }

    const turn = getTurn(traceId);
    if (type === "session.tool_output") {
      turn.returnedToolResults.push(...extractToolResults([entry.value.output], turn.index));
      continue;
    }
    if (type === "openai.request") {
      const body = asObject(entry.value.body) ?? {};
      turn.startedAt = asString(entry.value.timestamp);
      turn.endpoint = asString(entry.value.endpoint);
      turn.requestModel = asString(body.model);
      turn.previousResponseId = asString(body.previous_response_id);
      turn.rawRequest = asObject(entry.value.originalEntry) ?? entry.value;
      const displayInput = entry.value.sessionInput ?? body.input;
      turn.userInputs = extractUserInputs(displayInput);
      turn.returnedToolResults = extractToolResults(displayInput, turn.index);

      const instructions = asString(body.instructions) ?? "";
      const definitions = extractToolDefinitions(body.tools);
      const toolKey = stableStringify(body.tools ?? []);
      instructionVariants.add(instructions);
      toolVariants.add(toolKey);

      if (firstInstructions === "" && instructions !== "") firstInstructions = instructions;
      if (firstTools.length === 0 && definitions.length > 0) firstTools = definitions;
      firstEndpoint ??= turn.endpoint;
      if (turn.requestModel) requestModels.add(turn.requestModel);
      if (typeof body.store === "boolean" && store === undefined) store = body.store;
      if (typeof body.parallel_tool_calls === "boolean" && parallelToolCalls === undefined) {
        parallelToolCalls = body.parallel_tool_calls;
      }

      const currentConfig: ComparableConfig = {
        endpoint: turn.endpoint,
        model: turn.requestModel,
        instructions,
        tools: definitions,
        store: typeof body.store === "boolean" ? body.store : undefined,
        parallelToolCalls:
          typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : undefined,
      };
      if (previousConfigValue) {
        turn.configChanges = describeConfigChanges(previousConfigValue, currentConfig);
      }
      previousConfigValue = currentConfig;
      continue;
    }

    if (type === "openai.response") {
      const body = asObject(entry.value.body) ?? {};
      turn.completedAt = asString(entry.value.timestamp);
      turn.requestId = asString(entry.value.requestId) ?? null;
      turn.durationMs = asNumber(entry.value.durationMs);
      turn.rawResponse = asObject(entry.value.originalEntry) ?? entry.value;
      turn.responseId = asString(body.id);
      turn.responseModel = asString(body.model);
      turn.status = asString(body.status);
      turn.httpStatus = asNumber(asObject(entry.value.http)?.status);
      turn.reasoningSummaries = extractReasoningSummaries(body.output);
      turn.reasoningTexts = extractReasoningTexts(body.output);
      turn.assistantMessages = extractAssistantMessages(body.output, body.output_text);
      turn.toolCalls = extractToolCalls(body.output);
      turn.usage = extractUsage(body.usage);
      if (turn.responseModel) responseModels.add(turn.responseModel);
      continue;
    }

    if (type === "openai.error") {
      const error = asObject(entry.value.error) ?? {};
      turn.completedAt = asString(entry.value.timestamp);
      turn.durationMs = asNumber(entry.value.durationMs);
      turn.rawError = asObject(entry.value.originalEntry) ?? entry.value;
      turn.error = {
        name: asString(error.name) ?? "Error",
        message: asString(error.message) ?? "未知模型请求错误",
        status: asNumber(error.status),
        body: error.body,
      };
      continue;
    }

    warnings.push(`第 ${entry.lineNumber} 行包含未知类型 ${JSON.stringify(type)}，已忽略。`);
  }

  attachToolResults(turns, warnings);
  const totals = calculateTotals(turns);

  return {
    sourceName,
    startedAt: turns.find((turn) => turn.startedAt)?.startedAt,
    completedAt: [...turns].reverse().find((turn) => turn.completedAt)?.completedAt,
    endpoint: firstEndpoint,
    requestModels: [...requestModels],
    responseModels: [...responseModels],
    instructions: firstInstructions,
    instructionVariants: instructionVariants.size,
    tools: firstTools,
    toolDefinitionVariants: toolVariants.size,
    store,
    parallelToolCalls,
    turns,
    warnings,
    totals,
  };
}

function parseEntries(jsonl: string, warnings: string[]): ParsedTraceEntry[] {
  const entries: ParsedTraceEntry[] = [];
  for (const [index, line] of jsonl.split(/\r?\n/u).entries()) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      const object = asObject(value);
      if (!object) {
        warnings.push(`第 ${index + 1} 行不是 JSON 对象，已忽略。`);
        continue;
      }
      entries.push({ lineNumber: index + 1, value: object });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`第 ${index + 1} 行不是有效 JSON，已忽略：${message}`);
    }
  }
  return entries;
}

function extractUserInputs(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (!Array.isArray(input)) return [];

  const results: string[] = [];
  for (const item of input) {
    const object = asObject(item);
    if (!object || object.type === "function_call_output") continue;

    if (object.type === "input_text" && typeof object.text === "string") {
      results.push(object.text);
      continue;
    }

    if (object.type === "message" || object.role === "user") {
      results.push(...extractTextContent(object.content));
    }
  }
  return results;
}

function extractToolResults(input: unknown, returnedInTurn: number): TraceToolResult[] {
  if (!Array.isArray(input)) return [];
  const results: TraceToolResult[] = [];
  for (const item of input) {
    const object = asObject(item);
    if (!object || object.type !== "function_call_output") continue;
    const callId = asString(object.call_id);
    if (!callId) continue;
    const rawOutput = typeof object.output === "string" ? object.output : stableStringify(object.output);
    const parsedOutput = parseJsonIfPossible(rawOutput);
    const outputObject = asObject(parsedOutput);
    results.push({
      callId,
      rawOutput,
      parsedOutput,
      ok: typeof outputObject?.ok === "boolean" ? outputObject.ok : null,
      returnedInTurn,
    });
  }
  return results;
}

function extractToolDefinitions(tools: unknown): TraceToolDefinition[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    const object = asObject(tool);
    const name = asString(object?.name);
    if (!object || !name) return [];
    return [
      {
        name,
        description: asString(object.description) ?? "",
        type: asString(object.type),
        strict: typeof object.strict === "boolean" ? object.strict : undefined,
        schema: object.parameters,
      },
    ];
  });
}

function extractReasoningSummaries(output: unknown): string[] {
  if (!Array.isArray(output)) return [];
  const summaries: string[] = [];
  for (const item of output) {
    const object = asObject(item);
    if (!object || object.type !== "reasoning" || !Array.isArray(object.summary)) continue;
    for (const summary of object.summary) {
      const text = asString(asObject(summary)?.text);
      if (text) summaries.push(text);
    }
  }
  return summaries;
}

function extractReasoningTexts(output: unknown): string[] {
  if (!Array.isArray(output)) return [];
  const reasoningTexts: string[] = [];
  for (const item of output) {
    const object = asObject(item);
    if (!object || object.type !== "reasoning" || !Array.isArray(object.content)) continue;
    for (const content of object.content) {
      const contentObject = asObject(content);
      if (contentObject?.type !== "reasoning_text") continue;
      const text = asString(contentObject.text);
      if (text) reasoningTexts.push(text);
    }
  }
  return reasoningTexts;
}

function extractAssistantMessages(output: unknown, outputText: unknown): string[] {
  const messages: string[] = [];
  if (Array.isArray(output)) {
    for (const item of output) {
      const object = asObject(item);
      if (!object || object.type !== "message") continue;
      messages.push(...extractTextContent(object.content));
    }
  }
  if (messages.length === 0 && typeof outputText === "string" && outputText !== "") {
    messages.push(outputText);
  }
  return messages;
}

function extractTextContent(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (typeof part === "string") return [part];
    const object = asObject(part);
    const text = asString(object?.text);
    return text ? [text] : [];
  });
}

function extractToolCalls(output: unknown): TraceToolCall[] {
  if (!Array.isArray(output)) return [];
  return output.flatMap((item) => {
    const object = asObject(item);
    if (!object || object.type !== "function_call") return [];
    const callId = asString(object.call_id);
    const name = asString(object.name);
    if (!callId || !name) return [];
    const rawArguments =
      typeof object.arguments === "string" ? object.arguments : stableStringify(object.arguments ?? {});
    return [
      {
        callId,
        name,
        rawArguments,
        arguments: parseJsonIfPossible(rawArguments),
      },
    ];
  });
}

function extractUsage(usage: unknown): TraceUsage {
  const object = asObject(usage) ?? {};
  return {
    inputTokens: asNumber(object.input_tokens) ?? 0,
    outputTokens: asNumber(object.output_tokens) ?? 0,
    totalTokens: asNumber(object.total_tokens) ?? 0,
    cachedTokens: asNumber(asObject(object.input_tokens_details)?.cached_tokens) ?? 0,
    reasoningTokens: asNumber(asObject(object.output_tokens_details)?.reasoning_tokens) ?? 0,
  };
}

function attachToolResults(turns: TraceTurn[], warnings: string[]): void {
  const calls = new Map<string, TraceToolCall>();
  for (const turn of turns) {
    for (const call of turn.toolCalls) calls.set(call.callId, call);
  }
  for (const turn of turns) {
    for (const result of turn.returnedToolResults) {
      const call = calls.get(result.callId);
      if (call) call.result = result;
      else warnings.push(`第 ${turn.index} 轮返回了无法匹配调用的工具结果：${result.callId}`);
    }
  }
}

function calculateTotals(turns: TraceTurn[]): TraceReport["totals"] {
  return turns.reduce<TraceReport["totals"]>(
    (totals, turn) => {
      totals.durationMs += turn.durationMs ?? 0;
      totals.toolCalls += turn.toolCalls.length;
      totals.toolFailures += turn.toolCalls.filter((call) => call.result?.ok === false).length;
      totals.errors += turn.error ? 1 : 0;
      totals.inputTokens += turn.usage.inputTokens;
      totals.outputTokens += turn.usage.outputTokens;
      totals.totalTokens += turn.usage.totalTokens;
      totals.cachedTokens += turn.usage.cachedTokens;
      totals.reasoningTokens += turn.usage.reasoningTokens;
      return totals;
    },
    {
      durationMs: 0,
      toolCalls: 0,
      toolFailures: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    },
  );
}

function describeConfigChanges(base: ComparableConfig, current: ComparableConfig): string[] {
  const changes: string[] = [];
  if (base.endpoint !== current.endpoint) changes.push("API endpoint 发生变化");
  if (base.model !== current.model) changes.push("请求模型发生变化");
  if (base.instructions !== current.instructions) changes.push("instructions 发生变化");
  if (stableStringify(base.tools) !== stableStringify(current.tools)) changes.push("工具定义发生变化");
  if (base.store !== current.store) changes.push("store 设置发生变化");
  if (base.parallelToolCalls !== current.parallelToolCalls) changes.push("并行工具调用设置发生变化");
  return changes;
}

function parseJsonIfPossible(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  const object = asObject(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, sortObject(object[key])]),
  );
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
