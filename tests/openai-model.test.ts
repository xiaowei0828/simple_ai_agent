import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { ModelStreamEvent } from "../src/core/types.js";
import type { OpenAITraceEntry } from "../src/logging/openai-trace.js";
import { OpenAIModel, type OpenAIModelOptions } from "../src/model/openai-model.js";

describe("OpenAIModel", () => {
  it("requires explicit credentials and endpoint even when SDK environment variables are set", () => {
    vi.stubEnv("OPENAI_API_KEY", "environment-fixture-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://environment.test/v1");
    try {
      expect(() => new OpenAIModel({ apiKey: "explicit-key" } as OpenAIModelOptions))
        .toThrow("explicit apiKey and baseURL");
      expect(() => new OpenAIModel({ baseURL: "https://explicit.test/v1" } as OpenAIModelOptions))
        .toThrow("explicit apiKey and baseURL");
      expect(() => new OpenAIModel({ apiKey: "explicit-key", baseURL: "https://explicit.test/v1" }))
        .not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("captures the SDK request body and full parsed response without credentials", async () => {
    const traces: OpenAITraceEntry[] = [];
    let transmittedBody = "";
    const client = new OpenAI({
      apiKey: "api-key-that-must-not-be-logged",
      baseURL: "https://example.test/v1",
      fetch: async (_input, init) => {
        transmittedBody = String(init?.body ?? "");
        return new Response(JSON.stringify({
          id: "resp-test",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "test-model",
          output: [
            {
              id: "reasoning-test",
              type: "reasoning",
              status: "completed",
              summary: [{ type: "summary_text", text: "I should answer briefly." }],
            },
            {
              id: "msg-test",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "hello", annotations: [], logprobs: [] }],
            },
          ],
          usage: {
            input_tokens: 3,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 4,
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req-test",
            "set-cookie": "must-not-be-logged",
          },
        });
      },
    });
    const model = new OpenAIModel({
      client,
      traceSink: {
        async log(entry) {
          traces.push(entry);
        },
      },
    });

    const result = await model.respond({
      model: "test-model",
      instructions: "full instructions",
      input: "hello",
      previousResponseId: "resp-previous",
      reasoningSummary: "auto",
      tools: [],
    });

    expect(result).toMatchObject({
      id: "resp-test",
      outputText: "hello",
      reasoningSummary: "I should answer briefly.",
    });
    expect(JSON.parse(transmittedBody)).toMatchObject({
      model: "test-model",
      instructions: "full instructions",
      input: "hello",
      previous_response_id: "resp-previous",
      reasoning: { summary: "auto" },
      parallel_tool_calls: true,
      store: true,
    });
    expect(JSON.parse(transmittedBody)).not.toHaveProperty("stream");
    expect(traces[0]).toMatchObject({
      type: "openai.request",
      body: { instructions: "full instructions", input: "hello" },
    });
    expect(traces[1]).toMatchObject({
      type: "openai.response",
      requestId: "req-test",
      body: { id: "resp-test", usage: { total_tokens: 4 } },
      http: { status: 200, headers: { "x-request-id": "req-test" } },
    });
    expect(JSON.stringify(traces)).not.toContain("api-key-that-must-not-be-logged");
    expect(JSON.stringify(traces)).not.toContain("must-not-be-logged");

    const serialModel = new OpenAIModel({ client, parallelToolCalls: false });
    await serialModel.respond({
      model: "test-model",
      instructions: "full instructions",
      input: "hello",
      tools: [],
    });
    expect(JSON.parse(transmittedBody)).toMatchObject({ parallel_tool_calls: false });
  });

  it("streams reasoning and output deltas while returning the completed response", async () => {
    const emitted: ModelStreamEvent[] = [];
    const traces: OpenAITraceEntry[] = [];
    let transmittedBody = "";
    const finalResponse = {
      id: "resp-stream",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "test-model",
      output: [
        {
          id: "reasoning-stream",
          type: "reasoning",
          status: "completed",
          summary: [{ type: "summary_text", text: "Inspect the project." }],
          content: [{ type: "reasoning_text", text: "Read the files carefully." }],
        },
        {
          id: "msg-stream",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "hello", annotations: [], logprobs: [] }],
        },
      ],
      usage: {
        input_tokens: 3,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 4,
      },
    };
    const streamEvents = [
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "reasoning-stream",
        output_index: 0,
        summary_index: 0,
        delta: "Inspect ",
        sequence_number: 1,
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "reasoning-stream",
        output_index: 0,
        summary_index: 0,
        delta: "the project.",
        sequence_number: 2,
      },
      {
        type: "response.reasoning_text.delta",
        item_id: "reasoning-stream",
        output_index: 0,
        content_index: 0,
        delta: "Read the files carefully.",
        sequence_number: 3,
      },
      {
        type: "response.output_text.delta",
        item_id: "msg-stream",
        output_index: 1,
        content_index: 0,
        delta: "hel",
        logprobs: [],
        sequence_number: 4,
      },
      {
        type: "response.output_text.delta",
        item_id: "msg-stream",
        output_index: 1,
        content_index: 0,
        delta: "lo",
        logprobs: [],
        sequence_number: 5,
      },
      {
        type: "response.completed",
        response: finalResponse,
        sequence_number: 6,
      },
    ];
    const eventStream = `${streamEvents
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("")}data: [DONE]\n\n`;
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      fetch: async (_input, init) => {
        transmittedBody = String(init?.body ?? "");
        return new Response(eventStream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "req-stream",
          },
        });
      },
    });
    const model = new OpenAIModel({
      client,
      traceSink: {
        async log(entry) {
          traces.push(entry);
        },
      },
    });

    const result = await model.respond({
      model: "test-model",
      instructions: "test instructions",
      input: "hello",
      reasoningSummary: "auto",
      stream: true,
      async onStreamEvent(event) {
        emitted.push(event);
      },
      tools: [],
    });

    expect(JSON.parse(transmittedBody)).toMatchObject({
      model: "test-model",
      stream: true,
      reasoning: { summary: "auto" },
    });
    expect(emitted).toEqual([
      { type: "reasoning_summary_delta", delta: "Inspect " },
      { type: "reasoning_summary_delta", delta: "the project." },
      { type: "reasoning_text_delta", delta: "Read the files carefully." },
      { type: "output_text_delta", delta: "hel" },
      { type: "output_text_delta", delta: "lo" },
    ]);
    expect(result).toMatchObject({
      id: "resp-stream",
      outputText: "hello",
      reasoningSummary: "Inspect the project.",
      reasoningText: "Read the files carefully.",
    });
    expect(traces.filter((entry) => entry.type === "openai.stream").map((entry) => entry.event))
      .toEqual(streamEvents);
    expect(traces.at(-1)).toMatchObject({
      type: "openai.response",
      requestId: "req-stream",
      body: { id: "resp-stream", usage: { total_tokens: 4 } },
    });
  });

  it("accepts a terminal streaming event even if the connection then terminates", async () => {
    let requestCount = 0;
    const encoder = new TextEncoder();
    const completedResponse = {
      id: "resp-terminal",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "test-model",
      output: [{
        id: "msg-terminal",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "complete", annotations: [], logprobs: [] }],
      }],
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
      },
    };
    const completedEvent = {
      type: "response.completed",
      response: completedResponse,
      sequence_number: 1,
    };
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      fetch: async () => {
        requestCount += 1;
        let terminationTimer: ReturnType<typeof setTimeout> | undefined;
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(
              `event: ${completedEvent.type}\ndata: ${JSON.stringify(completedEvent)}\n\n`,
            ));
            terminationTimer = setTimeout(() => {
              controller.error(new TypeError("terminated after terminal event"));
            }, 25);
          },
          cancel() {
            if (terminationTimer) clearTimeout(terminationTimer);
          },
        }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const model = new OpenAIModel({ client });

    const result = await model.respond({
      model: "test-model",
      instructions: "test instructions",
      input: "hello",
      stream: true,
      tools: [],
    });

    expect(requestCount).toBe(1);
    expect(result).toMatchObject({ id: "resp-terminal", outputText: "complete" });
  });

  it("propagates a terminated response body without retrying", async () => {
    const emitted: ModelStreamEvent[] = [];
    const traces: OpenAITraceEntry[] = [];
    let requestCount = 0;
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      maxRetries: 0,
      fetch: async () => {
        requestCount += 1;
        return new Response(new ReadableStream({
          start(controller) {
            controller.error(new TypeError("terminated"));
          },
        }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const model = new OpenAIModel({
      client,
      traceSink: { async log(entry) { traces.push(entry); } },
    });

    await expect(model.respond({
      model: "test-model",
      instructions: "test instructions",
      input: "hello",
      stream: true,
      async onStreamEvent(event) { emitted.push(event); },
      tools: [],
    })).rejects.toThrow("terminated");

    expect(requestCount).toBe(1);
    expect(emitted).toEqual([]);
    expect(traces.map((trace) => trace.type)).toEqual(["openai.request", "openai.error"]);
  });

  it("forwards a visible delta before propagating stream termination", async () => {
    const emitted: ModelStreamEvent[] = [];
    let requestCount = 0;
    const encoder = new TextEncoder();
    const deltaEvent = {
      type: "response.output_text.delta",
      item_id: "msg-partial",
      output_index: 0,
      content_index: 0,
      delta: "partial",
      logprobs: [],
      sequence_number: 1,
    };
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      maxRetries: 0,
      fetch: async () => {
        requestCount += 1;
        let sentDelta = false;
        return new Response(new ReadableStream({
          pull(controller) {
            if (!sentDelta) {
              sentDelta = true;
              controller.enqueue(encoder.encode(
                `event: ${deltaEvent.type}\ndata: ${JSON.stringify(deltaEvent)}\n\n`,
              ));
              return;
            }
            controller.error(new TypeError("terminated"));
          },
        }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const model = new OpenAIModel({ client });

    await expect(model.respond({
      model: "test-model",
      instructions: "test instructions",
      input: "hello",
      stream: true,
      async onStreamEvent(event) { emitted.push(event); },
      tools: [],
    })).rejects.toThrow("terminated");

    expect(requestCount).toBe(1);
    expect(emitted).toEqual([{ type: "output_text_delta", delta: "partial" }]);
  });

  it.each([undefined, "low"] as const)("preserves reasoning effort (%s) when falling back without reasoning summaries", async (effort) => {
    const transmittedBodies: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      fetch: async (_input, init) => {
        requestCount += 1;
        transmittedBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        if (requestCount === 1) {
          return new Response(JSON.stringify({
            error: {
              message: "Unknown parameter: reasoning.summary",
              type: "invalid_request_error",
            },
          }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          id: `resp-${requestCount}`,
          object: "response",
          created_at: 1,
          status: "completed",
          model: "test-model",
          output: [{
            id: `msg-${requestCount}`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "hello", annotations: [], logprobs: [] }],
          }],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const model = new OpenAIModel({ client });
    const request = {
      model: "test-model",
      instructions: "test instructions",
      input: "hello",
      reasoningSummary: "auto" as const,
      reasoningEffort: effort,
      tools: [],
    };

    const recovered = await model.respond(request);
    const cachedFallback = await model.respond(request);

    expect(recovered.reasoningSummaryUnavailable).toBe(true);
    expect(cachedFallback.reasoningSummaryUnavailable).toBeUndefined();
    expect(requestCount).toBe(3);
    expect(transmittedBodies[0]).toMatchObject({ reasoning: { summary: "auto" } });
    if (effort) {
      expect(transmittedBodies[0]!.reasoning).toEqual({ summary: "auto", effort });
      expect(transmittedBodies[1]!.reasoning).toEqual({ effort });
      expect(transmittedBodies[2]!.reasoning).toEqual({ effort });
    } else {
      expect(transmittedBodies[1]).not.toHaveProperty("reasoning");
      expect(transmittedBodies[2]).not.toHaveProperty("reasoning");
    }
  });

  it("sends explicit reasoning effort none and does not treat effort errors as unsupported summaries", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = new OpenAIModel({ client: new OpenAI({ apiKey: "fixture-key", baseURL: "https://fixture.test/v1", maxRetries: 0,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ error: { message: "Unsupported value for reasoning.effort", type: "invalid_request_error" } }),
          { status: 400, headers: { "content-type": "application/json" } });
      },
    }) });
    await expect(model.respond({ model: "test", input: "hello", instructions: "test", tools: [], reasoningEffort: "none", reasoningSummary: "auto" }))
      .rejects.toThrow("reasoning.effort");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.reasoning).toEqual({ effort: "none", summary: "auto" });
  });

});
