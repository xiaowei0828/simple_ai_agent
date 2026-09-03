export interface TraceToolDefinition {
  name: string;
  description: string;
  type?: string;
  strict?: boolean;
  schema: unknown;
}

export interface TraceUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export interface TraceToolResult {
  callId: string;
  rawOutput: string;
  parsedOutput: unknown;
  ok: boolean | null;
  returnedInTurn: number;
}

export interface TraceToolCall {
  callId: string;
  name: string;
  rawArguments: string;
  arguments: unknown;
  result?: TraceToolResult;
}

export interface TraceTurn {
  index: number;
  purpose?: "compaction";
  traceId: string;
  startedAt?: string;
  completedAt?: string;
  endpoint?: string;
  requestModel?: string;
  responseModel?: string;
  previousResponseId?: string;
  responseId?: string;
  requestId?: string | null;
  status?: string;
  httpStatus?: number;
  durationMs?: number;
  userInputs: string[];
  returnedToolResults: TraceToolResult[];
  reasoningSummaries: string[];
  reasoningTexts: string[];
  assistantMessages: string[];
  toolCalls: TraceToolCall[];
  usage: TraceUsage;
  configChanges: string[];
  error?: {
    name: string;
    message: string;
    status?: number;
    body?: unknown;
  };
  rawRequest?: unknown;
  rawResponse?: unknown;
  rawError?: unknown;
}

export interface TraceReport {
  sourceName: string;
  startedAt?: string;
  completedAt?: string;
  endpoint?: string;
  requestModels: string[];
  responseModels: string[];
  instructions: string;
  instructionVariants: number;
  tools: TraceToolDefinition[];
  toolDefinitionVariants: number;
  store?: boolean;
  parallelToolCalls?: boolean;
  turns: TraceTurn[];
  warnings: string[];
  totals: {
    durationMs: number;
    toolCalls: number;
    toolFailures: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
  };
}
