export interface OpenAIRequestTrace {
  type: "openai.request";
  timestamp: string;
  traceId: string;
  endpoint: string;
  body: unknown;
}

export interface OpenAIResponseTrace {
  type: "openai.response";
  timestamp: string;
  traceId: string;
  requestId: string | null;
  durationMs: number;
  http: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
  };
  body: unknown;
}

export interface OpenAIErrorTrace {
  type: "openai.error";
  timestamp: string;
  traceId: string;
  durationMs: number;
  error: {
    name: string;
    message: string;
    status?: number;
    requestId?: string | null;
    body?: unknown;
    cause?: { name: string; message: string; code?: unknown };
    stack?: string;
  };
}

export interface OpenAIStreamTrace {
  type: "openai.stream";
  timestamp: string;
  traceId: string;
  event: unknown;
}

export type OpenAITraceEntry = OpenAIRequestTrace | OpenAIResponseTrace | OpenAIErrorTrace | OpenAIStreamTrace;

export interface OpenAITraceSink {
  log(entry: OpenAITraceEntry): Promise<void>;
}
