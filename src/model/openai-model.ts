import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type {
  FunctionTool,
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../core/types.js";
import { PreviousResponseUnavailableError } from "../core/errors.js";
import type { OpenAITraceSink } from "../logging/openai-trace.js";

export interface OpenAIModelOptions {
  apiKey?: string;
  baseURL?: string;
  client?: OpenAI;
  /**
   * Extra retries for a response body that ends before a usable response is
   * available. Connection and response-header retries remain owned by the SDK.
   * Defaults to 1 and accepts values from 0 through 3.
   */
  maxTransportRetries?: number;
  parallelToolCalls?: boolean;
  traceSink?: OpenAITraceSink;
}

interface CompletedResponseWithHttp {
  data: OpenAIResponse;
  response: globalThis.Response;
  request_id: string | null;
}

export class OpenAIModel implements ModelAdapter {
  readonly #client: OpenAI;
  readonly #maxTransportRetries: number;
  readonly #parallelToolCalls: boolean;
  readonly #traceSink?: OpenAITraceSink;
  readonly #endpoint: string;
  readonly #reasoningSummaryUnsupportedModels = new Set<string>();

  constructor(options: OpenAIModelOptions = {}) {
    const maxTransportRetries = options.maxTransportRetries ?? 1;
    if (
      !Number.isInteger(maxTransportRetries)
      || maxTransportRetries < 0
      || maxTransportRetries > 3
    ) {
      throw new RangeError("maxTransportRetries must be an integer from 0 through 3.");
    }
    this.#client = options.client ?? new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
    this.#maxTransportRetries = maxTransportRetries;
    this.#parallelToolCalls = options.parallelToolCalls ?? true;
    this.#traceSink = options.traceSink;
    this.#endpoint = createLoggableEndpoint(this.#client.baseURL);
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    if (!request.reasoningSummary || this.#reasoningSummaryUnsupportedModels.has(request.model)) {
      return this.#respondWithTransportRetry({ ...request, reasoningSummary: undefined });
    }

    try {
      return await this.#respondWithTransportRetry(request);
    } catch (error) {
      if (!isReasoningSummaryUnsupported(error)) throw error;
      this.#reasoningSummaryUnsupportedModels.add(request.model);
      const response = await this.#respondWithTransportRetry({
        ...request,
        reasoningSummary: undefined,
      });
      return { ...response, reasoningSummaryUnavailable: true };
    }
  }

  async #respondWithTransportRetry(request: ModelRequest): Promise<ModelResponse> {
    for (let attempt = 0; ; attempt += 1) {
      let streamProgressSeen = false;
      const attemptRequest = request.stream
        ? {
            ...request,
            onStreamEvent: async (event: Parameters<NonNullable<ModelRequest["onStreamEvent"]>>[0]) => {
              // Once any user-visible delta escapes this adapter, replaying the
              // request could duplicate or fork the displayed response.
              streamProgressSeen = true;
              await request.onStreamEvent?.(event);
            },
          }
        : request;
      try {
        return await this.#respondOnce(attemptRequest);
      } catch (error) {
        const retriesRemain = attempt < this.#maxTransportRetries;
        const retryIsSafe = !request.stream || !streamProgressSeen;
        if (!retriesRemain || !retryIsSafe || !isRetryableTransportError(error)) {
          throw error;
        }
      }
    }
  }

  async #respondOnce(request: ModelRequest): Promise<ModelResponse> {
    const input = typeof request.input === "string"
      ? request.input
      : request.input as ResponseInputItem[];

    const nonStreamingBody: ResponseCreateParamsNonStreaming = {
      model: request.model,
      instructions: request.instructions,
      input,
      previous_response_id: request.previousResponseId,
      reasoning: request.reasoningSummary
        ? { summary: request.reasoningSummary }
        : undefined,
      tools: request.tools as FunctionTool[],
      parallel_tool_calls: this.#parallelToolCalls,
      store: true,
    };
    const body = request.stream
      ? { ...nonStreamingBody, stream: true } satisfies ResponseCreateParamsStreaming
      : nonStreamingBody;
    const traceId = randomUUID();
    await this.#traceSink?.log({
      type: "openai.request",
      timestamp: new Date().toISOString(),
      traceId,
      endpoint: this.#endpoint,
      body,
    });

    const startedAt = performance.now();
    let result: CompletedResponseWithHttp;
    try {
      result = request.stream
        ? await this.#createStreamingResponse(body as ResponseCreateParamsStreaming, request)
        : await this.#client.responses.create(nonStreamingBody).withResponse();
    } catch (error) {
      await this.#traceSink?.log({
        type: "openai.error",
        timestamp: new Date().toISOString(),
        traceId,
        durationMs: Math.round(performance.now() - startedAt),
        error: serializeError(error),
      });
      if (request.previousResponseId && isPreviousResponseUnavailable(error)) {
        throw new PreviousResponseUnavailableError(request.previousResponseId, error);
      }
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
      outputText: response.output_text ?? extractOutputText(response),
      reasoningSummary: extractReasoningSummary(response),
      reasoningText: extractReasoningText(response),
      toolCalls: response.output
        .filter((item) => item.type === "function_call")
        .map((item) => ({
          callId: item.call_id,
          name: item.name,
          arguments: item.arguments,
        })),
    };
  }

  async #createStreamingResponse(
    body: ResponseCreateParamsStreaming,
    request: ModelRequest,
  ): Promise<CompletedResponseWithHttp> {
    const result = await this.#client.responses.create(body).withResponse();

    for await (const event of result.data) {
      switch (event.type) {
        case "response.output_text.delta":
          await request.onStreamEvent?.({ type: "output_text_delta", delta: event.delta });
          break;
        case "response.reasoning_summary_text.delta":
          await request.onStreamEvent?.({ type: "reasoning_summary_delta", delta: event.delta });
          break;
        case "response.reasoning_text.delta":
          await request.onStreamEvent?.({ type: "reasoning_text_delta", delta: event.delta });
          break;
        case "response.completed":
        case "response.incomplete":
          // The terminal event contains the complete response. Do not wait for
          // the optional [DONE] sentinel: the connection may close after the
          // terminal event without invalidating the response we already have.
          return { ...result, data: event.response };
        case "response.failed":
          throw new NonRetryableStreamingError(
            event.response.error?.message ?? "The streaming response failed.",
          );
        case "error":
          throw new NonRetryableStreamingError(event.message);
        default:
          break;
      }
    }

    throw new Error("The streaming response ended before returning a final response.");
  }
}

class NonRetryableStreamingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableStreamingError";
  }
}

function extractOutputText(response: OpenAIResponse): string {
  return response.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content)
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");
}

function extractReasoningSummary(response: OpenAIResponse): string | undefined {
  const summary = response.output
    .filter((item) => item.type === "reasoning")
    .flatMap((item) => item.summary ?? [])
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
  return summary || undefined;
}

function extractReasoningText(response: OpenAIResponse): string | undefined {
  const reasoning = response.output
    .filter((item) => item.type === "reasoning")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "reasoning_text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
  return reasoning || undefined;
}

function isReasoningSummaryUnsupported(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const details = error as { status?: unknown; message?: unknown; error?: unknown };
  const status = typeof details.status === "number" ? details.status : undefined;
  if (status !== 400 && status !== 422) return false;

  const description = JSON.stringify({
    message: details.message,
    error: details.error,
  });
  return /reasoning/iu.test(description)
    && /summary|unsupported|not supported|unknown|unrecognized|invalid|extra/iu.test(description);
}

function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof NonRetryableStreamingError) return false;

  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current !== "object") break;
    const details = current as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    if (details.name === "AbortError" || details.name === "APIUserAbortError") return false;
    // The OpenAI SDK already applies its own retry policy before surfacing
    // APIConnection errors. This adapter only adds a bounded body-level retry.
    if (typeof details.name === "string" && /^APIConnection/u.test(details.name)) return false;
    if (typeof details.status === "number") return false;
    if (
      typeof details.code === "string"
      && /^(?:ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_(?:BODY_TIMEOUT|HEADERS_TIMEOUT|SOCKET|CONNECT_TIMEOUT))$/u.test(details.code)
    ) {
      return true;
    }
    if (typeof details.message === "string" && (
      /\bterminated\b|premature(?:ly)? close|socket hang up/iu.test(details.message)
      || details.message === "The streaming response ended before returning a final response."
    )) {
      return true;
    }
    current = details.cause;
  }
  return false;
}

function isPreviousResponseUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const details = error as { status?: unknown; message?: unknown; error?: unknown };
  const status = typeof details.status === "number" ? details.status : undefined;
  if (status === 410) return true;
  if (status !== 400 && status !== 404 && status !== 422) return false;

  const description = JSON.stringify({
    message: details.message,
    error: details.error,
  });
  return /previous[_\s-]*response|(?:response|resp[_-])[^\n]{0,80}(?:not found|expired|missing|invalid)/iu
    .test(description);
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
