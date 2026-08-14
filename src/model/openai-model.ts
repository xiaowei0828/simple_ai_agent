import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type {
  FunctionTool,
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../core/types.js";
import type { OpenAITraceSink } from "../logging/openai-trace.js";

export interface OpenAIModelOptions {
  apiKey?: string;
  baseURL?: string;
  client?: OpenAI;
  traceSink?: OpenAITraceSink;
}

export class OpenAIModel implements ModelAdapter {
  readonly #client: OpenAI;
  readonly #traceSink?: OpenAITraceSink;
  readonly #endpoint: string;

  constructor(options: OpenAIModelOptions = {}) {
    this.#client = options.client ?? new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
    this.#traceSink = options.traceSink;
    this.#endpoint = createLoggableEndpoint(this.#client.baseURL);
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const input = typeof request.input === "string"
      ? request.input
      : request.input as ResponseInputItem[];

    const body: ResponseCreateParamsNonStreaming = {
      model: request.model,
      instructions: request.instructions,
      input,
      previous_response_id: request.previousResponseId,
      tools: request.tools as FunctionTool[],
      parallel_tool_calls: false,
      store: true,
    };
    const traceId = randomUUID();
    await this.#traceSink?.log({
      type: "openai.request",
      timestamp: new Date().toISOString(),
      traceId,
      endpoint: this.#endpoint,
      body,
    });

    const startedAt = performance.now();
    let result: {
      data: OpenAIResponse;
      response: globalThis.Response;
      request_id: string | null;
    };
    try {
      result = await this.#client.responses.create(body).withResponse();
    } catch (error) {
      await this.#traceSink?.log({
        type: "openai.error",
        timestamp: new Date().toISOString(),
        traceId,
        durationMs: Math.round(performance.now() - startedAt),
        error: serializeError(error),
      });
      throw error;
    }

    const durationMs = Math.round(performance.now() - startedAt);
    await this.#traceSink?.log({
      type: "openai.response",
      timestamp: new Date().toISOString(),
      traceId,
      requestId: result.request_id,
      durationMs,
      http: {
        status: result.response.status,
        statusText: result.response.statusText,
        headers: safeResponseHeaders(result.response.headers),
      },
      body: result.data,
    });

    const response = result.data;

    return {
      id: response.id,
      outputText: response.output_text,
      toolCalls: response.output
        .filter((item) => item.type === "function_call")
        .map((item) => ({
          callId: item.call_id,
          name: item.name,
          arguments: item.arguments,
        })),
    };
  }
}

function createLoggableEndpoint(baseURL: string): string {
  const url = new URL(baseURL);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/responses`;
  return url.toString();
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
  const sensitiveName = /^(?:authorization|cookie|set-cookie|proxy-authorization)$/i;
  return Object.fromEntries(
    [...headers.entries()].filter(([name]) => !sensitiveName.test(name)),
  );
}

function serializeError(error: unknown): {
  name: string;
  message: string;
  status?: number;
  requestId?: string | null;
  body?: unknown;
} {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }

  const details = error as Error & {
    status?: unknown;
    request_id?: unknown;
    error?: unknown;
  };
  return {
    name: error.name,
    message: error.message,
    ...(typeof details.status === "number" ? { status: details.status } : {}),
    ...(typeof details.request_id === "string" || details.request_id === null
      ? { requestId: details.request_id }
      : {}),
    ...(details.error === undefined ? {} : { body: details.error }),
  };
}
